// Explore view: search, picture (canvas), Frames / Stacks / Blink / Diff, timeline, advanced settings, hover and pin.
import * as api from "./api.js";
import * as TL from "./timeline.js";
import * as AP from "./aperture.js";
import * as SP from "./spectrum.js";
import { BAND_INTRO, BAND_NOTES, ColourBand } from "./colourband.js";
import { PRESETS } from "./presets.js";
import { S, writeUrl } from "./state.js";
import { $, DET, day, month, skyAt, hms, dms, stamp, toast } from "./util.js";

const N_BANDS = 17;
const PLAY_MS = { frames: 500, stacks: 900, blink: 500 };
const D = {
  info: null,          // /api/frames answer
  all: [],             // all frames, with t (ms)
  frames: [],          // frames of the chosen band
  epochs: [],          // visits: {start, end, n, label, t0, t1}
  wins: [],            // stack windows (epochs, days or one custom range)
  limits: { frames: null, stacks: null },
  tog: 0, play: false, timer: null, seq: 0, pin: null, used: null, scale: null,
  view: null,                // timeline zoom: [t0, t1] in ms, null = whole span
  dir: 1,                    // last stepping direction: background loading looks that way first
};
export const field = () => D;
const listeners = [];
export const onField = (f) => listeners.push(f);

const tipHtml = (t) => `<span class="tip" tabindex="0" role="note" data-t="${t}">i</span>`;
const DIFF_TIP = "Diff shows what changed between two visits. Very slow movers, which shift by less than about one star width between visits, and very fast ones, which smear into a streak within one visit, do not show up here. Seeing nothing does not mean nothing is there.";

const base = () => ({ coords: S.q, detector: S.det, size: S.fov, full: S.crop ? 0 : 1 });
const toWin = (w) => ({ start: w.start, end: w.end, n: w.n_frames, label: w.label, t0: Date.parse(w.start), t1: Date.parse(w.end) });
const items = () => (S.mode === "stacks" ? D.wins : D.frames);
const cur = () => items()[S.i];
const epA = () => D.epochs[Math.min(S.ea, D.epochs.length - 1)];
const epB = () => D.epochs[S.eb < 0 ? D.epochs.length - 1 : Math.min(S.eb, D.epochs.length - 1)];

// ---------- state overlay (her #state) ----------
function showState(html, id = "state") { const s = $(id); s.innerHTML = html; s.style.display = "flex"; }
function hideState(id = "state") { $(id).style.display = "none"; }
function blank(cv) { const x = cv.getContext("2d"); x.fillStyle = "#000"; x.fillRect(0, 0, cv.width, cv.height); }

// ---------- drawing ----------
function cross(x, w) {
  const k = w / 320, c = w / 2;
  x.strokeStyle = "#FFB347"; x.lineWidth = k; x.beginPath();
  [[-20, -8], [8, 20]].forEach(([a, b]) => { x.moveTo(c + a * k, c); x.lineTo(c + b * k, c); x.moveTo(c, c + a * k); x.lineTo(c, c + b * k); });
  x.stroke();
}
function draw(cv, img, tint) {
  const x = cv.getContext("2d"), w = cv.width;
  x.globalCompositeOperation = "source-over";
  x.drawImage(img, 0, 0, w, w);
  if (tint) {   // camera colour, as in the prototype (illustrative)
    x.globalCompositeOperation = "multiply"; x.fillStyle = DET[S.det - 1][3]; x.fillRect(0, 0, w, w);
    x.globalCompositeOperation = "source-over";
  }
  cross(x, w);
}

// Loading text appears only if the picture takes longer than a moment (cached ones are instant).
async function load(url, seq, text, id = "state") {
  const t = setTimeout(() => { if (seq === D.seq) showState(text, id); }, 350);
  try { return await api.image(url); } finally { clearTimeout(t); if (seq === D.seq) hideState(id); }
}

// ---------- request parameters ----------
const frameParams = (f, lim) => ({ path: f.path, coords: S.q, size: S.fov, scale: "mjy", bg: S.orig ? "raw" : S.bgm, bare: 1, stretch: S.stretch,
  holes: S.holes ? 1 : "", vmin: lim?.[0], vmax: lim?.[1] });
const stackParams = (w, method, lim) => ({ ...base(), start: w.start, end: w.end, band: S.band || "", method, bg: S.bgm, stretch: S.stretch,
  bare: 1, holes: S.holes ? 1 : "", vmin: lim?.[0], vmax: lim?.[1] });
const diffParams = () => ({ ...base(), a_start: epA().start, a_end: epA().end, b_start: epB().start, b_end: epB().end,
  band: S.band || "", method: S.method, bg: S.bgm, bare: 1, holes: S.holes ? 1 : "" });

// Background loading after every shown picture, in this order:
//   frames mode: frames +-1..3 (the stepping direction first), stacks of all visits, their Diff, all other frames;
//   other modes: stacks of all visits (or +-3 day / custom windows), Diff, frames +-3 around the current time, the rest.
// With Same contrast a kind of picture is queued only once its limits are known (they are part of the request).
function schedule() {
  if (!D.frames.length) return;
  const limF = S.same ? D.limits.frames : null, limS = S.same ? D.limits.stacks : null;
  const fUrl = (f) => api.frameUrl(frameParams(f, limF));
  const sUrl = (w) => api.stackUrl(stackParams(w, S.method, limS));
  const around = (list, c, n) => {
    const out = [];
    for (let d = 1; d <= n; d++) for (const sgn of [D.dir, -D.dir]) { const it = list[c + sgn * d]; if (it) out.push(it); }
    return out;
  };
  const fi = S.mode === "frames" ? S.i : nearest(D.frames, curTime(), (f) => f.t);
  const nearF = !S.same || limF ? around(D.frames, fi, 3).map(fUrl) : [];
  const restF = !S.same || limF
    ? D.frames.map((f, k) => [Math.abs(k - fi), f]).filter(([d]) => d > 3).sort((a, b) => a[0] - b[0]).map(([, f]) => fUrl(f)) : [];
  let stacks = [];
  if (!S.same || limS) {
    const wins = S.win === "epoch" ? D.epochs : around(D.wins, S.mode === "stacks" ? S.i : nearest(D.wins, curTime(), (w) => (w.t0 + w.t1) / 2), 3);
    stacks = (S.win === "epoch" ? wins : D.epochs.concat(wins)).map(sUrl);
  }
  const diff = D.epochs.length > 1 ? [api.diffUrl(diffParams())] : [];
  api.background(S.mode === "frames" ? [...nearF, ...stacks, ...diff, ...restF] : [...stacks, ...diff, ...nearF, ...restF]);
}

// ---------- paint ----------
export async function paint() {
  const seq = ++D.seq, m = S.mode;
  $("cv").dataset.done = "0";      // "1" once the picture of this paint is on screen (used by UI checks)
  controls(); caption(); TL.draw(); ring2(); AP.draw();
  $("stage2").hidden = !(m === "stacks" && S.cmp);
  $("stages").classList.toggle("two", !$("stage2").hidden);
  if (!D.info) return;
  if (!D.all.length) return;
  try {
    if (m === "frames" || m === "stacks") {
      const it = cur();
      if (!it) { blank($("cv")); showState(S.band ? `No photos in band ${S.band} here.` : "Nothing to show."); return; }
      if (m === "stacks" && !it.n) { blank($("cv")); showState("No photos in this date range."); return; }
      const lim = S.same ? D.limits[m] : null;
      const url = m === "frames" ? api.frameUrl(frameParams(it, lim)) : api.stackUrl(stackParams(it, S.method, lim));
      const r = await load(url, seq, m === "frames" ? "Loading the photo…" : "Building the stack…<br><span class='note'>first time 1–3 s, then instant</span>");
      if (seq !== D.seq) return;
      if (S.same && !D.limits[m]) D.limits[m] = api.limitsOf(r.h);
      D.used = m === "stacks" ? +r.h["x-n-frames"] : null;
      draw($("cv"), r.img, true);
      caption();
      if (m === "stacks" && S.cmp) {
        const r2 = await load(api.stackUrl(stackParams(it, S.cmp, api.limitsOf(r.h))), seq, "Building…", "state2");
        if (seq === D.seq) draw($("cv2"), r2.img, true);
      }
      if (seq === D.seq) { $("cv").dataset.done = "1"; schedule(); }
    } else if (m === "blink") {
      // the second visit uses the first one's contrast limits, so a brightness change is real
      const a = await load(api.stackUrl(stackParams(epA(), S.method, null)), seq, "Building both stacks…");
      const b = await load(api.stackUrl(stackParams(epB(), S.method, api.limitsOf(a.h))), seq, "Building both stacks…");
      if (seq !== D.seq) return;
      draw($("cv"), (D.tog ? b : a).img, true);
      $("cv").dataset.done = "1";
      schedule();
    } else {
      const r = await load(api.diffUrl(diffParams()), seq, "Comparing the two visits…<br><span class='note'>first time a few seconds</span>");
      if (seq !== D.seq) return;
      D.scale = r.h["x-s-scale"];
      draw($("cv"), r.img, false);
      caption();
      $("cv").dataset.done = "1";
      schedule();
    }
  } catch (e) {
    if (seq === D.seq) showState("Could not show this view.<br><span class='note'>" + e.message + "</span>");
  }
}

// ---------- captions, counters, timeline ----------
function lamRange(w) {
  const l = D.frames.filter((f) => f.t >= w.t0 && f.t <= w.t1 && f.lambda_um).map((f) => f.lambda_um);
  if (!l.length) return "";
  const a = Math.min(...l), b = Math.max(...l);
  return " · λ " + (b - a < 0.0005 ? a.toFixed(3) : a.toFixed(2) + "–" + b.toFixed(2)) + " µm";
}
const epochName = (w) => { const k = D.epochs.indexOf(w); return (k >= 0 ? "Epoch " + (k + 1) + " · " : "") + month(w.start); };

function caption() {
  const m = S.mode, it = cur();
  let t = "";
  if (!D.info) t = "";
  else if (m === "frames" && it) {
    t = stamp(it.date_obs) + " · " + DET[S.det - 1][0]
      + (it.lambda_um ? " · λ " + it.lambda_um.toFixed(3) + " µm" : "") + (it.full ? "" : " · cropped");
  } else if (m === "stacks" && it) {
    const what = S.win === "epoch" ? epochName(it) : S.win === "day" ? day(it.start) : "Custom range";
    t = what + " · " + (D.used ?? it.n) + " frames stacked (" + S.method + (S.cmp ? " | " + S.cmp : "") + ")" + lamRange(it);
  } else if (m === "blink" && D.epochs.length > 1) {
    t = "Blinking: " + month(epA().start) + " ⇄ " + month(epB().start) + " · now " + month((D.tog ? epB() : epA()).start) + " · same contrast";
  } else if (m === "diff" && D.epochs.length > 1) {
    t = "Difference: " + month(epB().start) + " minus " + month(epA().start) + (D.scale ? " · noise scale ×" + (+D.scale).toFixed(2) : "");
  }
  $("cap").textContent = t;
  $("lgd").innerHTML = m === "diff"
    ? "<span style='color:#fff'>■</span> white = appeared · <span style='color:#444'>■</span> black = vanished · grey = unchanged" + tipHtml(DIFF_TIP)
    : "";
  const n = items().length;
  $("cnt").textContent = (m === "frames" || m === "stacks") && n ? (S.i + 1) + " / " + n : "";
  $("sl").style.visibility = (m === "frames" || m === "stacks") ? "visible" : "hidden";
  $("sl").max = Math.max(0, n - 1); $("sl").value = S.i;
  $("cmp").hidden = !(m === "blink" || m === "diff");
  [].forEach.call($("mode").children, (b) => b.setAttribute("aria-pressed", b.dataset.v === m));
}

function curTime() {
  const m = S.mode;
  if (m === "blink") return ((D.tog ? epB() : epA()).t0 + (D.tog ? epB() : epA()).t1) / 2;
  if (m === "diff") return (epB().t0 + epB().t1) / 2;
  const it = cur();
  return it ? (it.t ?? (it.t0 + it.t1) / 2) : null;
}

function nearest(list, t, key) {
  let best = 0, bd = Infinity;
  list.forEach((x, k) => { const d = Math.abs(key(x) - t); if (d < bd) { bd = d; best = k; } });
  return best;
}

// ---------- controls ----------
function controls() {
  $("q").value = S.q;
  $("det").value = S.det; $("fov").value = S.fov; $("fovv").textContent = S.fov + "′";
  $("crop").checked = S.crop; $("same").checked = S.same; $("holes").checked = S.holes;
  $("method").value = S.method; $("cmpm").checked = !!S.cmp; $("method2").disabled = !S.cmp;
  if (S.cmp) $("method2").value = S.cmp;
  $("win").value = S.win; $("custom").hidden = S.win !== "custom";
  $("c-start").value = S.start; $("c-end").value = S.end;
  const framesOnly = S.mode === "frames";      // stacks, Blink and Diff always remove the background
  [].forEach.call($("bgseg").children, (b) => {
    b.setAttribute("aria-pressed", b.dataset.v === (S.orig && framesOnly ? "raw" : "removed"));
    b.disabled = b.dataset.v === "raw" && !framesOnly;
  });
  $("bgm").value = S.bgm;
  [].forEach.call($("stretch").children, (b) => b.setAttribute("aria-pressed", b.dataset.v === S.stretch));
  [].forEach.call($("chips").children, (c) => c.setAttribute("aria-pressed", c.dataset.q === S.q));
  bands();
  // colour band: a basic setting for single photos, an advanced one for stacks, Blink and Diff
  const slot = $(S.mode === "frames" ? "band-top" : "band-adv");
  if ($("bandbox").parentElement !== slot) slot.appendChild($("bandbox"));
  if (D.epochs.length) {
    const opts = D.epochs.map((e, k) => `<option value="${k}">Epoch ${k + 1} · ${month(e.start)} · ${e.n} fr.</option>`).join("");
    if ($("ea").innerHTML !== opts) { $("ea").innerHTML = opts; $("eb").innerHTML = opts; }
    $("ea").value = Math.min(S.ea, D.epochs.length - 1);
    $("eb").value = S.eb < 0 ? D.epochs.length - 1 : Math.min(S.eb, D.epochs.length - 1);
  }
}

let picker = null, pickerKey = "";
// Colour band picker: bars from /api/frames (photos per band, mean wavelength of their photos), edges from
// band_edges_um. Rebuilt only when the data change (new search, detector), so focus and hover survive repaints.
function bands() {
  if (!D.info) { if (pickerKey !== "loading") { picker.setLoading(); pickerKey = "loading"; } return; }
  const edges = D.info.band_edges_um || [], det = DET[S.det - 1];
  const list = [];
  for (let b = 1; b <= N_BANDS; b++) {
    const own = D.all.filter((f) => f.band === b && f.lambda_um);
    const lam = own.length ? own.reduce((x, f) => x + f.lambda_um, 0) / own.length
      : edges.length ? Math.sqrt(edges[b - 1] * edges[b]) : det[1] + (b - 0.5) * (det[2] - det[1]) / N_BANDS;
    list.push({ band: b, lambda_um: lam, count: D.all.filter((f) => f.band === b).length });
  }
  const range = edges.length ? [edges[0], edges[edges.length - 1]] : [det[1], det[2]];
  const key = S.det + "|" + list.map((x) => x.count).join(",") + "|" + range.join(",");
  if (key !== pickerKey) {
    pickerKey = key;
    picker.setData({ detector: det[0], range, bands: list, selected: S.band });
    bandLegend();
  } else if (picker.value !== S.band) picker.select(S.band);
}

// The (i) next to "Colour band": intro and what this detector shows, as a list (site tooltip).
function bandLegend() {
  const det = DET[S.det - 1], notes = BAND_NOTES[S.det] || [], t = $("band-tip");
  t.dataset.t = BAND_INTRO + (notes.length ? "\nIn this detector (" + det[0] + ", " + det[1].toFixed(2) + "–" + det[2].toFixed(2) + " µm):" : "");
  if (notes.length) t.dataset.list = notes.map(([a, b]) => a + " :: " + b).join(" ;; ");
  else delete t.dataset.list;
}

// ---------- data ----------
async function loadWindows() {
  const p = { ...base(), band: S.band };
  D.epochs = (await api.windows(p, "epoch")).windows.map(toWin);
  if (S.win === "day") D.wins = (await api.windows(p, "day")).windows.map(toWin);
  else if (S.win === "custom") {
    if (!S.start || !S.end) {   // default: the visit around the current time
      const e = D.epochs[nearest(D.epochs, curTime() ?? D.epochs[0]?.t0, (x) => x.t0)];
      if (e) { S.start = e.start.slice(0, 16); S.end = new Date(e.t1 + 6e4).toISOString().slice(0, 16); }
    }
    const t0 = Date.parse(S.start + ":00Z"), t1 = Date.parse(S.end + ":59.999Z");
    const n = D.frames.filter((f) => f.t >= t0 && f.t <= t1).length;
    D.wins = isNaN(t0) || isNaN(t1) ? [] : [{ start: S.start + ":00", end: S.end + ":59.999", n, label: "custom", t0, t1 }];
  } else D.wins = D.epochs;
}

function useBand() {
  D.frames = S.band ? D.all.filter((f) => f.band === S.band) : D.all.slice();
}

async function refresh(keepTime) {
  D.view = null;                          // visits may differ for another band or window
  try { await loadWindows(); } catch (e) { showState("Could not read the visits.<br><span class='note'>" + e.message + "</span>"); return; }
  const list = items();
  S.i = keepTime == null ? Math.min(S.i, Math.max(0, list.length - 1))
    : nearest(list, keepTime, (x) => x.t ?? (x.t0 + x.t1) / 2);
  writeUrl(); paint(); listeners.forEach((f) => f());
}

export async function search(q, opts = {}) {
  stop();
  const prev = { q: S.q, det: S.det };
  Object.assign(S, opts, { q: q.trim() });
  if (!S.q) return;
  if (prev.q !== S.q || prev.det !== S.det) { D.limits = { frames: null, stacks: null }; D.pin = null; pinPanel(); }
  if (prev.q !== S.q) SP.close();
  D.info = null; D.all = []; D.frames = []; D.epochs = []; D.wins = []; D.seq++; D.view = null;
  api.cancelBackground();
  controls(); caption(); TL.draw(); blank($("cv"));
  showState("Searching for frames…<br><span class='note'>about 4 seconds</span>");
  writeUrl();
  let info;
  try { info = await api.frames(base()); } catch (e) {
    showState(e.status === 400 || e.status === 422
      ? "I don’t understand these coordinates.<br>Example: 83.82 -5.39 or 08h55m10.8s -07d14m42s"
      : "Could not search for frames.<br><span class='note'>" + e.message + "</span>");
    pickerKey = "error";
    picker.setData({ detector: DET[S.det - 1][0], range: [DET[S.det - 1][1], DET[S.det - 1][2]], bands: [], selected: 0 });
    listeners.forEach((f) => f());
    return;
  }
  if (S.q !== q.trim()) return;                       // a newer search started
  D.info = info;
  D.all = info.frames.map((f) => ({ ...f, t: Date.parse(f.date_obs) }));
  listeners.forEach((f) => f());
  if (!D.all.length) {
    controls();
    showState(info.hidden_cropped
      ? "All photos here are cropped.<br>Turn on Show cropped frames in Advanced settings, or pick a smaller field."
      : "No SPHEREx photos of this spot with this camera yet.");
    return;
  }
  hideState();
  if (S.band && !D.all.some((f) => f.band === S.band)) S.band = 0;
  useBand();
  await refresh(null);
}

// ---------- modes and playback ----------
export function setMode(m) {
  const keep = curTime();
  if ((m === "blink" || m === "diff") && D.epochs.length < 2) {
    toast("Blink and Diff need two visits; this spot has " + D.epochs.length + ".");
    return;
  }
  S.mode = m; D.tog = 0;
  if (m === "frames" || m === "stacks") {
    const list = items();
    if (keep != null && list.length) S.i = nearest(list, keep, (x) => x.t ?? (x.t0 + x.t1) / 2);
  } else if (D.play && m === "diff") stop();
  writeUrl(); paint(); loop();
}

function stop() { clearTimeout(D.timer); D.play = false; $("play").textContent = "▶"; $("play").setAttribute("aria-label", "Play"); }
async function loop() {
  clearTimeout(D.timer);
  if (!D.play) return;
  const m = S.mode;
  if (m === "diff") { stop(); return; }
  if (m === "blink") D.tog = 1 - D.tog;
  else {
    const vis = TL.visibleItems();
    if (!vis.length) { stop(); return; }
    const k = vis.indexOf(S.i);
    S.i = vis[(k + 1) % vis.length];
  }
  await paint();
  if (D.play) D.timer = setTimeout(loop, PLAY_MS[m]);
}
export function toggle() {
  D.play = !D.play;
  $("play").textContent = D.play ? "❚❚" : "▶";
  $("play").setAttribute("aria-label", D.play ? "Pause" : "Play");
  if (D.play) loop(); else { clearTimeout(D.timer); writeUrl(); }
}
function step(d) {
  const n = items().length;
  if (!n) return;
  D.dir = d < 0 ? -1 : 1;
  S.i = Math.max(0, Math.min(n - 1, S.i + d)); writeUrl(); paint();
}
function select(i) { S.i = i; writeUrl(); paint(); }
// Blink / Diff: a visit picked on the timeline becomes B; picking A swaps the two
function selectB(k) {
  const a = Math.min(S.ea, D.epochs.length - 1), b = S.eb < 0 ? D.epochs.length - 1 : S.eb;
  if (k === b) return;
  if (k === a) { S.ea = b; S.eb = a; } else S.eb = k;
  D.tog = 0; writeUrl(); paint();
}

// What the picture shows now, as /api/point parameters (the image the click is snapped on).
function shown() {
  const m = S.mode, it = cur();
  const p = { ...base(), band: S.band || "", method: S.method, bg: S.bgm };
  if (m === "frames") return it ? { ...p, kind: "frame", path: it.path } : null;
  const w = m === "stacks" ? it : m === "blink" ? (D.tog ? epB() : epA()) : epB();
  return w && w.n ? { ...p, kind: "stack", start: w.start, end: w.end } : null;
}

// ---------- hover and pin ----------
function pointAt(e) {
  const r = $("cv").getBoundingClientRect();
  const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
  const [ra, dec] = skyAt(D.info.ra, D.info.dec, fx, fy, S.fov);
  return { fx, fy, ra, dec };
}
function whenText() {
  const m = S.mode, it = cur();
  if (m === "frames" && it) return stamp(it.date_obs);
  if (m === "stacks" && it) return day(it.start) + " – " + day(it.end);
  if (m === "blink") return month((D.tog ? epB() : epA()).start);
  if (m === "diff") return month(epA().start) + " → " + month(epB().start);
  return "—";
}
function colourText() {
  const it = cur();
  if (S.mode === "frames" && it?.lambda_um) return "λ " + it.lambda_um.toFixed(3) + " µm";
  const w = S.mode === "stacks" ? it : S.mode === "blink" ? (D.tog ? epB() : epA()) : null;
  return w ? lamRange(w).replace(" · ", "") || "—" : "—";
}
function infoDl(p, short = false) {
  const when = short ? whenText().replace(/ \d{4}(?= –)/, "").replace(" UTC", "") : whenText();
  return "<dl class='mono'><dt>RA</dt><dd>" + hms(p.ra) + "</dd><dt>Dec</dt><dd>" + dms(p.dec) + "</dd>"
    + (short ? "" : "<dt>Degrees</dt><dd>" + p.ra.toFixed(4) + " " + p.dec.toFixed(4) + "</dd>")
    + "<dt>Date</dt><dd>" + when + "</dd><dt>Detector</dt><dd>" + DET[S.det - 1][0]
    + (short ? "" : " · " + DET[S.det - 1][1] + "–" + DET[S.det - 1][2] + " µm") + "</dd><dt>"
    + (short ? "Colour" : "Colour at centre") + "</dt><dd>" + colourText().replace(" µm", short ? "" : " µm") + "</dd></dl>";
}
function ring2() {
  const r = $("ring2");
  if (!D.pin || !D.info || AP.ap.on) { r.style.display = "none"; return; }
  r.style.cssText = "display:block;left:" + D.pin.fx * 100 + "%;top:" + D.pin.fy * 100 + "%";
}
function pinPanel() {
  const el = $("pin");
  if (!D.pin) {
    el.innerHTML = "<h2>Point details" + tipHtml("Details about the point you click. Checking it against star catalogs is coming soon.").replace('class="tip"', 'class="tip r"') + "</h2><p class='note'>Click a star to see its spectrum. Alt+click measures exactly where you click; drag a circle over a nebula to measure an area.</p>";
    return;
  }
  el.innerHTML = "<h2>This point</h2>" + infoDl(D.pin)
    + "<div style='margin-top:10px'><button class='ghost' id='tosp' style='padding:4px 12px'>Spectrum</button></div>"
    + "<div style='margin-top:10px;font-size:13px' class='row'><button class='ghost' disabled style='padding:4px 12px'>Check catalogs</button><span class='badge soon'>Coming soon</span>"
    + tipHtml("Will look this point up in the Gaia and AllWISE star catalogs for the date of the photo. A real search takes 25–35 seconds.")
    + "</div><div style='margin-top:10px'><button class='ghost' id='toan' style='padding:4px 12px'>Field analytics</button></div>";
  $("toan").onclick = () => { location.hash = "analytics"; };
  $("tosp").onclick = () => SP.open({ ra: D.pin.ra, dec: D.pin.dec, mode: "point", snap: true });
}

// ---------- wiring ----------
export function init() {
  PRESETS.forEach((p) => {
    const b = document.createElement("button");
    b.className = "chip"; b.dataset.q = p.q; b.setAttribute("aria-pressed", "false");
    b.innerHTML = p.n + "<small>" + p.h + "</small>";
    b.onclick = () => search(p.q, { det: p.det, fov: p.fov, mode: p.mode, band: 0, i: 0, ea: 0, eb: -1 });
    $("chips").appendChild(b);
  });
  DET.forEach((d, k) => { const o = document.createElement("option"); o.value = k + 1; o.textContent = d[0] + " · " + d[1] + "–" + d[2] + " µm"; $("det").appendChild(o); });

  $("go").onclick = () => { const q = $("q").value.trim(); if (q) search(q, { i: 0 }); };
  $("q").onkeydown = (e) => { if (e.key === "Enter") $("go").onclick(); };
  $("share").onclick = () => {
    try { navigator.clipboard.writeText(location.href).then(() => toast("Link copied"), () => toast("Copy the address bar link")); }
    catch (e) { toast("Copy the address bar link"); }
  };
  [].forEach.call($("mode").children, (b) => { b.onclick = () => setMode(b.dataset.v); });
  $("ea").onchange = $("eb").onchange = () => { S.ea = +$("ea").value; S.eb = +$("eb").value; D.tog = 0; writeUrl(); paint(); };
  $("det").onchange = () => { if (S.q) search(S.q, { det: +$("det").value, band: 0, i: 0 }); else S.det = +$("det").value; };
  $("fov").oninput = () => { $("fovv").textContent = $("fov").value + "′"; };
  $("fov").onchange = () => { if (S.q) search(S.q, { fov: +$("fov").value }); else S.fov = +$("fov").value; };
  picker = ColourBand($("cb"), { onChange: (d) => setBand(d.band) });
  [].forEach.call($("bgseg").children, (b) => { b.onclick = () => { S.orig = b.dataset.v === "raw"; D.limits = { frames: null, stacks: null }; writeUrl(); paint(); }; });
  $("bgm").onchange = () => { S.bgm = $("bgm").value; D.limits = { frames: null, stacks: null }; writeUrl(); paint(); };
  $("crop").onchange = () => { if (S.q) search(S.q, { crop: $("crop").checked }); else S.crop = $("crop").checked; };
  $("same").onchange = () => { S.same = $("same").checked; D.limits = { frames: null, stacks: null }; writeUrl(); paint(); };
  $("holes").onchange = () => { S.holes = $("holes").checked; writeUrl(); paint(); };
  $("method").onchange = () => { S.method = $("method").value; writeUrl(); paint(); };
  $("cmpm").onchange = () => { S.cmp = $("cmpm").checked ? $("method2").value : ""; writeUrl(); paint(); };
  $("method2").onchange = () => { S.cmp = $("method2").value; writeUrl(); paint(); };
  $("win").onchange = () => { S.win = $("win").value; if (D.all.length) refresh(curTime()); else writeUrl(); };
  ["c-start", "c-end"].forEach((id) => { $(id).onchange = () => { S.start = $("c-start").value; S.end = $("c-end").value; if (D.all.length) refresh(curTime()); }; });
  $("sl").oninput = () => { stop(); S.i = +$("sl").value; writeUrl(); paint(); };
  $("play").onclick = toggle;
  [].forEach.call($("stretch").children, (b) => { b.onclick = () => { S.stretch = b.dataset.v; D.limits = { frames: null, stacks: null }; writeUrl(); paint(); }; });
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.target.closest?.(".cb")) return;   // arrows on the band picker change the band only
    if ($("v-explore").hidden || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.code === "Space" && e.target.tagName !== "BUTTON") { e.preventDefault(); toggle(); }
    if (S.mode === "frames" || S.mode === "stacks") {
      if (e.key === "ArrowRight") { stop(); step(1); }
      if (e.key === "ArrowLeft") { stop(); step(-1); }
    }
  });
  const cv = $("cv");
  cv.onpointermove = (e) => {
    if (!D.info || !D.all.length) return;
    const p = pointAt(e), h = $("hover"), st = $("stage").getBoundingClientRect();
    h.innerHTML = "<b>This point</b>" + infoDl(p, true);
    let lx = e.clientX - st.left + 14, ly = e.clientY - st.top + 14;
    h.style.display = "block";
    if (lx > st.width - 230) lx -= 244;
    if (ly > st.height - 170) ly -= 180;
    lx = Math.max(4, Math.min(lx, st.width - 224)); ly = Math.max(4, Math.min(ly, st.height - h.offsetHeight - 4));
    h.style.cssText = "display:block;left:" + lx + "px;top:" + ly + "px";
  };
  cv.onpointerleave = () => { $("hover").style.display = "none"; };
  // click / Alt+click / drag on the picture: aperture.js; the spectrum window: spectrum.js
  const ready = () => !!(D.info && D.all.length);
  AP.init({ info: () => D.info, fov: () => S.fov, ready, onRadius: (r) => SP.radius(r),
    onPick: (p) => { D.pin = { fx: p.fx, fy: p.fy, ra: p.ra, dec: p.dec }; pinPanel(); SP.open(p); ring2(); } });
  SP.init({ epochs: () => D.epochs, epochIndex: () => (D.epochs.length ? nearest(D.epochs, curTime(), (e) => (e.t0 + e.t1) / 2) : -1),
    shown, onClose: () => ring2() });
  TL.init({ D, items, curTime, select, selectB, stop });
  pinPanel();
  showState("Type coordinates, pick a target above, or press ✦ Random patch.");
}

async function setBand(b) {
  if (b === S.band) return;
  const keep = curTime();
  S.band = b; useBand(); D.limits = { frames: null, stacks: null };
  await refresh(keep);
}

export async function randomPatch() {
  showState("Picking a random spot…");
  try {
    const r = await api.randomPoint(S.det);
    await search(r.coords, { fov: 6, mode: "frames", band: 0, i: 0, ea: 0, eb: -1 });
  } catch (e) { showState("Could not pick a random spot.<br><span class='note'>" + e.message + "</span>"); }
}
