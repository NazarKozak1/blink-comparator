// Timeline under the picture (behaviour of the legacy page, look of the prototype):
// ticks at the real date of every photo, visits as green blocks, stack windows as labelled blocks,
// date axis that adapts from months to minutes, wheel zoom, drag to scrub, double click to zoom into a visit,
// + / - / All epochs buttons, and a label row above the bar: month and year of every visit, a click zooms into it.
import { S } from "./state.js";
import { $, MO, day, month, stamp } from "./util.js";

export const epochTitle = (e, k) => "Epoch " + (k + 1) + " · " + month(e.start) + " · " + e.n + " photo" + (e.n === 1 ? "" : "s");

const MIN_SPAN = 6 * 6e4;          // 6 minutes across at most zoom
const DOUBLE_MS = 350;
let C = null;                      // context from explore.js
let dragging = false, last = { t: 0, x: 0 };

const itemTime = (it) => it.t ?? (it.t0 + it.t1) / 2;

export function fullSpan() {
  const D = C.D;
  const ts = D.frames.map((f) => f.t).concat(D.epochs.flatMap((e) => [e.t0, e.t1]), D.wins.flatMap((w) => [w.t0, w.t1]));
  const lo = Math.min(...ts), hi = Math.max(...ts), pad = Math.max((hi - lo) * 0.02, 36e5);
  return [lo - pad, hi + pad];
}
export const span = () => C.D.view || fullSpan();

function setView(a, b) {
  const [flo, fhi] = fullSpan();
  if (b - a < MIN_SPAN) { const m = (a + b) / 2; a = m - MIN_SPAN / 2; b = m + MIN_SPAN / 2; }
  if (b - a >= fhi - flo) { C.D.view = null; return; }
  if (a < flo) { b += flo - a; a = flo; }
  if (b > fhi) { a -= b - fhi; b = fhi; }
  C.D.view = [a, b];
}

export function zoom(factor, t) {
  const [lo, hi] = span();
  setView(t - (t - lo) * factor, t + (hi - t) * factor);
  draw();
}

export function zoomToEpoch(k, selectFirst = false) {
  const e = C.D.epochs[k];
  if (!e) return;
  const pad = Math.max((e.t1 - e.t0) * 0.08, 36e5);
  setView(e.t0 - pad, e.t1 + pad);
  if (selectFirst) {
    const list = C.items();
    const i = list.findIndex((it) => itemTime(it) >= e.t0 - 864e5 && itemTime(it) <= e.t1 + 864e5);
    if (i >= 0 && S.mode !== "blink" && S.mode !== "diff") { C.select(i); return; }
  }
  draw();
}

// Items (frames or stacks) whose time is inside the visible window: playback walks through these.
export function showAll() { C.D.view = null; draw(); }

export function visibleItems() {
  const [lo, hi] = span();
  return C.items().map((it, k) => [itemTime(it), k]).filter(([t]) => t >= lo && t <= hi).map(([, k]) => k);
}

// ---------- drawing ----------
const STEPS = [6e4, 5 * 6e4, 15 * 6e4, 30 * 6e4, 36e5, 3 * 36e5, 6 * 36e5, 12 * 36e5, 864e5, 2 * 864e5, 7 * 864e5,
  14 * 864e5, "1M", "2M", "3M", "6M"];
const approx = (s) => (typeof s === "string" ? parseInt(s, 10) * 30.4 * 864e5 : s);

function axisTicks(lo, hi, maxLabels) {
  const step = STEPS.find((s) => (hi - lo) / approx(s) <= maxLabels) || "6M";
  const out = [];
  if (typeof step === "string") {
    const n = parseInt(step, 10), d = new Date(lo);
    let y = d.getUTCFullYear(), m = Math.ceil((d.getUTCMonth() + (d.getUTCDate() > 1 ? 1 : 0)) / n) * n;
    for (;;) {
      const t = Date.UTC(y, m, 1);
      if (t > hi) break;
      if (t >= lo) out.push([t, MO[((m % 12) + 12) % 12] + " " + new Date(t).getUTCFullYear()]);
      m += n;
    }
    return out;
  }
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) {
    const x = new Date(t), midnight = x.getUTCHours() === 0 && x.getUTCMinutes() === 0;
    const hm = String(x.getUTCHours()).padStart(2, "0") + ":" + String(x.getUTCMinutes()).padStart(2, "0");
    out.push([t, step >= 864e5 || midnight ? x.getUTCDate() + " " + MO[x.getUTCMonth()] : hm]);
  }
  return out;
}

function spanText(ms) {
  const d = ms / 864e5;
  return d > 60 ? Math.round(d / 30.4) + " months" : d > 2 ? Math.round(d) + " days" : d > 0.1 ? Math.round(d * 24) + " hours" : Math.max(1, Math.round(ms / 6e4)) + " minutes";
}

export function draw() {
  const D = C.D, tl = $("tl");
  if (!D.frames.length) { tl.innerHTML = ""; $("tlaxis").innerHTML = ""; $("tlep").innerHTML = ""; $("tlspan").textContent = ""; $("tlall").hidden = true; return; }
  const t = C.curTime();
  if (t != null && D.view && (t < D.view[0] || t > D.view[1])) {      // keep the current item in view
    const w = D.view[1] - D.view[0];
    setView(t - w / 2, t + w / 2);
  }
  const [lo, hi] = span(), X = (v) => 1 + (v - lo) / (hi - lo) * 98, inside = (v) => v >= lo && v <= hi;
  const W = tl.clientWidth || 600, px = (pc) => pc / 100 * W;
  const box = (a, b) => { const l = Math.max(0, X(a)), r = Math.min(100, X(b)); return r < 0 || l > 100 ? null : [l, Math.max(r - l, 0.4)]; };
  const m = S.mode, A = Math.min(S.ea, D.epochs.length - 1), B = S.eb < 0 ? D.epochs.length - 1 : Math.min(S.eb, D.epochs.length - 1);
  let h = "";
  // visits
  D.epochs.forEach((e, k) => {
    const bx = box(e.t0, e.t1);
    if (!bx) return;
    let cls = "", lab = "";
    if (m === "blink" || m === "diff") { cls = k === A ? "a" : k === B ? "b" : ""; lab = k === A ? "A" : k === B ? "B" : ""; }
    if (m === "stacks" && S.win === "epoch") return;       // drawn as stack blocks below
    h += `<i class="${cls}${m === "stacks" ? " dim" : ""}" style="left:${bx[0]}%;width:${bx[1]}%">${lab ? `<em>${lab}</em>` : ""}</i>`;
  });
  // stack windows: one block each, the current one highlighted. A short visit is only a few pixels wide on a
  // year-long bar, so blocks grow (into half of the free gap on each side) until their label fits;
  // the faint ticks keep the real dates of the photos.
  if (m === "stacks") {
    const WANT = 150, GAP = 4;
    const bl = D.wins.map((w, k) => ({ k, w, l: px(X(w.t0)), r: px(X(w.t1)) })).filter((b) => b.r >= 0 && b.l <= W);
    const grown = bl.map((b, j) => {
      const freeL = j ? (b.l - bl[j - 1].r) / 2 - GAP : b.l, freeR = j < bl.length - 1 ? (bl[j + 1].l - b.r) / 2 - GAP : W - b.r;
      const need = Math.max(0, WANT - (b.r - b.l));
      let gr = Math.min(need / 2, Math.max(0, freeR)), gl = Math.min(need - gr, Math.max(0, freeL));
      gr = Math.min(need - gl, Math.max(0, freeR));
      return { ...b, l: Math.max(0, b.l - gl), r: Math.min(W, b.r + gr) };
    });
    grown.forEach(({ k, w, l, r }) => {
      const ep = S.win === "epoch" ? "Epoch " + (k + 1) : S.win === "day" ? day(w.start) : "Custom";
      const short = S.win === "epoch" ? "E" + (k + 1) : ep;
      const wpx = r - l;
      const lab = wpx > 128 ? ep + " · " + w.n + " frames" : wpx > 92 ? ep + " · " + w.n + " fr." : wpx > 56 ? short + " · " + w.n + " fr." : wpx > 22 ? short : "";
      h += `<b class="${k === S.i ? "cur" : ""}" style="left:${l / W * 100}%;width:${Math.max(r - l, 3) / W * 100}%" title="${w.label} · ${w.n} frames">${lab ? `<em>${lab}</em>` : ""}</b>`;
    });
  }
  // photos: plain ticks in Frames, faint ticks elsewhere (what the stack is made of)
  const faint = m !== "frames";
  D.frames.forEach((f) => { if (inside(f.t)) h += `<u class="${faint ? "faint" : ""}" style="left:${X(f.t)}%"></u>`; });
  if (m === "frames" && t != null && inside(t)) h += `<s style="left:${X(t)}%"></s>`;
  tl.innerHTML = h;
  // date axis
  $("tlaxis").innerHTML = axisTicks(lo, hi, Math.max(2, Math.floor(W / 110)))
    .map(([v, s]) => `<span style="left:${X(v)}%">${s}</span>`).join("");
  // header and chips
  const visible = visibleItems().length;
  const noun = (m === "stacks" ? "stack" : "photo") + (visible === 1 ? "" : "s");
  $("tlspan").textContent = "· " + spanText(hi - lo) + " shown · " + visible + " " + noun + " in view";
  $("tlall").hidden = !D.view;
  // visit labels above the bar: centred on the visit and kept inside the bar; close visits push their labels
  // apart (a few relaxation passes), a label that still overlaps is left out (the visit stays in the tooltip)
  const zoomedTo = D.view ? D.epochs.findIndex((e) => e.t0 >= D.view[0] - 864e5 && e.t1 <= D.view[1] + 864e5
    && (D.view[1] - D.view[0]) < (e.t1 - e.t0) * 3 + 6 * 864e5) : -1;
  const GAP = 6;
  const lab = [];
  D.epochs.forEach((e, k) => {
    const a = Math.max(e.t0, lo), b = Math.min(e.t1, hi);
    if (b < lo || a > hi) return;
    const ab = m === "blink" || m === "diff" ? (k === A ? "A · " : k === B ? "B · " : "") : "";
    const text = ab + month(e.start), w = text.length * 7 + 10;
    lab.push({ k, e, text, w, x: px(X((a + b) / 2)) });
  });
  const clampX = (l) => { l.x = Math.min(W - l.w / 2, Math.max(l.w / 2, l.x)); };
  lab.forEach(clampX);
  for (let pass = 0; pass < 12; pass++) {
    let moved = false;
    for (let j = 1; j < lab.length; j++) {
      const p = lab[j - 1], q = lab[j], over = p.x + p.w / 2 + GAP - (q.x - q.w / 2);
      if (over > 0) { p.x -= over / 2; q.x += over / 2; clampX(p); clampX(q); moved = true; }
    }
    if (!moved) break;
  }
  let lastRight = -Infinity, labels = "";
  lab.forEach(({ k, e, text, w, x }) => {
    if (x - w / 2 < lastRight + GAP - 0.5) return;
    lastRight = x + w / 2;
    labels += `<button type="button" data-k="${k}" style="left:${x.toFixed(1)}px" aria-pressed="${k === zoomedTo}" `
      + `aria-label="${epochTitle(e, k)}: show this visit on the timeline">${text}</button>`;
  });
  if ($("tlep").innerHTML !== labels) $("tlep").innerHTML = labels;
}

// ---------- pointer ----------
function timeAt(clientX) {
  const r = $("tl").getBoundingClientRect(), [lo, hi] = span();
  return lo + (((clientX - r.left) / r.width * 100 - 1) / 98) * (hi - lo);
}
function nearestIdx(list, t, key) {
  let best = -1, bd = Infinity;
  list.forEach((x, k) => { const d = Math.abs(key(x) - t); if (d < bd) { bd = d; best = k; } });
  return best;
}
function epochAt(t) {
  const D = C.D, k = D.epochs.findIndex((e) => t >= e.t0 && t <= e.t1);
  return k >= 0 ? k : nearestIdx(D.epochs, t, (e) => (t < e.t0 ? e.t0 : e.t1));
}
function pick(t) {
  const D = C.D;
  if (S.mode === "frames") { const i = nearestIdx(D.frames, t, (f) => f.t); if (i !== S.i) C.select(i); return; }
  if (S.mode === "stacks") {
    let i = D.wins.findIndex((w) => t >= w.t0 && t <= w.t1);
    if (i < 0) i = nearestIdx(D.wins, t, (w) => (w.t0 + w.t1) / 2);
    if (i !== S.i) C.select(i);
    return;
  }
  C.selectB(epochAt(t));          // Blink / Diff: the clicked visit becomes B
}
function tip(t, clientX) {
  const D = C.D, el = $("tltip"), r = $("tl").getBoundingClientRect();
  let text;
  if (S.mode === "frames") { const f = D.frames[nearestIdx(D.frames, t, (x) => x.t)]; text = f ? stamp(f.date_obs) : ""; }
  else if (S.mode === "stacks") {
    const w = D.wins.find((x) => t >= x.t0 && t <= x.t1) || D.wins[nearestIdx(D.wins, t, (x) => (x.t0 + x.t1) / 2)];
    text = w ? w.label + " · " + w.n + " frames" : "";
  } else { const k = epochAt(t); text = k >= 0 ? "Epoch " + (k + 1) + " · " + D.epochs[k].label : ""; }
  el.textContent = text;
  el.style.display = text ? "block" : "none";
  el.style.left = Math.max(60, Math.min(r.width - 60, clientX - r.left)) + "px";
}
const hideTip = () => { $("tltip").style.display = "none"; };

export function init(ctx) {
  C = ctx;
  const tl = $("tl");
  tl.addEventListener("wheel", (e) => {            // over the timeline the wheel zooms; elsewhere it scrolls
    if (!C.D.frames.length) return;
    e.preventDefault();
    zoom(e.deltaY > 0 ? 1.35 : 1 / 1.35, timeAt(e.clientX));
  }, { passive: false });
  tl.addEventListener("pointerdown", (e) => {
    if (!C.D.frames.length) return;
    C.stop();
    const t = timeAt(e.clientX), now = performance.now();
    if (now - last.t < DOUBLE_MS && Math.abs(e.clientX - last.x) < 8) {   // redraws replace the target, so no native dblclick
      last = { t: 0, x: 0 };
      zoomToEpoch(epochAt(t));
      return;
    }
    last = { t: now, x: e.clientX };
    dragging = true;
    tl.setPointerCapture(e.pointerId);
    pick(t); tip(t, e.clientX);
  });
  tl.addEventListener("pointermove", (e) => {
    if (!C.D.frames.length) return;
    const t = timeAt(e.clientX);
    if (dragging) { pick(t); tip(t, e.clientX); return; }
    if (e.pointerType === "mouse") tip(t, e.clientX);
  });
  ["pointerup", "pointercancel"].forEach((n) => tl.addEventListener(n, () => { dragging = false; }));
  tl.addEventListener("pointerleave", () => { if (!dragging) hideTip(); });
  $("tlin").onclick = () => { const t = C.curTime(); const [lo, hi] = span(); zoom(0.5, t ?? (lo + hi) / 2); };
  $("tlout").onclick = () => { const t = C.curTime(); const [lo, hi] = span(); zoom(2, t ?? (lo + hi) / 2); };
  $("tlall").onclick = showAll;
  // a visit label zooms the timeline into that visit; the photo is then picked on the zoomed bar
  const ep = $("tlep");
  ep.onclick = (e) => {
    const b = e.target.closest("button[data-k]");
    if (!b) return;
    C.stop();
    zoomToEpoch(+b.dataset.k);
  };
  ep.addEventListener("pointerover", (e) => {
    const b = e.target.closest("button[data-k]");
    if (!b) return;
    const k = +b.dataset.k, el = $("tltip"), r = $("tl").getBoundingClientRect(), br = b.getBoundingClientRect();
    el.textContent = epochTitle(C.D.epochs[k], k);
    el.style.display = "block";
    el.style.left = Math.max(80, Math.min(r.width - 80, br.left + br.width / 2 - r.left)) + "px";
  });
  ep.addEventListener("pointerout", hideTip);
  addEventListener("resize", () => draw());
}
