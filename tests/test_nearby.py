"""Objects near a click (static/app/js/nearby.js): search radius by field of view, sorting by K, then G, then distance,
proper motion. Runs the page's JS file (see jsrun.py)."""
import pytest

from jsrun import run_js

# Barnard's star at 2025.6 and neighbours; distances from the click are set by small offsets in Dec (1" = 1/3600 deg)
PROGRAM = r"""
const c = { ra: 269.44625, dec: 4.7675 }, at = (dArcsec, extra) => ({ ra: c.ra, dec: c.dec + dArcsec / 3600, pmra: 0, pmdec: 0, ...extra });
const objs = [
  at(25, { name: "faint gaia", k: null, g: 19.5 }),
  at(12.7, { name: "Barnard's star", k: 4.52, g: 8.19 }),
  at(3, { name: "radio blob", k: null, g: null }),
  at(40, { name: "bright K", k: 7.1, g: null }),
  at(1, { name: "no mag near", k: null, g: null }),
  at(70, { name: "too far", k: 3.0, g: 5.0 }),
];
const near = (r) => nearPoint(objs, c.ra, c.dec, r).map((o) => [o.name, +o.dist.toFixed(1)]);
const OUT = {
  r4: +searchRadius(4, 536, 6.4).toFixed(2),        // 4' on 536 px: 0.45"/px -> 4.5" < PSF
  r30: +searchRadius(30, 536, 6.4).toFixed(2),      // 30': 3.36"/px -> 33.6"
  r30noPsf: +searchRadius(30, 536, null).toFixed(2),
  rCap: +searchRadius(60, 300, 6.4).toFixed(2),     // 12"/px -> capped at 60"
  rPsfOnly: +searchRadius(4, 2000, null).toFixed(2),
  n34: near(34), n60: near(60), n5: near(5),
  // halo: Barnard (K 4.5) 12.7" away counts with a 7" radius; a faint star (G 19.5) 25" away does not
  halo7: nearPoint(objs, c.ra, c.dec, 7, 6.6).map((o) => o.name),
  halos: [halo({ k: 4.52 }, 6.6), halo({ k: null, g: 19.5 }, 6.6), halo({ k: null, g: null }, 6.6), halo({ k: -5 }, 20)],
  mags: [magOf({ k: 4.5, g: 9 }), magOf({ k: null, g: 9.5 }), magOf({ k: null, g: null })],
  moved: (() => { const m = moveBy({ ra: 269.4520769586187, dec: 4.693364966576667, pmra: -801.551, pmdec: 10362.394 }, 25.6);
                  return [+(m.dec - 4.693364966576667).toFixed(6), +sepArcsec(m.ra, m.dec, c.ra, c.dec).toFixed(1)]; })(),
  same: moveBy({ ra: 1, dec: 2, pmra: null, pmdec: null }, 10),
  // a click 40" off a star (outside radius and halo) that climbed to its peak finds it; distance stays from the click
  peak: nearClick(objs, { ra: c.ra, dec: c.dec - 27.3 / 3600 }, 5, 6.6, [null, { ra: c.ra, dec: c.dec + 12 / 3600 }], 12.3)
    .map((o) => [o.name, +o.dist.toFixed(1)]),
  noPeak: nearClick(objs, { ra: c.ra, dec: c.dec - 27.3 / 3600 }, 5, 6.6).map((o) => o.name),
};
"""


@pytest.fixture(scope="module")
def res():
    return run_js(["nearby.js"], PROGRAM)


def test_radius_follows_field_of_view(res):
    assert res["r4"] == 6.4                      # PSF wins on a small field
    assert res["r30"] == pytest.approx(33.58, abs=0.01)
    assert res["r30noPsf"] == pytest.approx(33.58, abs=0.01)
    assert res["rCap"] == 60
    assert res["rPsfOnly"] == 6.6                # default PSF when the frame has none


def test_sorted_by_k_then_g_then_distance(res):
    assert res["n34"] == [["Barnard's star", 12.7], ["faint gaia", 25.0], ["no mag near", 1.0], ["radio blob", 3.0]]
    assert [n for n, _ in res["n60"]] == ["Barnard's star", "bright K", "faint gaia", "no mag near", "radio blob"]
    assert res["n5"] == [["Barnard's star", 12.7], ["no mag near", 1.0], ["radio blob", 3.0]]   # Barnard by its halo
    assert res["mags"] == [["K", 4.5], ["G", 9.5], None]


def test_bright_star_halo(res):
    assert res["halo7"] == ["Barnard's star", "no mag near", "radio blob"]
    assert res["halos"][0] == pytest.approx(6.6 * (1 + 0.25 * (12 - 4.52)))   # 18.9"
    assert res["halos"][1] == 6.6 and res["halos"][2] == 6.6
    assert res["halos"][3] == 60                                             # 4 x 20" capped at 60"


def test_click_on_a_star_image_uses_its_peak(res):
    assert res["noPeak"] == []
    assert res["peak"][0] == ["Barnard's star", 40.0]
    assert [n for n, _ in res["peak"]] == ["Barnard's star", "no mag near", "radio blob"]   # faint gaia is 13" from the peak


def test_proper_motion(res):
    assert res["moved"][0] == pytest.approx(10362.394 * 25.6 / 3.6e6, abs=1e-6)
    assert res["moved"][1] < 6                   # SIMBAD 2000 position moved to 2025.6 lands on the field centre
    assert res["same"] == {"ra": 1, "dec": 2, "pmra": None, "pmdec": None}
