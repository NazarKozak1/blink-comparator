// Colour band picker (component from demo/UX/band_selector.html, adapted to the site).
// Changes against the designer's file: no test data, no own (i) popup (the legend lives in the site's .tip),
// the band number is not shown on screen (only in aria-label and the URL), the hover hint sits above the bars.
//   const cb = ColourBand(root, { onChange: ({band, lambda_um, count, detector}) => ... })
//   cb.setData({ detector, range: [lo, hi], bands: [{band, lambda_um, count}], selected })
//   cb.setLoading();  cb.select(n);  cb.value          (band 0 = All)
export function ColourBand(root, opts = {}) {
  let bands = [], range = null, detector = "", selected = 0, total = 0;

  root.classList.add("cb");
  root.innerHTML =
    '<div class="cb-rg" role="radiogroup">' +
      '<div class="cb-head">' +
        '<div class="cb-read"></div>' +
        '<button type="button" class="ghost cb-all" role="radio">All</button>' +
      "</div>" +
      '<div class="cb-track"></div>' +
      '<div class="cb-axis"><span class="cb-lo"></span>' +
        '<span class="cb-mid" aria-hidden="true">wavelength →</span>' +
        '<span class="cb-hi"></span></div>' +
    "</div>" +
    '<div class="cb-tip" aria-hidden="true"></div>';

  const rg = root.querySelector(".cb-rg"), read = root.querySelector(".cb-read"), all = root.querySelector(".cb-all"),
    track = root.querySelector(".cb-track"), lo = root.querySelector(".cb-lo"), hi = root.querySelector(".cb-hi"),
    tip = root.querySelector(".cb-tip");

  const fmt = (l) => Number(l).toFixed(2);
  const photos = (k) => k + (k === 1 ? " photo" : " photos");
  const find = (n) => bands.find((b) => b.band === n) || null;
  const enabled = () => bands.filter((b) => b.count > 0).map((b) => b.band);
  const btn = (n) => (n === 0 ? all : track.querySelector('[data-band="' + n + '"]'));

  // ---- bars, on new data ----
  function build() {
    const max = Math.max(1, ...bands.map((b) => b.count));
    track.style.setProperty("--n", bands.length || 17);
    track.innerHTML = "";
    tip.classList.remove("on");
    bands.forEach((b) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "cb-band";
      el.setAttribute("role", "radio");
      el.dataset.band = b.band;
      el.setAttribute("aria-label", "Band " + b.band + " of " + bands.length + ", " + fmt(b.lambda_um) + " micrometres, " + photos(b.count));
      if (!b.count) el.setAttribute("aria-disabled", "true");
      const bar = document.createElement("i");
      bar.style.setProperty("--f", b.count / max);
      el.appendChild(bar);
      track.appendChild(el);
    });
    const a = range ? range[0] : bands[0]?.lambda_um, z = range ? range[1] : bands[bands.length - 1]?.lambda_um;
    lo.textContent = a != null ? fmt(a) + " µm" : "";
    hi.textContent = z != null ? fmt(z) + " µm" : "";
    rg.setAttribute("aria-label", "Colour band" + (detector ? ", detector " + detector : ""));
  }

  // ---- current selection ----
  function paint() {
    const empty = total === 0;
    root.dataset.state = empty ? "empty" : "ready";
    root.dataset.sel = selected === 0 ? "all" : "band";
    rg.removeAttribute("aria-busy");
    all.setAttribute("aria-checked", String(selected === 0 && !empty));
    all.setAttribute("aria-label", "All colours, " + photos(total));
    all.tabIndex = selected === 0 && !empty ? 0 : -1;
    if (empty) all.setAttribute("aria-disabled", "true"); else all.removeAttribute("aria-disabled");
    [].forEach.call(track.children, (el) => {
      const on = Number(el.dataset.band) === selected;
      el.setAttribute("aria-checked", String(on));
      el.tabIndex = on ? 0 : -1;
    });
    if (empty) read.textContent = "No photos for this point";
    else if (selected === 0) read.innerHTML = '<b>All colours</b> · <span class="cb-n">' + photos(total) + "</span>";
    else { const b = find(selected); read.innerHTML = "<b>" + fmt(b.lambda_um) + ' µm</b> · <span class="cb-n">' + photos(b.count) + "</span>"; }
  }

  function emit() {
    const b = find(selected);
    const detail = { band: selected, lambda_um: b ? b.lambda_um : null, count: b ? b.count : total, detector };
    root.dispatchEvent(new CustomEvent("bandchange", { detail, bubbles: true }));
    if (typeof opts.onChange === "function") opts.onChange(detail);
  }

  function select(n, focus) {
    n = Number(n);
    if (root.dataset.state !== "ready") return;
    if (n !== 0) { const b = find(n); if (!b || !b.count) return; }    // empty bands cannot be chosen
    const changed = n !== selected;
    selected = n;
    paint();
    tip.classList.remove("on");
    if (focus) { const el = btn(n); if (el) el.focus(); }
    if (changed) emit();
  }

  all.addEventListener("click", () => select(0, true));
  track.addEventListener("click", (e) => { const el = e.target.closest(".cb-band"); if (el) select(el.dataset.band, true); });

  // ---- hover hint (mouse only): above the bars, so the range labels under them stay visible ----
  track.addEventListener("pointerover", (e) => {
    if (e.pointerType !== "mouse") return;
    const el = e.target.closest(".cb-band");
    if (!el) return;
    const b = find(Number(el.dataset.band));
    if (!b || b.band === selected) { tip.classList.remove("on"); return; }
    tip.textContent = fmt(b.lambda_um) + " µm · " + (b.count ? photos(b.count) : "no photos");
    const r = root.getBoundingClientRect(), c = el.getBoundingClientRect(), t = track.getBoundingClientRect();
    const x = c.left - r.left + c.width / 2 - tip.offsetWidth / 2;
    tip.style.left = Math.max(0, Math.min(x, r.width - tip.offsetWidth)) + "px";
    tip.style.top = (t.top - r.top - tip.offsetHeight - 4) + "px";
    tip.classList.add("on");
  });
  track.addEventListener("pointerleave", () => tip.classList.remove("on"));

  // ---- keyboard: arrows skip empty bands, Home / End, Esc = All. preventDefault tells the page
  // not to step through the photos with the same key press.
  rg.addEventListener("keydown", (e) => {
    const en = enabled();
    if (!en.length || root.dataset.state !== "ready") return;
    const i = en.indexOf(selected);
    let next;
    switch (e.key) {
      case "ArrowRight": case "ArrowDown": next = i < 0 ? en[0] : en[Math.min(i + 1, en.length - 1)]; break;
      case "ArrowLeft": case "ArrowUp": next = i <= 0 ? 0 : en[i - 1]; break;
      case "Home": next = en[0]; break;
      case "End": next = en[en.length - 1]; break;
      case "Escape": if (selected === 0) return; next = 0; break;
      default: return;
    }
    e.preventDefault();
    select(next, true);
  });

  function setData(d) {
    detector = d.detector || "";
    range = d.range || null;
    bands = (d.bands || []).slice().sort((a, b) => a.band - b.band);
    total = bands.reduce((s, b) => s + b.count, 0);
    const want = find(Number(d.selected));
    selected = want && want.count ? want.band : 0;
    build();
    paint();
    return selected;
  }

  function setLoading() {
    root.dataset.state = "loading";
    root.dataset.sel = "all";
    rg.setAttribute("aria-busy", "true");
    read.textContent = "Loading bands…";
    all.setAttribute("aria-checked", "false");
    all.setAttribute("aria-disabled", "true");
    all.tabIndex = -1;
    tip.classList.remove("on");
    const h = [30, 45, 60, 80, 55, 40, 50, 65, 45, 35, 50, 70, 55, 40, 60, 35, 25];
    track.style.setProperty("--n", h.length);
    track.innerHTML = h.map((v) => '<div class="cb-sk" style="--h:' + v + '%"></div>').join("");
  }

  setLoading();
  return { setData, setLoading, select: (n) => select(n, false), get value() { return selected; } };
}

// What each detector shows: the list in the (i) next to "Colour band" (rendered by the site's tooltip).
const ICE = "looks dimmer here if this ice lies in front.";
const H = "glowing hydrogen gas in nebulae shines brighter here.";
const PAH = "organic dust in nebulae glows here; cold brown dwarfs look dimmer here.";
export const BAND_NOTES = {
  1: [],
  2: [["1.28 µm · Paβ hydrogen", H]],
  3: [["1.87 µm · Paα hydrogen", H], ["2.17 µm · Brγ hydrogen", H]],
  4: [["3.05 µm · water ice", ICE], ["3.3 µm · PAH / methane", PAH]],
  5: [["4.05 µm · Brα hydrogen", H], ["4.27 µm · CO₂ ice", ICE]],
  6: [["4.67 µm · CO ice", ICE], ["Best for very cold objects", ""]],
};
export const BAND_INTRO = "Each photo sees this spot in one narrow infrared colour. Pick one to see only those photos.";
