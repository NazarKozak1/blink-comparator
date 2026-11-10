"""Per-pixel combination of frames already on a common grid. Pure numpy, no I/O."""
import warnings

import numpy as np
from astropy.stats import sigma_clip

from ..config import MIN_VALID_ROBUST, STACK_METHODS


def robust_mean(frames: list[np.ndarray]) -> np.ndarray:
    """Per-pixel mean across frames after rejecting outliers (cosmic rays, satellite trails)."""
    cube = np.ma.masked_invalid(np.stack(frames))
    return sigma_clip(cube, sigma=3, axis=0).mean(axis=0).filled(np.nan)


def combine(cube: np.ndarray, weights: np.ndarray | None = None, method: str = "minmax",
            min_valid: int = MIN_VALID_ROBUST) -> np.ndarray:
    """Weighted per-pixel combination of a (n_frames, h, w) cube.
    NaN values and non-positive / NaN weights are ignored.
    minmax: drop one highest and one lowest value, average the rest;
    sigma: iterative 3-sigma clipping, then average;
    mean: plain weighted mean.
    Pixels with fewer than `min_valid` values use the weighted mean for every method.
    Pixels without any valid value are NaN."""
    if method not in STACK_METHODS:
        raise ValueError(f"unknown method {method!r}, expected one of {STACK_METHODS}")
    cube = np.asarray(cube, dtype=np.float64)
    w = np.ones_like(cube) if weights is None else np.asarray(weights, dtype=np.float64)
    valid = np.isfinite(cube) & np.isfinite(w) & (w > 0)
    n_valid = valid.sum(axis=0)
    keep = valid.copy()
    robust = n_valid >= min_valid

    if method == "minmax":
        hi = np.argmax(np.where(valid, cube, -np.inf), axis=0)
        lo = np.argmin(np.where(valid, cube, np.inf), axis=0)
        yy, xx = np.nonzero(robust)
        keep[hi[yy, xx], yy, xx] = False
        keep[lo[yy, xx], yy, xx] = False                # same index when all values are equal: mean unchanged
    elif method == "sigma":
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            clipped = sigma_clip(np.ma.masked_array(cube, ~valid), sigma=3, maxiters=None, axis=0)
        keep = np.where(robust, ~np.ma.getmaskarray(clipped), valid)

    wk = np.where(keep, w, 0.0)
    total = wk.sum(axis=0)
    num = np.where(keep, cube * w, 0.0).sum(axis=0)
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(total > 0, num / total, np.nan).astype(np.float32)
