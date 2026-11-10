"""Display rendering: NaN filling, contrast stretch, annotation, PNG; pipelines for frames and stacks."""
import io
import warnings
from dataclasses import dataclass

import numpy as np
from astropy.convolution import Gaussian2DKernel, interpolate_replace_nans
from astropy.utils.exceptions import AstropyUserWarning
from PIL import Image, ImageDraw

from ..config import ASINH_SOFTENING, CONTRAST_PERCENTILES, STRETCHES
from ..fits_s3 import Block
from .enhance import normalize, smooth, subtract_background
from .resampling import coverage, resample

CROSS_COLOR = (239, 159, 39)
HOLE_COLOR = (110, 0, 0)
SIGMA_LO = -2.0
FILL_MAX_ITER = 100


@dataclass
class Rendered:
    png: bytes
    vmin: float
    vmax: float


# ---------- NaN filling ----------

def fill_nans(arr: np.ndarray, where: np.ndarray | None = None, max_iter: int = FILL_MAX_ITER) -> np.ndarray:
    """Fill NaN by repeated Gaussian interpolation from the neighbours until none are left.
    `where`: only NaN inside this mask are filled (e.g. grid pixels covered by frames); others stay NaN."""
    out = np.array(arr, dtype=np.float32, copy=True)
    todo = np.isnan(out) if where is None else np.isnan(out) & where
    if not todo.any() or not np.isfinite(out).any():
        return out
    kernel = Gaussian2DKernel(1.0)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", AstropyUserWarning)
        for _ in range(max_iter):
            filled = interpolate_replace_nans(out, kernel, boundary="extend")
            step = todo & np.isfinite(filled)
            if not step.any():
                break
            out[step] = filled[step]
            todo &= ~step
            if not todo.any():
                break
    return out


# ---------- contrast ----------

def auto_limits(arr: np.ndarray, hi_pct: float = CONTRAST_PERCENTILES[1]) -> tuple[float, float]:
    """Display limits from percentiles of the image itself."""
    lo, hi = np.nanpercentile(arr, (CONTRAST_PERCENTILES[0], hi_pct))
    return float(lo), float(hi if hi > lo else lo + 1e-6)


def stretch_fixed(arr: np.ndarray, vmin: float, vmax: float, a: float = ASINH_SOFTENING) -> np.ndarray:
    """asinh stretch between fixed limits (same units as arr) -> 0..1; NaN -> 0."""
    u = np.clip((arr - vmin) / max(vmax - vmin, 1e-12), 0, 1)
    out = np.arcsinh(u / a) / np.arcsinh(1 / a)
    out[np.isnan(arr)] = 0
    return out


def stretch_sigma(snr: np.ndarray, lo: float = SIGMA_LO, hi: float | None = None,
                  ref: np.ndarray | None = None) -> tuple[np.ndarray, float, float]:
    """asinh stretch of a sigma-normalized image; the top follows the brightest pixels of `ref`
    (default snr), so bright sources keep their structure. Returns (0..1 image with NaN -> 0, lo, hi)."""
    if hi is None:
        hi = max(15.0, float(np.nanpercentile(snr if ref is None else ref, 99.95)))
    stretched = np.arcsinh(np.clip(np.nan_to_num(snr, nan=lo), lo, None) - lo) / np.arcsinh(hi - lo)
    stretched[np.isnan(snr)] = 0
    return stretched, lo, hi


# ---------- annotation ----------

def annotate(stretched: np.ndarray, label: str, size: int = 720, holes: np.ndarray | None = None,
             marks: bool = True) -> Image.Image:
    """0..1 image -> RGB `size` px with crosshair and caption; `holes` mask is painted dark red.
    marks=False: no crosshair and caption (the page draws its own). Row 0 of the input is south."""
    img = Image.fromarray((np.clip(stretched[::-1], 0, 1) * 255).astype(np.uint8))
    resample_filter = Image.BICUBIC if img.width < size else Image.LANCZOS
    img = img.resize((size, size), resample_filter).convert("RGB")
    if holes is not None and holes.any():
        mask = Image.fromarray((holes[::-1] * 255).astype(np.uint8)).resize((size, size), Image.NEAREST)
        img.paste(HOLE_COLOR, mask=mask)
    if not marks:
        return img
    d = ImageDraw.Draw(img)
    cx, cy = img.width // 2, img.height // 2
    gap, arm = img.width // 20, img.width // 8
    for x0, y0, x1, y1 in [(cx - arm, cy, cx - gap, cy), (cx + gap, cy, cx + arm, cy),
                           (cx, cy - arm, cx, cy - gap), (cx, cy + gap, cx, cy + arm)]:
        d.line([(x0, y0), (x1, y1)], fill=CROSS_COLOR, width=2)
    d.rectangle([0, 0, img.width, 18], fill=(0, 0, 0))
    d.text((6, 3), label, fill=(255, 255, 255))
    return img


def to_image(snr: np.ndarray, label: str, size: int = 720, lo: float = SIGMA_LO, hi: float | None = None) -> Image.Image:
    """Sigma-normalized image -> annotated picture (CLI and frame mode with scale=sigma)."""
    return annotate(stretch_sigma(snr, lo, hi)[0], label, size)


def _png(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


# ---------- pipelines ----------

def _background(arr: np.ndarray, measured: np.ndarray, zodi: np.ndarray | None, bg: str) -> np.ndarray:
    """MJy/sr image with the chosen background removed: median of the frame, ZODI model, or nothing (raw)."""
    if bg == "raw":
        return arr
    if bg == "zodi":
        return arr - zodi
    return subtract_background(arr, measured)


def cutout_png(block: Block, world: tuple[np.ndarray, np.ndarray], smooth_px: float, label: str,
               size: int = 720, scale: str = "sigma", holes: bool = False,
               vmin: float | None = None, vmax: float | None = None, bg: str = "median",
               marks: bool = True, stretch: str = "normal") -> Rendered:
    """One frame: [fill NaN in raw pixels] -> resample -> sigma (normalize) or MJy/sr (background only)
    -> smooth -> stretch -> annotate -> PNG. Without vmin/vmax the limits are automatic and returned.
    Background, noise and automatic limits come from the unfilled image processed the same way,
    so filling is purely cosmetic. holes=True: NaN are not filled and are painted dark red.
    bg (scale=mjy only): median | zodi (block.zodi needed) | raw. stretch (scale=mjy only): faint | normal | bright."""
    measured = resample(block, world)                          # NaN where the frame has no data
    hole_mask = np.isnan(measured) & coverage(block, world)
    arr = measured if holes else resample(block, world, fill_nans(block.data))
    fixed = vmin is not None and vmax is not None
    if scale == "sigma":
        snr = smooth(normalize(arr, measured), smooth_px)
        ref = snr if holes else smooth(normalize(measured), smooth_px)
        stretched, lo, hi = stretch_sigma(snr, *((vmin, vmax) if fixed else (SIGMA_LO, None)), ref=ref)
    else:
        zodi = resample(block, world, block.zodi) if bg == "zodi" else None
        img = smooth(_background(arr, measured, zodi, bg), smooth_px)
        pct, soft = STRETCHES[stretch]
        if fixed:
            lo, hi = vmin, vmax
        else:
            lo, hi = auto_limits(img if holes else smooth(_background(measured, measured, zodi, bg), smooth_px), pct)
        stretched = stretch_fixed(img, lo, hi, soft)
    return Rendered(_png(annotate(stretched, label, size, hole_mask if holes else None, marks)), lo, hi)


def stack_png(data: np.ndarray, covered: np.ndarray, label: str, smooth_px: float = 0.0,
              holes: bool = False, vmin: float | None = None, vmax: float | None = None,
              size: int = 720, marks: bool = True, stretch: str = "normal") -> Rendered:
    """Stack in MJy/sr: [fill NaN inside the covered area] -> smooth -> fixed or automatic asinh -> PNG.
    Automatic limits come from the unfilled stack. Grid pixels no frame covered stay black."""
    hole_mask = np.isnan(data) & covered
    arr = smooth(data if holes else fill_nans(data, covered), smooth_px)
    pct, soft = STRETCHES[stretch]
    if vmin is not None and vmax is not None:
        lo, hi = vmin, vmax
    else:
        lo, hi = auto_limits(arr if holes else smooth(data, smooth_px), pct)
    return Rendered(_png(annotate(stretch_fixed(arr, lo, hi, soft), label, size, hole_mask if holes else None, marks)),
                    lo, hi)


# ---------- difference of two stacks ----------

def significance(a: np.ndarray, b: np.ndarray, sigma_a: np.ndarray, sigma_b: np.ndarray) -> tuple[np.ndarray, float, float]:
    """S = (B - A) / sqrt(sA^2 + sB^2), then calibrated on the image itself: the median is moved to 0 and
    the robust scatter to 1. VARIANCE misses the faint-source background and resampling correlations,
    so the raw S is not in true sigmas. Returns (S, offset, scale) with S = (S_raw - offset) / scale."""
    with np.errstate(invalid="ignore", divide="ignore"):
        raw = (b - a) / np.sqrt(sigma_a ** 2 + sigma_b ** 2)
    finite = raw[np.isfinite(raw)]
    if finite.size < 10:
        return raw, 0.0, 1.0
    offset = float(np.median(finite))
    scale = float(1.4826 * np.median(np.abs(finite - offset))) or 1.0
    return (raw - offset) / scale, offset, scale


def diff_png(s: np.ndarray, covered: np.ndarray, holes: bool = False, limit: float = 5.0, size: int = 720,
             marks: bool = True, label: str = "") -> Rendered:
    """Significance map: grey at 0, white at S >= +limit (appeared), black at S <= -limit (vanished).
    Pixels without data stay grey, or dark red with holes=True."""
    grey = np.clip(0.5 + s / (2 * limit), 0, 1)
    grey[np.isnan(s)] = 0.5
    hole_mask = np.isnan(s) & covered
    return Rendered(_png(annotate(grey, label, size, hole_mask if holes else None, marks)), -limit, limit)
