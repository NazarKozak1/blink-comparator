// Known objects near a clicked point (no DOM, no imports: tests/test_nearby.py runs this file as plain JS).
// The search radius follows the field of view: the PSF of the shown frame, or about 10 screen pixels, whichever is
// larger, at most 60". A bright star's image is wider than the PSF (saturated core, wings), so each object also
// counts within its own halo, FWHM x (1 + 0.25 (12 - m)) clamped to 1..4 FWHM (m = K, else G). Objects are listed
// brightest in the infrared first: 2MASS K from SIMBAD, else Gaia G, then those without a magnitude, nearest first.

export const NEAR_MAX_ARCSEC = 60, NEAR_SCREEN_PX = 10, NEAR_LIMIT = 10, PSF_DEFAULT = 6.6;
export const HALO_MAG = 12, HALO_PER_MAG = 0.25, HALO_MAX = 4;

export function searchRadius(fovArcmin, stagePx, psfFwhm) {
  const perPx = fovArcmin * 60 / Math.max(1, stagePx);
  return Math.min(NEAR_MAX_ARCSEC, Math.max(psfFwhm || PSF_DEFAULT, NEAR_SCREEN_PX * perPx));
}

// Linear proper motion as src/web/catalogs.move (mas/yr, pmRA includes cos Dec), dt in years
export function moveBy(o, dt) {
  if (!dt || (!o.pmra && !o.pmdec)) return o;
  return { ...o, ra: ((o.ra + (o.pmra || 0) * dt / 3.6e6 / Math.cos(o.dec * Math.PI / 180)) % 360 + 360) % 360,
    dec: o.dec + (o.pmdec || 0) * dt / 3.6e6 };
}

export function sepArcsec(ra1, dec1, ra2, dec2) {
  const dra = (((ra1 - ra2 + 540) % 360) - 180) * Math.cos((dec1 + dec2) / 360 * Math.PI);
  return Math.hypot(dra, dec1 - dec2) * 3600;
}

// The magnitude used for sorting and shown next to the name: ["K", 4.5], ["G", 9.5] or null
export const magOf = (o) => (o.k != null ? ["K", o.k] : o.g != null ? ["G", o.g] : null);

// How far from its position a star's image reaches, in arcsec
export function halo(o, psfFwhm) {
  const m = o.k ?? o.g, f = psfFwhm || PSF_DEFAULT;
  if (m == null) return f;
  return Math.min(NEAR_MAX_ARCSEC, f * Math.min(HALO_MAX, Math.max(1, 1 + HALO_PER_MAG * (HALO_MAG - m))));
}

// objects (already at the right date) within radius of (ra, dec), or within their own halo, with .dist;
// K first, then G, then the rest
export function nearPoint(objects, ra, dec, radius, psfFwhm = null, limit = NEAR_LIMIT) {
  const cut = Math.max(radius, NEAR_MAX_ARCSEC) / 3600 * 1.5;
  const out = [];
  for (const o of objects) {
    if (Math.abs(o.dec - dec) > cut) continue;
    const d = sepArcsec(o.ra, o.dec, ra, dec);
    if (d <= radius || d <= halo(o, psfFwhm)) out.push({ ...o, dist: d });
  }
  return sortNear(out).slice(0, limit);
}

// K first (brightest first), then G, then objects without a magnitude by distance
export function sortNear(list) {
  const rank = (o) => (o.k != null ? 0 : o.g != null ? 1 : 2);
  return list.sort((a, b) => rank(a) - rank(b) || (rank(a) < 2 ? (a.k ?? a.g) - (b.k ?? b.g) : 0) || a.dist - b.dist);
}

// Objects near the click, plus those at the peaks of the star image the click fell on (the brightest points the
// click climbs to on the picture, see explore.js climb); distances are from the click, each object once.
export function nearClick(objects, click, radius, psfFwhm, peaks = [], peakRadius = 0, limit = NEAR_LIMIT) {
  const a = nearPoint(objects, click.ra, click.dec, radius, psfFwhm, 1e9);
  const seen = new Set(a.map((o) => o.name));
  (peaks || []).filter(Boolean).forEach((pk) => nearPoint(objects, pk.ra, pk.dec, peakRadius, psfFwhm, 1e9).forEach((o) => {
    if (!seen.has(o.name)) { seen.add(o.name); a.push({ ...o, dist: sepArcsec(o.ra, o.dec, click.ra, click.dec) }); }
  }));
  return sortNear(a).slice(0, limit);
}
