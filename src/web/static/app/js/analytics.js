// Analytics view: only numbers we really have (frame index, visits, colours). The rest is marked Coming soon.
import { field } from "./explore.js";
import { S } from "./state.js";
import { $, DET, dms, hms, month } from "./util.js";

export function render() {
  const D = field();
  if (!D.info) {
    $("an-t").textContent = "Area analytics";
    $("an-s").textContent = "";
    $("ov-h").innerHTML = "Open a field in Explore first: type coordinates, pick a target, or spin the Sky sphere.";
    $("ov").innerHTML = "";
    $("cov").innerHTML = "";
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
}
