import math
from datetime import datetime, timezone

import pytest

from src.utils.index.header_parser import MAX_CENTER_OFFSET_PX, HeaderError, image_center, parse_header

SCALE = 6.15 / 3600  # deg per pixel
ANGLE = math.radians(37.0)
PC = {
    "PC1_1": -SCALE * math.cos(ANGLE), "PC1_2": SCALE * math.sin(ANGLE),
    "PC2_1": SCALE * math.sin(ANGLE), "PC2_2": SCALE * math.cos(ANGLE),
}


def _block(cards: list[str]) -> str:
    text = "".join(c.ljust(80)[:80] for c in cards + ["END"])
    return text + " " * (-len(text) % 2880)


def _image(crpix1: float = 1020.5, crpix2: float = 1020.5) -> str:
    return _block([
        "XTENSION= 'IMAGE   '           / Image extension",
        "DETECTOR=                    6 / detector",
        "OBSID   = '2026W40_2A_0002_3'",
        "DATE-OBS= '2026-10-01T12:23:49.767'",
        "MJD-AVG =      61314.517214418",
        f"CRPIX1  = {crpix1:20}",
        f"CRPIX2  = {crpix2:20}",
        *[f"{k:<8}= {v:20.12E}" for k, v in PC.items()],
        "CDELT1  =                  1.0",
        "CDELT2  =                  1.0",
        "CRVAL1  =       299.93855089 / RA",
        "CRVAL2  =     -8.60068771256 / Dec",
    ])


PRIMARY = _block([
    "SIMPLE  =                    T",
    "NAXIS   =                    0",
    "DATE-OBS= '1999-01-01T00:00:00'",  # must be ignored: only IMAGE values count
])


def test_reads_image_header_not_primary():
    row = parse_header(PRIMARY + _image())
    assert row["date_obs"] == datetime(2026, 10, 1, 12, 23, 49, 767000, tzinfo=timezone.utc)
    assert row["detector"] == 6
    assert row["obsid"] == "2026W40_2A_0002_3"
    assert row["mjd_avg"] == 61314.517214418


def test_center_equals_crval_when_crpix_is_center():
    row = parse_header(PRIMARY + _image())
    assert row["ra_center"] == pytest.approx(299.93855089, abs=1e-9)
    assert row["dec_center"] == pytest.approx(-8.60068771256, abs=1e-9)


@pytest.mark.parametrize("crpix", [(1023.8, 1020.5), (1001.2, 1047.9)])
def test_center_matches_astropy_when_crpix_is_shifted(crpix):
    wcs_mod = pytest.importorskip("astropy.wcs")
    cards = {"CRPIX1": crpix[0], "CRPIX2": crpix[1], "CRVAL1": 299.93855089, "CRVAL2": -8.60068771256, **PC}
    w = wcs_mod.WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crpix = [cards["CRPIX1"], cards["CRPIX2"]]
    w.wcs.crval = [cards["CRVAL1"], cards["CRVAL2"]]
    w.wcs.pc = [[PC["PC1_1"], PC["PC1_2"]], [PC["PC2_1"], PC["PC2_2"]]]
    expected_ra, expected_dec = w.wcs_pix2world([[1020.5, 1020.5]], 1)[0]

    ra, dec = image_center({k: str(v) for k, v in cards.items()})
    assert ra == pytest.approx(expected_ra, abs=1e-8)
    assert dec == pytest.approx(expected_dec, abs=1e-8)


def test_truncated_header_raises():
    with pytest.raises(HeaderError, match="truncated"):
        parse_header((PRIMARY + _image())[: len(PRIMARY) + 400])


def test_missing_image_raises():
    with pytest.raises(HeaderError, match="IMAGE header not found"):
        parse_header(PRIMARY)


CENTER = 1020.5


# Real frames have CRPIX up to ~230 px off center; anything inside the image must be accepted.
@pytest.mark.parametrize("crpix", [(CENTER - 230, CENTER), (CENTER, CENTER + 230), (10.0, CENTER),
                                   (CENTER - MAX_CENTER_OFFSET_PX, CENTER + MAX_CENTER_OFFSET_PX)])
def test_reference_pixel_within_limit_is_accepted(crpix):
    row = parse_header(PRIMARY + _image(*crpix))
    assert -90 <= row["dec_center"] <= 90


@pytest.mark.parametrize("crpix", [(CENTER - MAX_CENTER_OFFSET_PX - 1, CENTER),
                                   (CENTER, CENTER + MAX_CENTER_OFFSET_PX + 1), (-500.0, 3000.0)])
def test_reference_pixel_beyond_limit_raises(crpix):
    with pytest.raises(HeaderError, match="too far"):
        parse_header(PRIMARY + _image(*crpix))