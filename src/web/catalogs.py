"""Known objects of a whole field: SIMBAD (Harvard mirror, sync TAP) and Gaia DR3 (ESA, async TAP only).

One background job per field (circle around the centre, radius = half the diagonal), started by the first request;
both catalogs are asked in parallel. Results are cached in memory and on disk (cache/catalog/). Positions are moved
by the proper motion to the requested date (SIMBAD 2000.0, Gaia 2016.0). IRSA is not reachable from the production
server and is not used here."""
import csv
import hashlib
import io
import json
import math
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict
from datetime import datetime
from pathlib import Path

SIMBAD_TAP = "https://simbad.harvard.edu/simbad/sim-tap/sync"
GAIA_TAP = "https://gea.esac.esa.int/tap-server/tap/async"    # async jobs: the only way from the production server
GAIA_SYNC = "https://gea.esac.esa.int/tap-server/tap/sync"     # answers in ~1 s elsewhere, 503 from the server
CACHE_DIR = Path(__file__).resolve().parents[2] / "cache" / "catalog"
UA = {"User-Agent": "spherex-viewer/1.0 (NASA Space Apps 2026)"}
SIMBAD_EPOCH, GAIA_EPOCH = 2000.0, 2016.0
SIMBAD_TIMEOUT = 15.0
GAIA_TIMEOUT = 120.0       # background job; the archive's async queue can hold a job for 40 s and more
GAIA_SYNC_TIMEOUT = 8.0
GAIA_RETRY_S = 60          # a failed Gaia query may be asked again (on request) after this long
GAIA_BUSY_S = 120          # after HTTP 429 (too many requests) nobody asks the archive for this long
CACHE_VERSION = 2          # 2: SIMBAD rows carry the K magnitude
MAX_ROWS = 5000
FAST_PM_MAS = 200          # stars faster than this are also looked for outside the field (they move into it)
FAST_MARGIN_DEG = {"simbad": 5 / 60, "gaia": 2 / 60}   # Barnard's star: 10.4"/yr -> 4.5' since 2000, 1.7' since 2016
EDGE_MARGIN_DEG = 0.1 / 60
MATCH_ARCSEC = 1.5         # a Gaia source this close to a SIMBAD object is the same object
GROUP_ARCSEC = 0.05        # SIMBAD records at the same position (a star and its planets) form one group

# SIMBAD object types (otype, current and older codes) in plain English; unknown codes are shown as they are.
OTYPES = {
    "*": "star", "**": "double star", "SB*": "spectroscopic binary star", "EB*": "eclipsing binary star",
    "V*": "variable star", "BY*": "variable star (spotted red dwarf)", "RS*": "variable star (active binary)",
    "Ro*": "variable star (rotating)", "Ir*": "variable star (irregular)", "Or*": "variable young star (Orion type)",
    "TT*": "young star (T Tauri)", "Ae*": "young star (Herbig Ae/Be)", "Y*O": "young star", "YSO": "young star",
    "Y*": "young star",   # base of the candidate code Y*?
    "Pl": "planet", "PM*": "high proper-motion star", "LM*": "low-mass star", "BD*": "brown dwarf",
    "WD*": "white dwarf", "RG*": "red giant", "C*": "carbon star", "Em*": "emission-line star", "Be*": "Be star",
    "Mi*": "variable star (Mira)", "LP*": "variable star (long period)", "RR*": "variable star (RR Lyrae)",
    "Ce*": "Cepheid variable star", "dS*": "variable star (delta Scuti)", "Pu*": "pulsating variable star",
    "HH": "Herbig-Haro object (jet of a young star)", "G": "galaxy", "GiG": "galaxy in a group",
    "GiC": "galaxy in a cluster", "EmG": "emission-line galaxy", "SBG": "starburst galaxy", "AGN": "active galaxy",
    "Sy1": "Seyfert galaxy", "Sy2": "Seyfert galaxy", "QSO": "quasar", "ClG": "galaxy cluster",
    "Cl*": "star cluster", "OpC": "open star cluster", "GlC": "globular star cluster",
    "Rad": "radio source", "X": "X-ray source", "UV": "ultraviolet source", "IR": "infrared source",
    "NIR": "near-infrared source", "MIR": "mid-infrared source", "FIR": "far-infrared source",
    "mm": "millimetre source", "smm": "submillimetre source", "gam": "gamma-ray source", "Mas": "maser",
    "cor": "dense gas core", "MoC": "molecular cloud", "PoC": "part of a cloud", "HII": "ionised hydrogen region",
    "ISM": "interstellar matter", "DNe": "dark nebula", "RNe": "reflection nebula", "PN": "planetary nebula",
    "SNR": "supernova remnant", "Psr": "pulsar", "reg": "region of the sky", "?": "unclassified object",
    "err": "probably not a real object",
}
GAIA_TYPE = "Gaia source"


def otype_name(code: str) -> str:
    code = (code or "").strip()
    if not code:
        return OTYPES["?"]
    if code in OTYPES:
        return OTYPES[code]
    if code.endswith("?") and code[:-1] in OTYPES:          # e.g. Y*? = young star candidate
        return OTYPES[code[:-1]] + " (candidate)"
    if code.endswith("?") and code[:-1] + "*" in OTYPES:    # e.g. BD? -> BD*
        return OTYPES[code[:-1] + "*"] + " (candidate)"
    return code


def clean_name(name: str) -> str:
    name = re.sub(r"\s+", " ", name.strip())
    return name[5:] if name.startswith("NAME ") else name


# ---------- proper motion ----------

def year_of(t: datetime) -> float:
    return 2000.0 + (t.timestamp() - 946728000.0) / (365.25 * 86400)


def move(ra: float, dec: float, pmra: float | None, pmdec: float | None, epoch: float, to_year: float):
    """Linear proper motion (mas/yr, pmRA includes cos Dec) from epoch to to_year."""
    if not pmra and not pmdec:
        return ra, dec
    dt = to_year - epoch
    return (ra + (pmra or 0) * dt / 3.6e6 / math.cos(math.radians(dec))) % 360, dec + (pmdec or 0) * dt / 3.6e6


def sep_arcsec(ra1: float, dec1: float, ra2: float, dec2: float) -> float:
    """Small-angle separation in arcsec."""
    dra = ((ra1 - ra2 + 180) % 360 - 180) * math.cos(math.radians((dec1 + dec2) / 2))
    return math.hypot(dra, dec1 - dec2) * 3600


# ---------- TAP queries ----------

def _f(v: str):
    try:
        return float(v) if v not in ("", None) else None
    except ValueError:
        return None


def _csv(text: str) -> list[dict]:
    # an archive in maintenance answers 200 with an HTML page: an error, not rows
    if text.lstrip()[:1] == "<":
        raise ValueError("HTML page instead of CSV (archive down?)")
    return list(csv.DictReader(io.StringIO(text)))


def _cone(ra, dec, r, fast_r, pm_cond) -> str:
    return (f"(CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra}, {dec}, {r}))=1 OR "
            f"(CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra}, {dec}, {fast_r}))=1 AND {pm_cond}))")


def query_simbad(ra: float, dec: float, r: float, timeout: float = SIMBAD_TIMEOUT) -> list[dict]:
    pm = f"pmra*pmra + pmdec*pmdec > {FAST_PM_MAS ** 2}"
    q = (f"SELECT TOP {MAX_ROWS} main_id, ra, dec, otype, pmra, pmdec, V, K FROM basic "
         f"LEFT JOIN allfluxes ON oid = oidref WHERE ra IS NOT NULL AND "
         + _cone(ra, dec, r + EDGE_MARGIN_DEG, r + FAST_MARGIN_DEG["simbad"], pm))
    data = urllib.parse.urlencode({"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": q}).encode()
    text = urllib.request.urlopen(urllib.request.Request(SIMBAD_TAP, data, UA), timeout=timeout).read().decode("utf-8")
    out = []
    for row in _csv(text):
        r_, d_ = _f(row["ra"]), _f(row["dec"])
        if r_ is None or d_ is None:
            continue
        out.append({"name": clean_name(row["main_id"]), "ra": r_, "dec": d_, "otype": (row.get("otype") or "").strip(),
                    "pmra": _f(row.get("pmra")), "pmdec": _f(row.get("pmdec")), "v": _f(row.get("V")),
                    "k": _f(row.get("K"))})
    return out


class GaiaBusy(Exception):
    """The ESA archive answered 429 (too many requests from this address)."""


_gaia_slot = threading.Semaphore(1)       # one job at the archive at a time from this server
_gaia_busy_until = 0.0


def _abort(job: str):
    try:
        data = urllib.parse.urlencode({"PHASE": "ABORT"}).encode()
        urllib.request.urlopen(urllib.request.Request(job + "/phase", data, UA), timeout=5).read()
    except Exception:
        pass                               # best effort: the archive drops old jobs itself


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def gaia_query(query: str, timeout: float = GAIA_TIMEOUT) -> list[dict]:
    """The sync endpoint first (fast where it works), then an async job for the rest of the time."""
    t = time.time()
    if time.time() >= _gaia_busy_until:
        try:
            data = urllib.parse.urlencode({"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": query}).encode()
            text = urllib.request.urlopen(urllib.request.Request(GAIA_SYNC, data, UA),
                                          timeout=min(GAIA_SYNC_TIMEOUT, timeout)).read().decode("utf-8")
            return _csv(text)
        except Exception as e:
            print(f"gaia sync failed ({e}), trying an async job")
    return gaia_async(query, max(5.0, timeout - (time.time() - t)))


def gaia_async(query: str, timeout: float = GAIA_TIMEOUT) -> list[dict]:
    """Run an ADQL query on the ESA Gaia archive as an async job, one at a time from this server; TimeoutError if it
    is not done in time (the job is then aborted, so it does not hold the archive's quota), GaiaBusy after a 429."""
    global _gaia_busy_until
    end = time.time() + timeout
    if time.time() < _gaia_busy_until:
        raise GaiaBusy("Gaia archive asked to wait")
    if not _gaia_slot.acquire(timeout=timeout):
        raise TimeoutError("another Gaia job is still running")
    try:
        return _gaia_job(query, end)
    except urllib.error.HTTPError as e:
        if e.code == 429:
            _gaia_busy_until = time.time() + GAIA_BUSY_S
            raise GaiaBusy("HTTP 429 from the Gaia archive") from e
        raise
    finally:
        _gaia_slot.release()


def _gaia_job(query: str, end: float) -> list[dict]:
    timeout = max(1.0, end - time.time())
    data = urllib.parse.urlencode({"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "PHASE": "RUN",
                                   "QUERY": query}).encode()
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        resp = opener.open(urllib.request.Request(GAIA_TAP, data, UA), timeout=min(15, timeout))
        job = resp.headers.get("Location") or resp.geturl()
    except urllib.error.HTTPError as e:          # 303 See Other -> the job URL
        if e.code not in (302, 303):
            raise
        job = e.headers["Location"]
    delay = 0.3
    try:
        while True:
            left = end - time.time()
            if left <= 0:
                raise TimeoutError("Gaia job not finished in time")
            phase = urllib.request.urlopen(urllib.request.Request(job + "/phase", headers=UA), timeout=min(10, left)).read().decode().strip()
            if phase == "COMPLETED":
                break
            if phase in ("ERROR", "ABORTED"):
                raise RuntimeError(f"Gaia job {phase}")
            time.sleep(min(delay, max(0.05, end - time.time())))
            delay = min(delay * 1.5, 2.0)
        left = max(3.0, end - time.time())
        text = urllib.request.urlopen(urllib.request.Request(job + "/results/result", headers=UA), timeout=left).read().decode("utf-8")
    except BaseException:
        _abort(job)
        raise
    return _csv(text)


def query_gaia(ra: float, dec: float, r: float, timeout: float = GAIA_TIMEOUT) -> list[dict]:
    """One plain cone, wide enough for fast stars to move in since 2016 (an OR of two cones, as for SIMBAD, may not
    use the archive's sky index); the field filter drops the rest."""
    q = (f"SELECT TOP {MAX_ROWS} source_id, ra, dec, pmra, pmdec, phot_g_mean_mag FROM gaiadr3.gaia_source WHERE "
         f"1=CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra}, {dec}, {r + FAST_MARGIN_DEG['gaia']})) "
         "ORDER BY phot_g_mean_mag")              # a crowded wide field keeps its brightest MAX_ROWS
    out = []
    for row in gaia_query(q, timeout):
        r_, d_ = _f(row["ra"]), _f(row["dec"])
        if r_ is None or d_ is None:
            continue
        out.append({"name": "Gaia DR3 " + row["source_id"], "ra": r_, "dec": d_, "pmra": _f(row.get("pmra")),
                    "pmdec": _f(row.get("pmdec")), "g": _f(row.get("phot_g_mean_mag"))})
    return out


# ---------- grouping and merging ----------

def group_simbad(rows: list[dict]) -> list[dict]:
    """Records at one position become one object: the main one first (not a planet, brightest, then by name),
    planets counted, other records kept as aliases."""
    groups: dict[tuple, list[dict]] = {}
    for r in rows:
        k = (round(r["ra"] * 3600 / GROUP_ARCSEC), round(r["dec"] * 3600 / GROUP_ARCSEC))
        groups.setdefault(k, []).append(r)
    out = []
    for g in groups.values():
        g.sort(key=lambda r: (r["otype"] == "Pl", r["v"] is None, r["v"] or 0, r["name"]))
        if main_k := next((r.get("k") for r in g if r.get("k") is not None and r["otype"] != "Pl"), None):
            g[0] = {**g[0], "k": g[0].get("k") if g[0].get("k") is not None else main_k}
        main, rest = g[0], g[1:]
        planets = sum(1 for r in rest if r["otype"] == "Pl")
        out.append({**main, "planets": planets, "also": [r["name"] for r in rest if r["otype"] != "Pl"]})
    return out


def merge(simbad: list[dict], gaia: list[dict], year: float) -> list[dict]:
    """Objects at `year`: SIMBAD groups, then Gaia sources that match no SIMBAD object (a match adds G to it)."""
    objs = []
    cell: dict[tuple, list[int]] = {}
    for s in simbad:
        ra, dec = move(s["ra"], s["dec"], s["pmra"], s["pmdec"], SIMBAD_EPOCH, year)
        o = {"name": s["name"], "otype": s["otype"], "type": otype_name(s["otype"]), "ra": ra, "dec": dec,
             "pmra": s["pmra"], "pmdec": s["pmdec"], "v": s["v"], "k": s.get("k"), "g": None, "planets": s["planets"],
             "also": s["also"], "source": "SIMBAD"}
        cell.setdefault((int(ra * 3600 // 2), int(dec * 3600 // 2)), []).append(len(objs))
        objs.append(o)
    for gs in gaia:
        ra, dec = move(gs["ra"], gs["dec"], gs["pmra"], gs["pmdec"], GAIA_EPOCH, year)
        cx, cy = int(ra * 3600 // 2), int(dec * 3600 // 2)
        best, bd = None, MATCH_ARCSEC
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for i in cell.get((cx + dx, cy + dy), ()):
                    o = objs[i]
                    if o["source"] != "SIMBAD" or o["g"] is not None or o["otype"] == "Pl":
                        continue
                    d = sep_arcsec(ra, dec, o["ra"], o["dec"])
                    if d < bd:
                        best, bd = o, d
        if best is not None:
            best["g"] = gs["g"]; best["source"] = "SIMBAD + Gaia"
            if best["pmra"] is None:
                best["pmra"], best["pmdec"] = gs["pmra"], gs["pmdec"]
        else:
            objs.append({"name": gs["name"], "otype": "", "type": GAIA_TYPE, "ra": ra, "dec": dec, "pmra": gs["pmra"],
                         "pmdec": gs["pmdec"], "v": None, "k": None, "g": gs["g"], "planets": 0, "also": [], "source": "Gaia"})
    return objs


# ---------- field jobs ----------

class Field:
    def __init__(self, key: str, ra: float, dec: float, r: float):
        self.key, self.ra, self.dec, self.r = key, ra, dec, r
        self.simbad = self.gaia = None             # lists once loaded
        self.state = {"simbad": "loading", "gaia": "loading"}
        self.seconds = {}
        self.tried = {}                            # catalog -> time of the last attempt
        self.limited = {}                          # catalog -> True if it hit MAX_ROWS
        self.done = threading.Event()
        self.lock = threading.Lock()

    @property
    def status(self) -> str:
        s = self.state.values()
        if all(v != "loading" for v in s):
            return "ready"
        return "partial" if any(v == "ok" for v in s) else "loading"


_fields: "OrderedDict[str, Field]" = OrderedDict()
_flock = threading.Lock()
MEMORY_FIELDS = 64


def field_key(ra: float, dec: float, r: float) -> str:
    return f"{round(ra * 3600)}_{round(dec * 3600)}_{round(r * 60, 1)}"


def _disk(key: str) -> Path:
    return CACHE_DIR / (hashlib.sha1(key.encode()).hexdigest()[:16] + ".json")


def _save(f: Field):
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        body = {"key": f.key, "v": CACHE_VERSION, "simbad": f.simbad if f.state["simbad"] == "ok" else None,
                "gaia": f.gaia if f.state["gaia"] == "ok" else None, "saved": time.time()}
        _disk(f.key).write_text(json.dumps(body), encoding="utf-8")
    except Exception as e:
        print(f"catalog cache not written: {e}")


def _run(f: Field, name: str, fn):
    t = time.time()
    f.tried[name] = t
    try:
        rows = fn(f.ra, f.dec, f.r)
        f.limited[name] = len(rows) >= MAX_ROWS
        with f.lock:
            setattr(f, name, group_simbad(rows) if name == "simbad" else rows)
            f.state[name] = "ok"
    except TimeoutError:
        f.state[name] = "timeout"
    except GaiaBusy:
        f.state[name] = "busy"
    except Exception as e:
        print(f"catalog {name} failed for {f.key}: {e}")
        f.state[name] = "error"
    f.seconds[name] = round(time.time() - t, 2)
    if f.status == "ready":
        _save(f)
        f.done.set()


def get_field(ra: float, dec: float, r: float) -> Field:
    """The job of this field: from memory, from disk (a catalog missing there is asked again), or a new one."""
    key = field_key(ra, dec, r)
    with _flock:
        f = _fields.get(key)
        if f is not None:
            _fields.move_to_end(key)
            return f
        f = Field(key, round(ra * 3600) / 3600, round(dec * 3600) / 3600, r)
        _fields[key] = f
        while len(_fields) > MEMORY_FIELDS:
            _fields.popitem(last=False)
    todo = {"simbad": query_simbad, "gaia": query_gaia}
    try:
        body = json.loads(_disk(key).read_text(encoding="utf-8"))
        for name in ("simbad", "gaia"):
            if name == "simbad" and body.get("v", 1) < CACHE_VERSION:
                continue                           # older SIMBAD rows have no K: asked again
            if body.get(name) is not None:
                setattr(f, name, body[name]); f.state[name] = "ok"; f.seconds[name] = 0.0
                todo.pop(name)
    except FileNotFoundError:
        pass
    except Exception as e:
        print(f"catalog cache unreadable for {key}: {e}")
    if not todo:
        f.done.set()
    for name, fn in todo.items():
        threading.Thread(target=_run, args=(f, name, fn), daemon=True, name=f"catalog-{name}").start()
    return f


def retry_gaia(f: Field) -> bool:
    """Ask Gaia again for a field where it failed (timeout, error, busy), at most once per GAIA_RETRY_S."""
    with f.lock:
        if f.state["gaia"] in ("ok", "loading") or time.time() - f.tried.get("gaia", 0) < GAIA_RETRY_S:
            return False
        f.state["gaia"] = "loading"
        f.done.clear()
    threading.Thread(target=_run, args=(f, "gaia", query_gaia), daemon=True, name="catalog-gaia-retry").start()
    return True


def field_objects(f: Field, when: datetime, half_deg: float | None = None) -> list[dict]:
    """Objects of the field at a date; with half_deg only those inside the square cutout (+ one pixel)."""
    with f.lock:
        simbad, gaia = list(f.simbad or []), list(f.gaia or [])
    objs = merge(simbad, gaia, year_of(when))
    if half_deg is not None:
        cosd = math.cos(math.radians(f.dec))
        lim = half_deg + 6.15 / 3600
        objs = [o for o in objs if abs(((o["ra"] - f.ra + 180) % 360 - 180) * cosd) <= lim and abs(o["dec"] - f.dec) <= lim]
    for o in objs:
        o["ra"], o["dec"] = round(o["ra"], 7), round(o["dec"], 7)
    return objs


def gaia_motion(ra: float, dec: float, when: datetime, radius_arcsec: float = 150, fast_mas: float = 100,
                match_arcsec: float = 4.0, timeout: float = 20.0) -> dict:
    """Fastest-matching Gaia DR3 star (ESA async) moving faster than fast_mas, within match_arcsec at `when`."""
    q = ("SELECT source_id, ra, dec, pmra, pmdec, phot_g_mean_mag FROM gaiadr3.gaia_source "
         f"WHERE 1=CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra}, {dec}, {radius_arcsec / 3600})) AND pm > {fast_mas}")
    best = None
    for row in gaia_query(q, timeout):
        gra, gdec, pmra, pmdec = (_f(row[k]) for k in ("ra", "dec", "pmra", "pmdec"))
        if None in (gra, gdec, pmra, pmdec):
            continue
        r, d = move(gra, gdec, pmra, pmdec, GAIA_EPOCH, year_of(when))
        sep = sep_arcsec(r, d, ra, dec)
        if sep <= match_arcsec and (best is None or sep < best["separation"]):
            best = {"found": True, "source_id": row["source_id"], "pm_ra": pmra, "pm_dec": pmdec,
                    "g": _f(row.get("phot_g_mean_mag")), "separation": round(sep, 2)}
    return best or {"found": False}


def simbad_motion(ra: float, dec: float, when: datetime, fast_mas: float = 100, match_arcsec: float = 4.0) -> dict:
    """Same as gaia_motion from SIMBAD (proper motions of 2000.0), used when the Gaia archive does not answer."""
    best = None
    for row in query_simbad(ra, dec, 150 / 3600):
        if row["pmra"] is None or row["pmdec"] is None or math.hypot(row["pmra"], row["pmdec"]) <= fast_mas:
            continue
        r, d = move(row["ra"], row["dec"], row["pmra"], row["pmdec"], SIMBAD_EPOCH, year_of(when))
        sep = sep_arcsec(r, d, ra, dec)
        if sep <= match_arcsec and (best is None or sep < best["separation"]):
            best = {"found": True, "source_id": row["name"], "pm_ra": row["pmra"], "pm_dec": row["pmdec"],
                    "g": None, "separation": round(sep, 2), "catalog": "SIMBAD"}
    return best or {"found": False}
