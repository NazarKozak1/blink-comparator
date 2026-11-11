"""Run page JS files (without imports) in Node, or in headless Chrome when Node is not installed; skip without both.
The files are joined with `export` removed; `program` must leave its result in a variable named OUT."""
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


def run_js(files: list[str], program: str):
    code = "\n".join((JS / f).read_text(encoding="utf-8") for f in files)
    code = re.sub(r"^export ", "", code, flags=re.M) + "\n" + program
    node = shutil.which("node")
    if node:
        out = subprocess.run([node, "-"], input=code + "\nconsole.log(JSON.stringify(OUT));", text=True,
                             capture_output=True, encoding="utf-8", timeout=60)
        assert out.returncode == 0, out.stderr
        return json.loads(out.stdout)
    chrome = next((c for c in CHROMES if (os.path.isfile(c) or shutil.which(c))), None)
    if not chrome:
        pytest.skip("neither node nor Chrome is installed")
    with tempfile.TemporaryDirectory() as d:
        page = Path(d) / "t.html"
        page.write_text("<!doctype html><meta charset='utf-8'><body><script>" + code
                        + "\ndocument.body.textContent = '@@' + JSON.stringify(OUT) + '@@';</script>", encoding="utf-8")
        out = subprocess.run([shutil.which(chrome) or chrome, "--headless=new", "--disable-gpu", "--no-first-run",
                              f"--user-data-dir={Path(d) / 'p'}", "--dump-dom", page.as_uri()],
                             capture_output=True, text=True, encoding="utf-8", timeout=120)
    m = re.search(r"@@(.*)@@", out.stdout, re.S)
    assert m, out.stdout[-500:] + out.stderr[-500:]
    return json.loads(m.group(1).replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">"))
