import math

import numpy as np
from astropy.wcs import WCS

from src.web.photometry import (BAD_MASK, WARN_MASK, aperture_correction, coverage, empty_scatter, find_features,
                                measure, pixel_solid_angle, snap)


def star(shape, x, y, flux, fwhm=1.6, bg=2.0, noise=0.0, seed=0):
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:shape[0], 0:shape[1]]
    s = fwhm / 2.3548
    img = bg + flux / (2 * math.pi * s * s) * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * s * s))
    return (img + rng.normal(0, noise, shape)).astype(np.float32) if noise else img.astype(np.float32)


def test_coverage_area_is_the_circle_area():
    w = coverage((41, 41), 20.3, 19.6, 3.7)
    assert abs(w.sum() - math.pi * 3.7 ** 2) / (math.pi * 3.7 ** 2) < 0.01


def test_aperture_recovers_a_star_above_the_background():
    img = star((41, 41), 20.2, 20.4, 1000.0)
    a = measure(img, np.full_like(img, 0.01), None, 20.2, 20.4, 6.0, 8.0, 11.0)
    assert abs(a.flux - 1000.0) < 5 and abs(a.background - 2.0) < 1e-3 and a.n_bad == 0


def test_fixed_background_skips_the_annulus():
    img = star((41, 41), 20, 20, 1000.0, bg=2.0) - 2.0          # sky already removed (zodiacal model)
    a = measure(img, np.full_like(img, 0.01), None, 20, 20, 15.0, 16.0, 18.0, background=0.0)
    assert a is not None and abs(a.flux - 1000.0) < 5 and a.background == 0.0


def test_bad_flags_and_nan_are_left_out_and_counted_warn_flags_kept():
    img = star((41, 41), 20, 20, 1000.0)
    flags = np.zeros(img.shape, np.int64)
    flags[20, 20] = 1 << 6            # NONFUNC: bad
    flags[20, 21] = 1 << 1            # OVERFLOW: kept, counted
    flags[19, 20] = 1 << 21           # SOURCE: ignored
    img[21, 20] = np.nan
    a = measure(img, np.full_like(img, 0.01), flags, 20, 20, 3.0, 8.0, 11.0)
    assert a.n_bad == 2 and a.n_warn == 1
    assert (1 << 6) & BAD_MASK and (1 << 1) & WARN_MASK and not (1 << 21) & (BAD_MASK | WARN_MASK)


def test_empty_apertures_measure_the_real_noise():
    img = star((15, 600), 300, 7, 0.0, noise=1.0)
    s = empty_scatter(img, None, None, 300, 7, 1.6, 4.0, 6.0, avoid=9)
    expected = math.sqrt(math.pi * 1.6 ** 2)            # pixel noise 1 over the aperture area
    assert s is not None and 0.75 * expected < s < 1.3 * expected


def test_solid_angle_of_a_nominal_pixel():
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [150.0, 20.0]
    w.wcs.crpix = [100, 100]
    w.wcs.cdelt = [-6.15 / 3600, 6.15 / 3600]
    omega = pixel_solid_angle(w, 99, 99)
    assert abs(omega - (6.15 / 206264.806) ** 2) / omega < 1e-3
    assert abs(omega * 1e12 - 889) < 3                  # uJy per MJy/sr per pixel


def test_aperture_correction_grows_for_small_apertures():
    big, small = aperture_correction(6.6, 4.0, 6.15), aperture_correction(6.6, 1.0, 6.15)
    assert 1.0 < big < small


def test_measured_correction_is_used_and_smooth():
    c10 = aperture_correction(6.6, 10 / 6.15, 6.15, 6)
    assert 1.1 < c10 < 1.5                                  # stars need ~1.2 at 10", the Gaussian says ~1.04
    assert aperture_correction(6.6, 10 / 6.15, 6.15) < 1.1  # no detector: Gaussian fallback
    rs = [3, 5, 8, 10, 14, 20, 30, 39, 45]
    cs = [aperture_correction(6.6, r / 6.15, 6.15, 3) for r in rs]
    assert all(a >= b for a, b in zip(cs, cs[1:])) and cs[-1] == 1.0


def test_snap_finds_a_nearby_star_and_ignores_empty_sky():
    img = star((41, 41), 21.4, 19.3, 400.0, noise=0.3, seed=1)
    s = snap(img, 20.0, 20.0, 1.6)
    assert s["snapped"] and math.hypot(s["x"] - 21.4, s["y"] - 19.3) < 0.3 and not s["blend"]
    empty = star((41, 41), 20, 20, 0.0, noise=0.3, seed=2)
    e = snap(empty, 20.0, 20.0, 1.6)
    assert not e["snapped"] and (e["x"], e["y"]) == (20.0, 20.0)


def test_two_close_stars_are_a_blend():
    img = star((41, 41), 20, 20, 500.0, noise=0.2, seed=3) + star((41, 41), 23, 20, 300.0, bg=0)
    s = snap(img, 20, 20, 1.6)
    assert s["blend"]


def _spectrum(dip_at=None, n_dip=3, depth=0.4, sky=False):
    lam = np.linspace(4.0, 4.9, 60)
    pts = [{"detector": 6, "lambda_um": float(l), "band_um": 0.04, "flux_ujy": 1000.0, "err_ujy": 20.0, "upper_limit": False}
           for l in lam]
    if dip_at:
        near = np.argsort(np.abs(lam - dip_at))[:n_dip]
        for k in near:
            pts[k]["flux_ujy"] *= 1 - depth
    return pts


def test_co2_absorption_in_three_adjacent_measurements_is_found():
    f = find_features(_spectrum(4.27, n_dip=3))
    assert [x["name"] for x in f] == ["CO₂ ice"] and f[0]["sigma"] > 3 and f[0]["tau"] > 0.3


def test_a_single_low_point_is_not_a_feature():
    assert find_features(_spectrum(4.27, n_dip=1)) == []


def test_sky_line_at_4_64_is_not_taken_for_co_ice():
    pts = _spectrum()
    for p in pts:                                     # a dip only at the 4.64 um sky / instrument line
        if abs(p["lambda_um"] - 4.64) < 0.03:
            p["flux_ujy"] *= 0.5
    assert all(x["name"] != "CO ice" for x in find_features(pts))


def test_a_narrow_line_on_one_measurement_needs_5_sigma():
    lam = np.arange(3.8, 4.4, 0.035)                     # one visit: ~1 measurement per resolution element
    pts = [{"detector": 5, "lambda_um": float(l), "band_um": 0.035, "flux_ujy": 1000.0, "err_ujy": 30.0, "upper_limit": False}
           for l in lam]
    k = int(np.argmin(np.abs(lam - 4.052)))
    pts[k]["flux_ujy"] = 1120.0                           # +4 sigma: not enough alone
    assert find_features(pts) == []
    pts[k]["flux_ujy"] = 3000.0
    f = find_features(pts)
    assert [x["name"] for x in f] == ["Brα hydrogen"] and f[0]["n"] >= 1


def test_a_steep_star_with_calibration_scatter_has_no_features():
    rng = np.random.default_rng(5)
    lam = np.sort(np.concatenate([np.arange(0.75, 3.8, 0.04), np.arange(3.82, 5.0, 0.035)]))
    pts = [{"detector": 1 + min(5, int(np.searchsorted([1.1, 1.62, 2.42, 3.82, 4.42], l))), "lambda_um": float(l),
            "band_um": float(l) / 60, "flux_ujy": float(1e6 * l ** -2.5 * (1 + rng.normal(0, 0.08))), "err_ujy": float(3e4 * l ** -2.5),
            "upper_limit": False} for l in lam]          # 8 % scatter, errors claim 3 %
    assert find_features(pts) == []


def test_v27_artifact_bits_are_classified():
    for bit in (27, 28, 29):                         # snowball, halo, satellite halo: left out
        assert (1 << bit) & BAD_MASK
    for bit in (20, 22, 23, 24, 25, 26):             # crosstalk, ghosts, streak, bloom: kept and counted
        assert (1 << bit) & WARN_MASK and not (1 << bit) & BAD_MASK


def test_row_tiled_flags_are_decoded():
    from astropy.io import fits
    from src.web import fits_s3
    rng = np.random.default_rng(0)
    flags = (rng.integers(0, 4, (6, 40)) << 20).astype(np.int32)       # bits 20-21, like SOURCE
    hdu = fits.CompImageHDU(flags, compression_type="RICE_1", tile_shape=(1, 40), name="FLAGS")
    hdul = fits.HDUList([fits.PrimaryHDU(), hdu])
    import io
    buf = io.BytesIO(); hdul.writeto(buf); raw = buf.getvalue()
    header = fits.Header.fromstring(raw[2880:2880 * 2].decode("latin-1"))
    start = 2880 * 2
    assert fits_s3.flags_readable(header)
    orig = fits_s3.read_range
    fits_s3.read_range = lambda key, a, b: raw[a:b + 1]
    try:
        rows = fits_s3._read_rows("x", header, start, 2, 4)
    finally:
        fits_s3.read_range = orig
    assert rows.dtype == np.int32 and (rows == flags[2:5]).all()
