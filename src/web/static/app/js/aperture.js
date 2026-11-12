// Aperture on the picture, only while the spectrum tool is on (otherwise a click just pins a point): click = a star
// near the click, or the area if there is none (spectrum.js decides), Alt+click = a star exactly here, drag = a circle
// of any size (an area). Drawn as an SVG over the canvas in grid pixels (1 grid pixel = 1 SPHEREx pixel).
import { $, fracAt, gridSize, PIXEL_ARCSEC, skyAt } from "./util.js";

const NS = "http://www.w3.org/2000/svg";
export const R_MIN = 4, R_MAX = 120;            // arcsec, a dragged circle
export const ap = { on: false, ra: 0, dec: 0, r: 10, blend: false, mode: "point" };
let ctx = null, svg = null, down = null;

// Background annulus in frame pixels, as src/web/photometry.frame_point
export const annulus = (rArcsec) => { const r = rArcsec / PIXEL_ARCSEC, a = Math.max(4, r + 1.5); return [a, a + 2]; };

// mode "extended": no background ring (the sky there is the zodiacal model)
export function show(ra, dec, r, blend, mode = "point") { Object.assign(ap, { on: true, ra, dec, r, blend: !!blend, mode }); draw(); }
export function hide() { ap.on = false; draw(); }

export function draw() {
  if (!svg) return;
  const info = ctx.info();
  if (!ap.on || !info) { svg.style.display = "none"; return; }
  const n = gridSize(ctx.fov()), [fx, fy] = fracAt(info.ra, info.dec, ap.ra, ap.dec, ctx.fov());
  const cx = fx * n, cy = fy * n, r = ap.r / PIXEL_ARCSEC, [a, b] = annulus(ap.r);
  const col = ap.blend ? "var(--hot)" : "var(--a2)", fs = n / 24;
  svg.setAttribute("viewBox", `0 0 ${n} ${n}`);
  svg.style.display = "block";
  svg.innerHTML = (ap.mode === "point" ? `<circle cx="${cx}" cy="${cy}" r="${a}" class="ap-bg"/><circle cx="${cx}" cy="${cy}" r="${b}" class="ap-bg"/>` : "")
    + `<circle cx="${cx}" cy="${cy}" r="${r}" class="ap-c" style="stroke:${col}"/>`
    + `<text x="${cx + r * 0.75 + fs * 0.3}" y="${cy - r * 0.75 - fs * 0.3}" style="font-size:${fs}px" class="ap-t">${fmtR(ap.r)}″</text>`;
}
const fmtR = (r) => (r < 20 ? r.toFixed(1) : r.toFixed(0));

// css px on the canvas -> arcsec
function scale() { const w = $("cv").getBoundingClientRect().width; return gridSize(ctx.fov()) / w * PIXEL_ARCSEC; }
function sky(e) {
  const r = $("cv").getBoundingClientRect(), fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
  const [ra, dec] = skyAt(ctx.info().ra, ctx.info().dec, fx, fy, ctx.fov());
  return { fx, fy, ra, dec };
}

// c: {info(), fov(), ready(), active(), onPick({ra, dec, fx, fy, mode, snap, r}), onPoint({ra, dec, fx, fy})}
export function init(c) {
  ctx = c;
  svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "apsvg"); svg.setAttribute("preserveAspectRatio", "none"); svg.setAttribute("aria-hidden", "true");
  $("stage").insertBefore(svg, $("toolhint"));
  const cv = $("cv");
  cv.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !ctx.ready()) return;
    down = { x: e.clientX, y: e.clientY, id: e.pointerId, drag: false, mouse: e.pointerType === "mouse", p: sky(e) };
  });
  cv.addEventListener("pointermove", (e) => {
    if (!down || e.pointerId !== down.id || !down.mouse || !ctx.active()) return;   // touch: drag would block page scrolling
    const d = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    if (!down.drag && d > 6) { down.drag = true; try { cv.setPointerCapture(e.pointerId); } catch (x) { /* gone */ } }
    if (down.drag) show(down.p.ra, down.p.dec, clampR(d * scale()), false, "extended");
  });
  cv.addEventListener("pointerup", (e) => {
    if (!down || e.pointerId !== down.id) return;
    const d = down; down = null;
    if (!ctx.active()) { ctx.onPoint(d.p); return; }
    if (d.drag) ctx.onPick({ ...d.p, mode: "extended", snap: false, r: ap.r });
    else ctx.onPick({ ...d.p, mode: "point", snap: !e.altKey });
  });
  cv.addEventListener("pointercancel", () => { down = null; });
}
export const clampR = (r) => Math.round(Math.min(R_MAX, Math.max(R_MIN, r)) * 2) / 2;
