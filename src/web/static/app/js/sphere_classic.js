// Classic sky sphere (the first version, kept at #sphere-classic): drag to look around, pick a field, open it in Explore.
// Background stars are decorative (random); the rings are the real targets.
import { PRESETS } from "./presets.js";
import { $, hms } from "./util.js";

function rng(s) { return function () { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const K = { ra: 133.8, dec: -7.2, fov: 70, fs: 6, dirty: 1 };
let sk, sx;
function vec(ra, de) { ra *= Math.PI / 180; de *= Math.PI / 180; return [Math.cos(de) * Math.cos(ra), Math.cos(de) * Math.sin(ra), Math.sin(de)]; }
function nrm(v) { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; }
function basis() { const r = K.ra * Math.PI / 180, d = K.dec * Math.PI / 180; return { f: [Math.cos(d) * Math.cos(r), Math.cos(d) * Math.sin(r), Math.sin(d)], e: [-Math.sin(r), Math.cos(r), 0], n: [-Math.sin(d) * Math.cos(r), -Math.sin(d) * Math.sin(r), Math.cos(d)] }; }
function proj(v, B, F, w, h) { const z = v[0] * B.f[0] + v[1] * B.f[1] + v[2] * B.f[2]; if (z < 0.08) return null; return [w / 2 - F * (v[0] * B.e[0] + v[1] * B.e[1] + v[2] * B.e[2]) / z, h / 2 - F * (v[0] * B.n[0] + v[1] * B.n[1] + v[2] * B.n[2]) / z]; }

export function resize() {
  const d = devicePixelRatio || 1, w = sk.clientWidth, h = sk.clientHeight;
  if (!w) return;
  sk.width = w * d; sk.height = h * d; sx.setTransform(d, 0, 0, d, 0, 0); K.dirty = 1; sfr();
}
function paintSky() {
  K.dirty = 0;
  const w = sk.clientWidth, h = sk.clientHeight, B = basis(), F = (h / 2) / Math.tan(K.fov * Math.PI / 360);
  sx.fillStyle = "#02030a"; sx.fillRect(0, 0, w, h); sx.lineWidth = 1; sx.strokeStyle = "rgba(120,140,255,.16)";
  function line(fn, n) { sx.beginPath(); let pen = false; for (let j = 0; j <= n; j++) { const q = proj(fn(j), B, F, w, h); if (q && Math.abs(q[0] - w / 2) < 3 * w && Math.abs(q[1] - h / 2) < 3 * h) { pen ? sx.lineTo(q[0], q[1]) : sx.moveTo(q[0], q[1]); pen = true; } else pen = false; } sx.stroke(); }
  for (let de = -60; de <= 60; de += 30) line((j) => vec(j * 5, de), 72);
  for (let ra = 0; ra < 360; ra += 30) line((j) => vec(ra, -85 + j * 5), 34);
  K.stars.forEach((s) => { const q = proj(s.v, B, F, w, h); if (!q || q[0] < -4 || q[1] < -4 || q[0] > w + 4 || q[1] > h + 4) return; sx.fillStyle = "rgba(" + s.c + "," + Math.min(1, s.b + 0.15) + ")"; sx.beginPath(); sx.arc(q[0], q[1], 0.5 + s.b * 1.3 * Math.min(2.2, 70 / K.fov * 0.6 + 0.5), 0, 7); sx.fill(); });
  K.marks = [];
  PRESETS.forEach((t) => { const q = proj(vec(t.ra, t.dec), B, F, w, h); if (!q) return; K.marks.push([q[0], q[1], t]); sx.strokeStyle = "#62D0FF"; sx.lineWidth = 1.5; sx.beginPath(); sx.arc(q[0], q[1], 8, 0, 7); sx.stroke(); sx.fillStyle = "#EDEEFA"; sx.font = '500 12px "Aber Mono","IBM Plex Mono",monospace'; sx.fillText(t.n, q[0] + 13, q[1] + 4); });
  $("c-sk-read").textContent = "RA " + hms(K.ra) + "  Dec " + (K.dec >= 0 ? "+" : "") + K.dec.toFixed(2) + "°";
}
function sfr() { const s = 60 + K.fs * 4; $("c-sfr").style.width = $("c-sfr").style.height = s + "px"; $("c-sfl").textContent = K.fs + "′ field (frame enlarged)"; }
function zoom(k) { K.fov = Math.max(10, Math.min(110, K.fov * k)); K.dirty = 1; }

export function lookAt(ra, dec) { K.ra = ra; K.dec = dec; K.dirty = 1; }

export function init(open) {
  sk = $("c-sky"); sx = sk.getContext("2d");
  const r = rng(42), a = [], pole = nrm(vec(192.86, 27.13));
  for (let i = 0; i < 3800; i++) {
    let u = nrm([r() - 0.5, r() - 0.5, r() - 0.5]);
    const band = i > 1600, d = u[0] * pole[0] + u[1] * pole[1] + u[2] * pole[2];
    if (band) u = nrm([u[0] - 0.93 * d * pole[0], u[1] - 0.93 * d * pole[1], u[2] - 0.93 * d * pole[2]]);
    const t = r();
    a.push({ v: u, b: band ? 0.25 + r() * 0.4 : 0.3 + Math.pow(r(), 2) * 0.7, c: t < 0.25 ? "170,200,255" : t < 0.75 ? "255,245,230" : "255,190,140" });
  }
  K.stars = a;
  addEventListener("resize", resize);
  (function tick() { if (K.dirty && !$("v-sphere-classic").hidden) paintSky(); requestAnimationFrame(tick); })();
  let drag = null, moved = 0;
  sk.onpointerdown = (e) => { drag = [e.clientX, e.clientY]; moved = 0; sk.setPointerCapture(e.pointerId); };
  sk.onpointermove = (e) => { if (!drag) return; const dx = e.clientX - drag[0], dy = e.clientY - drag[1], dpp = K.fov / sk.clientHeight; moved += Math.abs(dx) + Math.abs(dy); drag = [e.clientX, e.clientY]; K.ra = (K.ra + dx * dpp / Math.max(0.3, Math.cos(K.dec * Math.PI / 180)) + 360) % 360; K.dec = Math.max(-89, Math.min(89, K.dec + dy * dpp)); K.dirty = 1; };
  sk.onpointerup = (e) => { drag = null; if (moved < 5) { const rc = sk.getBoundingClientRect(), x = e.clientX - rc.left, y = e.clientY - rc.top; (K.marks || []).forEach((m) => { if (Math.hypot(m[0] - x, m[1] - y) < 16) { K.ra = m[2].ra; K.dec = m[2].dec; K.dirty = 1; } }); } };
  sk.onwheel = (e) => { e.preventDefault(); zoom(e.deltaY > 0 ? 1.12 : 0.89); };
  $("c-zi").onclick = () => zoom(0.8); $("c-zo").onclick = () => zoom(1.25);
  $("c-sk-fov").oninput = function () { K.fs = +this.value; $("c-sk-fovv").textContent = K.fs + "′"; sfr(); };
  $("c-sk-go").onclick = () => open(K.ra, K.dec, K.fs);
  sfr();
}
