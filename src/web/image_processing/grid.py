"""Target grid of the cutout: north-up, east-left TAN projection centered on the target."""
import numpy as np
from astropy.coordinates import SkyCoord
from astropy.wcs import WCS

from ..config import PIXEL_ARCSEC


def half_size_px(size_arcmin: float) -> int:
    """Cutout half-side in SPHEREx pixels."""
    return int(size_arcmin * 60 / PIXEL_ARCSEC / 2)


def grid_wcs(coord: SkyCoord, half: int, oversample: int = 1) -> tuple[WCS, tuple[int, int]]:
    """Grid of (2*half+1)*oversample pixels per side; same sky area for any oversampling."""
    n = (2 * half + 1) * oversample
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [coord.ra.deg, coord.dec.deg]
    w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    step = PIXEL_ARCSEC / 3600 / oversample
    w.wcs.cdelt = [-step, step]
    return w, (n, n)


def grid_world(w: WCS, shape: tuple[int, int]) -> tuple[np.ndarray, np.ndarray]:
    """(ra, dec) in degrees of every grid pixel."""
    yy, xx = np.mgrid[0:shape[0], 0:shape[1]]
    return w.pixel_to_world_values(xx, yy)
