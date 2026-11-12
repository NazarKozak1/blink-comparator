// Floating spectrum window for the place picked on the picture: a click of the Spectrum tool or "Measure spectrum
// here" (a 10" circle) or a dragged circle (its own size). Two ways to process it, switched in the window:
// Ring background (mode "point": snap to the brightest pixel, sky from a ring, aperture correction, proper motion
// when comparing visits) and Sky-model background (mode "extended": the circle as drawn, IMAGE - ZODI, no correction).
// Aperture photometry of every frame of the six detectors in the chosen visit +-10 days (/api/spectrum, 3 at a
// time), features (/api/features) and a second visit to compare with.
import * as api from "./api.js";
import * as AP from "./aperture.js";
import { $, DET, day, dms, hms, month } from "./util.js";
import { createWindow } from "./windows.js";

const PAD_DAYS = 10, PARALLEL = 3, LAM = [0.75, 5.0];
const CLICK_R = 10;      // arcsec, the circle of a click
const HALF = { "Paα hydrogen": 0.02, "Brγ hydrogen": 0.02, "H₂O ice": 0.15, "PAH": 0.05, "CH₄": 0.06, "Brα hydrogen": 0.02, "CO₂ ice": 0.03, "CO ice": 0.03 };
const W = 560, H = 300, M = { l: 58, r: 12, t: 22, b: 38 };   // plot box
const METHODS = [["point", "Ring background"], ["extended", "Sky-model background"]];   // mode as /api/spectrum takes it

// cra / cdec: the place picked (a visit change snaps again from it); ra / dec: the circle on screen (snapped for Ring)
let ctx = null;          // {epochs(), epochIndex(), shown(), onClose()}
const P = { seq: 0, cra: 0, cdec: 0, ra: 0, dec: 0, r: CLICK_R, mode: "point", exact: false, looking: false, snapped: false,
  snr: null, blend: false, nSrc: 1, note: "", motion: null, ea: -1, eb: -1, A: null, B: null, features: [], warnings: [],
  cmpNote: "", ratio: null, conf: {}, ctrl: null, busy: false };
let el = null, win = null;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const isOpen = () => win && win.state !== "closed";      // open or minimised

const INFO_T = "Each dot is one SPHEREx photo of this place. The six detectors see different colours, so together they make a spectrum.\n"
  + "Click (a 10″ circle) or drag a circle of any size, then pick how the sky behind it is removed.";
const INFO_LIST = "Ring background :: for stars and other point-like sources. The circle moves to the brightest pixel near the click, the sky is measured in the dashed ring around it, and the flux is corrected for the starlight that falls outside the circle. When two visits are compared, a fast star (Gaia DR3 or SIMBAD) is followed along its motion. ;; "
  + "Sky-model background :: for nebulae, galaxies and other extended areas. The circle stays where it is, the sky is NASA’s model of the zodiacal glow, there is no correction and no motion: a ring would remove the nebula itself. ;; "
  + "Default :: a click uses Ring, a dragged circle uses Sky-model. Alt+click: Ring exactly where you click. ;; "
  + "Features :: a line or band is shown when it stands out by ≥3σ in 3 neighbouring colours, or by ≥5σ where the visit has only one or two colours on it. One seen in a single measurement is looked for in other visits. ;; "
  + "Compare with :: the flux ratio of two visits, detector by detector, from the detectors that are not saturated.";

// ---------- window (windows.js: drag, minimise to a tab, Esc, place) ----------
function build() {
  win = createWindow("spectrum", {
    title: "Spectrum", label: "Spectrum of the picked place", className: "spw",
    header: `<span class="tip" tabindex="0" role="note" data-t="${esc(INFO_T)}" data-list="${esc(INFO_LIST)}">i</span>`,
    onClose: cleanup,
  });
  el = win.el; el.id = "spw"; el.dataset.busy = "0";
  win.body.innerHTML = `
    <div class="seg sm spw-meth" id="spw-meth" role="group" aria-label="How the sky background is removed">`
    + METHODS.map(([v, t]) => `<button type="button" data-v="${v}" aria-pressed="false">${t}</button>`).join("") + `</div>
    <div class="spw-pos mono" id="spw-pos"></div>
    <div class="spw-row">
      <label>Visit <select id="spw-ea"></select></label>
      <label>Compare with <select id="spw-eb"></select></label>
    </div>
    <div class="spw-prog" id="spw-prog" aria-live="polite"></div>
    <div id="spw-warn"></div>
    <div id="spw-cmp"></div>
    <div class="spw-plot"><svg id="spw-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Spectrum: flux against wavelength"></svg>
      <div class="spw-tip" id="spw-tip"></div></div>
    <div class="spw-leg" id="spw-leg"></div>
    <div id="spw-feat"></div>`;
  $("spw-ea").onchange = () => { P.ea = +$("spw-ea").value; if (P.eb === P.ea) P.eb = -1; rerun({}); };
  $("spw-eb").onchange = () => { P.eb = +$("spw-eb").value; setBusy(true); compare(); };
  // another method: the circle stays where it is on screen (keep), only the processing changes
  [].forEach.call($("spw-meth").children, (b) => {
    b.onclick = () => { if (b.dataset.v !== P.mode) rerun({ ra: P.ra, dec: P.dec, mode: b.dataset.v, keep: true }); };
  });
  const svg = $("spw-svg");
  svg.addEventListener("pointermove", hover);
  svg.addEventListener("pointerleave", () => { $("spw-tip").style.display = "none"; });
}

// data-busy on the window: "1" while measuring the visit(s) (screenshot scripts wait for "0")
function setBusy(b) { P.busy = b; if (el) el.dataset.busy = b ? "1" : "0"; }

// Closing (from the window or its tab) drops the circle; minimising keeps it.
function cleanup() {
  P.seq++; P.ctrl?.abort(); setBusy(false);
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

// pick: {ra, dec, mode, snap, r?} from aperture.js / explore.js: a click = "point" (Ring; snap false = Alt+click),
// a dragged circle = "extended" (Sky-model) with its r; also {ea, eb} on a rerun, keep = do not move the circle
// (a method switch: Ring still asks for a source there, for S/N, blends and "No point source found here")
export async function open(pick) {
  const seq = ++P.seq;
  P.ctrl?.abort();
  win.open();             // a minimised window stays a tab, marked "updated"
  const mode = pick.mode === "extended" ? "extended" : "point";
  Object.assign(P, { cra: pick.ra, cdec: pick.dec, ra: pick.ra, dec: pick.dec, mode, r: pick.r || CLICK_R,
    exact: pick.snap === false && mode === "point", looking: mode === "point", snapped: false, snr: null, blend: false,
    nSrc: 1, note: "", motion: null, A: null, B: null, features: [], warnings: [], cmpNote: "", ratio: null, eb: pick.eb ?? -1 });
  P.ea = pick.ea ?? ctx.epochIndex();          // a visit picked in the window survives a rerun
  setBusy(true);
  epochSelects();
  AP.show(P.ra, P.dec, P.r, false, P.mode);
  render();
  if (mode === "point") {
    // Ring: snap to the brightest pixel near the place (Alt+click: exactly there, only the blend check)
    progress("Looking for a point source…");
    const sh = ctx.shown();
    let q = null;
    if (sh) {
      try { q = await api.point({ ...sh, ra: P.ra, dec: P.dec, radius: P.r, snap: P.exact ? 0 : 1 }); }
      catch (e) { if (seq !== P.seq) return; P.note = "Could not look for a point source: " + e.message; }
    }
    if (seq !== P.seq) return;
    P.looking = false;
    if (q) Object.assign(P, pick.keep ? {} : { ra: q.ra, dec: q.dec }, { snapped: q.snapped, snr: q.snr, blend: q.blend, nSrc: q.n_sources });
    if (q && !q.snapped && !P.exact) P.note = "No point source found here";
    AP.show(P.ra, P.dec, P.r, P.blend, P.mode);
  }
  run(seq);
}

// The same circle again (another method or visit), from the place picked unless o says where; the compared visit is kept.
function rerun(o) {
  if (!isOpen()) return;
  open({ ra: P.cra, dec: P.cdec, mode: P.mode, snap: !P.exact, r: P.r, ea: P.ea, eb: P.eb, ...o });
}

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
const allDone = (res) => !!res && Object.values(res.status).every((x) => x === "ok" || x === "err");
const satDets = () => P.warnings.filter((w) => w.kind === "saturated").map((w) => w.detector);

async function run(seq) {
  P.features = []; P.warnings = []; P.B = null; P.ratio = null; P.cmpNote = ""; P.conf = {}; P.motion = null;
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
  if (seq !== P.seq) return;
  setBusy(false); render();
  confirmSingles(seq);
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

// Second visit, Ring: a fast star is followed along its proper motion (Gaia DR3, else SIMBAD); a snapped source the
// catalogs do not know is snapped again on the stack of that visit. Sky-model: the circle stays where it is.
async function compare() {
  P.B = null; P.ratio = null; P.cmpNote = ""; P.motion = null;
  render();
  if (!P.A || P.A.seconds == null) return;     // run() calls this again when visit A is done
  const seq = P.seq, a = windowOf(P.ea), b = windowOf(P.eb);
  if (P.eb < 0 || !a || !b) { setBusy(false); render(); return; }
  let pos = { ra: P.ra, dec: P.dec };
  if (P.mode === "point") {
    progress("Checking the motion of the source…");
    const mid = new Date((a.e.t0 + a.e.t1) / 2).toISOString();
    let m = null;
    try { m = await api.motion({ ra: P.ra, dec: P.dec, date: mid }); } catch (e) { m = { found: false }; }
    if (seq !== P.seq) return;
    if (m.found) {
      pos = { ...pos, pm_ra: m.pm_ra, pm_dec: m.pm_dec, t_ref: mid };
      P.motion = { speed: Math.hypot(m.pm_ra, m.pm_dec), from: `${m.catalog || "Gaia DR3"} ${m.source_id}` };
    } else if (P.snapped) {
      const sh = ctx.shown();
      try {
        const q = sh && await api.point({ ...sh, kind: "stack", path: "", start: b.e.start, end: b.e.end, ra: P.ra, dec: P.dec, radius: P.r, snap: 1 });
        if (seq !== P.seq) return;
        if (q && q.snapped) pos = { ra: q.ra, dec: q.dec };
        else P.cmpNote = "⚠ The source is not at this place in the other visit. It may be moving fast: fast-moving objects are not supported yet.";
      } catch (e) { P.cmpNote = "Could not look for the source in the other visit: " + e.message; }
    }
  }
  const res = await measure(seq, P.eb, pos, "B");
  if (seq !== P.seq) return;
  P.ratio = ratioBy(pointsOf(P.A), pointsOf(res));
  setBusy(false);
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
const isReal = (r) => Math.abs(r.med - 1) > 3 * r.err && Math.abs(r.med - 1) >= 0.05;

// One line for the change between the visits, from the detectors that are not saturated:
// "no clear change", "68% fainter (D5–D6)", "12% brighter (D1–D2); 40% fainter (D6)".
function cmpSummary() {
  const sat = new Set(satDets());
  const use = P.ratio.filter((r) => r.med != null && !sat.has(r.d));
  if (!use.length) {
    return P.ratio.every((r) => sat.has(r.d) || r.why === "no photos")
      ? "no detector has unsaturated photos in both visits" : "not enough matching colours";
  }
  const real = use.filter(isReal), parts = [];
  for (const [sign, word] of [[1, "brighter"], [-1, "fainter"]]) {
    const g = real.filter((r) => Math.sign(r.med - 1) === sign);
    if (!g.length) continue;
    const wsum = g.reduce((s, r) => s + 1 / r.err ** 2, 0), mean = g.reduce((s, r) => s + r.med / r.err ** 2, 0) / wsum;
    parts.push(`${Math.round(Math.abs(mean - 1) * 100)}% ${word} (${detList(g.map((r) => r.d))})`);
  }
  const flat = use.filter((r) => !isReal(r)).map((r) => r.d);
  if (!parts.length) return "no clear change";
  return parts.join("; ") + (flat.length ? `; no clear change in ${detList(flat)}` : "");
}

// ---------- drawing ----------
function epochSelects() {
  const eps = ctx.epochs();
  const opt = (e, k) => `<option value="${k}">Visit ${k + 1} · ${month(e.start)}</option>`;
  $("spw-ea").innerHTML = eps.map(opt).join("");
  $("spw-ea").value = P.ea;
  $("spw-eb").innerHTML = `<option value="-1">none</option>` + eps.map((e, k) => (k === P.ea ? "" : opt(e, k))).join("");
  $("spw-eb").value = P.eb;
  $("spw-eb").disabled = eps.length < 2;
}
function progress(text) { $("spw-prog").textContent = text; }

function render() {
  if (!isOpen()) return;
  win.setStatus(tabStatus());
  [].forEach.call($("spw-meth").children, (b) => b.setAttribute("aria-pressed", b.dataset.v === P.mode));
  $("spw-pos").textContent = `${hms(P.ra)} ${dms(P.dec)}` + (P.mode === "point" && P.snapped ? ` · S/N ${Math.round(P.snr)}` : "");
  const stat = (res, tag) => {
    if (!res) return "";
    const s = res.status, done = Object.values(s).filter((x) => x === "ok" || x === "err").length;
    const marks = [1, 2, 3, 4, 5, 6].map((d) => `<span class="st-${s[d]}">D${d}${s[d] === "ok" ? " ✓" : s[d] === "err" ? " ✕" : s[d] === "run" ? " …" : ""}</span>`).join(" ");
    return `<div>${tag}${marks} <b>${done} of 6</b></div>`;
  };
  // the detector marks only while loading
  if (P.A && (!allDone(P.A) || (P.B && !allDone(P.B)))) $("spw-prog").innerHTML = stat(P.A, P.B ? "A: " : "") + stat(P.B, "B: ");
  else if (!P.busy) progress("");
  const warn = [];
  if (P.note) warn.push(["info", P.note]);
  if (P.blend && P.mode === "point") warn.push(["hot", P.nSrc > 1 ? `⚠ Blended: ${P.nSrc} sources — the spectrum mixes them`
    : "⚠ Elongated: probably two blended sources — the spectrum may mix both"]);
  const sat = satDets();
  if (sat.length) {
    const have = [...new Set(pointsOf(P.A).map((p) => p.detector))].filter((d) => !sat.includes(d));
    warn.push(["warm", `⚠ ${detList(sat)} saturated (too bright)` + (have.length ? `, using ${detList(have)}` : "")]);
  }
  P.warnings.filter((w) => w.kind !== "saturated").forEach((w) => warn.push([w.kind === "variable" ? "warm" : "info", "⚠ " + w.text]));
  if (P.cmpNote) warn.push([P.cmpNote.startsWith("⚠") ? "warm" : "info", P.cmpNote]);
  if (allDone(P.A) && !pointsOf(P.A).length) warn.push(["info", "No photos of this place in this visit."]);
  $("spw-warn").innerHTML = warn.map(([c, t]) => `<p class="spw-w ${c}">${esc(t)}</p>`).join("");
  $("spw-cmp").innerHTML = cmpHtml();
  plot();
  $("spw-feat").innerHTML = allDone(P.A) && P.features.length
    ? "<b>Found</b><ul>" + P.features.map((f) => `<li><b>${esc(f.name)}</b> ${f.lambda_um} µm · ${f.kind} ×${f.ratio} of the continuum · ${f.sigma}σ`
      + (f.tau != null ? ` · τ ${f.tau}` : "") + ` · ${f.n > 1 ? f.n + " measurements" : confText(f)}</li>`).join("") + "</ul>"
    : "";
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

// Change between the two visits: one line, the table per detector folded under "details".
function cmpHtml() {
  if (!P.ratio || P.eb < 0) return "";
  const eps = ctx.epochs(), sat = satDets();
  const rows = P.ratio.map((r) => {
    if (r.med == null) return `<tr><th>D${r.d}</th><td colspan="2" class="note">${r.why}</td></tr>`;
    const pct = Math.round((r.med - 1) * 100), real = isReal(r);
    return `<tr><th>D${r.d}</th><td>×${r.med.toFixed(2)} ± ${r.err.toFixed(2)} <span class="note">(${r.n})</span></td>`
      + `<td class="${sat.includes(r.d) ? "note" : real ? (pct < 0 ? "spw-fade" : "spw-bright") : "note"}">`
      + (sat.includes(r.d) ? "saturated, not used" : real ? Math.abs(pct) + "% " + (pct < 0 ? "fainter" : "brighter") : "no clear change") + "</td></tr>";
  }).join("");
  const mv = P.motion ? ` <span class="spw-mv" title="${esc(P.motion.from)}">· followed along its motion (${(P.motion.speed / 1000).toFixed(1)}″/yr)</span>` : "";
  return `<div class="spw-ratio"><b>vs ${month(eps[P.eb].start)}:</b> ${cmpSummary()}${mv}`
    + `<details><summary>details</summary><p class="note">Visit ${P.eb + 1} / visit ${P.ea + 1}, median ratio by detector (pairs of colours)</p><table>${rows}</table></details></div>`;
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
  if (!all.length) g.push(`<text class="sp-ax" x="${W / 2}" y="${H / 2}" text-anchor="middle">${P.busy ? "Measuring…" : ""}</text>`);
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
    + (P.mode === "point" ? `ring background, corrected ×${(p.aperture_corr || 1).toFixed(2)} for light outside the circle` : "sky-model background, no correction")
    + (p.n_bad_pixels ? ` · ${p.n_bad_pixels} bad pixel${p.n_bad_pixels > 1 ? "s" : ""} left out` : "")
    + (p.n_warn_pixels ? ` · ${p.n_warn_pixels} flagged` : "") + "</span>";
  t.style.display = "block";
  const box = t.parentElement.getBoundingClientRect();
  let lx = e.clientX - box.left + 12, ly = e.clientY - box.top + 12;
  if (lx + t.offsetWidth > box.width) lx = e.clientX - box.left - t.offsetWidth - 12;
  if (ly + t.offsetHeight > box.height) ly = Math.max(0, e.clientY - box.top - t.offsetHeight - 12);
  t.style.left = Math.max(0, lx) + "px"; t.style.top = ly + "px";
}
