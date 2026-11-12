// Sky sphere: real stars to 6 mag, Milky Way glow, constellation figures and target markers on a Canvas 2D
// gnomonic projection. Drag / pinch / scroll to look around; click a marker to open it in Explore.
// Data: data/sky.json, built by docs/ui/tools/build_sky_data.py from d3-celestial (BSD-3-Clause).
// The first version lives on in sphere_classic.js (#sphere-classic).
import { PRESETS } from "./presets.js";
import { $, hms } from "./util.js";

const D2R = Math.PI / 180;
const EXTRA = [   // landmarks, opened by coordinates
  { n: "Andromeda Galaxy", h: "M31 · nearest large galaxy", ra: 10.6847, dec: 41.2690 },
  { n: "Pleiades", h: "M45 · young star cluster", ra: 56.7500, dec: 24.1167 },
  { n: "Polaris", h: "North Star", ra: 37.9546, dec: 89.2641 },
];
const MARKS = PRESETS.map((t) => ({ ...t, target: true })).concat(EXTRA);
const HIT = { mouse: 16, touch: 28 };          // marker hit radius, px
const KEY = "sky-layers";
// B-V colour index -> star colour (hot blue to cool orange)
const BV = [[-0.35, 155, 178, 255], [-0.1, 182, 200, 255], [0.15, 222, 230, 255], [0.45, 255, 250, 242],
  [0.7, 255, 238, 214], [1.0, 255, 219, 176], [1.4, 255, 196, 138], [2.0, 255, 172, 104]];

const K = { ra: 300, dec: 38, fov: 70, fs: 6, dirty: 1, hover: null, layers: { con: true, obj: true } };
const SKY = { n: 0, v: null, r: null, fill: null, cons: [], names: [], status: "loading" };
let sk, sx, onField, onTarget, frame = null;

function vec(ra, de) { ra *= D2R; de *= D2R; return [Math.cos(de) * Math.cos(ra), Math.cos(de) * Math.sin(ra), Math.sin(de)]; }
// galactic (l, b) -> equatorial unit vector (J2000)
function gal(l, b) {
  const x = Math.cos(b * D2R) * Math.cos(l * D2R), y = Math.cos(b * D2R) * Math.sin(l * D2R), z = Math.sin(b * D2R);
  return [-0.0548756 * x + 0.4941094 * y - 0.8676661 * z, -0.8734371 * x - 0.4448296 * y - 0.1980764 * z,
    -0.4838350 * x + 0.7469822 * y + 0.4559838 * z];
}
function basis() {
  const r = K.ra * D2R, d = K.dec * D2R;
  return { f: [Math.cos(d) * Math.cos(r), Math.cos(d) * Math.sin(r), Math.sin(d)], e: [-Math.sin(r), Math.cos(r), 0],
    n: [-Math.sin(d) * Math.cos(r), -Math.sin(d) * Math.sin(r), Math.cos(d)] };
}
// view of one repaint: size, basis, focal length in px, cut-off for points outside the screen
function view() {
  const w = sk.clientWidth, h = sk.clientHeight, F = (h / 2) / Math.tan(K.fov * D2R / 2);
  return { w, h, B: basis(), F, zmin: Math.max(0.08, Math.cos(Math.atan(Math.hypot(w, h) / 2 / F)) - 0.02) };
}
function proj(v, V) {
  const B = V.B, z = v[0] * B.f[0] + v[1] * B.f[1] + v[2] * B.f[2];
  if (z < 0.08) return null;
  return [V.w / 2 - V.F * (v[0] * B.e[0] + v[1] * B.e[1] + v[2] * B.e[2]) / z,
    V.h / 2 - V.F * (v[0] * B.n[0] + v[1] * B.n[1] + v[2] * B.n[2]) / z];
}
// polyline through unit vectors, broken where it leaves the visible hemisphere or flies far off screen
function polyline(c, pts, V) {
  let pen = false;
  for (const v of pts) {
    const q = proj(v, V);
    if (q && Math.abs(q[0] - V.w / 2) < 3 * V.w && Math.abs(q[1] - V.h / 2) < 3 * V.h) {
      pen ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1]); pen = true;
    } else pen = false;
  }
}
const onScreen = (q, V, m) => q && q[0] > -m && q[1] > -m && q[0] < V.w + m && q[1] < V.h + m;

function bvRgb(bv) {
  let i = 1;
  while (i < BV.length - 1 && bv > BV[i][0]) i++;
  const a = BV[i - 1], b = BV[i], t = Math.max(0, Math.min(1, (bv - a[0]) / (b[0] - a[0])));
  return [1, 2, 3].map((k) => Math.round(a[k] + (b[k] - a[k]) * t)).join(",");
}

function setData(d) {
  const s = d.stars, n = s.length / 4;
  SKY.n = n; SKY.v = new Float32Array(n * 3); SKY.r = new Float32Array(n); SKY.fill = new Array(n);
  for (let i = 0; i < n; i++) {
    const v = vec(s[4 * i], s[4 * i + 1]), mag = s[4 * i + 2];
    SKY.v[3 * i] = v[0]; SKY.v[3 * i + 1] = v[1]; SKY.v[3 * i + 2] = v[2];
    SKY.r[i] = Math.max(0.45, 0.4 + 0.085 * (6.5 - mag) * (6.5 - mag));
    SKY.fill[i] = "rgba(" + bvRgb(s[4 * i + 3]) + "," + Math.min(1, 0.32 + (6.5 - mag) * 0.14).toFixed(2) + ")";
  }
  SKY.cons = d.cons.map((c) => ({ n: c.n, at: vec(c.at[0], c.at[1]),
    l: c.l.map((seg) => { const p = []; for (let k = 0; k < seg.length; k += 2) p.push(vec(seg[k], seg[k + 1])); return p; }) }));
  SKY.names = d.names.map(([n, ra, dec]) => ({ n, v: vec(ra, dec) }));
  SKY.status = "ok";
}

// ---------- layers ----------
// Milky Way: soft blobs along the galactic equator, brighter towards the centre (l = 0)
let glow = null, band = null;
function drawMilkyWay(c, V) {
  if (!glow) {
    glow = document.createElement("canvas"); glow.width = glow.height = 64;
    const g = glow.getContext("2d"), r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, "rgba(150,165,255,1)"); r.addColorStop(0.5, "rgba(150,165,255,.35)"); r.addColorStop(1, "rgba(150,165,255,0)");
    g.fillStyle = r; g.fillRect(0, 0, 64, 64);
    band = [];
    for (let l = 0; l < 360; l += 3) {
      const k = 0.45 + 0.55 * Math.pow(Math.cos(l * D2R / 2), 2);
      band.push({ v: gal(l, 0), a: 0.07 * k, s: 22 + 10 * k });
    }
  }
  const px = V.F * D2R;
  c.save(); c.globalCompositeOperation = "lighter";
  band.forEach((p) => {
    const q = proj(p.v, V), s = p.s * px;
    if (!q || q[0] < -s || q[1] < -s || q[0] > V.w + s || q[1] > V.h + s) return;
    c.globalAlpha = p.a; c.drawImage(glow, q[0] - s / 2, q[1] - s / 2, s, s);
  });
  c.restore();
}

function drawGrid(c, V) {
  c.lineWidth = 1; c.strokeStyle = "rgba(120,140,255,.13)"; c.beginPath();
  for (let de = -60; de <= 60; de += 30) { const p = []; for (let j = 0; j <= 72; j++) p.push(vec(j * 5, de)); polyline(c, p, V); }
  for (let ra = 0; ra < 360; ra += 30) { const p = []; for (let j = 0; j <= 34; j++) p.push(vec(ra, -85 + j * 5)); polyline(c, p, V); }
  c.stroke();
}

function drawStars(c, V) {
  const B = V.B, v = SKY.v, k = Math.min(1.7, Math.max(0.8, Math.sqrt(70 / K.fov)));
  for (let i = 0; i < SKY.n; i++) {
    const x = v[3 * i], y = v[3 * i + 1], z = v[3 * i + 2], d = x * B.f[0] + y * B.f[1] + z * B.f[2];
    if (d < V.zmin) continue;
    const px = V.w / 2 - V.F * (x * B.e[0] + y * B.e[1] + z * B.e[2]) / d,
      py = V.h / 2 - V.F * (x * B.n[0] + y * B.n[1] + z * B.n[2]) / d;
    if (px < -6 || py < -6 || px > V.w + 6 || py > V.h + 6) continue;
    const r = SKY.r[i] * k;
    c.fillStyle = SKY.fill[i];
    if (r < 1.1) { c.fillRect(px - r, py - r, 2 * r, 2 * r); continue; }   // faint: a square is as good and faster
    if (r > 2) { c.globalAlpha = 0.18; c.beginPath(); c.arc(px, py, r * 2.4, 0, 7); c.fill(); c.globalAlpha = 1; }
    c.beginPath(); c.arc(px, py, r, 0, 7); c.fill();
  }
}

function drawConstellations(c, V) {
  c.lineWidth = 1; c.strokeStyle = "rgba(98,208,255,.4)"; c.beginPath();
  SKY.cons.forEach((k) => k.l.forEach((seg) => polyline(c, seg, V)));
  c.stroke();
  c.textAlign = "center"; c.font = '500 11px "Aber Mono","IBM Plex Mono",monospace'; c.fillStyle = "rgba(140,156,200,.8)";
  SKY.cons.forEach((k) => { const q = proj(k.at, V); if (onScreen(q, V, 40)) c.fillText(k.n.toUpperCase().split("").join(" "), q[0], q[1]); });
  c.textAlign = "left"; c.font = '400 10px "Aber Mono","IBM Plex Mono",monospace'; c.fillStyle = "rgba(237,238,250,.55)";
  SKY.names.forEach((s) => { const q = proj(s.v, V); if (onScreen(q, V, 20)) c.fillText(s.n, q[0] + 6, q[1] - 5); });
}

function drawMarkers(c, V) {
  frame = [];
  c.font = '500 12px "Aber Mono","IBM Plex Mono",monospace'; c.textAlign = "left";
  MARKS.forEach((m) => {
    const q = proj(m.v || (m.v = vec(m.ra, m.dec)), V);
    if (!onScreen(q, V, 60)) return;
    frame.push([q[0], q[1], m]);
    const hot = K.hover === m, col = m.target ? "#62D0FF" : "#EDEEFA";
    if (hot) { c.fillStyle = "rgba(98,208,255,.16)"; c.beginPath(); c.arc(q[0], q[1], 13, 0, 7); c.fill(); }
    c.strokeStyle = col; c.lineWidth = hot ? 2 : 1.5; c.setLineDash(m.target ? [] : [3, 3]);
    c.beginPath(); c.arc(q[0], q[1], hot ? 10 : 8, 0, 7); c.stroke(); c.setLineDash([]);
    c.fillStyle = m.target ? "#EDEEFA" : "rgba(237,238,250,.75)"; c.fillText(m.n, q[0] + 14, q[1] + 4);
  });
}

function paint() {
  K.dirty = 0;
  const V = view(), c = sx;
  c.fillStyle = "#02030a"; c.fillRect(0, 0, V.w, V.h);
  drawMilkyWay(c, V);
  drawGrid(c, V);
  if (SKY.status === "ok") drawStars(c, V);
  if (SKY.status === "ok" && K.layers.con) drawConstellations(c, V);
  if (K.layers.obj) drawMarkers(c, V); else frame = [];
  $("sk-read").textContent = SKY.status === "error" ? "Star map did not load"
    : "RA " + hms(K.ra) + "  Dec " + (K.dec >= 0 ? "+" : "") + K.dec.toFixed(2) + "°";
  tip();
}

// ---------- interaction ----------
function hit(x, y, type) {
  const r = HIT[type === "mouse" ? "mouse" : "touch"];
  let best = null, bd = r;
  (frame || []).forEach(([mx, my, m]) => { const d = Math.hypot(mx - x, my - y); if (d < bd) { bd = d; best = m; } });
  return best;
}
function tip() {
  const t = $("sk-tip"), m = K.hover, f = m && (frame || []).find((e) => e[2] === m);
  if (!f) { t.hidden = true; return; }
  t.innerHTML = "<b>" + m.n + "</b><span>" + m.h + "</span><small>Click to open in Explore</small>";
  t.hidden = false;
  const w = sk.clientWidth, tw = t.offsetWidth, th = t.offsetHeight;
  t.style.left = Math.max(8, Math.min(w - tw - 8, f[0] + 16)) + "px";
  t.style.top = (f[1] - th - 14 < 8 ? f[1] + 18 : f[1] - th - 14) + "px";
}
function setHover(m) { if (K.hover !== m) { K.hover = m; K.dirty = 1; sk.style.cursor = m ? "pointer" : ""; } }
function zoom(k) { K.fov = Math.max(10, Math.min(110, K.fov * k)); K.dirty = 1; }
function pan(dx, dy) {
  const dpp = K.fov / sk.clientHeight;
  K.ra = (K.ra + dx * dpp / Math.max(0.3, Math.cos(K.dec * D2R)) + 360) % 360;
  K.dec = Math.max(-89, Math.min(89, K.dec + dy * dpp)); K.dirty = 1;
}
function openMark(m) {
  setHover(null);
  if (m.target) onTarget(m); else onField(m.ra, m.dec, K.fs);
}

function saveLayers() { try { localStorage.setItem(KEY, JSON.stringify(K.layers)); } catch (e) { /* storage blocked */ } }
function loadLayers() {
  try { const s = JSON.parse(localStorage.getItem(KEY) || "null"); if (s) K.layers = { con: s.con !== false, obj: s.obj !== false }; }
  catch (e) { /* storage blocked or broken: defaults */ }
}
function layerButtons() {
  [["sk-con", "con"], ["sk-obj", "obj"]].forEach(([id, k]) => {
    const b = $(id);
    b.setAttribute("aria-pressed", K.layers[k]);
    b.onclick = () => { K.layers[k] = !K.layers[k]; b.setAttribute("aria-pressed", K.layers[k]); if (!K.layers.obj) setHover(null); saveLayers(); K.dirty = 1; };
  });
}

function pointers() {
  const P = new Map();
  let moved = 0, pinch = null;
  const pos = (e) => { const r = sk.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const spread = () => { const [a, b] = [...P.values()]; return Math.hypot(a[0] - b[0], a[1] - b[1]); };
  sk.onpointerdown = (e) => {
    P.set(e.pointerId, [e.clientX, e.clientY]); sk.setPointerCapture(e.pointerId);
    if (P.size === 1) moved = 0;
    if (P.size === 2) { pinch = { d: spread(), fov: K.fov }; moved = 99; }
    if (e.pointerType !== "mouse") setHover(null);
  };
  sk.onpointermove = (e) => {
    const p = P.get(e.pointerId);
    if (!p) { if (e.pointerType === "mouse" && K.layers.obj) setHover(hit(...pos(e), "mouse")); return; }
    if (P.size >= 2) {
      P.set(e.pointerId, [e.clientX, e.clientY]);
      if (pinch && spread() > 0) { K.fov = Math.max(10, Math.min(110, pinch.fov * pinch.d / spread())); K.dirty = 1; }
      return;
    }
    const dx = e.clientX - p[0], dy = e.clientY - p[1];
    moved += Math.abs(dx) + Math.abs(dy); P.set(e.pointerId, [e.clientX, e.clientY]);
    if (moved > 4) { setHover(null); pan(dx, dy); }
  };
  const up = (e) => {
    if (!P.has(e.pointerId)) return;
    P.delete(e.pointerId);
    if (P.size < 2) pinch = null;
    if (e.type !== "pointerup" || P.size || moved > (e.pointerType === "mouse" ? 4 : 10) || !K.layers.obj) return;
    const m = hit(...pos(e), e.pointerType);
    if (m) openMark(m);
  };
  sk.onpointerup = up; sk.onpointercancel = up;
  sk.onpointerleave = (e) => { if (e.pointerType === "mouse" && !P.size) setHover(null); };
  sk.onwheel = (e) => { e.preventDefault(); zoom(e.deltaY > 0 ? 1.12 : 0.89); };
  sk.onkeydown = (e) => {
    const s = sk.clientHeight / 12, a = { ArrowLeft: [s, 0], ArrowRight: [-s, 0], ArrowUp: [0, s], ArrowDown: [0, -s] }[e.key];
    if (a) { e.preventDefault(); pan(a[0], a[1]); } else if (e.key === "+" || e.key === "=") zoom(0.8); else if (e.key === "-") zoom(1.25);
  };
}

function sfr() { const s = 60 + K.fs * 4; $("sfr").style.width = $("sfr").style.height = s + "px"; $("sfl").textContent = K.fs + "′ field (frame enlarged)"; }

export function resize() {
  const d = Math.min(2, devicePixelRatio || 1), w = sk.clientWidth, h = sk.clientHeight;
  if (!w) return;
  sk.width = w * d; sk.height = h * d; sx.setTransform(d, 0, 0, d, 0, 0); K.dirty = 1; sfr();
}

export function lookAt(ra, dec, fov) { K.ra = ra; K.dec = dec; if (fov) K.fov = fov; K.dirty = 1; }

// field(ra, dec, fov): open a field by coordinates; target(preset): open a challenge target as the name search does
export function init(field, target) {
  onField = field; onTarget = target;
  sk = $("sky"); sx = sk.getContext("2d");
  loadLayers(); layerButtons(); pointers();
  fetch("/static/app/data/sky.json").then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(setData).catch(() => { SKY.status = "error"; }).finally(() => { sk.dataset.load = SKY.status; K.dirty = 1; });
  addEventListener("resize", resize);
  (function tick() { if (K.dirty && !$("v-sphere").hidden) paint(); requestAnimationFrame(tick); })();
  $("zi").onclick = () => zoom(0.8); $("zo").onclick = () => zoom(1.25);
  $("sk-fov").oninput = function () { K.fs = +this.value; $("sk-fovv").textContent = K.fs + "′"; sfr(); };
  $("sk-go").onclick = () => onField(K.ra, K.dec, K.fs);
  sfr();
}
