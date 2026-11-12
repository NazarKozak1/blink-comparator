"""Proper motion for comparing visits: SIMBAD fallback when Gaia has no fast star, and the disk cache TTL (no network)."""
import json
from datetime import datetime, timezone

import pytest

from src.web import spectrum as S

WHEN = datetime(2025, 11, 20, tzinfo=timezone.utc)
WISE = {"found": True, "source_id": "WISE J085510.83-071442.5", "pm_ra": -8118.0, "pm_dec": 680.0, "g": None,
        "separation": 1.2, "catalog": "SIMBAD"}


@pytest.fixture
def lookups(tmp_path, monkeypatch):
    """Fake catalogs (answers set per test) and a cache file of its own; returns the call counters."""
    monkeypatch.setattr(S, "GAIA_CACHE", tmp_path / "gaia_pm.json")
    calls = {"gaia": 0, "simbad": 0, "gaia_out": {"found": False}, "simbad_out": {"found": False}}

    def fake(name):
        def f(*a, **k):
            calls[name] += 1
            out = calls[name + "_out"]
            if isinstance(out, Exception):
                raise out
            return dict(out)
        return f
    monkeypatch.setattr(S.catalogs, "gaia_motion", fake("gaia"))
    monkeypatch.setattr(S.catalogs, "simbad_motion", fake("simbad"))
    return calls


def test_simbad_is_asked_when_gaia_has_no_fast_star(lookups):
    lookups["simbad_out"] = WISE
    m = S.gaia_motion(133.76, -7.2422, WHEN)
    assert m["found"] and m["catalog"] == "SIMBAD" and m["pm_ra"] == -8118.0
    assert (lookups["gaia"], lookups["simbad"]) == (1, 1)
    assert S.gaia_motion(133.76, -7.2422, WHEN) == WISE          # a star found is cached
    assert (lookups["gaia"], lookups["simbad"]) == (1, 1)


def test_gaia_star_does_not_ask_simbad(lookups):
    lookups["gaia_out"] = {"found": True, "source_id": "4472832130942575872", "pm_ra": -801.6, "pm_dec": 10362.4,
                           "g": 8.2, "separation": 0.9}
    assert S.gaia_motion(269.4463, 4.7675, WHEN)["source_id"] == "4472832130942575872"
    assert lookups["simbad"] == 0


def test_simbad_is_asked_when_gaia_fails(lookups):
    lookups["gaia_out"] = TimeoutError("ESA busy")
    lookups["simbad_out"] = WISE
    assert S.gaia_motion(133.76, -7.2422, WHEN)["found"]


def test_no_star_is_cached_for_a_day_only(lookups, monkeypatch):
    now = [1_800_000_000.0]
    monkeypatch.setattr(S.time, "time", lambda: now[0])
    assert S.gaia_motion(76.9562, 30.4012, WHEN) == {"found": False}
    assert (lookups["gaia"], lookups["simbad"]) == (1, 1)
    now[0] += S.EMPTY_TTL_S - 60                                    # still fresh
    assert S.gaia_motion(76.9562, 30.4012, WHEN) == {"found": False}
    assert lookups["gaia"] == 1
    now[0] += 120                                                   # a day later: asked again
    S.gaia_motion(76.9562, 30.4012, WHEN)
    assert (lookups["gaia"], lookups["simbad"]) == (2, 2)


def test_failed_lookup_is_not_cached(lookups):
    lookups["gaia_out"] = {"found": False}
    lookups["simbad_out"] = ConnectionError("SIMBAD down")
    assert S.gaia_motion(133.76, -7.2422, WHEN) == {"found": False}
    assert not S.GAIA_CACHE.exists()
    lookups["simbad_out"] = WISE
    assert S.gaia_motion(133.76, -7.2422, WHEN)["found"]


def test_old_empty_entries_without_time_are_dropped(lookups):
    S.GAIA_CACHE.write_text(json.dumps({"76.9562,30.4012": {"found": False},
                                        "269.4463,4.7675": {"found": True, "source_id": "x", "pm_ra": 1, "pm_dec": 2}}))
    lookups["simbad_out"] = WISE
    assert S.gaia_motion(76.9562, 30.4012, WHEN)["found"]           # the old "none" is not trusted
    cache = json.loads(S.GAIA_CACHE.read_text())
    assert cache["76.9562,30.4012"]["found"] and cache["269.4463,4.7675"]["source_id"] == "x"
