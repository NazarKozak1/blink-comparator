"""Partial reads of SPHEREx FITS files from the public S3 bucket: headers, pixel rows, WCS-WAVE.
Only the needed byte ranges are downloaded, never the whole ~70 MB file.

File layout: PRIMARY, IMAGE, FLAGS, VARIANCE, ZODI (2040x2040 each), PSF, WCS-WAVE.
Extension headers have variable length, so VARIANCE is located by reading the FLAGS and VARIANCE headers."""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from functools import lru_cache

import boto3
import numpy as np
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.wcs import WCS
from botocore import UNSIGNED
from botocore.config import Config

from .config import BLOCK_CACHE_SIZE, BUCKET, EXT_HEADER_BYTES, HEAD_BYTES, S3_WORKERS, WAVE_TAIL_BYTES

s3 = boto3.client("s3", region_name="us-east-1",
                  config=Config(signature_version=UNSIGNED, max_pool_connections=S3_WORKERS * 2))

FITS_BLOCK = 2880
_io_pool = ThreadPoolExecutor(S3_WORKERS)    # inner reads of one frame; separate from callers' pools


def read_range(key: str, start: int, end: int) -> bytes:
    return s3.get_object(Bucket=BUCKET, Key=key, Range=f"bytes={start}-{end}")["Body"].read()


def _padded(n: int) -> int:
    return -(-n // FITS_BLOCK) * FITS_BLOCK


def _data_bytes(header: fits.Header) -> int:
    n = abs(header["BITPIX"]) // 8
    for k in range(1, header.get("NAXIS", 0) + 1):
        n *= header[f"NAXIS{k}"]
    return _padded(n + header.get("PCOUNT", 0)) if header.get("NAXIS", 0) else 0


def _parse_header(text: str, start: int) -> tuple[fits.Header, int] | None:
    """Header starting at `start` in `text` and its padded length; None if END is not in `text`."""
    end_card = next((i for i in range(start, len(text), 80) if text[i:i + 8] == "END     "), None)
    if end_card is None:
        return None
    return fits.Header.fromstring(text[start:end_card + 80]), _padded(end_card + 80 - start)


@lru_cache(maxsize=2048)
def image_header(key: str) -> tuple[fits.Header, int]:
    """IMAGE header and the byte offset where its pixel data starts."""
    text = read_range(key, 0, HEAD_BYTES - 1).decode("latin-1")  # latin-1 keeps byte offsets 1:1
    start = text.find("XTENSION= 'IMAGE")
    header, length = _parse_header(text, start)
    return header, start + length


def _header_at(key: str, offset: int) -> tuple[fits.Header, int]:
    """Extension header at a known file offset and the offset of its data."""
    n = EXT_HEADER_BYTES
    while True:
        parsed = _parse_header(read_range(key, offset, offset + n - 1).decode("latin-1"), 0)
        if parsed:
            return parsed[0], offset + parsed[1]
        n *= 4


@lru_cache(maxsize=2048)
def flags_location(key: str) -> tuple[fits.Header, int]:
    """FLAGS header and its data offset: right after the IMAGE data. From l2b-v27 (July 2026) FLAGS is a
    RICE-compressed BINTABLE with one tile per row; _read_rows decodes just the rows asked for."""
    image_hdr, image_start = image_header(key)
    return _header_at(key, image_start + _data_bytes(image_hdr))



def _row_tiles(header: fits.Header) -> bool:
    """Tile-compressed image with one RICE tile per row (FLAGS of l2b-v27)."""
    return (header.get("XTENSION") == "BINTABLE" and header.get("ZIMAGE") is True and header.get("ZCMPTYPE") == "RICE_1"
            and header.get("ZTILE2") == 1 and header.get("ZTILE1") == header.get("ZNAXIS1")
            and header.get("TFORM1", "").startswith("1P") and header.get("NAXIS1") == 8)


def flags_readable(header: fits.Header) -> bool:
    return (header.get("XTENSION") == "IMAGE" and header.get("BITPIX") in (16, 32)) or         (_row_tiles(header) and header.get("ZBITPIX") in (16, 32))


def _read_tiled_rows(key: str, header: fits.Header, data_start: int, y0: int, y1: int) -> np.ndarray:
    """Rows y0..y1 of a row-tiled RICE image: their (size, heap offset) descriptors, then one heap range."""
    from astropy.io.fits.hdu.compressed._codecs import Rice1     # astropy's own decoder
    desc = np.frombuffer(read_range(key, data_start + y0 * 8, data_start + (y1 + 1) * 8 - 1), ">i4").reshape(-1, 2)
    heap = data_start + header.get("THEAP", header["NAXIS1"] * header["NAXIS2"])
    lo, hi = int(desc[:, 1].min()), int((desc[:, 1] + desc[:, 0]).max())
    buf = np.frombuffer(read_range(key, heap + lo, heap + hi - 1), np.uint8)
    codec = Rice1(blocksize=header.get("ZVAL1", 32), bytepix=header.get("ZVAL2", 4), tilesize=header["ZTILE1"])
    return np.stack([np.asarray(codec.decode(buf[off - lo:off - lo + n]), dtype=np.int32) for n, off in desc])


@lru_cache(maxsize=2048)
def variance_location(key: str) -> tuple[fits.Header, int]:
    """VARIANCE header and its data offset: IMAGE data -> FLAGS header -> FLAGS data -> VARIANCE header."""
    flags_hdr, flags_start = flags_location(key)
    var_hdr, var_start = _header_at(key, flags_start + _data_bytes(flags_hdr))
    if var_hdr.get("EXTNAME") != "VARIANCE":
        raise ValueError(f"expected VARIANCE after FLAGS in {key}, got {var_hdr.get('EXTNAME')}")
    return var_hdr, var_start


@lru_cache(maxsize=2048)
def zodi_location(key: str) -> tuple[fits.Header, int]:
    """ZODI header (zodiacal light model) and its data offset: right after the VARIANCE data."""
    var_hdr, var_start = variance_location(key)
    zodi_hdr, zodi_start = _header_at(key, var_start + _data_bytes(var_hdr))
    if zodi_hdr.get("EXTNAME") != "ZODI":
        raise ValueError(f"expected ZODI after VARIANCE in {key}, got {zodi_hdr.get('EXTNAME')}")
    return zodi_hdr, zodi_start


_LOCATE = {"IMAGE": image_header, "VARIANCE": variance_location, "ZODI": zodi_location, "FLAGS": flags_location}


@dataclass
class Block:
    """Pixel rows of one frame around the target, with the frame WCS.
    `data` covers frame pixels y0.., x0.. ; `var` and `zodi` are the matching VARIANCE / ZODI cuts, if read."""
    wcs: WCS
    data: np.ndarray
    y0: int
    x0: int = 0
    var: np.ndarray | None = None
    zodi: np.ndarray | None = None


def _read_rows(key: str, header: fits.Header, data_start: int, y0: int, y1: int) -> np.ndarray:
    """Full-width rows y0..y1: float32 for images, int32 for integer layers (FLAGS bits)."""
    if _row_tiles(header):
        return _read_tiled_rows(key, header, data_start, y0, y1)
    nx = header["NAXIS1"]
    dtype = np.dtype({-32: ">f4", -64: ">f8", 32: ">i4", 16: ">i2"}[header["BITPIX"]])
    row_bytes = nx * dtype.itemsize
    raw = read_range(key, data_start + y0 * row_bytes, data_start + (y1 + 1) * row_bytes - 1)
    rows = np.frombuffer(raw, dtype=dtype).reshape(-1, nx)
    return rows.astype(np.int32 if header["BITPIX"] > 0 else np.float32)


def _footprint_box(wcs: WCS, shape: tuple[int, int], footprint, pad: int = 2) -> tuple[int, int, int, int]:
    """Frame pixel box (x0, x1, y0, y1) covering the world coordinates in `footprint`, inclusive."""
    fx, fy = wcs.world_to_pixel_values(*footprint)
    ny, nx = shape
    return (max(0, int(np.floor(np.nanmin(fx))) - pad), min(nx - 1, int(np.ceil(np.nanmax(fx))) + pad),
            max(0, int(np.floor(np.nanmin(fy))) - pad), min(ny - 1, int(np.ceil(np.nanmax(fy))) + pad))


def fetch_block(key: str, coord: SkyCoord, footprint: tuple[np.ndarray, np.ndarray]) -> Block | None:
    """Full-width rows of the frame covering `footprint` (world coords of the cutout grid);
    None if the target is outside. Used by the CLI drizzle, which needs absolute x columns."""
    header, data_start = image_header(key)
    shape = header["NAXIS2"], header["NAXIS1"]
    wcs = WCS(header)
    tx, ty = wcs.world_to_pixel(coord)                     # 0-based, includes SIP distortion
    if not (0 <= tx < shape[1] and 0 <= ty < shape[0]):
        return None                                        # index match was by center distance only
    _, _, y0, y1 = _footprint_box(wcs, shape, footprint)
    return Block(wcs, _read_rows(key, header, data_start, y0, y1), y0)


@lru_cache(maxsize=BLOCK_CACHE_SIZE)
def _layer_cut(key: str, layer: str, x0: int, x1: int, y0: int, y1: int) -> np.ndarray:
    """Pixel box of IMAGE, VARIANCE or ZODI; rows come from S3, columns are cropped before caching."""
    header, data_start = _LOCATE[layer](key)
    cut = _read_rows(key, header, data_start, y0, y1)[:, x0:x1 + 1].copy()   # copy frees the full rows
    cut.setflags(write=False)                              # shared through the cache
    return cut


def fetch_cutout(key: str, coord: SkyCoord, footprint: tuple[np.ndarray, np.ndarray],
                 variance: bool = False, zodi: bool = False) -> Block | None:
    """Like fetch_block, but cropped to the cutout in x and cached; optionally with VARIANCE and ZODI."""
    header, _ = image_header(key)
    shape = header["NAXIS2"], header["NAXIS1"]
    wcs = WCS(header)
    tx, ty = wcs.world_to_pixel(coord)
    if not (0 <= tx < shape[1] and 0 <= ty < shape[0]):
        return None
    x0, x1, y0, y1 = _footprint_box(wcs, shape, footprint)
    if not variance and not zodi:
        return Block(wcs, _layer_cut(key, "IMAGE", x0, x1, y0, y1), y0, x0)
    image = _io_pool.submit(_layer_cut, key, "IMAGE", x0, x1, y0, y1)   # overlaps the header chain
    var = _io_pool.submit(_layer_cut, key, "VARIANCE", x0, x1, y0, y1) if variance else None
    zod = _layer_cut(key, "ZODI", x0, x1, y0, y1) if zodi else None
    return Block(wcs, image.result(), y0, x0, var.result() if var else None, zod)


@lru_cache(maxsize=4096)
def wave_table(key: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """WCS-WAVE lookup table from the last HDU, via a suffix range read.
    Returns X knots, Y knots (1-based raw detector pixels) and values [y, x, (lambda, bandwidth)] in um."""
    for n in WAVE_TAIL_BYTES:
        resp = s3.get_object(Bucket=BUCKET, Key=key, Range=f"bytes=-{n}")
        tail = resp["Body"].read()
        file_size = int(resp["ContentRange"].rsplit("/", 1)[1])
        pos = len(tail)
        while (pos := tail.rfind(b"XTENSION= 'BINTABLE'", 0, pos)) >= 0:
            if (file_size - len(tail) + pos) % FITS_BLOCK:   # not a header start
                continue
            hdu = fits.BinTableHDU.fromstring(tail[pos:])
            if hdu.name == "WCS-WAVE":
                row = hdu.data[0]
                return (np.asarray(row["X"], float), np.asarray(row["Y"], float),
                        np.asarray(row["VALUES"], float))
        if len(tail) >= file_size:
            break
    raise ValueError(f"no WCS-WAVE HDU in the last {WAVE_TAIL_BYTES[-1]} bytes of {key}")
