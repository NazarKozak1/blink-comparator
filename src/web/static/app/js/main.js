// Entry point: views (hash routing, as in the prototype), header buttons, start-up from the address.
import * as analytics from "./analytics.js";
import * as explore from "./explore.js";
import * as sphere from "./sphere.js";
import { readUrl, S, writeUrl } from "./state.js";
import { $ } from "./util.js";

const V = ["home", "explore", "sphere", "analytics", "article", "object"];

function route() {
  let h = decodeURIComponent(location.hash.slice(1));
  if (h.startsWith("object/")) {          // reserved: one page per object, not built yet
    $("obj-t").textContent = "Object at " + h.slice(7).replace(",", ", ");
    h = "object";
  } else if (window.__art && h.startsWith("a-") && window.__art(h)) h = "article";
  else if (!V.includes(h) || h === "article" || h === "object") h = "home";
  V.forEach((v) => { $("v-" + v).hidden = v !== h; });
  [].forEach.call(document.querySelectorAll("nav button"), (b) => b.setAttribute("aria-current", b.dataset.v === h));
  $("back").hidden = h === "home";
  if (h === "sphere") sphere.resize();
  if (h === "explore") explore.fitStage();
  else document.body.classList.remove("fit");
  if (h === "analytics") analytics.render();
  if (h !== "explore" && $("play").textContent !== "▶") explore.toggle();
  writeUrl();
}
function go(v) { location.hash = v; route(); }

function open(ra, dec, fov) {
  go("explore");
  explore.search(ra.toFixed(5) + " " + dec.toFixed(5), { fov, mode: "frames", band: 0, i: 0, ea: 0, eb: -1 });
}

explore.init();
sphere.init(open);
explore.onField(() => { if (!$("v-analytics").hidden) analytics.render(); });

addEventListener("hashchange", route);
[].forEach.call(document.querySelectorAll("nav button"), (b) => { b.onclick = () => go(b.dataset.v); });
$("logo").onclick = () => go("home");
$("back").onclick = () => go("home");
$("bcont").onclick = () => $("d-cont").showModal();
[].forEach.call(document.querySelectorAll("[data-go]"), (b) => {
  b.onclick = () => {
    const t = b.dataset.go;
    if (t === "random") { go("explore"); explore.randomPatch(); } else if (t === "info") $("d-info").showModal(); else go(t);
  };
});

if (readUrl()) {
  if (!location.hash) location.hash = "explore";
  explore.search(S.q, {});
}
route();
