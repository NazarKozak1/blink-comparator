// Floating windows (Vera's idea): one per type, dragged by the title and kept on screen, the clicked one on top,
// minimised into a tab docked at the bottom right (several tabs line up right to left), Esc closes the focused
// one, the place of each type remembered in localStorage (windows never reopen by themselves).
// Below 700 px a window is a bottom sheet and tabs are thin strips above the bottom edge.

const PHONE = 700;
const wins = new Map();          // type -> window
let z = 60, focused = null, dock = null, lastPointer = "mouse";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const phone = () => innerWidth < PHONE;
const key = (type) => "win-pos:" + type;

function ensureDock() {
  if (dock) return dock;
  dock = document.createElement("div");
  dock.className = "wdock"; dock.setAttribute("role", "toolbar"); dock.setAttribute("aria-label", "Minimised windows");
  document.body.appendChild(dock);
  document.addEventListener("pointerdown", (e) => { lastPointer = e.pointerType; }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    const w = focused && wins.get(focused);
    if (w && w.state === "open") { e.preventDefault(); w.close(); }
  });
  window.addEventListener("resize", () => wins.forEach((w) => { if (w.state === "open") w.place(); }));
  return dock;
}

// Room for the tabs at the bottom of the page, so they never cover its controls.
function pad() {
  const n = [...wins.values()].filter((w) => w.state === "min").length;
  document.body.style.paddingBottom = n ? (dock.offsetHeight + 12) + "px" : "";
}

// opts: {title, label (aria), header (extra html after the title), className, onClose()}
// Returns {el, body, state, open(), close(), minimise(), restore(), setStatus(text), markUpdated(), place()}.
export function createWindow(type, opts) {
  if (wins.has(type)) return wins.get(type);
  ensureDock();
  const el = document.createElement("section");
  el.className = "fw " + (opts.className || ""); el.hidden = true;
  el.setAttribute("role", "dialog"); el.setAttribute("aria-label", opts.label || opts.title);
  el.innerHTML = `<header class="fw-h"><b class="fw-t">${esc(opts.title)}</b>${opts.header || ""}`
    + `<span class="fw-btns"><button class="fw-min" aria-label="Minimise" title="Minimise">—</button>`
    + `<button class="fw-x" aria-label="Close" title="Close">✕</button></span></header><div class="fw-b"></div>`;
  document.body.appendChild(el);
  const tab = document.createElement("div");
  tab.className = "fw-tab"; tab.hidden = true;
  tab.innerHTML = `<button class="fw-tab-open" title="Restore"><b>${esc(opts.title)}</b><span class="fw-st"></span>`
    + `<i class="fw-upd" hidden>updated</i><span class="fw-up" aria-hidden="true">▴</span></button>`
    + `<button class="fw-tab-x" aria-label="Close ${esc(opts.title)}" title="Close">✕</button>`;
  dock.appendChild(tab);

  let openedAt = 0, status = "";
  const w = {
    el, body: el.querySelector(".fw-b"), state: "closed",
    open() {
      if (w.state === "min") { w.markUpdated(); return; }       // stays minimised; the tab says so
      const was = w.state;
      w.state = "open"; el.hidden = false; tab.hidden = true;
      if (was !== "open") { w.place(); touched(); }
      w.focus(); pad();
    },
    close() {
      if (w.state === "closed") return;
      w.state = "closed"; el.hidden = true; tab.hidden = true;
      if (focused === type) focused = null;
      pad(); opts.onClose?.();
    },
    minimise() {
      if (w.state !== "open") return;
      w.state = "min"; el.hidden = true; tab.hidden = false;
      if (focused === type) focused = null;
      pad();
    },
    restore() {
      if (w.state !== "min") return;
      w.state = "open"; el.hidden = false; tab.hidden = true;
      tab.querySelector(".fw-upd").hidden = true;             // seen now
      w.place(); touched(); w.focus(); pad();
    },
    setStatus(text) {
      status = text;
      tab.querySelector(".fw-st").textContent = text ? " · " + text : "";
      tab.querySelector(".fw-tab-open").title = "Restore " + opts.title + (text ? " · " + text : "");
    },
    markUpdated() { if (w.state === "min") tab.querySelector(".fw-upd").hidden = false; },
    focus() { focused = type; el.style.zIndex = ++z; },
    place() {
      if (phone()) { el.style.left = el.style.top = ""; return; }      // bottom sheet (CSS)
      let pos = null;
      try { pos = JSON.parse(localStorage.getItem(key(type))); } catch (x) { pos = null; }
      if (!Array.isArray(pos)) pos = [innerWidth - el.offsetWidth - 24, 90];
      setPos(pos[0], pos[1]);
    },
    get status() { return status; },
  };

  // a tap that opened the sheet under the finger is followed by a click there: it must not press a button
  const touched = () => { openedAt = lastPointer === "touch" ? performance.now() : 0; };
  function setPos(x, y) {          // the whole window stays on screen
    el.style.left = Math.max(8, Math.min(x, innerWidth - el.offsetWidth - 8)) + "px";
    el.style.top = Math.max(8, Math.min(y, innerHeight - el.offsetHeight - 8)) + "px";
  }
  // drag by the title bar (not on phones: the sheet is fixed)
  const h = el.querySelector(".fw-h");
  let drag = null;
  h.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button, select, input") || phone()) return;
    const r = el.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    h.setPointerCapture(e.pointerId);
  });
  h.addEventListener("pointermove", (e) => { if (drag) setPos(e.clientX - drag.dx, e.clientY - drag.dy); });
  h.addEventListener("pointerup", () => {
    if (!drag) return;
    drag = null;
    try { localStorage.setItem(key(type), JSON.stringify([el.offsetLeft, el.offsetTop])); } catch (x) { /* storage off */ }
  });
  el.addEventListener("pointerdown", () => w.focus(), true);
  el.addEventListener("click", (e) => { if (openedAt && performance.now() - openedAt < 500) { e.stopPropagation(); e.preventDefault(); } }, true);
  el.querySelector(".fw-min").onclick = () => w.minimise();
  el.querySelector(".fw-x").onclick = () => w.close();
  tab.querySelector(".fw-tab-open").onclick = () => w.restore();
  tab.querySelector(".fw-tab-x").onclick = () => w.close();
  wins.set(type, w);
  return w;
}
