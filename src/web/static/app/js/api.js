// All requests to the backend. Images are fetched as blobs because the page needs their headers
// (X-Vmin / X-Vmax for shared contrast, X-N-Frames, X-S-Scale); decoded images are kept in a cache.
// Background loading: a queue of pictures the user will probably open next, at most BG_PARALLEL requests
// at a time, so the browser's 6 connections stay free for what the user asks for.
export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

const qs = (p) => new URLSearchParams(Object.entries(p).filter(([, v]) => v !== undefined && v !== null && v !== "")).toString();

async function fail(r) {
  let detail = r.statusText;
  try { detail = (await r.json()).detail || detail; } catch (e) { /* not JSON */ }
  return new ApiError(typeof detail === "string" ? detail : JSON.stringify(detail), r.status);
}

async function json(path, params) {
  const r = await fetch(path + "?" + qs(params));
  if (!r.ok) throw await fail(r);
  return r.json();
}

export const frames = (p) => json("/api/frames", p);
export const windows = (p, kind) => json("/api/windows", { ...p, window: kind });
export const randomPoint = (detector) => json("/api/random", { detector });

export const frameUrl = (p) => "/api/frame.png?" + qs(p);
export const stackUrl = (p) => "/api/stack.png?" + qs(p);
export const diffUrl = (p) => "/api/diff.png?" + qs(p);

const cache = new Map();          // url -> Promise<{img, h}>, most recently used last
const CACHE_MAX = 250;            // one whole field (up to 200 frames) plus its stacks
const BG_PARALLEL = 2;

function load(url, signal) {
  const p = (async () => {
    const r = await fetch(url, { signal });
    if (!r.ok) throw await fail(r);
    const blob = await r.blob();
    const img = new Image();
    img.src = URL.createObjectURL(blob);
    await img.decode();
    const h = {};
    r.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
    return { img, h };
  })();
  p.catch(() => { if (cache.get(url) === p) cache.delete(url); });
  cache.set(url, p);
  while (cache.size > CACHE_MAX) {
    const [k, old] = cache.entries().next().value;
    cache.delete(k);
    old.then((x) => URL.revokeObjectURL(x.img.src)).catch(() => {});
  }
  return p;
}

// A picture the user wants now: from the cache, joining a background request already under way, or a new request.
export function image(url) {
  if (cache.has(url)) {
    const p = cache.get(url);
    cache.delete(url); cache.set(url, p);
    return p;
  }
  return load(url);
}

const queue = [];
const running = new Set();        // AbortControllers of background requests in flight

// Replaces the waiting list (order = priority); requests already running continue.
export function background(urls) {
  queue.length = 0;
  for (const u of urls) if (!cache.has(u) && !queue.includes(u)) queue.push(u);
  pump();
}

// New field: forget the waiting list and stop what is running.
export function cancelBackground() {
  queue.length = 0;
  running.forEach((c) => c.abort());
  running.clear();
}

function pump() {
  while (!paused && running.size < BG_PARALLEL && queue.length) {
    const url = queue.shift();
    if (cache.has(url)) continue;
    const c = new AbortController();
    running.add(c);
    load(url, c.signal).catch(() => {}).finally(() => { running.delete(c); pump(); });
  }
}

export const limitsOf = (h) => [h["x-vmin"], h["x-vmax"]];

// Point details: snapping, spectrum per detector, features, proper motion.
export const point = (p) => json("/api/point", p);
export async function spectrum(p, signal) {
  const r = await fetch("/api/spectrum?" + qs(p), { signal });
  if (!r.ok) throw await fail(r);
  return r.json();
}
export async function features(points) {
  const r = await fetch("/api/features", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ points }) });
  if (!r.ok) throw await fail(r);
  return r.json();
}
export const motion = (p) => json("/api/motion", p);
// Known objects of the whole field (SIMBAD + Gaia), status loading | partial | ready
export const catalog = (p) => json("/api/catalog", p);

// Spectra take the connections while they run: background pictures wait.
let paused = 0;
export function pauseBackground(on) { paused = Math.max(0, paused + (on ? 1 : -1)); if (!paused) pump(); }
