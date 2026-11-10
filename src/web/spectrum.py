"""Spectrum of one point or area: aperture photometry on every frame of a detector in a time window,
and the proper motion of the object from Gaia DR3 (IRSA TAP, cached on disk) for comparing visits."""
import csv
import io
import json
import math
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from functools import lru_cache
from pathlib import Path

from .catalog import find_in_window
from .config import S3_WORKERS
from .photometry import frame_point

_pool = ThreadPoolExecutor(S3_WORKERS)
IRSA_TAP = "https://irsa.ipac.caltech.edu/TAP/sync"
GAIA_CACHE = Path(__file__).resolve().parents[2] / "cache" / "gaia_pm.json"
GAIA_EPOCH = 2016.0
FAST_PM_MAS = 100        # slower stars move < 1" in 10 years: treated as fixed
GAIA_MATCH_ARCSEC = 4.0
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
    """Fast-moving Gaia DR3 star (> 100 mas/yr) whose position at `when` is within 4" of (ra, dec).
    Returns {found, source_id, pm_ra, pm_dec, g, separation} or {found: False}; {error} if IRSA did not answer."""
    key = f"{ra:.4f},{dec:.4f}"
    with _lock:
        cache = _load_cache()
    if key in cache:
        return cache[key]
    q = ("SELECT source_id, ra, dec, pmra, pmdec, phot_g_mean_mag FROM gaia_dr3_source "
         f"WHERE CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra}, {dec}, {150 / 3600}))=1 "
         f"AND pm > {FAST_PM_MAS}")
    data = urllib.parse.urlencode({"LANG": "ADQL", "FORMAT": "csv", "QUERY": q}).encode()
    try:
        text = urllib.request.urlopen(IRSA_TAP, data, timeout=timeout).read().decode("utf-8")
        rows = list(csv.reader(io.StringIO(text)))[1:]      # IRSA's JSON is a VOTable dump; CSV is plain
    except Exception as e:
        return {"found": False, "error": f"Gaia lookup failed: {e}"}
    best = None
    for row in rows:
        try:
            sid, gra, gdec, pmra, pmdec = row[0], *(float(v) for v in row[1:5])
            g = float(row[5]) if row[5] else None
        except (ValueError, IndexError):
            continue
        r, d = shift(gra, gdec, pmra, pmdec, year(when) - GAIA_EPOCH)
        sep = math.hypot((r - ra) * math.cos(math.radians(dec)), d - dec) * 3600
        if sep <= GAIA_MATCH_ARCSEC and (best is None or sep < best["separation"]):
            best = {"found": True, "source_id": str(sid), "pm_ra": pmra, "pm_dec": pmdec, "g": g, "separation": round(sep, 2)}
    out = best or {"found": False}
    with _lock:
        cache = _load_cache()
        cache[key] = out
        _save_cache(cache)
    return out
