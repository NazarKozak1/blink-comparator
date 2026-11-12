"""Spectrum of one point or area: aperture photometry on every frame of a detector in a time window,
and the proper motion of the object from Gaia DR3 (ESA archive, async; SIMBAD if Gaia has none or does not answer;
cached on disk) for comparing visits. IRSA is not reachable from the production server and is not used."""
import json
import math
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from functools import lru_cache
from pathlib import Path

from . import catalogs
from .catalog import find_in_window
from .config import S3_WORKERS
from .photometry import frame_point

_pool = ThreadPoolExecutor(S3_WORKERS)
GAIA_CACHE = Path(__file__).resolve().parents[2] / "cache" / "gaia_pm.json"
GAIA_EPOCH = 2016.0
FAST_PM_MAS = 100        # slower stars move < 1" in 10 years: treated as fixed
GAIA_MATCH_ARCSEC = 4.0
EMPTY_TTL_S = 86400     # "no fast star here" is asked again after a day
_lock = threading.Lock()


def year(t: datetime) -> float:
    return 2000.0 + (t.timestamp() - 946728000.0) / (365.25 * 86400)


def shift(ra: float, dec: float, pm_ra: float, pm_dec: float, dt_years: float) -> tuple[float, float]:
    """Move by a proper motion (mas/yr, pmRA includes cos Dec) over dt years."""
    dec2 = dec + pm_dec * dt_years / 3.6e6
    return ra + pm_ra * dt_years / 3.6e6 / math.cos(math.radians(dec)), dec2


@lru_cache(maxsize=256)
def detector_spectrum(ra: float, dec: float, radius_arcsec: float, t0: datetime, t1: datetime, detector: int,
                      point: bool, pm_ra: float = 0.0, pm_dec: float = 0.0, t_ref: datetime | None = None) -> dict:
    """All frames of one detector between t0 and t1 that contain the position (moved by the proper motion to each
    frame's date if given). ra / dec are expected rounded to 1" by the caller, so nearby clicks share the cache."""
    started = time.time()
    rows = find_in_window(ra, dec, detector, t0, t1)

    def one(row):
        path, d, _ = row
        r, de = (shift(ra, dec, pm_ra, pm_dec, year(d) - year(t_ref)) if t_ref and (pm_ra or pm_dec) else (ra, dec))
        try:
            return frame_point(path, r, de, radius_arcsec, point, detector, d.isoformat())
        except Exception as e:                 # one unreadable frame must not lose the detector
            print(f"spectrum: {path}: {e}")
            return None

    points = sorted((p for p in _pool.map(one, rows) if p), key=lambda p: p["lambda_um"])
    return {"detector": detector, "points": points, "candidates": len(rows), "seconds": round(time.time() - started, 2)}


# ---------- proper motion from Gaia DR3 ----------

def _load_cache() -> dict:
    try:
        return json.loads(GAIA_CACHE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_cache(c: dict):
    try:
        GAIA_CACHE.parent.mkdir(parents=True, exist_ok=True)
        GAIA_CACHE.write_text(json.dumps(c, indent=0), encoding="utf-8")
    except Exception as e:
        print(f"gaia cache not written: {e}")


def gaia_motion(ra: float, dec: float, when: datetime, timeout: float = 20.0) -> dict:
    """Fast-moving star (> 100 mas/yr) whose position at `when` is within 4" of (ra, dec): Gaia DR3 from the ESA
    archive, then SIMBAD when Gaia has none or does not answer (WISE 0855 is too faint for Gaia).
    Returns {found, source_id, pm_ra, pm_dec, g, separation[, catalog]} or {found: False}. A star found is cached for
    good; "none" only for EMPTY_TTL_S and only when both catalogs answered; a failed lookup is not cached."""
    key = f"{ra:.4f},{dec:.4f}"
    with _lock:
        cache = _load_cache()
    hit = cache.get(key)
    if hit and (hit.get("found") or time.time() - hit.get("t", 0) < EMPTY_TTL_S):
        return {k: v for k, v in hit.items() if k != "t"}
    failed = False
    try:
        out = catalogs.gaia_motion(ra, dec, when, 150, FAST_PM_MAS, GAIA_MATCH_ARCSEC, timeout)
    except Exception as e:
        print(f"motion {key}: Gaia ESA failed ({e}), trying SIMBAD")
        out, failed = {"found": False}, True
    if out.get("found"):
        print(f"motion {key}: Gaia DR3 {out['source_id']}, {math.hypot(out['pm_ra'], out['pm_dec']):.0f} mas/yr")
    else:
        if not failed:
            print(f"motion {key}: no fast star in Gaia DR3, trying SIMBAD")
        try:
            out = catalogs.simbad_motion(ra, dec, when, FAST_PM_MAS, GAIA_MATCH_ARCSEC)
            print(f"motion {key}: SIMBAD " + (f"{out['source_id']}, {math.hypot(out['pm_ra'], out['pm_dec']):.0f} mas/yr"
                                               if out.get("found") else "has none either"))
        except Exception as e:
            print(f"motion {key}: SIMBAD failed ({e})")
            failed = True
    if failed and not out.get("found"):
        return {"found": False}
    with _lock:
        cache = _load_cache()
        now = time.time()
        cache = {k: v for k, v in cache.items() if v.get("found") or now - v.get("t", 0) < EMPTY_TTL_S}
        cache[key] = out if out.get("found") else {**out, "t": round(now)}
        _save_cache(cache)
    return out
