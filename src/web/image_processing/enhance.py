"""Background subtraction, noise normalization and display smoothing."""
import warnings

import numpy as np
from astropy.convolution import Gaussian2DKernel, convolve
from astropy.stats import sigma_clipped_stats
from astropy.utils.exceptions import AstropyUserWarning


def subtract_background(arr: np.ndarray, ref: np.ndarray | None = None) -> np.ndarray:
    """arr minus the sigma-clipped median of `ref` (default arr); units stay MJy/sr.
    `ref` keeps NaN where pixels were filled, so cosmetic values never enter the statistics."""
    ref = arr if ref is None else ref
    finite = ref[np.isfinite(ref)]
    if not finite.size:
        return arr
    _, median, _ = sigma_clipped_stats(finite, sigma=3)
    return arr - np.float32(median)


def normalize(arr: np.ndarray, ref: np.ndarray | None = None) -> np.ndarray:
    """Background-subtracted, in units of noise sigma (frame mode, scale=sigma); stats from `ref`.
    Not for stacks: per-frame noise scaling makes stacks incomparable."""
    ref = arr if ref is None else ref
    med = np.nanmedian(ref)
    sigma = 1.4826 * np.nanmedian(np.abs(ref - med))
    return (arr - med) / max(sigma, 1e-9)


def smooth(arr: np.ndarray, sigma_px: float) -> np.ndarray:
    """Gaussian smoothing; NaN areas stay NaN."""
    if sigma_px <= 0:
        return arr
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", AstropyUserWarning)
        return convolve(arr, Gaussian2DKernel(sigma_px), nan_treatment="interpolate",
                        boundary="extend", preserve_nan=True)
