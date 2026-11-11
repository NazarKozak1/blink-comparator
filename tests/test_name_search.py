"""Name search of the Explore page (static/app/js/names.js): word-start matches, trigram fuzzy matches, coordinates.
The JS file itself is run, in Node if it is installed, else in headless Chrome; the test is skipped without both."""
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

JS = Path(__file__).resolve().parents[1] / "src" / "web" / "static" / "app" / "js"
CHROMES = [r"C:\Program Files\Google\Chrome\Application\chrome.exe",
           r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
           "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]

CASES = {
    "suggest": ["Bar", "bar", "bernard", "Barnards", "m42", "M42", "rw", "qwerty", "orion nebla", "orion", "or",
                "eps indi", "ε Indi B", "R Dra", "wise j0855", "0855", "83.8221 -5.3911", "17h57m47.1s +4d46m03s",
                "dracnis", "b"],
    "coords": ["83.8221 -5.3911", "17h57m47.1s +4d46m03s", "08h55m02.4s -7d14m32s", "M42", "WISE 0855", "m 42", "0855"],
    "sim": [["bernard", "barnard"], ["orion nebla", "orion nebula"], ["qwerty", "barnards star"]],
}


def _source() -> str:
    code = (JS / "presets.js").read_text(encoding="utf-8") + "\n" + (JS / "names.js").read_text(encoding="utf-8")
    return re.sub(r"^export ", "", code, flags=re.M)


def _program() -> str:
    return _source() + f"""
const C = {json.dumps(CASES, ensure_ascii=False)};
const OUT = {{
  suggest: Object.fromEntries(C.suggest.map((q) => [q, suggest(q, PRESETS).map((s) => [s.t.n, s.how, +s.score.toFixed(3)])])),
  coords: Object.fromEntries(C.coords.map((q) => [q, looksLikeCoords(q)])),
  sim: C.sim.map(([a, b]) => +bestSimilarity(a, b).toFixed(3)),
}};
"""


def _run() -> dict:
    node = shutil.which("node")
    if node:
        out = subprocess.run([node, "-"], input=_program() + "console.log(JSON.stringify(OUT));", text=True,
                             capture_output=True, encoding="utf-8", timeout=60)
        assert out.returncode == 0, out.stderr
        return json.loads(out.stdout)
    chrome = next((c for c in CHROMES if (os.path.isfile(c) or shutil.which(c))), None)
    if not chrome:
        pytest.skip("neither node nor Chrome is installed")
    with tempfile.TemporaryDirectory() as d:
        page = Path(d) / "t.html"
        page.write_text("<!doctype html><meta charset='utf-8'><body><script>" + _program()
                        + "document.body.textContent = '@@' + JSON.stringify(OUT) + '@@';</script>", encoding="utf-8")
        out = subprocess.run([shutil.which(chrome) or chrome, "--headless=new", "--disable-gpu", "--no-first-run",
                              f"--user-data-dir={Path(d) / 'p'}", "--dump-dom", page.as_uri()],
                             capture_output=True, text=True, encoding="utf-8", timeout=120)
    m = re.search(r"@@(.*)@@", out.stdout, re.S)
    assert m, out.stdout[-500:] + out.stderr[-500:]
    return json.loads(m.group(1).replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">"))


@pytest.fixture(scope="module")
def res():
    return _run()


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
