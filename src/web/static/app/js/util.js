// Small shared helpers: DOM, dates, sky coordinates of the north-up grid.
export const $ = (id) => document.getElementById(id);
export const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Cameras: name, wavelength range in micrometres, display tint (illustrative)
export const DET = [["D1", 0.75, 1.10, "#4DA3FF"], ["D2", 1.10, 1.62, "#5be3d0"], ["D3", 1.62, 2.42, "#9be35b"],
  ["D4", 2.42, 3.82, "#FFB347"], ["D5", 3.82, 4.42, "#FF7A5C"], ["D6", 4.42, 5.00, "#FF5C7A"]];
export const PIXEL_ARCSEC = 6.15;   // SPHEREx pixel = grid pixel of every picture

// rounded first, so 305° reads 20h20m0.0s, not 20h19m60.0s
export function hms(ra) {
  const t = Math.round((((ra % 360) + 360) % 360) * 240 * 10) / 10, a = Math.floor(t / 3600), m = Math.floor((t - a * 3600) / 60);
  return (a % 24) + "h" + m + "m" + (t - a * 3600 - m * 60).toFixed(1) + "s";
}
export function dms(dec) {
  const s = dec < 0 ? "-" : "+", t = Math.round(Math.abs(dec) * 3600), d = Math.floor(t / 3600), m = Math.floor((t - d * 3600) / 60);
  return s + d + "°" + String(m).padStart(2, "0") + "′" + String(t - d * 3600 - m * 60).padStart(2, "0") + "″";
}
export const date = (iso) => new Date(iso);
export function day(t) { const x = date(t); return x.getUTCDate() + " " + MO[x.getUTCMonth()] + " " + x.getUTCFullYear(); }
export function month(t) { const x = date(t); return MO[x.getUTCMonth()] + " " + x.getUTCFullYear(); }
export function stamp(t) {
  const x = date(t);
  return day(t) + " " + String(x.getUTCHours()).padStart(2, "0") + ":" + String(x.getUTCMinutes()).padStart(2, "0") + " UTC";
}

// Grid of a picture: (2*half+1) SPHEREx pixels per side, as src/web/image_processing/grid.py
export function gridSize(fov) { return 2 * Math.floor(fov * 60 / PIXEL_ARCSEC / 2) + 1; }

// Sky position of a point of the picture (fractions 0..1 from the left / top), inverse TAN projection.
export function skyAt(ra0, dec0, fx, fy, fov) {
  const n = gridSize(fov), c = (n - 1) / 2, s = PIXEL_ARCSEC / 3600 * Math.PI / 180;
  const xi = -(fx * n - 0.5 - c) * s;                // east is left
  const eta = ((1 - fy) * n - 0.5 - c) * s;          // north is up
  const d0 = dec0 * Math.PI / 180, rho = Math.hypot(xi, eta);
  if (rho === 0) return [ra0, dec0];
  const cc = Math.atan(rho);
  const dec = Math.asin(Math.cos(cc) * Math.sin(d0) + eta * Math.sin(cc) * Math.cos(d0) / rho);
  const ra = ra0 * Math.PI / 180 + Math.atan2(xi * Math.sin(cc), rho * Math.cos(d0) * Math.cos(cc) - eta * Math.sin(d0) * Math.sin(cc));
  return [((ra * 180 / Math.PI) % 360 + 360) % 360, dec * 180 / Math.PI];
}

// Inverse of skyAt: picture fractions (0..1 from the left / top) of a sky position, TAN projection.
export function fracAt(ra0, dec0, ra, dec, fov) {
  const n = gridSize(fov), c = (n - 1) / 2, s = PIXEL_ARCSEC / 3600 * Math.PI / 180, k = Math.PI / 180;
  const d0 = dec0 * k, d = dec * k, da = (ra - ra0) * k;
  const cc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(da);
  const xi = Math.cos(d) * Math.sin(da) / cc, eta = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(da)) / cc;
  return [(-xi / s + 0.5 + c) / n, 1 - (eta / s + 0.5 + c) / n];
}

export function toast(text) {
  const t = $("toast");
  t.textContent = text; t.style.display = "block";
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.style.display = "none"; }, 1800);
}
