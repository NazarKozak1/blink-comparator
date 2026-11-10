"""FITS header parsing without astropy.

A header is a sequence of 80-char cards: `KEYWORD = value / comment`.
SPHEREx files start with an empty primary header followed by the IMAGE extension;
values are taken from IMAGE only, since some keywords may also exist in the primary header.
"""
import math
from datetime import datetime, timezone

CARD = 80
WCS_KEYS = ("CRVAL1", "CRVAL2", "CRPIX1", "CRPIX2", "PC1_1", "PC1_2", "PC2_1", "PC2_2")
WANTED = ("DATE-OBS", "MJD-AVG", "DETECTOR", "OBSID", "CDELT1", "CDELT2") + WCS_KEYS
REQUIRED = ("DATE-OBS", "MJD-AVG", "DETECTOR") + WCS_KEYS
IMAGE_CENTER_PIXEL = 1020.5  # FITS 1-based center of a 2040x2040 image
MAX_CENTER_OFFSET_PX = 1020  # reference pixel must lie inside the image; center is approximate (no SIP)


class HeaderError(ValueError):
    pass


def read_image_cards(text: str) -> dict[str, str]:
    start = text.find("XTENSION= 'IMAGE")
    if start < 0:
        raise HeaderError("IMAGE header not found in fetched bytes")
    cards: dict[str, str] = {}
    for i in range(start, len(text) - CARD + 1, CARD):
        card = text[i:i + CARD]
        keyword = card[:8].rstrip()
        if keyword == "END":
            return cards
        if keyword not in WANTED or card[8:10] != "= ":
            continue
        value = card[10:].lstrip()
        if value.startswith("'"):
            cards[keyword] = value[1:value.find("'", 1)].rstrip()
        else:
            cards[keyword] = value.split("/", 1)[0].strip()
    missing = [k for k in REQUIRED if k not in cards]
    if missing:
        raise HeaderError(f"header truncated, missing: {missing}")
    return cards


def image_center(c: dict[str, str]) -> tuple[float, float]:
    """Sky position of the central pixel: linear WCS offset from CRPIX, then inverse TAN projection.
    SIP distortion is ignored; it is negligible this close to the reference pixel."""
    f = {k: float(c[k]) for k in WCS_KEYS}
    dx = IMAGE_CENTER_PIXEL - f["CRPIX1"]
    dy = IMAGE_CENTER_PIXEL - f["CRPIX2"]
    if max(abs(dx), abs(dy)) > MAX_CENTER_OFFSET_PX:
        raise HeaderError(f"reference pixel too far from center: CRPIX=({f['CRPIX1']}, {f['CRPIX2']})")
    cdelt1 = float(c.get("CDELT1", 1.0))
    cdelt2 = float(c.get("CDELT2", 1.0))
    xi = math.radians(cdelt1 * (f["PC1_1"] * dx + f["PC1_2"] * dy))
    eta = math.radians(cdelt2 * (f["PC2_1"] * dx + f["PC2_2"] * dy))

    ra0, dec0 = math.radians(f["CRVAL1"]), math.radians(f["CRVAL2"])
    denom = math.cos(dec0) - eta * math.sin(dec0)
    ra = ra0 + math.atan2(xi, denom)
    dec = math.atan2(math.sin(dec0) + eta * math.cos(dec0), math.hypot(xi, denom))
    return math.degrees(ra) % 360.0, math.degrees(dec)


def parse_header(text: str) -> dict:
    c = read_image_cards(text)
    missing = [k for k in REQUIRED if not c.get(k)]
    if missing:
        raise HeaderError(f"missing keywords: {missing}")
    ra_center, dec_center = image_center(c)
    return {
        # FITS DATE-OBS is UTC unless TIMESYS says otherwise
        "date_obs": datetime.fromisoformat(c["DATE-OBS"]).replace(tzinfo=timezone.utc),
        "mjd_avg": float(c["MJD-AVG"]),
        "detector": int(c["DETECTOR"]),
        "obsid": c.get("OBSID"),
        "ra_center": ra_center,
        "dec_center": dec_center,
    }