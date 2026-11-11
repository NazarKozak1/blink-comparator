// Known objects of the open field (SIMBAD + Gaia DR3 from /api/catalog), loaded once per field in the background.
// Positions come for the server's date and are moved here to the date of the shown frame / stack by proper motion.
import * as api from "./api.js";
import { fracAt, gridSize, PIXEL_ARCSEC, skyAt } from "./util.js";

export const C = { key: "", status: "idle", catalogs: {}, seconds: {}, objects: [], year: 0, error: "" };
const listeners = [];
export const onChange = (f) => listeners.push(f);
const emit = () => listeners.forEach((f) => f());
let seq = 0, memo = { year: null, list: [] };

export const yearOf = (ms) => 2000 + (ms / 1000 - 946728000) / (365.25 * 86400);

// Same linear motion as src/web/catalogs.move (mas/yr, pmRA includes cos Dec)
function move(o, dt) {
  if (!dt || (!o.pmra && !o.pmdec)) return o;
  return { ...o, ra: ((o.ra + (o.pmra || 0) * dt / 3.6e6 / Math.cos(o.dec * Math.PI / 180)) % 360 + 360) % 360,
    dec: o.dec + (o.pmdec || 0) * dt / 3.6e6 };
}

// One request that waits a little (most fields answer in ~2 s), then one long wait for the rest.
export async function load(coords, size) {
  const key = coords + "|" + size;
  if (key === C.key && C.status !== "error") return;
  const my = ++seq;
  Object.assign(C, { key, status: "loading", catalogs: {}, seconds: {}, objects: [], year: 0, error: "" });
  memo = { year: null, list: [] };
  emit();
  for (const wait of [3, 25, 25]) {
    let r;
    try { r = await api.catalog({ coords, size, wait }); } catch (e) {
      if (my !== seq) return;
      Object.assign(C, { status: "error", error: e.message }); emit(); return;
    }
    if (my !== seq) return;
    Object.assign(C, { status: r.status, catalogs: r.catalogs, seconds: r.seconds, objects: r.objects, year: r.epoch_year });
    memo = { year: null, list: [] };
    emit();
    if (r.status === "ready") return;
  }
}

// All objects at a date (ms), memoised per ~4 days
export function objectsAt(ms) {
  const y = ms == null ? C.year : yearOf(ms), k = Math.round(y * 100);
  if (memo.year !== k) memo = { year: k, list: C.objects.map((o) => move(o, y - C.year)) };
  return memo.list;
}

const sepArcsec = (ra1, dec1, ra2, dec2) => {
  const dra = (((ra1 - ra2 + 540) % 360) - 180) * Math.cos((dec1 + dec2) / 360 * Math.PI);
  return Math.hypot(dra, dec1 - dec2) * 3600;
};

// Objects inside the clicked SPHEREx pixel of the picture grid (a 6.15" square), nearest to its centre first.
export function inPixel(ra0, dec0, fov, fx, fy, ms) {
  const n = gridSize(fov), px = Math.floor(fx * n), py = Math.floor(fy * n);
  const [cra, cdec] = skyAt(ra0, dec0, (px + 0.5) / n, (py + 0.5) / n, fov);
  const out = [];
  for (const o of objectsAt(ms)) {
    if (Math.abs(o.dec - cdec) > 0.003) continue;                  // cheap pre-cut (~11")
    const [ox, oy] = fracAt(ra0, dec0, o.ra, o.dec, fov);
    if (Math.floor(ox * n) === px && Math.floor(oy * n) === py) out.push({ ...o, dist: sepArcsec(o.ra, o.dec, cra, cdec) });
  }
  return { ra: cra, dec: cdec, size: PIXEL_ARCSEC, objects: out.sort((a, b) => a.dist - b.dist) };
}

// Short notes on what is missing, for the panels
export function sourcesNote() {
  const g = C.catalogs.gaia, s = C.catalogs.simbad;
  if (C.status === "error") return "Catalogs are not reachable right now.";
  if (s && s !== "ok" && s !== "loading" && g && g !== "ok" && g !== "loading") return "Catalogs did not answer; try again later.";
  if (g === "loading" && s === "ok") return "Gaia is still loading…";
  if (g && g !== "ok" && g !== "loading") return "Gaia did not answer in time: SIMBAD only.";
  if (s && s !== "ok" && s !== "loading") return "SIMBAD did not answer: Gaia only.";
  return "";
}
