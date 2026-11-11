"""Name search of the Explore page (static/app/js/names.js): word-start matches, trigram fuzzy matches, coordinates.
The JS file itself is run (see jsrun.py: Node, else headless Chrome, else skipped)."""
import json

import pytest

from jsrun import run_js

CASES = {
    "suggest": ["Bar", "bar", "bernard", "Barnards", "m42", "M42", "rw", "qwerty", "orion nebla", "orion", "or",
                "eps indi", "ε Indi B", "R Dra", "wise j0855", "0855", "83.8221 -5.3911", "17h57m47.1s +4d46m03s",
                "dracnis", "b"],
    "coords": ["83.8221 -5.3911", "17h57m47.1s +4d46m03s", "08h55m02.4s -7d14m32s", "M42", "WISE 0855", "m 42", "0855"],
    "sim": [["bernard", "barnard"], ["orion nebla", "orion nebula"], ["qwerty", "barnards star"]],
}


PROGRAM = f"""
const C = {json.dumps(CASES, ensure_ascii=False)};
const OUT = {{
  suggest: Object.fromEntries(C.suggest.map((q) => [q, suggest(q, PRESETS).map((s) => [s.t.n, s.how, +s.score.toFixed(3)])])),
  coords: Object.fromEntries(C.coords.map((q) => [q, looksLikeCoords(q)])),
  sim: C.sim.map(([a, b]) => +bestSimilarity(a, b).toFixed(3)),
}};
"""


@pytest.fixture(scope="module")
def res():
    return run_js(["presets.js", "names.js"], PROGRAM)


def first(res, q):
    s = res["suggest"][q]
    return s[0][0] if s else None


def test_prefix_matches(res):
    assert first(res, "Bar") == first(res, "bar") == "Barnard’s Star"
    assert [s[:2] for s in res["suggest"]["Bar"]] == [["Barnard’s Star", "prefix"]]
    assert first(res, "Barnards") == "Barnard’s Star"
    assert first(res, "m42") == first(res, "M42") == "Orion Nebula"
    assert first(res, "rw") == "RW Aurigae"
    assert first(res, "or") == "Orion Nebula"
    assert first(res, "orion") == "Orion Nebula"
    assert first(res, "R Dra") == "R Draconis"
    assert first(res, "eps indi") == first(res, "ε Indi B") == "Epsilon Indi B"
    assert first(res, "wise j0855") == first(res, "0855") == "WISE 0855"
    assert [s[0] for s in res["suggest"]["b"]] == ["Barnard’s Star", "Epsilon Indi B"]   # "B" of Epsilon Indi B


def test_fuzzy_trigram_matches(res):
    assert res["suggest"]["bernard"][0][:2] == ["Barnard’s Star", "fuzzy"]
    assert res["suggest"]["orion nebla"][0][0] == "Orion Nebula"
    assert first(res, "dracnis") == "R Draconis"
    assert res["sim"][0] == pytest.approx(5 / 11, abs=1e-3)       # 5 shared of 11 trigrams
    assert res["sim"][1] > 0.6 and res["sim"][2] < 0.3


def test_unknown_names_and_coordinates(res):
    assert res["suggest"]["qwerty"] == []
    assert res["suggest"]["83.8221 -5.3911"] == [] and res["suggest"]["17h57m47.1s +4d46m03s"] == []
    assert res["coords"] == {"83.8221 -5.3911": True, "17h57m47.1s +4d46m03s": True, "08h55m02.4s -7d14m32s": True,
                             "M42": False, "WISE 0855": False, "m 42": False, "0855": False}
