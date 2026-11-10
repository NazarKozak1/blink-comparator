"""Frame pixels -> target grid."""
import numpy as np

from ..fits_s3 import Block


def bilinear(img: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Values of `img` at fractional pixel positions; NaN outside the image."""
    x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int)
    inside = (x0 >= 0) & (y0 >= 0) & (x0 + 1 < img.shape[1]) & (y0 + 1 < img.shape[0])
    out = np.full(x.shape, np.nan, dtype=np.float32)
    xi, yi, fx, fy = x0[inside], y0[inside], (x - x0)[inside], (y - y0)[inside]
    out[inside] = (img[yi, xi] * (1 - fx) * (1 - fy) + img[yi, xi + 1] * fx * (1 - fy)
                   + img[yi + 1, xi] * (1 - fx) * fy + img[yi + 1, xi + 1] * fx * fy)
    return out


def _block_pixels(block: Block, world: tuple[np.ndarray, np.ndarray]) -> tuple[np.ndarray, np.ndarray]:
    """Grid world coords -> fractional indices into block.data."""
    fx, fy = block.wcs.world_to_pixel_values(*world)
    return fx - block.x0, fy - block.y0


def resample(block: Block, world: tuple[np.ndarray, np.ndarray], arr: np.ndarray | None = None) -> np.ndarray:
    """Frame cut -> target grid given by its world coordinates (see grid.grid_world).
    `arr` replaces block.data, e.g. the VARIANCE cut or NaN-filled pixels; same geometry."""
    fx, fy = _block_pixels(block, world)
    return bilinear(block.data if arr is None else arr, fx, fy)


def coverage(block: Block, world: tuple[np.ndarray, np.ndarray]) -> np.ndarray:
    """True where the grid pixel falls inside the frame cut, whatever the pixel values are."""
    fx, fy = _block_pixels(block, world)
    h, w = block.data.shape
    return (fx >= 0) & (fy >= 0) & (np.floor(fx) + 1 < w) & (np.floor(fy) + 1 < h)
