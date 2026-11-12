import json
from pathlib import Path

from tests.jsrun import run_js

DATA = Path(__file__).resolve().parents[1] / "src" / "web" / "static" / "app" / "data" / "sky.json"


def test_sky_data_is_small_and_complete():
    d = json.loads(DATA.read_text(encoding="utf-8"))
    assert DATA.stat().st_size <= 300 * 1024
    stars = d["stars"]
    assert len(stars) % 4 == 0 and len(stars) // 4 > 5000
    assert all(0 <= ra < 360 and -90 <= dec <= 90 and m <= 6.5 for ra, dec, m in zip(stars[::4], stars[1::4], stars[2::4]))
    cons = {c["id"]: c for c in d["cons"]}
    assert set(cons) == {"Cyg", "Ori", "UMa", "Cas", "Sco", "Leo", "Tau", "Gem", "Lyr", "Cru"}
    assert len(cons["Cyg"]["l"]) == 2                      # the cross: body and wings
    deneb = next(n for n in d["names"] if n[0] == "Deneb")
    assert abs(deneb[1] - 310.36) < 0.05 and abs(deneb[2] - 45.28) < 0.05
    assert "BSD" in d["source"]


def test_sexagesimal_rounds_up_into_the_next_unit():
    out = run_js(["util.js"], "var OUT = [hms(305), hms(269.4463), hms(359.99999), dms(40), dms(-0.99999), dms(4.7675)];")
    assert out == ["20h20m0.0s", "17h57m47.1s", "0h0m0.0s", "+40°00′00″", "-1°00′00″", "+4°46′03″"]
