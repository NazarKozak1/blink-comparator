// Page state and its copy in the address: ?q=...&det=... (settings) and #view.
export const S = {
  q: "",            // coordinates exactly as sent to the server (frame lists are cached by this text)
  det: 6, fov: 6, mode: "frames", band: 0, i: 0,
  ea: 0, eb: -1,    // epochs for Blink / Diff; -1 = last
  method: "minmax", cmp: "", win: "epoch", start: "", end: "",
  same: false, holes: false, crop: false, stretch: "normal",
  orig: false,        // frames shown as recorded (stacks, Blink and Diff always remove the background)
  bgm: "median",      // background method: median of the photo, or the NASA zodiacal model ("zodi")
};

const NUM = ["det", "fov", "band", "i", "ea", "eb"];
const BOOL = ["same", "holes", "crop"];
const MODES = ["frames", "stacks", "blink", "diff"];
const METHODS = ["minmax", "sigma", "mean"];

export function readUrl() {
  const p = new URLSearchParams(location.search);
  if (!p.get("q")) return false;
  S.q = p.get("q");
  NUM.forEach((k) => { if (p.has(k) && !isNaN(+p.get(k))) S[k] = +p.get(k); });
  BOOL.forEach((k) => { S[k] = p.get(k) === "1"; });
  if (MODES.includes(p.get("mode"))) S.mode = p.get("mode");
  if (METHODS.includes(p.get("method"))) S.method = p.get("method");
  S.cmp = METHODS.includes(p.get("cmp")) ? p.get("cmp") : "";
  if (["epoch", "day", "custom"].includes(p.get("win"))) S.win = p.get("win");
  S.start = p.get("start") || ""; S.end = p.get("end") || "";
  S.orig = p.get("orig") === "1" || p.get("bg") === "raw";                 // bg= is the older form
  S.bgm = p.get("bgm") === "zodi" || p.get("bg") === "zodi" ? "zodi" : "median";
  if (["faint", "normal", "bright"].includes(p.get("stretch"))) S.stretch = p.get("stretch");
  S.det = Math.min(6, Math.max(1, S.det)); S.fov = Math.min(30, Math.max(1, S.fov));
  return true;
}

export function writeUrl() {
  if (!S.q) return;
  const p = { q: S.q, det: S.det, fov: S.fov, mode: S.mode, i: S.i, method: S.method };
  if (S.orig) p.orig = 1;
  if (S.bgm !== "median") p.bgm = S.bgm;
  if (S.band) p.band = S.band;
  if (S.stretch !== "normal") p.stretch = S.stretch;
  if (S.mode === "blink" || S.mode === "diff") { p.ea = S.ea; p.eb = S.eb; }
  if (S.cmp) p.cmp = S.cmp;
  if (S.win !== "epoch") p.win = S.win;
  if (S.win === "custom") { p.start = S.start; p.end = S.end; }
  BOOL.forEach((k) => { if (S[k]) p[k] = 1; });
  try { history.replaceState(null, "", "?" + new URLSearchParams(p) + location.hash); } catch (e) { /* file:// */ }
}
