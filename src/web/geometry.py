"""Coordinate parsing and the cutout-in-frame check."""
import re

import numpy as np
from astropy import units as u
from astropy.coordinates import SkyCoord
from astropy.wcs import WCS

from .config import FIT_MARGIN_PX
from .image_processing.grid import grid_wcs


def parse_coord(text: str) -> SkyCoord:
    """'RA Dec' as degrees ('133.795 -7.245', '133.795, -7.245') or sexagesimal
    ('08h55m10.8s -7d14m42.5s', '08:55:10.8 -07:14:42.5', '08 55 10.8 -07 14 42.5')."""
    cleaned = " ".join(text.replace(",", " ").replace(";", " ").replace("°", " ").split())
    cleaned = re.sub(r"([+-])\s+(?=\d)", r"\1", cleaned)   # '- 5.39' -> '-5.39'
    parts = cleaned.split(" ")
    if len(parts) == 2:
        try:
            return SkyCoord(float(parts[0]) * u.deg, float(parts[1]) * u.deg)
        except ValueError:
            return SkyCoord(parts[0], parts[1], unit=(u.hourangle, u.deg))
    return SkyCoord(cleaned, unit=(u.hourangle, u.deg))


def cutout_fits(wcs: WCS, shape: tuple[int, int], coord: SkyCoord, half: int) -> bool:
    """True if all four corners of the cutout square land inside the frame."""
    grid, (n, _) = grid_wcs(coord, half)
    corners = np.array([0, n - 1, n - 1, 0], float), np.array([0, 0, n - 1, n - 1], float)
    cx, cy = wcs.world_to_pixel_values(*grid.pixel_to_world_values(*corners))
    ny, nx = shape
    return bool(np.all((cx >= -FIT_MARGIN_PX) & (cx <= nx - 1 + FIT_MARGIN_PX)
                       & (cy >= -FIT_MARGIN_PX) & (cy <= ny - 1 + FIT_MARGIN_PX)))
