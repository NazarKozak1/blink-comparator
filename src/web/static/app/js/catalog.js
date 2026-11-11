// Known objects of the open field (SIMBAD + Gaia DR3 from /api/catalog), loaded once per field in the background.
// Positions come for the server's date and are moved here to the date of the shown frame / stack by proper motion.
import * as api from "./api.js";
import { moveBy, nearClick } from "./nearby.js";

export const C = { key: "", status: "idle", catalogs: {}, seconds: {}, limited: {}, objects: [], year: 0, error: "" };
const listeners = [];
export const onChange = (f) => listeners.push(f);
const emit = () => listeners.forEach((f) => f());
let seq = 0, memo = { year: null, list: [] }, retried = "";

export const yearOf = (ms) => 2000 + (ms / 1000 - 946728000) / (365.25 * 86400);

// One request that waits a little (most fields answer in ~2 s), then long waits while Gaia is still running
// (its archive may queue a job for a minute or more); SIMBAD is shown as soon as it is there.
export async function load(coords, size) {
  const key = coords + "|" + size;
  if (key === C.key && C.status !== "error") return;
  const my = ++seq;
  Object.assign(C, { key, status: "loading", catalogs: {}, seconds: {}, objects: [], year: 0, error: "" });
  memo = { year: null, list: [] };
  emit();
  for (const wait of [3, 25, 25, 25, 25, 25]) {
    let r;
    try { r = await api.catalog({ coords, size, wait }); } catch (e) {
      if (my !== seq) return;
      Object.assign(C, { status: "error", error: e.message }); emit(); return;
    }
    if (my !== seq) return;
    Object.assign(C, { status: r.status, catalogs: r.catalogs, seconds: r.seconds, limited: r.limited || {}, objects: r.objects, year: r.epoch_year });
    memo = { year: null, list: [] };
    emit();
    if (r.status === "ready") return;
  }
}

// All objects at a date (ms), memoised per ~4 days
export function objectsAt(ms) {
  const y = ms == null ? C.year : yearOf(ms), k = Math.round(y * 100);
  if (memo.year !== k) memo = { year: k, list: C.objects.map((o) => moveBy(o, y - C.year)) };
  return memo.list;
}

// Known objects within `radius` arcsec of a point (or within a bright star's halo), at a date (ms):
// K first, then G, then the rest by distance
export const near = (click, radius, ms, psf, peaks, peakRadius) => nearClick(objectsAt(ms), click, radius, psf, peaks, peakRadius);

// Gaia failed for this field (timeout / error / busy): ask the server once more, on the first click
export async function retryGaia() {
  const g = C.catalogs.gaia;
  if (C.status !== "ready" || !g || g === "ok" || retried === C.key) return;
  retried = C.key;
  const key = C.key, [coords, size] = key.split("|");
  Object.assign(C, { catalogs: { ...C.catalogs, gaia: "loading" }, status: "partial" }); emit();
  try {
    const r = await api.catalog({ coords, size, wait: 25, retry: 1 });
    if (key !== C.key) return;
    Object.assign(C, { status: r.status, catalogs: r.catalogs, seconds: r.seconds, limited: r.limited || {}, objects: r.objects, year: r.epoch_year });
  } catch (e) { if (key === C.key) Object.assign(C, { status: "ready", catalogs: { ...C.catalogs, gaia: "error" } }); }
  memo = { year: null, list: [] };
  emit();
}

// Short notes on what is missing, for the panels
export function sourcesNote() {
  const g = C.catalogs.gaia, s = C.catalogs.simbad;
  if (C.status === "error") return "Catalogs are not reachable right now.";
  if (s && s !== "ok" && s !== "loading" && g && g !== "ok" && g !== "loading") return "Catalogs did not answer; try again later.";
  if (g === "loading" && s === "ok") return "Gaia is still loading…";
  if (g === "busy") return "The Gaia archive is busy: SIMBAD only for now.";
  if (g && g !== "ok" && g !== "loading") return "Gaia did not answer in time: SIMBAD only.";
  if (s && s !== "ok" && s !== "loading") return "SIMBAD did not answer: Gaia only.";
  if (C.limited.gaia) return "Crowded field: only the 5000 brightest Gaia stars are listed.";
  return "";
}
