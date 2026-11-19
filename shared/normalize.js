// normalize.js — Arabic/Latin answer normalization, Levenshtein distance,
// and typo-tolerant answer matching with cross-country disambiguation.
// Pure, no dependencies. ES2022.

// Arabic diacritics U+064B–U+0652, U+0670, tatweel U+0640
const DIACRITICS = /[\u064B-\u0652\u0670\u0640]/g;

const ALEF_MAP = { '\u0623': '\u0627', '\u0625': '\u0627', '\u0622': '\u0627', '\u0671': '\u0627' }; // أ إ آ ٱ -> ا

/**
 * Normalize text for comparison:
 * - strip Arabic diacritics + tatweel
 * - unify alef forms -> ا, ى -> ي, ة -> ه, ؤ -> و, ئ -> ي
 * - strip the "ال" prefix from each word
 * - remove punctuation, collapse spaces, lowercase Latin, trim
 * @param {string} s
 * @returns {string}
 */
export function normalizeText(s) {
  if (s === null || s === undefined) return '';
  let t = String(s);
  t = t.replace(DIACRITICS, '');
  t = t.replace(/[\u0623\u0625\u0622\u0671]/g, (ch) => ALEF_MAP[ch]);
  t = t.replace(/\u0649/g, '\u064A'); // ى -> ي
  t = t.replace(/\u0629/g, '\u0647'); // ة -> ه
  t = t.replace(/\u0624/g, '\u0648'); // ؤ -> و
  t = t.replace(/\u0626/g, '\u064A'); // ئ -> ي
  // Remove punctuation / symbols, keep letters, numbers and spaces.
  t = t.replace(/[^\p{L}\p{N} ]+/gu, ' ');
  t = t.toLowerCase();
  // Strip the "ال" prefix from each word (only when something remains).
  t = t
    .split(' ')
    .map((w) => (w.startsWith('\u0627\u0644') && w.length > 2 ? w.slice(2) : w))
    .filter((w) => w.length > 0)
    .join(' ');
  // Collapse extra spaces and trim.
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

/**
 * Classic Levenshtein edit distance (insert/delete/substitute cost 1).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function levenshtein(a, b) {
  const s = String(a);
  const t = String(b);
  const m = s.length;
  const n = t.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    const sc = s.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = sc === t.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

/**
 * All normalized accepted names for a country entry:
 * Arabic name, English name, Arabic aliases, English aliases.
 * @param {{ar:string, en:string, aliasesAr?:string[], aliasesEn?:string[]}} country
 * @returns {string[]}
 */
export function ACCEPTED_NAMES(country) {
  if (!country) return [];
  const names = [];
  const add = (v) => {
    const n = normalizeText(v);
    if (n && !names.includes(n)) names.push(n);
  };
  add(country.ar);
  add(country.en);
  (country.aliasesAr || []).forEach(add);
  (country.aliasesEn || []).forEach(add);
  return names;
}

function allowedTypos(normalizedInputLength) {
  if (normalizedInputLength >= 9) return 2;
  if (normalizedInputLength >= 5) return 1;
  return 0;
}

/**
 * Does the typed input name this country?
 * - exact normalized match against ar/en/aliases, or within typo tolerance
 * - returns false when the input matches ANY OTHER country at least as well
 *   (exact or within tolerance), so ambiguous input like "الكونغو" or a
 *   near-miss like Niger vs Nigeria can never be accepted.
 * @param {string} input
 * @param {{code:string, ar:string, en:string, aliasesAr?:string[], aliasesEn?:string[]}} country
 * @param {Array} allCountries - every country to disambiguate against
 * @returns {boolean}
 */
export function matchesAnswer(input, country, allCountries) {
  if (!country) return false;
  const n = normalizeText(input);
  if (!n) return false;
  const tol = allowedTypos(n.length);
  const bestDistance = (names) => {
    let best = Infinity;
    for (const name of names) {
      const d = levenshtein(n, name);
      if (d < best) best = d;
      if (best === 0) break;
    }
    return best;
  };
  const d1 = bestDistance(ACCEPTED_NAMES(country));
  if (d1 > tol) return false;
  for (const other of allCountries || []) {
    if (!other || other.code === country.code) continue;
    const d2 = bestDistance(ACCEPTED_NAMES(other));
    if (d2 <= d1 && d2 <= tol) return false;
  }
  return true;
}
