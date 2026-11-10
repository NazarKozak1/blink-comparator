// Floating spectrum window for the point or area picked on the picture: aperture photometry of every frame of
// all six detectors in the chosen visit +-10 days (/api/spectrum, detector by detector, 3 at a time), the plot,
// features found (/api/features) and a second visit to compare with (moved by the Gaia proper motion, or re-snapped).
import * as api from "./api.js";
import * as AP from "./aperture.js";
import { $, DET, day, dms, hms, month } from "./util.js";
import { createWindow } from "./windows.js";

const PAD_DAYS = 10, PARALLEL = 3, LAM = [0.75, 5.0];
const HALF = { "Paα hydrogen": 0.02, "Brγ hydrogen": 0.02, "H₂O ice": 0.15, "PAH": 0.05, "CH₄": 0.06, "Brα hydrogen": 0.02, "CO₂ ice": 0.03, "CO ice": 0.03 };
const W = 560, H = 300, M = { l: 58, r: 12, t: 22, b: 38 };   // plot box

let ctx = null;          // {epochs(), epochIndex(), shown(), detector(), onClose()}
const P = { seq: 0, ra: 0, dec: 0, r: 10, mode: "point", snapped: false, snr: null, blend: false, nSrc: 1, note: "",
  ea: -1, eb: -1, A: null, B: null, features: [], warnings: [], cmpNote: "", ratio: null, conf: {}, ctrl: null, timer: null };
let el = null, win = null;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const isOpen = () => win && win.state !== "closed";      // open or minimised

// ---------- window (windows.js: drag, minimise to a tab, Esc, place) ----------
function build() {
  win = createWindow("spectrum", {
    title: "Spectrum", label: "Spectrum of the picked point", className: "spw",
    header: `<div class="spw-tabs" role="tablist"><button role="tab" aria-selected="true">Spectrum</button>
      <button role="tab" aria-selected="false" disabled title="Coming soon">Colours</button>
      <button role="tab" aria-selected="false" disabled title="Coming soon">Star</button></div>`,
    onClose: cleanup,
  });
  el = win.el; el.id = "spw";
  win.body.innerHTML = `
    <div class="spw-pos" id="spw-pos"></div>
    <div class="spw-row">
      <div class="seg" id="spw-mode" role="group" aria-label="What to measure">
        <button data-v="point" aria-pressed="true" title="One star or galaxy: total flux, aperture-corrected">Point source</button>
        <button data-v="extended" aria-pressed="false" title="A patch of nebula: flux inside the circle, no correction">Extended area</button></div>
      <label class="spw-rad">Radius <input type="range" id="spw-r" min="${AP.R_MIN}" max="${AP.R_MAX}" step="0.5"><span id="spw-rv"></span></label>
    </div>
    <div class="spw-row">
      <label>Visit <select id="spw-ea"></select></label>
      <label>Compare with <select id="spw-eb"></select></label>
    </div>
    <div class="spw-prog" id="spw-prog" aria-live="polite"></div>
    <div id="spw-warn"></div>
    <div class="spw-plot"><svg id="spw-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Spectrum: flux against wavelength"></svg>
      <div class="spw-tip" id="spw-tip"></div></div>
    <div class="spw-leg" id="spw-leg"></div>
    <div id="spw-feat"></div>
    <p class="note spw-foot" id="spw-foot"></p>`;
  [].forEach.call($("spw-mode").children, (b) => { b.onclick = () => { if (P.mode !== b.dataset.v) { P.mode = b.dataset.v; P.snapped = false; P.blend = false; rerun(); } }; });
  $("spw-r").oninput = () => { P.r = +$("spw-r").value; $("spw-rv").textContent = P.r + "″"; AP.show(P.ra, P.dec, P.r, P.blend, P.mode); later(); };
  $("spw-ea").onchange = () => { P.ea = +$("spw-ea").value; if (P.eb === P.ea) P.eb = -1; rerun(); };
  $("spw-eb").onchange = () => { P.eb = +$("spw-eb").value; compare(); };
  const svg = $("spw-svg");
  svg.addEventListener("pointermove", hover);
  svg.addEventListener("pointerleave", () => { $("spw-tip").style.display = "none"; });
}

// Closing (from the window or its tab) drops the circle; minimising keeps it.
function cleanup() {
  P.seq++; P.ctrl?.abort(); clearTimeout(P.timer);
  AP.hide(); ctx.onClose();
}
export function close() { win?.close(); }

// Short state for the tab: "loading 3/6" while measuring, else the position ("6h23m44s −9°24′").
function tabStatus() {
  const s = P.A?.status;
  const done = s ? Object.values(s).filter((x) => x === "ok" || x === "err").length : 0;
  if (!P.A || done < 6) return `loading ${done}/6`;
  const h = P.ra / 15, hh = Math.floor(h), m = Math.floor((h - hh) * 60), sec = Math.floor(((h - hh) * 60 - m) * 60);
  const d = Math.abs(P.dec), dd = Math.floor(d), dm = Math.floor((d - dd) * 60);
  return `${hh}h${String(m).padStart(2, "0")}m${String(sec).padStart(2, "0")}s ${P.dec < 0 ? "−" : "+"}${dd}°${String(dm).padStart(2, "0")}′`;
}

// ---------- picking ----------
export function init(c) { ctx = c; build(); }

// pick: {ra, dec, mode, snap, r?} from aperture.js
export async function open(pick) {
  const seq = ++P.seq;
  P.ctrl?.abort();
  win.open();             // a minimised window stays a tab, marked "updated"
  Object.assign(P, { ra: pick.ra, dec: pick.dec, mode: pick.mode, snapped: false, snr: null, blend: false, nSrc: 1, note: "",
    A: null, B: null, features: [], warnings: [], cmpNote: "", ratio: null, eb: -1 });
  if (pick.r) P.r = pick.r;
  P.ea = pick.ea ?? ctx.epochIndex();          // a visit picked in the window survives a rerun
  epochSelects();
  AP.show(P.ra, P.dec, P.r, false, P.mode);
  render();
  if (P.mode === "point") {
    const sh = ctx.shown();
    if (sh) {
      progress("Looking for a source here…");
      try {
        const q = await api.point({ ...sh, ra: P.ra, dec: P.dec, radius: P.r, snap: pick.snap ? 1 : 0 });
        if (seq !== P.seq) return;
        Object.assign(P, { ra: q.ra, dec: q.dec, snapped: q.snapped, snr: q.snr, blend: q.blend, nSrc: q.n_sources });
        if (pick.snap && !q.snapped) P.note = "No source here — measuring at the clicked point";
      } catch (e) { if (seq !== P.seq) return; P.note = "Could not look for a source: " + e.message; }
      AP.show(P.ra, P.dec, P.r, P.blend, P.mode);
    }
  }
  run(seq);
}

function rerun() {
  clearTimeout(P.timer);
  if (!isOpen()) return;
  open({ ra: P.ra, dec: P.dec, mode: P.mode, snap: P.mode === "point", r: P.r, ea: P.ea });
}
function later() { clearTimeout(P.timer); P.timer = setTimeout(() => { P.ctrl?.abort(); run(++P.seq); }, 450); }
export function radius(r) { if (!isOpen()) return; P.r = r; $("spw-r").value = r; $("spw-rv").textContent = r + "″"; later(); }

// ---------- measuring ----------
function windowOf(k) {
  const e = ctx.epochs()[k];
  return e && { start: new Date(e.t0 - PAD_DAYS * 864e5).toISOString(), end: new Date(e.t1 + PAD_DAYS * 864e5).toISOString(), e };
}

// Six detectors, PARALLEL at a time; each result is drawn as it comes.
async function measure(seq, k, pos, which) {
  const w = windowOf(k);
  const res = { dets: {}, status: {}, epoch: k };
  P[which] = res;
  if (!w) return res;
  for (let d = 1; d <= 6; d++) res.status[d] = "wait";
  render();
  const ctrl = P.ctrl = P.ctrl && !P.ctrl.signal.aborted && which === "B" ? P.ctrl : new AbortController();
  api.pauseBackground(true);
  try {
    const todo = [1, 2, 3, 4, 5, 6];
    const worker = async () => {
      while (todo.length) {
        const d = todo.shift();
        res.status[d] = "run"; render();
        try {
          const r = await api.spectrum({ ra: pos.ra, dec: pos.dec, start: w.start, end: w.end, detector: d, radius: P.r, mode: P.mode,
            pm_ra: pos.pm_ra, pm_dec: pos.pm_dec, t_ref: pos.t_ref }, ctrl.signal);
          if (seq !== P.seq) return;
          res.dets[d] = r.points; res.status[d] = "ok";
        } catch (e) {
          if (seq !== P.seq) return;
          res.status[d] = "err";
        }
        render();
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
  } finally { api.pauseBackground(false); }
  return res;
}
const detList = (ds) => {           // [1,2,3,4] -> "D1–D4", [1,3] -> "D1, D3"
  const s = [...ds].sort((a, b) => a - b), out = [];
  for (let i = 0; i < s.length;) { let j = i; while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++; out.push(j > i ? `D${s[i]}–D${s[j]}` : `D${s[i]}`); i = j + 1; }
  return out.join(", ");
};
const pointsOf = (res) => (res ? Object.values(res.dets).flat() : []);

async function run(seq) {
  P.features = []; P.warnings = []; P.B = null; P.ratio = null; P.cmpNote = ""; P.conf = {};
  const t = performance.now();
  await measure(seq, P.ea, { ra: P.ra, dec: P.dec }, "A");
  if (seq !== P.seq) return;
  P.A.seconds = (performance.now() - t) / 1000;
  const pts = pointsOf(P.A);
  if (pts.length) {
    try {
      const f = await api.features(pts);
      if (seq !== P.seq) return;
      P.features = f.features; P.warnings = f.warnings;
    } catch (e) { P.warnings = [{ kind: "error", text: "Features not checked: " + e.message }]; }
  }
  render();
  if (P.eb >= 0) await compare();
  if (seq === P.seq) confirmSingles(seq);
}

// A feature seen in one measurement only is looked for in other visits (the compared one first, then the
// nearest in time, at most 3), measuring just the detectors around it. Same name found there: confirmed.
const coreExtra = (hw) => (hw > 0.02 ? hw / 2 : 0);     // as photometry.core_extra
const detsFor = (lam) => [1, 2, 3, 4, 5, 6].filter((d) => DET[d - 1][2] >= lam / 1.26 && DET[d - 1][1] <= lam * 1.26);
async function confirmSingles(seq) {
  const singles = P.features.filter((f) => f.n === 1), eps = ctx.epochs();
  if (!singles.length) return;
  const others = eps.map((e, k) => k).filter((k) => k !== P.ea && k !== P.eb)
    .sort((x, y) => Math.abs(eps[x].t0 - eps[P.ea].t0) - Math.abs(eps[y].t0 - eps[P.ea].t0));
  const order = (P.eb >= 0 ? [P.eb] : []).concat(others).slice(0, 3);
  singles.forEach((f) => { P.conf[f.name] = { state: order.length ? "checking" : "alone", unseen: [] }; });
  render();
  const dets = [...new Set(singles.flatMap((f) => detsFor(f.lambda_um)))];
  api.pauseBackground(true);
  try {
    for (const k of order) {
      const todo = singles.filter((f) => P.conf[f.name].state === "checking");
      if (!todo.length) break;
      const w = windowOf(k);
      try {
        const rs = await Promise.all(dets.map((d) => api.spectrum({ ra: P.ra, dec: P.dec, start: w.start, end: w.end, detector: d,
          radius: P.r, mode: P.mode }, P.ctrl?.signal)));
        if (seq !== P.seq) return;
        const pts = rs.flatMap((r) => r.points);
        const found = pts.length ? (await api.features(pts)).features : [];
        if (seq !== P.seq) return;
        for (const f of todo) {
          const g = found.find((x) => x.name === f.name);
          const covered = pts.some((q) => !q.upper_limit && Math.abs(q.lambda_um - f.lambda_um) <= q.band_um / 2 + coreExtra(HALF[f.name] || 0.03));
          if (g) P.conf[f.name] = { ...P.conf[f.name], state: "confirmed", visit: k, sigma: g.sigma };
          else if (covered) P.conf[f.name].unseen.push(k);     // keep looking: another visit may still show it
        }
      } catch (e) { if (seq !== P.seq) return; }
      render();
    }
  } finally { api.pauseBackground(false); }
  singles.forEach((f) => {
    const c = P.conf[f.name];
    if (c.state === "checking") c.state = c.unseen.length ? "unseen" : "uncovered";
  });
  render();
}

// Second visit: a fast Gaia star is followed along its proper motion; any other source is snapped again on the
// stack of that visit. A source that is gone near its old place is probably moving fast (not supported yet).
async function compare() {
  P.B = null; P.ratio = null; P.cmpNote = "";
  render();
  if (P.eb < 0 || !P.A || P.A.seconds == null) return;     // run() calls this again when visit A is done
  const seq = P.seq, a = windowOf(P.ea), b = windowOf(P.eb);
  if (!a || !b) return;
  let pos = { ra: P.ra, dec: P.dec };
  if (P.mode === "point" && P.snapped) {
    progress("Checking the proper motion in Gaia DR3…");
    const mid = new Date((a.e.t0 + a.e.t1) / 2).toISOString();
    let m = null;
    try { m = await api.motion({ ra: P.ra, dec: P.dec, date: mid }); } catch (e) { m = { found: false }; }
    if (seq !== P.seq) return;
    if (m.found) {
      pos = { ...pos, pm_ra: m.pm_ra, pm_dec: m.pm_dec, t_ref: mid };
      P.cmpNote = `Followed along its Gaia DR3 motion: ${(Math.hypot(m.pm_ra, m.pm_dec) / 1000).toFixed(2)}″ per year`;
    } else {
      const sh = ctx.shown();
      try {
        const q = sh && await api.point({ ...sh, kind: "stack", path: "", start: b.e.start, end: b.e.end, ra: P.ra, dec: P.dec, radius: P.r, snap: 1 });
        if (seq !== P.seq) return;
        if (q && q.snapped) { pos = { ra: q.ra, dec: q.dec }; P.cmpNote = "Source found again on the stack of that visit"; }
        else P.cmpNote = "⚠ The source is not at this place in the other visit. It may be moving fast: fast-moving objects are not supported yet.";
      } catch (e) { P.cmpNote = "Could not look for the source in the other visit: " + e.message; }
      if (m.error) P.cmpNote += " (Gaia was not reachable.)";
    }
  }
  const res = await measure(seq, P.eb, pos, "B");
  if (seq !== P.seq) return;
  P.ratio = ratioBy(pointsOf(P.A), pointsOf(res));
  render();
}

// Flux ratio B / A per detector: every good point of B against A's spectrum of the same detector interpolated
// to its wavelength (A's neighbours at most 3 bands apart); median and its error from the scatter. One ratio for
// the whole spectrum would hide a star that brightens in blue and fades in red (RW Aur).
function ratioBy(a, b) {
  const good = (p) => !p.upper_limit && !p.n_bad_pixels && p.flux_ujy > 0;
  const out = [];
  for (let d = 1; d <= 6; d++) {
    const A = a.filter((p) => p.detector === d), B = b.filter((p) => p.detector === d);
    if (!A.length || !B.length) { out.push({ d, why: "no photos" }); continue; }
    const ga = A.filter(good).sort((x, y) => x.lambda_um - y.lambda_um), rs = [];
    for (const q of B.filter(good)) {
      const k = ga.findIndex((p) => p.lambda_um >= q.lambda_um);
      if (k <= 0) continue;
      const p0 = ga[k - 1], p1 = ga[k], dl = p1.lambda_um - p0.lambda_um;
      if (dl > 3 * q.band_um) continue;
      const f = dl > 0 ? p0.flux_ujy + (p1.flux_ujy - p0.flux_ujy) * (q.lambda_um - p0.lambda_um) / dl : (p0.flux_ujy + p1.flux_ujy) / 2;
      if (f > 0) rs.push(q.flux_ujy / f);
    }
    if (rs.length < 3) {
      const all = A.concat(B), sat = all.filter((p) => p.n_bad_pixels).length > all.length / 2;
      out.push({ d, why: sat ? "saturated" : "too few matching colours" });
      continue;
    }
    rs.sort((x, y) => x - y);
    const med = rs[rs.length >> 1], mad = rs.map((r) => Math.abs(r - med)).sort((x, y) => x - y)[rs.length >> 1];
    out.push({ d, med, n: rs.length, err: Math.max(1.2533 * 1.4826 * mad / Math.sqrt(rs.length), 0.005) });
  }
  return out;
}

// ---------- drawing ----------
function epochSelects() {
  const eps = ctx.epochs();
  const opt = (e, k) => `<option value="${k}">Visit ${k + 1} · ${month(e.start)}</option>`;
  $("spw-ea").innerHTML = eps.map(opt).join("");
  $("spw-ea").value = P.ea;
  $("spw-eb").innerHTML = `<option value="-1">—</option>` + eps.map((e, k) => (k === P.ea ? "" : opt(e, k))).join("");
  $("spw-eb").value = P.eb;
  $("spw-eb").disabled = eps.length < 2;
}
function progress(text) { $("spw-prog").textContent = text; }

function render() {
  if (!isOpen()) return;
  win.setStatus(tabStatus());
  $("spw-pos").innerHTML = `<span class="mono">${hms(P.ra)} ${dms(P.dec)}</span>`
    + (P.mode === "point" && P.snapped ? ` · <span title="Snapped to the brightest source near the click">snapped, S/N ${Math.round(P.snr)}</span>` : "")
    + (P.mode === "extended" ? " · extended area" : "");
  [].forEach.call($("spw-mode").children, (b) => b.setAttribute("aria-pressed", b.dataset.v === P.mode));
  $("spw-r").value = P.r; $("spw-rv").textContent = P.r + "″";
  const stat = (res, tag) => {
    if (!res) return "";
    const s = res.status, done = Object.values(s).filter((x) => x === "ok" || x === "err").length;
    const marks = [1, 2, 3, 4, 5, 6].map((d) => `<span class="st-${s[d]}">D${d}${s[d] === "ok" ? " ✓" : s[d] === "err" ? " ✕" : s[d] === "run" ? " …" : ""}</span>`).join(" ");
    return `<div>${tag}${marks} <b>${done} of 6</b>${done === 6 && res.seconds != null ? (res.seconds < 0.3 ? " · from cache" : ` · ${res.seconds.toFixed(1)} s`) : ""}</div>`;
  };
  if (P.A) $("spw-prog").innerHTML = stat(P.A, P.B ? "A: " : "") + stat(P.B, "B: ");
  const warn = [];
  if (P.note) warn.push(["info", P.note]);
  if (P.blend && P.mode === "point") warn.push(["hot", P.nSrc > 1 ? `⚠ Blended: ${P.nSrc} sources — spectrum mixes ${P.nSrc > 2 ? "them" : "both"}`
    : "⚠ Elongated source: probably two blended sources — the spectrum may mix both"]);
  const sat = P.warnings.filter((w) => w.kind === "saturated").map((w) => w.detector);
  if (sat.length) warn.push(["warm", `⚠ Too bright for ${detList(sat)}: the core is saturated there, so those fluxes are too low`]);
  P.warnings.filter((w) => w.kind !== "saturated").forEach((w) => warn.push([w.kind === "variable" ? "warm" : "info", "⚠ " + w.text]));
  if (P.cmpNote) warn.push([P.cmpNote.startsWith("⚠") ? "warm" : "info", P.cmpNote]);
  $("spw-warn").innerHTML = warn.map(([c, t]) => `<p class="spw-w ${c}">${esc(t)}</p>`).join("") + ratioTable();
  plot();
  $("spw-foot").textContent = (P.mode === "point"
    ? "Every dot is one SPHEREx photo: the flux inside the circle minus the sky around it (dashed ring), corrected for the starlight outside the circle."
    : "Every dot is one SPHEREx photo: all the light inside the circle minus NASA's model of the zodiacal glow.")
    + " The six detectors see different colours, so together they make a spectrum.";
  const pts = pointsOf(P.A);
  const allDone = P.A && Object.values(P.A.status).every((x) => x === "ok" || x === "err");
  $("spw-feat").innerHTML = !allDone ? "" : !pts.length ? `<p class="note">No photos of this place in this visit.</p>`
    : P.features.length ? "<b>Found</b><ul>" + P.features.map((f) => `<li><b>${esc(f.name)}</b> ${f.lambda_um} µm · ${f.kind} ×${f.ratio} of the continuum · ${f.sigma}σ`
      + (f.tau != null ? ` · τ ${f.tau}` : "") + ` · ${f.n > 1 ? f.n + " measurements" : confText(f)}</li>`).join("") + "</ul>"
    : `<p class="note">No emission or absorption features found. A feature needs ≥3σ in 3 neighbouring colours, or ≥5σ where this visit has only one or two colours on it.</p>`;
}

function confText(f) {
  const c = P.conf[f.name] || {}, v = (k) => "visit " + (k + 1);
  const base = `<span class="spw-single">single measurement</span>`;
  if (c.state === "checking") return base + " · checking other visits…";
  const miss = (c.unseen || []).map((k) => k + 1).join(", ");
  if (c.state === "confirmed") return base + ` · <span class="spw-ok">confirmed in 2 visits</span> (also ${v(c.visit)}, ${c.sigma}σ)`
    + (miss ? `; not seen in visit ${miss}` : "");
  if (c.state === "unseen") return base + ` · <span class="spw-no">not seen in visit ${miss}</span>: an artefact, or the source changed`;
  if (c.state === "uncovered") return base + " · other visits have no colour on it";
  return base + " · no other visit to check";
}

// Per-detector brightness change between the two visits.
function ratioTable() {
  if (!P.ratio) return "";
  const rows = P.ratio.map((r) => {
    if (r.med == null) return `<tr><th>D${r.d}</th><td colspan="2" class="note">${r.why}</td></tr>`;
    const pct = Math.round((r.med - 1) * 100), real = Math.abs(r.med - 1) > 3 * r.err && Math.abs(pct) >= 5;
    return `<tr><th>D${r.d}</th><td>×${r.med.toFixed(2)} ± ${r.err.toFixed(2)} <span class="note">(${r.n})</span></td>`
      + `<td class="${real ? (pct < 0 ? "spw-fade" : "spw-bright") : "note"}">${real ? Math.abs(pct) + "% " + (pct < 0 ? "fainter" : "brighter") : "no clear change"}</td></tr>`;
  }).join("");
  return `<div class="spw-ratio"><b>Visit ${P.eb + 1} / visit ${P.ea + 1}, by detector</b><table>${rows}</table></div>`;
}

let marks = [];          // hover targets: {x, y, p, which}
function plot() {
  const svg = $("spw-svg"), A = pointsOf(P.A), B = pointsOf(P.B);
  const all = A.concat(B);
  const val = (p) => (p.upper_limit ? p.limit_ujy : p.flux_ujy);
  const pos = all.map(val).filter((v) => v > 0);
  const x = (l) => M.l + (l - LAM[0]) / (LAM[1] - LAM[0]) * (W - M.l - M.r);
  let lo = pos.length ? Math.min(...pos) : 1, hi = pos.length ? Math.max(...pos) : 10;
  const useLog = pos.length && hi / lo > 30;
  let y;
  if (useLog) {
    lo = Math.pow(10, Math.floor(Math.log10(lo))); hi = Math.pow(10, Math.ceil(Math.log10(hi)));
    y = (v) => H - M.b - (Math.log10(Math.max(v, lo)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)) * (H - M.t - M.b);
  } else {
    const ext = all.map((p) => (p.upper_limit ? p.limit_ujy : p.flux_ujy + p.err_ujy));
    const mn = Math.min(0, ...all.map((p) => (p.upper_limit ? 0 : p.flux_ujy - p.err_ujy)));
    lo = mn; hi = ext.length ? Math.max(...ext) * 1.08 : 10;
    if (hi <= lo) hi = lo + 1;
    y = (v) => H - M.b - (v - lo) / (hi - lo) * (H - M.t - M.b);
  }
  const g = [];
  // features (behind everything)
  P.features.forEach((f) => {
    const h = HALF[f.name] || 0.03;
    g.push(`<rect class="sp-feat" x="${x(f.lambda_um - h)}" y="${M.t}" width="${Math.max(3, x(f.lambda_um + h) - x(f.lambda_um - h))}" height="${H - M.t - M.b}"/>`
      + `<text class="sp-ft" x="${x(f.lambda_um)}" y="${M.t - 6}" text-anchor="middle">${esc(f.name.replace(" hydrogen", ""))}</text>`);
  });
  // axes and grid
  for (let l = 1; l <= 5; l++) g.push(`<line class="sp-grid" x1="${x(l)}" x2="${x(l)}" y1="${M.t}" y2="${H - M.b}"/><text class="sp-ax" x="${x(l)}" y="${H - M.b + 14}" text-anchor="middle">${l}</text>`);
  g.push(`<text class="sp-ax" x="${(M.l + W - M.r) / 2}" y="${H - 4}" text-anchor="middle">wavelength, µm</text>`);
  const ticks = useLog ? range10(lo, hi) : nice(lo, hi);
  ticks.forEach((v) => g.push(`<line class="sp-grid" x1="${M.l}" x2="${W - M.r}" y1="${y(v)}" y2="${y(v)}"/><text class="sp-ax" x="${M.l - 6}" y="${y(v) + 4}" text-anchor="end">${fmtFlux(v)}</text>`));
  g.push(`<text class="sp-ax" transform="translate(12 ${(M.t + H - M.b) / 2}) rotate(-90)" text-anchor="middle">flux, µJy${useLog ? " (log)" : ""}</text>`);
  // detector ranges along the bottom
  DET.forEach((d) => g.push(`<line x1="${x(d[1]) + 1}" x2="${x(d[2]) - 1}" y1="${H - M.b}" y2="${H - M.b}" stroke="${d[3]}" stroke-width="3"/>`));
  marks = [];
  const dotsOf = (pts, which) => pts.forEach((p) => {
    const cx = x(p.lambda_um), col = DET[p.detector - 1][3];
    if (p.upper_limit) {
      const cy = y(p.limit_ujy);
      g.push(`<path class="sp-ul ${which}" d="M${cx} ${cy}v12m-4 -5l4 5l4 -5" stroke="${which === "B" ? "var(--vio)" : col}"/>`);
      marks.push({ x: cx, y: cy, p, which });
      return;
    }
    const cy = y(p.flux_ujy);
    const e0 = y(p.flux_ujy - p.err_ujy), e1 = y(p.flux_ujy + p.err_ujy);
    if (Math.abs(e0 - e1) > 2) g.push(`<line class="sp-err" x1="${cx}" x2="${cx}" y1="${e0}" y2="${e1}" stroke="${which === "B" ? "var(--vio)" : col}"/>`);
    g.push(which === "B" ? `<circle class="sp-b" cx="${cx}" cy="${cy}" r="3.5"/>` : `<circle class="sp-a" cx="${cx}" cy="${cy}" r="3.5" fill="${col}"/>`);
    marks.push({ x: cx, y: cy, p, which });
  });
  dotsOf(A, "A"); dotsOf(B, "B");
  if (!all.length) g.push(`<text class="sp-ax" x="${W / 2}" y="${H / 2}" text-anchor="middle">${P.A && Object.values(P.A.status).some((s) => s === "run" || s === "wait") ? "Measuring…" : ""}</text>`);
  svg.innerHTML = g.join("");
  const eps = ctx.epochs();
  const lab = (k) => (eps[k] ? `Visit ${k + 1} · ${month(eps[k].start)}` : "");
  $("spw-leg").innerHTML = DET.map((d) => `<span><i style="background:${d[3]}"></i>${d[0]}</span>`).join("")
    + (P.B ? `<span><i class="a"></i>${lab(P.ea)}</span><span><i class="b"></i>${lab(P.eb)}</span>` : "")
    + `<span><i class="ul">↓</i>upper limit (3σ)</span>`;
}
const fmtFlux = (v) => (Math.abs(v) >= 1e6 ? (v / 1e6).toPrecision(2) + " Jy" : Math.abs(v) >= 1e3 ? (v / 1e3).toPrecision(3).replace(/\.?0+$/, "") + " mJy" : (+v.toPrecision(3)).toString());
function range10(lo, hi) { const out = []; for (let v = lo; v <= hi * 1.001; v *= 10) out.push(v); return out; }
function nice(lo, hi) {
  const step0 = (hi - lo) / 4, m = Math.pow(10, Math.floor(Math.log10(step0))), f = step0 / m;
  const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * m;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(+v.toPrecision(6));
  return out;
}

function hover(e) {
  const svg = $("spw-svg"), r = svg.getBoundingClientRect(), sx = (e.clientX - r.left) * W / r.width, sy = (e.clientY - r.top) * H / r.height;
  let best = null, bd = 14;
  for (const m of marks) { const d = Math.hypot(m.x - sx, (m.y - sy) * 0.5); if (d < bd) { bd = d; best = m; } }
  const t = $("spw-tip");
  if (!best) { t.style.display = "none"; return; }
  const p = best.p;
  const flux = p.upper_limit ? `&lt; ${fmtFlux(p.limit_ujy)}${p.limit_ujy < 1e3 ? " µJy" : ""} (3σ)` : `${fmtFlux(p.flux_ujy)}${p.flux_ujy < 1e3 ? " µJy" : ""} ± ${fmtFlux(p.err_ujy)}${p.err_ujy < 1e3 ? " µJy" : ""}`;
  t.innerHTML = `<b>${DET[p.detector - 1][0]} · ${p.lambda_um.toFixed(3)} µm</b> <span class="note">(band ${p.band_um.toFixed(3)})</span><br>${flux}<br>`
    + `<span class="note">${day(p.date)}${P.B ? " · visit " + ((best.which === "A" ? P.ea : P.eb) + 1) : ""}<br>`
    + (P.mode === "point" ? `aperture-corrected ×${(p.aperture_corr || 1).toFixed(2)}` : "area: sky = zodiacal model, no aperture correction")
    + (p.n_bad_pixels ? ` · ${p.n_bad_pixels} bad pixel${p.n_bad_pixels > 1 ? "s" : ""} left out` : "")
    + (p.n_warn_pixels ? ` · ${p.n_warn_pixels} flagged` : "") + "</span>";
  t.style.display = "block";
  const box = t.parentElement.getBoundingClientRect();
  let lx = e.clientX - box.left + 12, ly = e.clientY - box.top + 12;
  if (lx + t.offsetWidth > box.width) lx = e.clientX - box.left - t.offsetWidth - 12;
  if (ly + t.offsetHeight > box.height) ly = Math.max(0, e.clientY - box.top - t.offsetHeight - 12);
  t.style.left = Math.max(0, lx) + "px"; t.style.top = ly + "px";
}
