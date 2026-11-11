"""
Demo site: enter coordinates -> SPHEREx frames covering them -> browse by date and spectral band,
frame by frame or as stacks per time window.

From the project root:
    pip install fastapi uvicorn
    uvicorn src.web.app:app --reload
    (without an activated venv: .venv/Scripts/python -m uvicorn src.web.app:app --reload)
Then open http://localhost:8000/ (new interface, static/app) or http://localhost:8000/legacy (old one).
"""
import math
import os
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Literal

from astropy.wcs import WCS
from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from .catalog import find_candidates, random_center
from .config import MAX_FRAMES, N_BANDS, PIXEL_ARCSEC, STACK_METHODS
from .fits_s3 import fetch_cutout, image_header
from .geometry import cutout_fits, parse_coord
from .image_processing import (Rendered, cutout_png, diff_png, grid_wcs, grid_world, half_size_px, resample,
                               significance, stack_png, subtract_background)
from .spectral import band_edges, band_of, wavelength
from .stacks import build_stack, stack_sigma
from . import catalogs, photometry, spectrum as spec
from .windows import WINDOW_KINDS, as_utc, split, spread_over_epochs
from . import warmup

STATIC = Path(__file__).parent / "static"
PNG_MAX_AGE = 86400

pool = ThreadPoolExecutor(16)


@asynccontextmanager
async def lifespan(_app):
    if os.getenv("SPHEREX_WARMUP", "1") != "0":   # presets: frame lists and first pictures, in the background
        warmup.start()
    yield


app = FastAPI(title="SPHEREx demo", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC), name="static")
Background = Literal["median", "zodi", "raw"]
Stretch = Literal["faint", "normal", "bright"]


# ---------- frame list ----------

def frame_info(path: str, coord, detector: int, half: int) -> dict | None:
    """Target pixel, cutout fit and spectral band of one frame; None if the target is outside."""
    header, _ = image_header(path)
    wcs = WCS(header)
    shape = header["NAXIS2"], header["NAXIS1"]
    x, y = (float(v) for v in wcs.world_to_pixel(coord))
    if not (0 <= x < shape[1] and 0 <= y < shape[0]):
        return None
    info = {"x": round(x, 2), "y": round(y, 2), "full": cutout_fits(wcs, shape, coord, half),
            "lambda_um": None, "bandwidth_um": None, "band": None, "global_band": None}
    try:
        lam, bw = wavelength(path, x, y)
    except Exception as e:   # frame stays usable without a band
        print(f"WCS-WAVE failed for {path}: {e}")
        return info
    band, global_band = band_of(detector, lam)
    info.update(lambda_um=round(lam, 4), bandwidth_um=round(bw, 4), band=band, global_band=global_band)
    return info


def _coord(coords: str):
    try:
        return parse_coord(coords)
    except Exception as e:
        raise HTTPException(400, f"cannot parse coords {coords!r}: {e}. "
                                 "Use 'RA Dec' in degrees ('270.0 66.56') or '08h55m10.8s -7d14m42.5s'")


@lru_cache(maxsize=64)
def scan_frames(coords: str, detector: int, size: float) -> tuple[float, float, tuple[dict, ...]]:
    """(ra, dec, frames containing the target, oldest first); shared by frames, windows and stacks."""
    coord = _coord(coords)
    rows = find_candidates(coord.ra.deg, coord.dec.deg, detector)
    rows = [rows[i] for i in spread_over_epochs([r[1] for r in rows], MAX_FRAMES)]   # every epoch kept
    half = half_size_px(size)
    infos = list(pool.map(lambda r: frame_info(r[0], coord, detector, half), rows))
    found = tuple({"path": path, "date_obs": date_obs.isoformat(), "obsid": obsid, **info}
                  for (path, date_obs, obsid), info in zip(rows, infos) if info)
    return coord.ra.deg, coord.dec.deg, found


def select_frames(coords: str, detector: int, size: float, full: bool, band: int | None = None,
                  start: datetime | None = None, end: datetime | None = None) -> list[dict]:
    """Frames after the cutout-fit, band and time filters."""
    _, _, found = scan_frames(coords, detector, size)
    out = []
    for f in found:
        if full and not f["full"]:
            continue
        if band and f["band"] != band:
            continue
        if start or end:
            t = datetime.fromisoformat(f["date_obs"])
            if (start and t < as_utc(start)) or (end and t > as_utc(end)):
                continue
        out.append(f)
    return out


# ---------- endpoints ----------

@app.get("/")
def index():
    return FileResponse(STATIC / "app" / "index.html")


@app.get("/legacy")
def legacy():
    """The first interface, kept for comparison."""
    return FileResponse(STATIC / "legacy.html")


@app.get("/api/warmup")
def warmup_status():
    """Progress of the preset warm-up started with the server (SPHEREX_WARMUP=0 turns it off)."""
    return warmup.STATUS


@app.get("/api/random")
def random_point(detector: int = Query(6, ge=1, le=6)):
    """A sky point with frames of this detector (centre of a random indexed frame)."""
    found = random_center(detector)
    if not found:
        raise HTTPException(503, "index sample was empty, try again")
    ra, dec = found
    return {"ra": ra, "dec": dec, "coords": f"{ra:.5f} {dec:.5f}"}


@app.get("/api/catalog")
def catalog(coords: str, size: float = Query(6.0, gt=0.5, le=60), date: datetime | None = None,
            wait: float = Query(0.0, ge=0, le=30)):
    """Known objects of the whole cutout: SIMBAD and Gaia DR3, asked once per field in the background and cached.
    Positions are moved to `date` (default now) by the proper motion. wait > 0 holds the answer until both catalogs
    are done or the time is up. status: loading (nothing yet) | partial (one catalog) | ready (both done or failed)."""
    coord = _coord(coords)
    half_deg = (half_size_px(size) + 0.5) * PIXEL_ARCSEC / 3600
    f = catalogs.get_field(coord.ra.deg, coord.dec.deg, half_deg * math.sqrt(2))
    if wait:
        f.done.wait(wait)
    when = as_utc(date) if date else datetime.now(timezone.utc)
    t = time.time()
    objs = catalogs.field_objects(f, when, half_deg)
    return {"status": f.status, "catalogs": dict(f.state), "seconds": dict(f.seconds), "ra": f.ra, "dec": f.dec,
            "radius_deg": round(f.r, 6), "date": when.isoformat(), "epoch_year": round(catalogs.year_of(when), 4),
            "n": len(objs), "merge_seconds": round(time.time() - t, 3), "objects": objs}


@app.get("/api/frames")
def frames(coords: str, detector: int = Query(6, ge=1, le=6),
           size: float = Query(6.0, gt=0.5, le=60), full: bool = True):
    """Frames that really contain the position (index match is by center distance only), oldest first.
    full=1: only frames where the whole size x size cutout lies inside; full=0: also cropped ones."""
    ra, dec, found = scan_frames(coords, detector, size)
    shown = select_frames(coords, detector, size, full)
    return {
        "ra": ra,
        "dec": dec,
        "detector": detector,
        "n_bands": N_BANDS,
        "band_edges_um": band_edges(detector),
        "hidden_cropped": len(found) - len(shown),
        "frames": shown,
    }


@app.get("/api/windows")
def windows(coords: str, detector: int = Query(6, ge=1, le=6), size: float = Query(6.0, gt=0.5, le=60),
            full: bool = True, band: int = Query(0, ge=0, le=N_BANDS),
            window: Literal[WINDOW_KINDS] = "epoch"):
    """Time windows (epochs or UTC days) over the selected frames; band=0 means all bands."""
    times = [datetime.fromisoformat(f["date_obs"]) for f in select_frames(coords, detector, size, full, band)]
    return {"window": window, "windows": [w.to_json() for w in split(times, window)]}


def _png_response(r: Rendered, **headers) -> Response:
    return Response(r.png, media_type="image/png",
                    headers={"Cache-Control": f"public, max-age={PNG_MAX_AGE}",
                             "X-Vmin": f"{r.vmin:.6g}", "X-Vmax": f"{r.vmax:.6g}",
                             **{k: str(v) for k, v in headers.items()}})


@lru_cache(maxsize=512)
def render(path: str, coords: str, size: float, smooth_px: float, label: str, scale: str = "sigma",
           holes: bool = False, vmin: float | None = None, vmax: float | None = None,
           bg: str = "median", bare: bool = False, stretch: str = "normal") -> Rendered:
    coord = parse_coord(coords)
    grid, shape = grid_wcs(coord, half_size_px(size))
    world = grid_world(grid, shape)
    block = fetch_cutout(path, coord, world, zodi=bg == "zodi" and scale == "mjy")
    if block is None:
        raise HTTPException(404, "position is outside this frame")
    return cutout_png(block, world, smooth_px, label, scale=scale, holes=holes, vmin=vmin, vmax=vmax,
                      bg=bg, marks=not bare, stretch=stretch)


@app.get("/api/frame.png")
def frame_png(path: str, coords: str, label: str = "",
              size: float = Query(6.0, gt=0.5, le=60), smooth: float = Query(0.8, ge=0, le=3),
              scale: Literal["sigma", "mjy"] = "sigma", holes: bool = False,
              vmin: float | None = None, vmax: float | None = None,
              bg: Background = "median", bare: bool = False, stretch: Stretch = "normal"):
    """One frame. scale=sigma: noise units (default, as before); scale=mjy: MJy/sr minus background,
    so vmin/vmax can be shared between pictures. Limits used are returned in X-Vmin / X-Vmax.
    bg (scale=mjy): median of the frame (default) | zodi (zodiacal light model, ZODI layer) | raw.
    bare=1: no caption bar and crosshair (the page draws its own).
    stretch (scale=mjy): faint | normal | bright - upper percentile and asinh softening of the contrast."""
    if not path.endswith(".fits") or ".." in path:
        raise HTTPException(400, "bad path")
    r = render(path, coords, size, smooth, label, scale, holes, vmin, vmax, bg, bare, stretch)
    return _png_response(r, **{"X-Scale": scale})


def _stack_label(start: datetime, end: datetime, detector: int, band: int, method: str, n: int) -> str:
    """ASCII only: the PNG font has no Cyrillic."""
    span = f"{start:%Y-%m-%d}" if start.date() == end.date() else f"{start:%Y-%m-%d}..{end:%Y-%m-%d}"
    return f"{span}  D{detector}  {f'b{band}' if band else 'all bands'}  {method}  N={n}"


@lru_cache(maxsize=256)
def render_stack(coords: str, detector: int, size: float, full: bool, start: datetime, end: datetime,
                 band: int, method: str, weights: bool, holes: bool, smooth_px: float,
                 vmin: float | None, vmax: float | None, bg: str = "median",
                 bare: bool = False, stretch: str = "normal") -> tuple[Rendered, int]:
    picked = select_frames(coords, detector, size, full, band, start, end)
    if not picked:
        raise HTTPException(404, "no frames in this window")
    result = build_stack(tuple(f["path"] for f in picked), coords, size, method, weights, bg)
    if not result.n_frames:
        raise HTTPException(404, "no frames in this window contain the target")
    label = _stack_label(as_utc(start), as_utc(end), detector, band, method, result.n_frames)
    return (stack_png(result.data, result.covered, label, smooth_px, holes, vmin, vmax, marks=not bare,
                      stretch=stretch),
            result.n_frames)


@app.get("/api/stack.png")
def stack(coords: str, start: datetime, end: datetime,
          detector: int = Query(6, ge=1, le=6), size: float = Query(6.0, gt=0.5, le=60), full: bool = True,
          band: int = Query(0, ge=0, le=N_BANDS), method: Literal[STACK_METHODS] = "minmax",
          weights: bool = True, holes: bool = False, smooth: float = Query(0.0, ge=0, le=3),
          vmin: float | None = None, vmax: float | None = None,
          bg: Background = "median", bare: bool = False, stretch: Stretch = "normal"):
    """Stack of the frames with start <= date_obs <= end (ISO, UTC if no zone), in MJy/sr.
    weights=1: each frame weighted by 1/VARIANCE. X-N-Frames: frames that went into the stack.
    bg: background removed from every frame before stacking (median | zodi | raw). bare=1: no caption.
    stretch: faint | normal | bright contrast."""
    if as_utc(end) < as_utc(start):
        raise HTTPException(400, "end is before start")
    r, n = render_stack(coords, detector, size, full, start, end, band, method, weights, holes, smooth, vmin, vmax,
                        bg, bare, stretch)
    return _png_response(r, **{"X-N-Frames": n})


@lru_cache(maxsize=128)
def render_diff(coords: str, detector: int, size: float, full: bool, a: tuple[datetime, datetime],
                b: tuple[datetime, datetime], band: int, method: str, bg: str, holes: bool, bare: bool,
                limit: float) -> tuple[Rendered, int, int, float, float]:
    stacks = []
    for start, end in (a, b):
        picked = select_frames(coords, detector, size, full, band, start, end)
        paths = tuple(f["path"] for f in picked)
        result = build_stack(paths, coords, size, method, True, bg) if paths else None
        if not result or not result.n_frames:
            raise HTTPException(404, f"no frames between {start:%Y-%m-%d} and {end:%Y-%m-%d}")
        stacks.append((result, stack_sigma(paths, coords, size, bg)))
    (ra, sa), (rb, sb) = stacks
    s, offset, scale = significance(ra.data, rb.data, sa, sb)
    label = f"{a[0]:%Y-%m-%d} -> {b[0]:%Y-%m-%d}  D{detector}  S=(B-A)/sigma  scale x{scale:.2f}"
    rendered = diff_png(s, ra.covered & rb.covered, holes, limit, marks=not bare, label=label)
    return rendered, ra.n_frames, rb.n_frames, offset, scale


@app.get("/api/diff.png")
def diff(coords: str, a_start: datetime, a_end: datetime, b_start: datetime, b_end: datetime,
         detector: int = Query(6, ge=1, le=6), size: float = Query(6.0, gt=0.5, le=60), full: bool = True,
         band: int = Query(0, ge=0, le=N_BANDS), method: Literal[STACK_METHODS] = "minmax",
         bg: Background = "median", holes: bool = False, bare: bool = False,
         limit: float = Query(5.0, gt=0, le=50)):
    """Stack B minus stack A as a significance map S = (B - A) / sqrt(sA^2 + sB^2), sigma from VARIANCE,
    calibrated on the image (median -> 0, robust scatter -> 1; X-S-Offset, X-S-Scale give the raw values).
    Grey = 0, white = S >= +limit (appeared), black = S <= -limit (vanished). The background is always
    removed: bg=raw falls back to the frame median."""
    a, b = (as_utc(a_start), as_utc(a_end)), (as_utc(b_start), as_utc(b_end))
    if a[1] < a[0] or b[1] < b[0]:
        raise HTTPException(400, "end is before start")
    r, na, nb, offset, scale = render_diff(coords, detector, size, full, a, b, band, method,
                                           "median" if bg == "raw" else bg, holes, bare, limit)
    return _png_response(r, **{"X-N-A": na, "X-N-B": nb, "X-S-Offset": f"{offset:.4g}",
                               "X-S-Scale": f"{scale:.4g}"})


# ---------- point details: snapping, spectrum, features ----------

def _shown_image(coords: str, detector: int, size: float, full: bool, kind: str, path: str | None,
                 start: datetime | None, end: datetime | None, band: int, method: str, bg: str):
    """Grid image (MJy/sr) of what the page shows: one frame, or the stack of a window."""
    coord = _coord(coords)
    grid, shape = grid_wcs(coord, half_size_px(size))
    world = grid_world(grid, shape)
    if kind == "frame":
        if not path or not path.endswith(".fits") or ".." in path:
            raise HTTPException(400, "bad path")
        block = fetch_cutout(path, coord, world)
        if block is None:
            raise HTTPException(404, "position is outside this frame")
        return grid, resample(block, world, subtract_background(block.data))
    if start is None or end is None:
        raise HTTPException(400, "start and end are needed for a stack")
    picked = select_frames(coords, detector, size, full, band, start, end)
    if not picked:
        raise HTTPException(404, "no frames in this window")
    return grid, build_stack(tuple(f["path"] for f in picked), coords, size, method, True,
                             "median" if bg == "raw" else bg).data


@app.get("/api/point")
def point(coords: str, ra: float, dec: float, kind: Literal["frame", "stack"] = "stack", path: str | None = None,
          start: datetime | None = None, end: datetime | None = None,
          detector: int = Query(6, ge=1, le=6), size: float = Query(6.0, gt=0.5, le=60), full: bool = True,
          band: int = Query(0, ge=0, le=N_BANDS), method: Literal[STACK_METHODS] = "minmax",
          bg: Background = "median", radius: float = Query(10.0, gt=1, le=600), snap: bool = True):
    """A click on the picture: snapped to the source within ~12" if its S/N > 5 (snap=0: exactly the click),
    with the S/N there and a blend warning (another source within 2 radii, or an elongated source)."""
    grid, img = _shown_image(coords, detector, size, full, kind, path, start, end, band, method, bg)
    x, y = (float(v) for v in grid.world_to_pixel_values(ra, dec))
    r_px = radius / PIXEL_ARCSEC
    res = photometry.snap(img, x, y, r_px, search=2.0 if snap else 0.0)
    if not snap:
        res.update(x=x, y=y, snapped=False)
    sra, sdec = (float(v) for v in grid.pixel_to_world_values(res["x"], res["y"]))
    peaks = [dict(p, ra=float(grid.pixel_to_world_values(p["x"], p["y"])[0]),
                  dec=float(grid.pixel_to_world_values(p["x"], p["y"])[1])) for p in res["peaks"]]
    return {"ra": sra, "dec": sdec, "snapped": res["snapped"], "snr": res["snr"], "blend": res["blend"],
            "n_sources": 1 + len(peaks), "peaks": peaks, "elongation": res["elongation"], "radius_arcsec": radius}


@app.get("/api/spectrum")
def spectrum_endpoint(ra: float, dec: float, start: datetime, end: datetime, detector: int = Query(..., ge=1, le=6),
                      radius: float = Query(10.0, gt=1, le=600), mode: Literal["point", "extended"] = "point",
                      pm_ra: float = 0.0, pm_dec: float = 0.0, t_ref: datetime | None = None):
    """Aperture photometry of every frame of one detector between start and end (raw frame pixels, no
    reprojection). Points: lambda_um, band_um, flux_ujy, err_ujy, upper_limit, n_bad_pixels, date. The page
    asks detector by detector, so the plot fills in gradually. Cached by position (1"), radius, window, detector."""
    t0, t1 = as_utc(start), as_utc(end)
    if t1 < t0:
        raise HTTPException(400, "end is before start")
    r_ra, r_dec = round(ra * 3600) / 3600, round(dec * 3600) / 3600
    return spec.detector_spectrum(r_ra, r_dec, round(radius, 1), t0, t1, detector, mode == "point",
                                  round(pm_ra, 1), round(pm_dec, 1), as_utc(t_ref) if t_ref else None)


@app.post("/api/features")
def features(body: dict = Body(...)):
    """Spectral features of the points sent ({points: [...]}) and warnings (variability within a visit)."""
    pts = body.get("points") or []
    found = photometry.find_features(pts)
    warnings = []
    by_det: dict = {}
    for p_ in pts:              # saturated / damaged cores would fake variability
        if not p_.get("upper_limit") and not p_.get("n_bad_pixels"):
            by_det.setdefault(p_.get("detector"), []).append(p_)
    for det, lst in by_det.items():        # same colour twice in one visit, differing by > 5 sigma
        lst.sort(key=lambda q: q["lambda_um"])
        for a, b in zip(lst, lst[1:]):
            if abs(a["lambda_um"] - b["lambda_um"]) < min(a["band_um"], b["band_um"]) / 4:
                if abs(a["flux_ujy"] - b["flux_ujy"]) > 5 * (a["err_ujy"] ** 2 + b["err_ujy"] ** 2) ** 0.5:
                    warnings.append({"kind": "variable", "detector": det,
                                     "text": f"Brightness changed within this visit (D{det}, {a['lambda_um']:.2f} µm)"})
                    break
    per_det: dict = {}
    for p_ in pts:
        per_det.setdefault(p_.get("detector"), []).append(p_)
    for det, lst in sorted(per_det.items(), key=lambda kv: kv[0] or 0):
        if any(q.get("sky") == "zodi" for q in lst):     # an area: missing pixels are filled by its mean
            continue
        bad = sorted(q.get("n_bad_pixels") or 0 for q in lst)
        if bad and bad[len(bad) // 2] > 0:
            warnings.append({"kind": "saturated", "detector": det,
                             "text": f"Saturated or damaged core in D{det}: flux there is a lower limit"})
    return {"features": found, "warnings": warnings}


@app.get("/api/motion")
def motion(ra: float, dec: float, date: datetime):
    """Proper motion of a fast star (> 100 mas/yr) at this position on this date: Gaia DR3 (ESA), else SIMBAD."""
    return spec.gaia_motion(round(ra, 4), round(dec, 4), as_utc(date))
