"""Aperture photometry on raw SPHEREx frame pixels (no reprojection) and spectral features of the result.

Per frame: aperture centre from the frame WCS -> sum inside the circle (fractional pixel coverage) minus the
sigma-clipped median of an annulus -> MJy/sr*px -> uJy through the solid angle of the pixel there.
Pixels that are NaN or carry a bad FLAGS bit are left out and counted.
Error: the larger of the VARIANCE error and the scatter of empty apertures of the same frame
(which also holds the faint-source background), plus 3% systematics in quadrature; flux < 3 sigma = upper limit.
Point sources get an aperture correction from a Gaussian PSF with the frame's PSF_FWHM ("aperture-corrected");
extended sources do not."""
import json
import math
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np
from astropy.stats import sigma_clipped_stats
from astropy.wcs import WCS

from .fits_s3 import _layer_cut, flags_location, flags_readable, image_header
from .spectral import wavelength

# FLAGS bits (from the MP_* keywords of the FLAGS header), in two tiers.
# BAD: no trustworthy value -> left out of the aperture and counted.
# WARN: value present but from a corrected ramp (cosmic-ray jump, saturation in later samples, nonlinearity):
#   kept, because on bright stars these bits cover the whole core (Barnard D6: TRANSIENT / OVERFLOW on the
#   central pixels with finite values up to ~1000 MJy/sr); counted and shown in the point's hint.
# Ignored: 12 FULLSAMPLE, 14 PHANMISS, 21 SOURCE (pixel of a known source, ~70% of all pixels).
# To be checked against the SPHEREx Explanatory Supplement.
# FLAGS bits (MP_* keys in l2b-v20..v25 headers, MSKN/MSKD keys from v27). Bits 20, 22-29 exist only from v27,
# 4 and 5 only before it. BLOOM is kept: it covers whole bright nebulae (42-49 of 49 pixels of the Orion Bar in
# v24 / v27, with the same values as v20 frames that lack the bit). Differences from IRSA: docs/notes.md.
BAD_BITS = {4: "PHANTOM", 5: "REFERENCE", 6: "NONFUNC", 9: "MISSING_DATA", 10: "HOT", 11: "COLD",
            17: "PERSIST", 19: "OUTLIER", 27: "SNOWBALL", 28: "HALO", 29: "SATELLITE_HALO"}
WARN_BITS = {0: "TRANSIENT", 1: "OVERFLOW", 2: "SUR_ERROR", 7: "DICHROIC", 15: "NONLINEAR",
             20: "CROSSTALK", 22: "GHOST", 23: "GHOST_FPA", 24: "GHOST_EXT", 25: "STREAK", 26: "BLOOM"}
BAD_MASK = sum(1 << b for b in BAD_BITS)
WARN_MASK = sum(1 << b for b in WARN_BITS)
SYSTEMATIC = 0.03
UJY_PER_MJY_SR_SR = 1e12          # 1 MJy/sr over 1 sr = 1e6 Jy
SUBPIX = 7                        # subsampling for fractional pixel coverage
EMPTY_MIN = 8                     # empty apertures needed for the empirical noise
STRIP_HALF_X = 300                # columns kept around the object for empty apertures (rows are read full width anyway)


# ---------- pure functions ----------

def coverage(shape: tuple[int, int], x: float, y: float, r: float, sub: int = SUBPIX) -> np.ndarray:
    """Fraction of every pixel (centres at integers) inside the circle of radius r around (x, y)."""
    out = np.zeros(shape, np.float32)
    y0, y1 = max(0, int(math.floor(y - r - 1))), min(shape[0] - 1, int(math.ceil(y + r + 1)))
    x0, x1 = max(0, int(math.floor(x - r - 1))), min(shape[1] - 1, int(math.ceil(x + r + 1)))
    if y0 > y1 or x0 > x1:
        return out
    o = (np.arange(sub) + 0.5) / sub - 0.5
    yy, xx = np.mgrid[y0:y1 + 1, x0:x1 + 1]
    sy = yy[..., None, None] + o[:, None] - y
    sx = xx[..., None, None] + o[None, :] - x
    out[y0:y1 + 1, x0:x1 + 1] = ((sx * sx + sy * sy) <= r * r).mean(axis=(-1, -2))
    return out


def annulus(shape: tuple[int, int], x: float, y: float, r_in: float, r_out: float) -> np.ndarray:
    yy, xx = np.mgrid[0:shape[0], 0:shape[1]]
    d2 = (xx - x) ** 2 + (yy - y) ** 2
    return (d2 >= r_in * r_in) & (d2 <= r_out * r_out)


def good_pixels(img: np.ndarray, var: np.ndarray | None, flags: np.ndarray | None) -> np.ndarray:
    good = np.isfinite(img)
    if var is not None:
        good &= np.isfinite(var) & (var > 0)
    if flags is not None:
        good &= (flags & BAD_MASK) == 0
    return good


@dataclass
class Aperture:
    flux: float          # MJy/sr * px, background removed
    sigma: float         # from VARIANCE and the background estimate
    n_bad: int           # pixels in the aperture left out (NaN or bad flag)
    background: float    # MJy/sr per pixel
    area: float          # pixels covered
    n_warn: int = 0      # pixels kept but flagged saturated / jump / nonlinear


def measure(img: np.ndarray, var: np.ndarray | None, flags: np.ndarray | None, x: float, y: float,
            r: float, r_in: float, r_out: float, background: float | None = None) -> Aperture | None:
    """Aperture sum minus the annulus median (or minus a given background, e.g. 0 after removing the zodiacal
    model); None if the annulus has too few good pixels."""
    good = good_pixels(img, var, flags)
    w = coverage(img.shape, x, y, r)
    inside = w > 0
    if background is None:
        ring = annulus(img.shape, x, y, r_in, r_out) & good
        if ring.sum() < 8:
            return None
        _, bg, bg_std = sigma_clipped_stats(img[ring], sigma=3)
    else:
        ring, bg, bg_std = None, float(background), 0.0
    use = inside & good
    flux = float(np.sum(w[use] * (img[use] - bg)))
    area = float(w[use].sum())
    var_sum = float(np.sum(w[use] ** 2 * var[use])) if var is not None else float(bg_std ** 2 * area)
    if ring is not None:
        var_sum += (area * bg_std) ** 2 * (math.pi / 2) / ring.sum()      # error of the median background
    n_warn = int((inside & good & ((flags & WARN_MASK) != 0)).sum()) if flags is not None else 0
    return Aperture(flux, math.sqrt(var_sum), int((inside & ~good).sum()), float(bg), area, n_warn)


def empty_scatter(img: np.ndarray, var: np.ndarray | None, flags: np.ndarray | None, x: float, y: float,
                  r: float, r_in: float, r_out: float, avoid: float) -> float | None:
    """Clipped scatter of aperture sums at empty places along the same rows of the cut (same r and annulus),
    away from the object: the real noise, faint background sources included. None if too few places."""
    sums = []
    step = 2 * r_out + 1
    for cx in np.arange(r_out + 1, img.shape[1] - r_out - 1, step):
        if abs(cx - x) < avoid:
            continue
        a = measure(img, var, flags, cx, y, r, r_in, r_out)
        if a is not None and a.n_bad == 0:
            sums.append(a.flux)
    if len(sums) < EMPTY_MIN:
        return None
    return float(sigma_clipped_stats(sums, sigma=3)[2])


def pixel_solid_angle(wcs: WCS, x: float, y: float) -> float:
    """Solid angle (sr) of the frame pixel at (x, y), from the local Jacobian of the WCS (SIP included)."""
    (ra0, ra1, ra2), (de0, de1, de2) = wcs.pixel_to_world_values(np.array([x, x + 1, x]), np.array([y, y, y + 1]))
    c = math.cos(math.radians(de0))
    ax, ay = ((ra1 - ra0 + 540) % 360 - 180) * c, de1 - de0
    bx, by = ((ra2 - ra0 + 540) % 360 - 180) * c, de2 - de0
    return abs(ax * by - ay * bx) * (math.pi / 180) ** 2


def gaussian_correction(fwhm_arcsec: float, r_px: float, pix_arcsec: float) -> float:
    """1 / (fraction of a Gaussian PSF, widened by the pixel box, inside radius r)."""
    s2 = (fwhm_arcsec / 2.3548 / pix_arcsec) ** 2 + 1 / 12
    return 1 / (1 - math.exp(-r_px * r_px / (2 * s2)))


CORRECTION_FILE = Path(__file__).resolve().parent / "data" / "aperture_correction.json"


@lru_cache(maxsize=1)
def _correction_table() -> tuple[float, dict]:
    """Empirical curve of growth per detector (demo/aperture_curve.py); empty if the file is missing."""
    try:
        d = json.loads(CORRECTION_FILE.read_text(encoding="utf-8"))
        return float(d["total_arcsec"]), {int(k): sorted((float(r), float(c)) for r, c in v.items())
                                          for k, v in d["detectors"].items()}
    except Exception:
        return 40.0, {}


def aperture_correction(fwhm_arcsec: float, r_px: float, pix_arcsec: float, detector: int | None = None) -> float:
    """Factor from the flux in radius r (production background annulus) to the total flux of a point source.
    Measured per detector, interpolated in log r; below the smallest measured radius the Gaussian shape is
    scaled to it, beyond the largest it falls to 1 at the 'total' radius. Gaussian if no table."""
    total, table = _correction_table()
    pts = table.get(detector) if detector else None
    if not pts:
        return gaussian_correction(fwhm_arcsec, r_px, pix_arcsec)
    r = r_px * pix_arcsec
    if r <= pts[0][0]:
        r0, c0 = pts[0]
        return c0 * gaussian_correction(fwhm_arcsec, r_px, pix_arcsec) / gaussian_correction(fwhm_arcsec, r0 / pix_arcsec, pix_arcsec)
    pts = pts + [(total, 1.0)] if pts[-1][0] < total else pts
    if r >= pts[-1][0]:
        return 1.0
    for (r0, c0), (r1, c1) in zip(pts, pts[1:]):
        if r0 <= r <= r1:
            t = math.log(r / r0) / math.log(r1 / r0)
            return max(1.0, c0 + t * (c1 - c0))
    return 1.0


# ---------- one frame ----------

def _cut(key: str, layer: str, x0: int, x1: int, y0: int, y1: int) -> np.ndarray:
    return np.array(_layer_cut(key, layer, x0, x1, y0, y1))


@lru_cache(maxsize=4096)
def frame_point(key: str, ra: float, dec: float, r_arcsec: float, point: bool, detector: int, date: str) -> dict | None:
    """Photometry of one frame at (ra, dec) in the frame's own pixels; None if outside the frame."""
    header, _ = image_header(key)
    wcs = WCS(header)
    ny, nx = header["NAXIS2"], header["NAXIS1"]
    x, y = (float(v) for v in wcs.world_to_pixel_values(ra, dec))
    omega = pixel_solid_angle(wcs, x, y)
    pix = math.degrees(math.sqrt(omega)) * 3600
    r = r_arcsec / pix
    r_in = max(4.0, r + 1.5)
    r_out = r_in + 2.0
    m = int(math.ceil(r_out)) + 1
    if not (m <= x < nx - m and m <= y < ny - m):
        return None
    y0, y1 = int(y) - m, int(y) + m + 1
    x0, x1 = max(0, int(x) - STRIP_HALF_X), min(nx - 1, int(x) + STRIP_HALF_X)
    img = _cut(key, "IMAGE", x0, x1, y0, y1)
    var = _cut(key, "VARIANCE", x0, x1, y0, y1)
    fh, _ = flags_location(key)
    flags = _cut(key, "FLAGS", x0, x1, y0, y1).astype(np.int64) if flags_readable(fh) else None
    lx, ly = x - x0, y - y0
    if point:
        a = measure(img, var, flags, lx, ly, r, r_in, r_out)
        emp = empty_scatter(img, var, flags, lx, ly, r, r_in, r_out, avoid=r_out + 3) if a else None
    else:   # an area of nebula: a ring around it would remove the nebula too, so the sky is the zodiacal model
        a = measure(img - _cut(key, "ZODI", x0, x1, y0, y1), var, flags, lx, ly, r, r_in, r_out, background=0.0)
        emp = None             # empty apertures inside a nebula measure its structure, not the noise
        if a is not None and a.area <= 0.5 * math.pi * r * r:
            return None                       # mostly bad pixels: nothing to fill the circle from
        if a is not None and a.area < math.pi * r * r - 0.01:
            k = math.pi * r * r / a.area      # pixels left out: mean surface brightness over the whole circle
            a = Aperture(a.flux * k, a.sigma * k, a.n_bad, a.background, a.area, a.n_warn)
    if a is None:
        return None
    fwhm = float(header.get("PSF_FWHM", 6.6))
    corr = aperture_correction(fwhm, r, pix, detector) if point else 1.0
    to_ujy = omega * UJY_PER_MJY_SR_SR * corr
    flux = a.flux * to_ujy
    stat = max(a.sigma, emp or 0.0) * to_ujy
    err = math.hypot(stat, SYSTEMATIC * flux)
    lam, bw = wavelength(key, x, y)
    return {"detector": detector, "date": date,
            "lambda_um": round(lam, 4), "band_um": round(bw, 4),
            "flux_ujy": round(flux, 3), "err_ujy": round(err, 3),
            "err_variance_ujy": round(a.sigma * to_ujy, 3), "err_empty_ujy": None if emp is None else round(emp * to_ujy, 3),
            "upper_limit": bool(flux < 3 * err), "limit_ujy": round(max(flux, 0) + 3 * err, 3) if flux < 3 * err else None,
            "n_bad_pixels": a.n_bad, "n_warn_pixels": a.n_warn, "flags_used": flags is not None, "aperture_corr": round(corr, 4),
            "sky": "annulus" if point else "zodi",
            "radius_px": round(r, 3), "x": round(x, 2), "y": round(y, 2), "path": key}


# ---------- spectral features ----------

FEATURES = (   # name, wavelength (um), half-width of its window (um), kind
    ("Paα hydrogen", 1.875, 0.02, "emission"), ("Brγ hydrogen", 2.166, 0.02, "emission"),
    ("H₂O ice", 3.05, 0.15, "absorption"), ("PAH", 3.29, 0.05, "emission"), ("CH₄", 3.30, 0.06, "absorption"),
    ("Brα hydrogen", 4.052, 0.02, "emission"), ("CO₂ ice", 4.27, 0.03, "absorption"), ("CO ice", 4.67, 0.03, "absorption"),
)
SKY_LINES = (0.78, 0.84, 0.93, 1.083, 1.13, 1.81, 2.63, 2.75, 4.03, 4.64)   # sky / instrument, left out
SKY_HALF = 0.012
CONT_WINDOW = 0.10            # dex in wavelength around a point for its continuum
MIN_RUN, MIN_SIGMA = 3, 3.0
SPARSE_SIGMA = 5.0          # when one visit samples a feature with fewer than MIN_RUN measurements


def _near_sky(lam: float, bw: float) -> bool:
    """Band covers a sky line, and the measurement is closer to it than to any feature (Bra 4.052 is 0.022 um
    from the 4.03 sky line, less than one band: the measurement centred on Bra must stay)."""
    feat = min(abs(lam - c) for _, c, _, _ in FEATURES)
    return any(abs(lam - s) <= SKY_HALF + bw / 2 and abs(lam - s) < feat for s in SKY_LINES)


def core_extra(hw: float) -> float:
    """How far beyond a band's half-width a feature still reaches it: hydrogen lines (window 0.02 um) are much
    narrower than a band, so none; the broad PAH / ice bands reach by half their window."""
    return hw / 2 if hw > 0.02 else 0.0


def find_features(points: list[dict]) -> list[dict]:
    """Features seen in >= 3 adjacent measurements (sorted by wavelength) at >= 3 sigma from the continuum.
    Each frame sees the object at its own wavelength, so a line wider than nothing but narrower than a band still
    shows in every measurement whose band covers it. Continuum: a power law fitted to the measurements within
    +-0.1 dex on both sides outside this feature's window and sky lines. Significance counts both the errors and
    the scatter of the neighbours around the continuum. If one visit puts fewer than 3 measurements on the feature,
    each one whose band covers its centre must stand out at >= 5 sigma. Returns [{name, lambda_um, kind, sigma, n, tau?}]."""
    # a point source with bad pixels in the aperture (a saturated core) has a wrong flux: no features from it
    pts = sorted((p for p in points if not p.get("upper_limit") and p.get("flux_ujy", 0) > 0 and p.get("err_ujy", 0) > 0
                  and not (p.get("sky", "annulus") == "annulus" and p.get("n_bad_pixels"))
                  and not _near_sky(p["lambda_um"], p["band_um"])), key=lambda p: p["lambda_um"])
    if len(pts) < 6:
        return []
    lam = np.array([p["lambda_um"] for p in pts])
    bw = np.array([p["band_um"] for p in pts])
    f = np.array([p["flux_ujy"] for p in pts])
    e = np.array([p["err_ujy"] for p in pts])
    loglam, logf = np.log10(lam), np.log10(f)

    def continuum(i: int, mask: np.ndarray) -> tuple[float, float]:
        """Local power law at point i through unmasked neighbours within CONT_WINDOW on both sides (a star's slope
        is steep, a median would be biased), with one clipping pass; and the relative scatter of the neighbours
        around it (calibration systematics, often well above the per-point errors). NaN if one side is empty."""
        near = (np.abs(loglam - loglam[i]) <= CONT_WINDOW) & mask
        if near.sum() < 4 or not (loglam[near] < loglam[i]).any() or not (loglam[near] > loglam[i]).any():
            return math.nan, 0.0
        xs, ys = loglam[near], logf[near]
        keep = np.ones(len(xs), bool)
        for _ in range(2):
            k, c0 = np.polyfit(xs[keep], ys[keep], 1)
            res = ys - (k * xs + c0)
            mad = 1.4826 * np.median(np.abs(res[keep] - np.median(res[keep])))
            keep = np.abs(res) <= max(3 * mad, 1e-3)
            if keep.sum() < 3:
                keep[:] = True
                break
        k, c0 = np.polyfit(xs[keep], ys[keep], 1)
        res = ys[keep] - (k * xs[keep] + c0)
        return 10 ** (k * loglam[i] + c0), math.log(10) * 1.4826 * float(np.median(np.abs(res - np.median(res))))

    out = []
    for name, c, hw, kind in FEATURES:
        # continuum for this feature: everything outside its own window and the windows of features at the same
        # place (PAH / CH4); other features nearby (the wide 3.05 um ice band next to PAH) are left to the clipping
        mask = np.ones(len(pts), bool)
        for _, c2, hw2, _ in FEATURES:
            if abs(c2 - c) <= hw + hw2:
                mask &= np.abs(lam - c2) > hw2 + bw / 2
        idx = np.where(np.abs(lam - c) <= hw + bw / 2)[0]
        if not len(idx):
            continue
        cs = [continuum(i, mask) for i in idx]
        cont = np.full(len(pts), np.nan); scat = np.zeros(len(pts))
        cont[idx] = [x[0] for x in cs]; scat[idx] = [x[1] for x in cs]
        idx = idx[np.isfinite(cont[idx])]
        if not len(idx):
            continue
        # One visit has ~1 measurement per 0.035 um at 3-5 um: a narrow line or the 3.3 um PAH band lands on 1-2 of
        # them. Then all of those must stand out at >= 5 sigma instead of 3 adjacent ones at >= 3 sigma.
        need, level = MIN_RUN, MIN_SIGMA
        if len(idx) < MIN_RUN:             # sparse: only the measurements whose band covers the feature's centre
            idx = idx[np.abs(lam[idx] - c) <= bw[idx] / 2 + core_extra(hw)]
            need, level = (len(idx) + 1) // 2, SPARSE_SIGMA     # at least half of them (band wings see less)
            if not need:
                continue
        dev = (f[idx] - cont[idx]) / np.hypot(e[idx], scat[idx] * cont[idx])
        sign = 1 if kind == "emission" else -1
        hit = sign * dev >= level
        run = best = 0
        for h in hit:                      # adjacent measurements
            run = run + 1 if h else 0
            best = max(best, run)
        if best < need:
            continue
        sig = float(sign * dev[hit].sum() / math.sqrt(hit.sum()))
        amp = float(np.median(f[idx][hit] / cont[idx][hit]))
        item = {"name": name, "lambda_um": c, "kind": kind, "sigma": round(sig, 1), "n": int(hit.sum()), "ratio": round(amp, 3)}
        if kind == "absorption":
            ratio = np.clip(f[idx][hit] / cont[idx][hit], 1e-3, None)
            item["tau"] = round(float(np.median(-np.log(ratio))), 3)
        out.append(item)
    # PAH (emission) and CH4 (absorption) share 3.3 um: keep the stronger one
    names = {o["name"] for o in out}
    if "PAH" in names and "CH₄" in names:
        out = [o for o in out if o["name"] != min(("PAH", "CH₄"), key=lambda n: next(x["sigma"] for x in out if x["name"] == n))]
    return out


# ---------- snapping a click to a source (on the picture shown: stack or resampled frame) ----------

def _smooth(a: np.ndarray, passes: int = 2) -> np.ndarray:
    """Binomial 1-2-1 smoothing (two passes: sigma ~1 px); NaN treated as the median."""
    a = np.where(np.isfinite(a), a, np.nanmedian(a))
    k = np.array([1, 2, 1], float) / 4
    for _ in range(passes):
        a = np.apply_along_axis(lambda r: np.convolve(r, k, mode="same"), 0, a)
        a = np.apply_along_axis(lambda r: np.convolve(r, k, mode="same"), 1, a)
    return a


def _centroid(img: np.ndarray, x: float, y: float, r: float = 1.5, iters: int = 5) -> tuple[float, float]:
    yy, xx = np.mgrid[0:img.shape[0], 0:img.shape[1]]
    for _ in range(iters):
        m = ((xx - x) ** 2 + (yy - y) ** 2 <= r * r) & np.isfinite(img)
        w = np.clip(img[m], 0, None)
        if w.sum() <= 0:
            break
        x, y = float((w * xx[m]).sum() / w.sum()), float((w * yy[m]).sum() / w.sum())
    return x, y


def _snr(img: np.ndarray, x: float, y: float, r: float, r_in: float, r_out: float) -> float:
    a = measure(img, None, None, x, y, r, r_in, r_out)
    return a.flux / a.sigma if a and a.sigma > 0 else 0.0


ELONG_BLEND = 1.8      # single stars reach 1.4-1.7 (undersampled PSF): 90th percentile of 4 fields < 1.8


def snap(img: np.ndarray, x: float, y: float, r: float, search: float = 2.0, snr_min: float = 5.0) -> dict:
    """Snap a click (x, y in grid pixels) to the brightest smoothed peak within `search` px, refined by a
    centroid, if its S/N after background removal is > snr_min; otherwise keep the click.
    Also reports other sources within 2 aperture radii and the elongation of the source (blend warning)."""
    r_in, r_out = max(4.0, r + 1.5), max(4.0, r + 1.5) + 2.0
    ring = annulus(img.shape, x, y, r_in, r_out) & np.isfinite(img)
    bg = float(np.median(img[ring])) if ring.sum() >= 8 else float(np.nanmedian(img))
    d = img - bg
    sm = _smooth(d)
    y0, y1 = max(0, int(y - search)), min(img.shape[0] - 1, int(math.ceil(y + search)))
    x0, x1 = max(0, int(x - search)), min(img.shape[1] - 1, int(math.ceil(x + search)))
    box = sm[y0:y1 + 1, x0:x1 + 1]
    py, px = np.unravel_index(int(np.argmax(box)), box.shape)
    cx, cy = _centroid(d, x0 + px, y0 + py)
    snr = _snr(img, cx, cy, r, r_in, r_out)
    snapped = snr > snr_min and math.hypot(cx - x, cy - y) <= search + 1
    if not snapped:
        cx, cy, snr = x, y, _snr(img, x, y, r, r_in, r_out)
    # other peaks within 2 radii (at least 3 px): local maxima of a lightly smoothed image (two passes would
    # merge stars 3 px apart) with S/N > snr_min
    reach = max(2 * r, 3.0)
    sm = _smooth(d, passes=1)
    peaks = []
    for j in range(max(1, int(cy - reach)), min(img.shape[0] - 1, int(cy + reach) + 1)):
        for i in range(max(1, int(cx - reach)), min(img.shape[1] - 1, int(cx + reach) + 1)):
            if math.hypot(i - cx, j - cy) < 1.5 or math.hypot(i - cx, j - cy) > reach:
                continue
            if sm[j, i] < sm[j - 1:j + 2, i - 1:i + 2].max():
                continue
            s = _snr(img, i, j, r, r_in, r_out)
            if s > snr_min:
                peaks.append({"x": float(i), "y": float(j), "snr": round(s, 1)})
    # elongation from second moments of the positive signal (only meaningful for a clear source)
    elong = 1.0
    if snr > 10:
        yy, xx = np.mgrid[0:img.shape[0], 0:img.shape[1]]
        m = ((xx - cx) ** 2 + (yy - cy) ** 2 <= 2.5 ** 2) & np.isfinite(d)
        w = np.clip(d[m], 0, None)
        if w.sum() > 0:
            dx, dy = xx[m] - cx, yy[m] - cy
            c = np.array([[np.sum(w * dx * dx), np.sum(w * dx * dy)], [np.sum(w * dx * dy), np.sum(w * dy * dy)]]) / w.sum()
            ev = np.sort(np.linalg.eigvalsh(c))
            if ev[0] > 0:
                elong = float(math.sqrt(ev[1] / ev[0]))
    return {"x": cx, "y": cy, "snapped": bool(snapped), "snr": round(float(snr), 1), "peaks": peaks,
            "elongation": round(elong, 2), "blend": bool(peaks) or elong > ELONG_BLEND}
