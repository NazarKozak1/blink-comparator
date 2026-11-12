"""Build src/web/static/app/data/sky.json for the Sky sphere from d3-celestial (BSD-3-Clause, (c) 2015 Olaf Frohn):
stars to 6 mag (XHIP, Anderson & Francis 2012, doi:10.1134/S1063773712050015, via CDS/VizieR V/137D), lines and label points of a few constellations
(after the IAU / Sky & Telescope charts, CC BY 4.0), names of bright stars. Licence text: data/LICENSE-d3-celestial.txt.

    .venv/Scripts/python scripts/build_sky_data.py [DIR]      (from the project root)

DIR holds stars.6.json, constellations.lines.json and constellations.json from
https://github.com/ofrohn/d3-celestial/tree/master/data; without it the files are downloaded.
"""
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "src" / "web" / "static" / "app" / "data" / "sky.json"
URL = "https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/"
CONS = ["Cyg", "Ori", "UMa", "Cas", "Sco", "Leo", "Tau", "Gem", "Lyr", "Cru"]
# label -> Hipparcos number (the id of stars.6.json)
NAMES = {"Deneb": 102098, "Vega": 91262, "Altair": 97649, "Albireo": 95947, "Betelgeuse": 27989, "Rigel": 24436,
         "Sirius": 32349, "Aldebaran": 21421, "Antares": 80763, "Regulus": 49669, "Castor": 36850, "Pollux": 37826,
         "Capella": 24608, "Arcturus": 69673, "Spica": 65474, "Acrux": 60718, "Dubhe": 54061, "Schedar": 3179}


def load(src: Path | None, name: str):
    if src:
        return json.loads((src / name).read_text(encoding="utf-8"))
    with urllib.request.urlopen(URL + name, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def ra360(lon: float) -> float:
    return round(lon % 360, 2)


def main():
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    stars, by_id = [], {}
    for f in sorted(load(src, "stars.6.json")["features"], key=lambda f: f["properties"]["mag"]):
        lon, lat = f["geometry"]["coordinates"]
        bv = f["properties"].get("bv")
        bv = round(float(bv), 2) if bv not in (None, "") else 0.6       # two stars lack B-V: sun-like colour
        row = [ra360(lon), round(lat, 2), round(f["properties"]["mag"], 2), bv]
        stars += row
        by_id[f["id"]] = row
    lines = {f["id"]: f["geometry"]["coordinates"] for f in load(src, "constellations.lines.json")["features"]}
    meta = {f["id"]: f for f in load(src, "constellations.json")["features"]}
    cons = []
    for c in CONS:
        lon, lat = meta[c]["geometry"]["coordinates"]
        cons.append({"id": c, "n": meta[c]["properties"]["name"], "at": [ra360(lon), lat],
                     "l": [[v for p in seg for v in (ra360(p[0]), round(p[1], 2))] for seg in lines[c]]})
    names = [[n, by_id[h][0], by_id[h][1]] for n, h in NAMES.items()]
    data = {"source": ("d3-celestial (c) 2015 Olaf Frohn, BSD-3-Clause, see LICENSE-d3-celestial.txt; stars: XHIP: An Extended Hipparcos Compilation (Anderson & Francis 2012, Astronomy Letters 38, 331, doi:10.1134/S1063773712050015), via CDS/VizieR V/137D; lines: after IAU / Sky & Telescope charts, CC BY 4.0"),
            "stars": stars, "cons": cons, "names": names}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    print(f"{OUT.relative_to(ROOT)}: {len(stars) // 4} stars, {len(cons)} constellations, "
          f"{len(names)} names, {OUT.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
