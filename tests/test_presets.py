import re
from pathlib import Path

from src.web.presets import PRESETS

JS = Path(__file__).resolve().parents[1] / "src" / "web" / "static" / "app" / "js" / "presets.js"


def test_server_presets_match_the_page():
    """The warm-up only helps if it computes exactly what the page asks for."""
    rows = re.findall(r'q: "([^"]+)".*?det: (\d), fov: (\d+), mode: "(\w+)"', JS.read_text(encoding="utf-8"))
    page = [(q, int(d), float(f), m) for q, d, f, m in rows]
    server = [(p.q, p.detector, float(p.size), p.mode) for p in PRESETS]
    assert page == server
