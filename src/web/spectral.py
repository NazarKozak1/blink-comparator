"""Wavelength at a detector pixel and the conventional spectral band number."""
import numpy as np

from .config import DETECTOR_RANGE_UM, N_BANDS
from .fits_s3 import wave_table


def wavelength(key: str, x: float, y: float) -> tuple[float, float]:
    """(lambda, bandwidth) in um at 0-based pixel (x, y): bilinear lookup in raw detector coordinates.
    Equals astropy WCS(header, fobj=hdul, key='W') with the SIP keywords removed; astropy otherwise
    applies the sky SIP distortion to this table, while the header says it is in raw pixel coordinates."""
    xk, yk, vals = wave_table(key)
    px, py = x + 1, y + 1
    i = int(np.clip(np.searchsorted(xk, px, "right") - 1, 0, len(xk) - 2))
    j = int(np.clip(np.searchsorted(yk, py, "right") - 1, 0, len(yk) - 2))
    fx = float(np.clip((px - xk[i]) / (xk[i + 1] - xk[i]), 0, 1))
    fy = float(np.clip((py - yk[j]) / (yk[j + 1] - yk[j]), 0, 1))
    v = (vals[j, i] * (1 - fx) * (1 - fy) + vals[j, i + 1] * fx * (1 - fy)
         + vals[j + 1, i] * (1 - fx) * fy + vals[j + 1, i + 1] * fx * fy)
    return float(v[0]), float(v[1])


def band_of(detector: int, lam_um: float) -> tuple[int, int]:
    """(band 1..17 within the detector, global band 1..102). Out-of-range lambda is clamped."""
    lo, hi = DETECTOR_RANGE_UM[detector]
    k = int(np.floor(N_BANDS * np.log(lam_um / lo) / np.log(hi / lo))) + 1
    band = min(max(k, 1), N_BANDS)
    return band, (detector - 1) * N_BANDS + band


def band_edges(detector: int) -> list[float]:
    """N_BANDS + 1 band boundaries in um."""
    return np.geomspace(*DETECTOR_RANGE_UM[detector], N_BANDS + 1).round(4).tolist()
