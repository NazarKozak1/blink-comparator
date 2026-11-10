"""Stack of the frames of one time window: S3 blocks -> background -> common grid -> combine.
Meant for visual search, not photometry (1/VARIANCE weights include source noise)."""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from functools import lru_cache

import numpy as np

from .config import S3_WORKERS
from .fits_s3 import fetch_cutout
from .geometry import parse_coord
from .image_processing import (combine, coverage, grid_wcs, grid_world, half_size_px, resample,
                               subtract_background)

_pool = ThreadPoolExecutor(S3_WORKERS)


@dataclass(frozen=True)
class StackInputs:
    cube: np.ndarray            # (n, h, w) MJy/sr, background-subtracted, NaN kept
    weights: np.ndarray | None  # (n, h, w) 1/VARIANCE, NaN where unknown
    covered: np.ndarray         # (h, w) grid pixels inside at least one frame


@dataclass(frozen=True)
class StackResult:
    data: np.ndarray            # (h, w) MJy/sr, NaN where no valid value
    covered: np.ndarray
    n_frames: int


BACKGROUNDS = ("median", "zodi", "raw")


def _frame_layers(path: str, coord, world, weights: bool, bg: str = "median"):
    block = fetch_cutout(path, coord, world, variance=weights, zodi=bg == "zodi")
    if block is None:
        return None
    # background before reprojection: median of the frame (default), ZODI model, or none
    data = {"median": lambda: subtract_background(block.data), "zodi": lambda: block.data - block.zodi,
            "raw": lambda: block.data}[bg]()
    img = resample(block, world, data)
    var = resample(block, world, block.var) if weights else None
    return img, var, coverage(block, world)


@lru_cache(maxsize=8)
def stack_inputs(paths: tuple[str, ...], coords: str, size: float, weights: bool, bg: str = "median") -> StackInputs:
    """Per-frame layers on the common grid; independent of the method, so a method change is cheap."""
    coord = parse_coord(coords)
    grid, shape = grid_wcs(coord, half_size_px(size))
    world = grid_world(grid, shape)
    layers = [r for r in _pool.map(lambda p: _frame_layers(p, coord, world, weights, bg), paths) if r]
    if not layers:
        return StackInputs(np.empty((0, *shape), np.float32), None, np.zeros(shape, bool))
    cube = np.stack([img for img, _, _ in layers])
    w = None
    if weights:
        var = np.stack([v for _, v, _ in layers])
        with np.errstate(divide="ignore", invalid="ignore"):
            w = np.where(var > 0, 1.0 / var, np.nan).astype(np.float32)
    covered = np.logical_or.reduce([c for _, _, c in layers])
    for a in (cube, covered) + ((w,) if w is not None else ()):
        a.setflags(write=False)                                       # shared through the cache
    return StackInputs(cube, w, covered)


@lru_cache(maxsize=64)
def build_stack(paths: tuple[str, ...], coords: str, size: float, method: str, weights: bool,
                bg: str = "median") -> StackResult:
    """Stack of the given frames in MJy/sr. Rendering is separate, so blink / difference can reuse this."""
    inputs = stack_inputs(paths, coords, size, weights, bg)
    if not len(inputs.cube):
        return StackResult(np.full(inputs.covered.shape, np.nan, np.float32), inputs.covered, 0)
    data = combine(inputs.cube, inputs.weights, method)
    return StackResult(data, inputs.covered, len(inputs.cube))


@lru_cache(maxsize=64)
def stack_sigma(paths: tuple[str, ...], coords: str, size: float, bg: str = "median") -> np.ndarray:
    """1-sigma of a weighted stack from VARIANCE: 1 / sqrt(sum of 1/VARIANCE over frames with data).
    Ignores rejection by minmax / sigma; the difference map calibrates its scale anyway."""
    inputs = stack_inputs(paths, coords, size, True, bg)
    if not len(inputs.cube):
        return np.full(inputs.covered.shape, np.nan, np.float32)
    w = np.where(np.isfinite(inputs.cube) & np.isfinite(inputs.weights), inputs.weights, 0.0)
    total = w.sum(axis=0)
    with np.errstate(divide="ignore"):
        return np.where(total > 0, 1 / np.sqrt(total), np.nan).astype(np.float32)
