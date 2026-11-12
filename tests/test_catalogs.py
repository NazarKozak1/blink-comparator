"""Field catalogs: proper-motion propagation, SIMBAD grouping, type names, SIMBAD x Gaia merge (no network)."""
from datetime import datetime, timezone

import pytest

from src.web import catalogs as C

# Barnard's star in SIMBAD (J2000 position, epoch 2000.0) and its 4 planets at the same position
BARNARD = dict(ra=269.4520769586187, dec=4.693364966576667, pmra=-801.551, pmdec=10362.394)


def rec(name, otype, v=None, **pos):
    return {"name": name, "otype": otype, "v": v, **(pos or BARNARD)}


def test_move_by_proper_motion():
    ra, dec = C.move(BARNARD["ra"], BARNARD["dec"], BARNARD["pmra"], BARNARD["pmdec"], 2000.0, 2025.6)
    assert dec - BARNARD["dec"] == pytest.approx(10362.394 * 25.6 / 3.6e6)          # 4.4' north in 25.6 yr
    assert (ra - BARNARD["ra"]) * 3600 * C.math.cos(C.math.radians(BARNARD["dec"])) == pytest.approx(-0.801551 * 25.6, rel=1e-6)
    back = C.move(ra, dec, BARNARD["pmra"], BARNARD["pmdec"], 2025.6, 2000.0)
    assert C.sep_arcsec(*back, BARNARD["ra"], BARNARD["dec"]) < 0.05


def test_move_without_motion_and_across_zero_ra():
    assert C.move(10.0, 20.0, None, None, 2000.0, 2030.0) == (10.0, 20.0)
    ra, _ = C.move(0.00001, 0.0, -1000.0, 0.0, 2000.0, 2010.0)   # 10" west of RA 0 -> just below 360
    assert 359.99 < ra < 360.0


def test_field_date_moves_barnard_into_the_field():
    """The SIMBAD position (2000) is 4.4' south of the 2025 field centre used by the page."""
    when = datetime(2025, 8, 20, tzinfo=timezone.utc)
    ra, dec = C.move(BARNARD["ra"], BARNARD["dec"], BARNARD["pmra"], BARNARD["pmdec"], C.SIMBAD_EPOCH, C.year_of(when))
    centre = (269.44625, 4.7675)                           # 17h57m47.1s +4d46m03s
    assert C.sep_arcsec(BARNARD["ra"], BARNARD["dec"], *centre) > 240
    assert C.sep_arcsec(ra, dec, *centre) < 6


def test_group_star_with_planets():
    rows = [rec("Barnard's Star c", "Pl"), rec("Barnard's Star e", "Pl"), rec("Barnard's star", "BY*", 9.511),
            rec("Barnard's Star b", "Pl"), rec("Barnard's Star d", "Pl"),
            rec("TYC 425-262-1", "SB*", 11.5, ra=269.4664581074621, dec=4.705611349569168, pmra=0.578, pmdec=-8.671)]
    g = C.group_simbad(rows)
    assert len(g) == 2
    main = next(o for o in g if o["otype"] == "BY*")
    assert main["name"] == "Barnard's star" and main["planets"] == 4 and main["also"] == []


def test_group_prefers_brighter_non_planet():
    pos = dict(ra=10.0, dec=10.0, pmra=None, pmdec=None)
    g = C.group_simbad([rec("faint", "X", None, **pos), rec("bright", "*", 5.0, **pos), rec("p", "Pl", None, **pos)])
    assert len(g) == 1 and g[0]["name"] == "bright" and g[0]["also"] == ["faint"] and g[0]["planets"] == 1


def test_type_names_and_clean_names():
    assert C.otype_name("BY*") == "variable star (spotted red dwarf)"
    assert C.otype_name("Pl") == "planet" and C.otype_name("G") == "galaxy" and C.otype_name("*") == "star"
    assert C.otype_name("YSO") == C.otype_name("Y*O") == "young star"
    assert C.otype_name("Y*?") == "young star (candidate)"
    assert C.otype_name("BD?") == "brown dwarf (candidate)"
    assert C.otype_name("Xyz") == "Xyz" and C.otype_name("") == "unclassified object"
    assert C.clean_name("NAME Barnard's star") == "Barnard's star"
    assert C.clean_name("TYC  425-262-1") == "TYC 425-262-1"


def test_merge_gaia_into_simbad():
    year = 2025.6
    simbad = C.group_simbad([rec("Barnard's star", "BY*", 9.511), rec("Barnard's Star b", "Pl")])
    # Gaia: Barnard at its 2016 position (same motion) and one unrelated faint source
    gra, gdec = C.move(BARNARD["ra"], BARNARD["dec"], BARNARD["pmra"], BARNARD["pmdec"], 2000.0, C.GAIA_EPOCH)
    gaia = [{"name": "Gaia DR3 4472832130942575872", "ra": gra, "dec": gdec, "pmra": BARNARD["pmra"],
             "pmdec": BARNARD["pmdec"], "g": 8.19},
            {"name": "Gaia DR3 1", "ra": 269.45, "dec": 4.70, "pmra": None, "pmdec": None, "g": 19.0}]
    objs = C.merge(simbad, gaia, year)
    assert len(objs) == 2
    b = next(o for o in objs if o["name"] == "Barnard's star")
    assert b["source"] == "SIMBAD + Gaia" and b["g"] == 8.19 and b["planets"] == 1
    other = next(o for o in objs if o["name"] == "Gaia DR3 1")
    assert other["source"] == "Gaia" and other["type"] == C.GAIA_TYPE


def test_field_job_without_gaia(monkeypatch, tmp_path):
    """Gaia timing out leaves the field ready with SIMBAD only; the result is cached on disk without Gaia."""
    monkeypatch.setattr(C, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(C, "_fields", C.OrderedDict())
    monkeypatch.setattr(C, "query_simbad", lambda ra, dec, r: [rec("Barnard's star", "BY*", 9.5), rec("Barnard's Star b", "Pl")])

    def no_gaia(ra, dec, r):
        raise TimeoutError("slow")
    monkeypatch.setattr(C, "query_gaia", no_gaia)
    f = C.get_field(269.44625, 4.7675, 0.03)
    assert f.done.wait(5)
    assert f.status == "ready" and f.state == {"simbad": "ok", "gaia": "timeout"}
    objs = C.field_objects(f, datetime(2025, 8, 20, tzinfo=timezone.utc), half_deg=0.02)
    assert [o["name"] for o in objs] == ["Barnard's star"] and objs[0]["planets"] == 1
    body = C.json.loads(next(tmp_path.glob("*.json")).read_text(encoding="utf-8"))
    assert body["simbad"] and body["gaia"] is None


def test_group_keeps_k_of_the_main_object():
    rows = [rec("Barnard's star", "BY*", 9.511), rec("Barnard's Star b", "Pl")]
    rows[0]["k"], rows[1]["k"] = 4.524, None
    g = C.group_simbad(rows)
    objs = C.merge(g, [], 2025.6)
    assert objs[0]["k"] == 4.524 and objs[0]["planets"] == 1


def test_gaia_busy_and_retry_once_a_minute(monkeypatch, tmp_path):
    """HTTP 429 marks Gaia busy (no error for the page); a retry is allowed once per GAIA_RETRY_S."""
    monkeypatch.setattr(C, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(C, "_fields", C.OrderedDict())
    monkeypatch.setattr(C, "query_simbad", lambda ra, dec, r: [rec("Barnard's star", "BY*", 9.5)])
    calls = []

    def busy(ra, dec, r):
        calls.append(1)
        raise C.GaiaBusy("429")
    monkeypatch.setattr(C, "query_gaia", busy)
    f = C.get_field(269.44625, 4.7675, 0.03)
    assert f.done.wait(5) and f.state["gaia"] == "busy" and f.status == "ready"
    assert C.retry_gaia(f) is False                      # tried less than a minute ago
    f.tried["gaia"] -= C.GAIA_RETRY_S + 1
    assert C.retry_gaia(f) is True
    assert f.done.wait(5) and len(calls) == 2 and f.state["gaia"] == "busy"


def test_archive_downtime_page_is_an_error_not_rows():
    # ESA Gaia in maintenance answers 200 with an HTML page (2026-11-12)
    with pytest.raises(ValueError):
        C._csv('<html class="ltr" dir="ltr" lang="en-GB">\n<head>\n')
    assert C._csv("a,b\n1,2\n") == [{"a": "1", "b": "2"}]
