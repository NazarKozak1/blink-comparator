"""Challenge targets offered as presets; must match static/app/js/presets.js (checked by tests/test_presets.py).
q is the exact coordinate text the page sends, because frame lists and pictures are cached by it."""
from dataclasses import dataclass


@dataclass(frozen=True)
class Preset:
    name: str
    q: str
    detector: int
    size: float
    mode: str          # view the page opens: "frames" or "stacks"


PRESETS = (
    Preset("Barnard’s Star", "17h57m47.1s +4d46m03s", 6, 4, "stacks"),
    Preset("Epsilon Indi B", "22h04m23.4s -56d48m03s", 6, 4, "stacks"),
    Preset("WISE 0855", "08h55m02.4s -7d14m32s", 6, 4, "stacks"),
    Preset("RW Aurigae", "76.9564 30.4014", 6, 6, "frames"),
    Preset("R Draconis", "248.1675 66.7550", 6, 6, "frames"),
    Preset("Orion Nebula", "83.8221 -5.3911", 4, 6, "frames"),
)
