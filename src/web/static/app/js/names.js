// Name search for the targets list (no DOM): word-start matches first, then fuzzy matches by trigram similarity
// (as PostgreSQL pg_trgm: words padded with two spaces in front and one behind), so "bernard" finds Barnard's Star.
// Also used by tests/test_name_search.py, which runs this file as plain JS (keep it free of imports).

export const FUZZY_MIN = 0.3;
export const FUZZY_FROM = 4;     // shorter queries match too many names by chance (e.g. "bar" ~ "Ba" at 0.4)

// lower case, no accents or apostrophes, Greek epsilon spelled out, single spaces
export function normalize(s) {
  return String(s).toLowerCase().replace(/ε/g, "eps ").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/['’`]/g, "").replace(/[^a-z0-9+\-.]+/g, " ").trim().replace(/\s+/g, " ");
}

export function trigrams(s) {
  const out = new Set();
  normalize(s).split(" ").filter(Boolean).forEach((w) => {
    const p = "  " + w + " ";
    for (let i = 0; i + 3 <= p.length; i++) out.add(p.slice(i, i + 3));
  });
  return out;
}

export function similarity(a, b) {
  const A = trigrams(a), B = trigrams(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  A.forEach((t) => { if (B.has(t)) n++; });
  return n / (A.size + B.size - n);
}

// best similarity of the query to the whole name or to any run of as many words as the query has
export function bestSimilarity(query, name) {
  const qw = normalize(query).split(" ").filter(Boolean).length, w = normalize(name).split(" ");
  let best = similarity(query, name);
  for (let i = 0; i + qw <= w.length; i++) best = Math.max(best, similarity(query, w.slice(i, i + qw).join(" ")));
  return best;
}

// 1: the name starts with the query, 2: a word of the name does, 0: neither
function prefixRank(q, name) {
  const n = normalize(name);
  if (n.startsWith(q)) return 1;
  return (" " + n).includes(" " + q) ? 2 : 0;
}

// Coordinates (degrees or sexagesimal): only digits, signs, separators and h/m/s/d marks, with at least two numbers.
export function looksLikeCoords(text) {
  const t = String(text).trim();
  return /^[\d\s+\-.,:hmsd°′″'"]+$/i.test(t) && (t.match(/\d+(\.\d+)?/g) || []).length >= 2;
}

// targets: [{n (name), h (hint), alt: [other names]}]; returns [{t, name (matched spelling), how, score}]
export function suggest(query, targets, limit = 6) {
  const q = normalize(query);
  if (!q || looksLikeCoords(query)) return [];
  const found = [];
  targets.forEach((t, k) => {
    let best = null;
    [t.n, ...(t.alt || [])].forEach((name) => {
      const r = prefixRank(q, name);
      const c = r ? { t, name, how: "prefix", score: 3 - r }
        : q.length >= FUZZY_FROM ? { t, name, how: "fuzzy", score: bestSimilarity(q, name) } : null;
      if (!c || (c.how === "fuzzy" && c.score < FUZZY_MIN)) return;
      if (!best || (c.how === "prefix") > (best.how === "prefix") || (c.how === best.how && c.score > best.score)) best = c;
    });
    if (best) found.push({ ...best, k });
  });
  found.sort((a, b) => (a.how === "prefix" ? 0 : 1) - (b.how === "prefix" ? 0 : 1) || b.score - a.score || a.k - b.k);
  return found.slice(0, limit);
}
