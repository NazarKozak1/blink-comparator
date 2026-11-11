// Analytics view: only numbers we really have (frame index, visits, colours, known objects from SIMBAD and Gaia).
// The rest is marked Coming soon.
import * as CAT from "./catalog.js";
import { field, pinSky } from "./explore.js";
import { S } from "./state.js";
import { $, DET, dms, hms, month } from "./util.js";

export function render() {
  const D = field();
  if (!D.info) {
    $("an-t").textContent = "Area analytics";
    $("an-s").textContent = "";
    $("ov-h").innerHTML = "Open a field in Explore first: type a target name or coordinates, or spin the Sky sphere.";
    $("ov").innerHTML = "";
    $("cov").innerHTML = "";
    ["an-types", "an-known", "an-list"].forEach((id) => { $(id).innerHTML = "<p class='note'>Open a field in Explore first.</p>"; });
    return;
  }
  const info = D.info, all = D.all, det = DET[S.det - 1];
  const lam = all.map((f) => f.lambda_um).filter(Boolean);
  const bands = new Set(all.map((f) => f.band).filter(Boolean));
  const first = all.length ? all[0].date_obs : null, last = all.length ? all[all.length - 1].date_obs : null;
  const centre = hms(info.ra) + " " + dms(info.dec);
  $("an-t").textContent = "Area analytics";
  $("an-s").textContent = "RA " + hms(info.ra) + "  Dec " + dms(info.dec) + " · field " + S.fov + "′ · camera " + det[0];
  $("ov-h").textContent = all.length
    ? "In this " + S.fov + "′ patch SPHEREx took " + all.length + " photos with camera " + det[0] + " during "
      + D.epochs.length + " visit" + (D.epochs.length === 1 ? "" : "s") + ", from " + month(first) + " to " + month(last) + "."
    : "SPHEREx has no photos of this patch with camera " + det[0] + " yet.";
  const kv = [
    ["Centre", centre],
    ["Area size", S.fov + "′ × " + S.fov + "′ (≈ " + (S.fov / 30).toFixed(2) + " Moon widths)"],
    ["Camera", det[0] + " · " + det[1] + "–" + det[2] + " µm"],
    ["Photos", all.length + " in " + D.epochs.length + " visit" + (D.epochs.length === 1 ? "" : "s")],
    ["Time span", first ? month(first) + " – " + month(last) : "—"],
    ["Colours seen", lam.length ? Math.min(...lam).toFixed(2) + "–" + Math.max(...lam).toFixed(2) + " µm" : "—"],
    ["Colour bands with photos", bands.size + " of 17"],
    ["Cropped photos hidden", S.crop ? "none (shown)" : String(info.hidden_cropped)],
  ];
  $("ov").innerHTML = kv.map((x) => "<div><span>" + x[0] + "</span><b>" + x[1] + "</b></div>").join("");
  $("cov").innerHTML = D.epochs.map((e, k) => "<dt>Epoch " + (k + 1) + "</dt><dd>" + e.label + " · " + e.n + " frames</dd>").join("")
    || "<dt>—</dt><dd>no visits</dd>";
  objects(D);
}

// ---------- known objects of the field (catalog.js) ----------
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const TOP_TYPES = 10, PAGE = 200;
let sort = { key: "type", dir: 1 }, showAll = false, lastKey = "";

function objects(D) {
  const st = CAT.C.status, note = CAT.sourcesNote();
  if (CAT.C.key !== lastKey) { lastKey = CAT.C.key; showAll = false; }
  if (st === "loading" || st === "idle") {
    ["an-types", "an-known", "an-list"].forEach((id) => { $(id).innerHTML = "<p class='note'>Checking catalogs…</p>"; });
    foot(); return;
  }
  const t = D.all.length ? (D.all[0].t + D.all[D.all.length - 1].t) / 2 : null;
  const objs = CAT.objectsAt(t);
  // types
  const n = new Map();
  objs.forEach((o) => n.set(o.type, (n.get(o.type) || 0) + 1));
  const types = [...n.entries()].sort((a, b) => b[1] - a[1]);
  const top = types.slice(0, TOP_TYPES), rest = types.slice(TOP_TYPES).reduce((k, x) => k + x[1], 0);
  if (rest) top.push(["other types (" + (types.length - TOP_TYPES) + ")", rest]);
  const max = Math.max(1, ...top.map((x) => x[1]));
  $("an-types").innerHTML = objs.length
    ? "<div class='bars'>" + top.map(([k, v]) => "<div class='tb'><span class='bl' title='" + esc(k) + "'>" + esc(k)
      + "</span><span class='bt'><i style='width:" + (v / max * 100).toFixed(1) + "%'></i></span><span class='bn mono'>" + v + "</span></div>").join("") + "</div>"
      + (note ? "<p class='note'>" + note + "</p>" : "")
    : "<p class='note'>" + (note || "No known objects in this patch.") + "</p>";
  // known
  const sim = objs.filter((o) => o.source !== "Gaia").length, both = objs.filter((o) => o.source === "SIMBAD + Gaia").length;
  const gaiaOnly = objs.length - sim, planets = objs.reduce((k, o) => k + (o.planets || 0), 0);
  $("an-known").innerHTML = "<p class='big'>" + objs.length + "</p><p style='margin:0 0 10px'>known objects in catalogs</p>"
    + "<dl class='mono'><dt>SIMBAD</dt><dd>" + sim + "</dd><dt>of them also in Gaia</dt><dd>" + both + "</dd><dt>Gaia only</dt><dd>" + gaiaOnly + "</dd>"
    + (planets ? "<dt>known planets</dt><dd>" + planets + "</dd>" : "") + "</dl>"
    + "<p class='note'>Unknown objects are not counted yet: that needs finding sources in the SPHEREx picture itself.</p>"
    + (note ? "<p class='note'>" + note + "</p>" : "");
  table(objs);
  foot(t);
}

function table(objs) {
  if (!objs.length) { $("an-list").innerHTML = "<p class='note'>Nothing to list.</p>"; return; }
  const k = sort.key, d = sort.dir;
  const rows = objs.slice().sort((a, b) => (k === "type" ? a.type.localeCompare(b.type) * d || a.name.localeCompare(b.name)
    : a.name.localeCompare(b.name, undefined, { numeric: true }) * d));
  const shown = showAll ? rows : rows.slice(0, PAGE);
  const th = (key, label) => "<th><button data-k='" + key + "'" + (k === key ? " aria-sort='" + (d > 0 ? "ascending" : "descending") + "'" : "")
    + ">" + label + (k === key ? (d > 0 ? " ▲" : " ▼") : "") + "</button></th>";
  $("an-list").innerHTML = "<div class='otbl'><table><thead><tr>" + th("name", "Name") + th("type", "Type")
    + "<th>RA, Dec</th><th class='hs'>Source</th></tr></thead><tbody>"
    + shown.map((o, i) => "<tr class='r' tabindex='0' data-i='" + i + "'><td>" + esc(o.name) + (o.planets ? " <span class='note'>+" + o.planets + " planets</span>" : "")
      + "</td><td>" + esc(o.type) + "</td><td class='mono'>" + o.ra.toFixed(5) + "<br>" + (o.dec >= 0 ? "+" : "") + o.dec.toFixed(5)
      + "</td><td class='hs'>" + o.source + "</td></tr>").join("") + "</tbody></table></div>"
    + (rows.length > shown.length ? "<p class='note'>Showing " + shown.length + " of " + rows.length + ". <button class='linkbtn' id='an-all'>Show all</button></p>" : "");
  $("an-list").querySelectorAll("th button").forEach((b) => {
    b.onclick = () => { sort = { key: b.dataset.k, dir: sort.key === b.dataset.k ? -sort.dir : 1 }; table(objs); };
  });
  const open = (tr) => { const o = shown[+tr.dataset.i]; location.hash = "explore"; setTimeout(() => pinSky(o.ra, o.dec), 0); };
  $("an-list").querySelectorAll("tr.r").forEach((tr) => {
    tr.onclick = () => open(tr);
    tr.onkeydown = (e) => { if (e.key === "Enter") open(tr); };
  });
  if ($("an-all")) $("an-all").onclick = () => { showAll = true; table(objs); };
}

function foot(t) {
  const when = t ? new Date(t).toISOString().slice(0, 10) : "";
  $("an-foot").textContent = "Photo numbers come from the SPHEREx frame index. Known objects: SIMBAD (CDS, via the Harvard mirror) and "
    + "Gaia DR3 (ESA archive), asked once for the whole patch; Gaia sometimes does not answer in time, and then only SIMBAD is counted. "
    + (when ? "Positions are moved by proper motion to " + when + ", the middle of the photos. " : "")
    + "Panels marked Coming soon are in development.";
}

CAT.onChange(() => { if (!$("v-analytics").hidden) render(); });
