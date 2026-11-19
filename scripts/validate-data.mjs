// validate-data.mjs — validates shared/countries.js data + flag SVGs.
// Collects ALL failures, prints each, exits 1 if any; exits 0 on success.
import { COUNTRIES, TERRITORIES, byCode } from '../shared/countries.js';
import { normalizeText } from '../shared/normalize.js';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

const VALID_CONTINENTS = new Set([
  'africa', 'asia', 'europe', 'north-america', 'south-america', 'oceania',
]);

// --- counts -----------------------------------------------------------------
check(Array.isArray(COUNTRIES), 'COUNTRIES is not an array');
check(Array.isArray(TERRITORIES), 'TERRITORIES is not an array');
check(COUNTRIES.length === 195, `COUNTRIES length is ${COUNTRIES.length}, expected exactly 195`);
check(TERRITORIES.length >= 20, `TERRITORIES length is ${TERRITORIES.length}, expected >= 20`);

// --- flag files --------------------------------------------------------------
let flagFiles = new Set();
try {
  const files = await readdir(path.join(root, 'public', 'flags'));
  flagFiles = new Set(files);
} catch (err) {
  failures.push(`cannot read public/flags directory: ${err.message}`);
}

const all = [...(COUNTRIES ?? []), ...(TERRITORIES ?? [])];

// --- per-entry checks + uniqueness -------------------------------------------
const seenCodes = new Map(); // code -> where
const arNames = new Map(); // normalized Arabic name/alias -> "code (field)"
const enNames = new Map(); // normalized English name/alias -> "code (field)"

function noteName(map, normalized, label, code) {
  if (!normalized) return;
  if (map.has(normalized)) {
    const prev = map.get(normalized);
    // same entry listing its own name again as an alias is redundant, not a collision
    if (prev.code === code) return;
    failures.push(`duplicate normalized name "${normalized}": ${prev.label} and ${label}`);
  } else {
    map.set(normalized, { label, code });
  }
}

const continentCounts = new Map();
let arabCount = 0;
const difficultyCounts = { 1: 0, 2: 0, 3: 0 };
const similarGroups = new Map(); // group -> [codes]
let similarGroupCountries = 0;

for (const entry of all) {
  const where = entry?.code ?? '(missing code)';
  // required non-empty string fields
  for (const field of ['code', 'ar', 'en', 'continent', 'capitalAr', 'capitalEn']) {
    check(
      typeof entry?.[field] === 'string' && entry[field].trim().length > 0,
      `${where}: field "${field}" is missing or empty`,
    );
  }
  if (typeof entry?.code !== 'string' || !entry.code) continue;

  // duplicate codes across countries + territories
  if (seenCodes.has(entry.code)) {
    failures.push(`duplicate code "${entry.code}": ${seenCodes.get(entry.code)} and ${where}`);
  } else {
    seenCodes.set(entry.code, where);
  }

  // flag SVG exists
  const svg = `${entry.code}.svg`;
  const svgLower = `${entry.code.toLowerCase()}.svg`;
  check(
    flagFiles.has(svg) || flagFiles.has(svgLower),
    `${entry.code}: missing flag file public/flags/${svg}`,
  );

  // continent
  check(
    VALID_CONTINENTS.has(entry.continent),
    `${entry.code}: invalid continent "${entry.continent}"`,
  );
  continentCounts.set(entry.continent, (continentCounts.get(entry.continent) ?? 0) + 1);

  // difficulty 1-3
  check(
    Number.isInteger(entry.difficulty) && entry.difficulty >= 1 && entry.difficulty <= 3,
    `${entry.code}: difficulty "${entry.difficulty}" is not an integer 1-3`,
  );
  if (Number.isInteger(entry.difficulty)) {
    difficultyCounts[entry.difficulty] = (difficultyCounts[entry.difficulty] ?? 0) + 1;
  }

  // isArab boolean
  check(typeof entry.isArab === 'boolean', `${entry.code}: isArab is not a boolean`);
  if (entry.isArab === true) arabCount += 1;

  // capitalAmbiguous only boolean/undefined
  check(
    entry.capitalAmbiguous === undefined || typeof entry.capitalAmbiguous === 'boolean',
    `${entry.code}: capitalAmbiguous must be boolean or undefined, got ${typeof entry.capitalAmbiguous}`,
  );

  // duplicate normalized names / aliases (Arabic + English namespaces)
  noteName(arNames, normalizeText(entry.ar ?? ''), `${entry.code} (ar)`, entry.code);
  noteName(enNames, normalizeText(entry.en ?? ''), `${entry.code} (en)`, entry.code);
  for (const a of entry.aliasesAr ?? []) {
    noteName(arNames, normalizeText(a), `${entry.code} (aliasesAr "${a}")`, entry.code);
  }
  for (const a of entry.aliasesEn ?? []) {
    noteName(enNames, normalizeText(a), `${entry.code} (aliasesEn "${a}")`, entry.code);
  }

  // similar groups
  if (entry.similarGroup) {
    similarGroupCountries += 1;
    const list = similarGroups.get(entry.similarGroup) ?? [];
    list.push(entry.code);
    similarGroups.set(entry.similarGroup, list);
  }
}

// byCode sanity: every code resolves to itself
for (const entry of all) {
  const found = byCode(entry.code);
  check(found?.code === entry.code, `byCode("${entry.code}") did not return the entry`);
}

// --- filter coverage (enough questions per filter) ---------------------------
for (const continent of VALID_CONTINENTS) {
  const n = continentCounts.get(continent) ?? 0;
  check(n >= 10, `continent "${continent}" has only ${n} countries, expected >= 10`);
}
check(arabCount >= 15, `arabOnly filter has only ${arabCount} countries, expected >= 15`);
check((difficultyCounts[1] ?? 0) >= 30, `difficulty 1 has only ${difficultyCounts[1] ?? 0} countries, expected >= 30`);
check((difficultyCounts[2] ?? 0) >= 30, `difficulty 2 has only ${difficultyCounts[2] ?? 0} countries, expected >= 30`);
check((difficultyCounts[3] ?? 0) >= 10, `difficulty 3 has only ${difficultyCounts[3] ?? 0} countries, expected >= 10`);
check(similarGroupCountries >= 8, `similarGroup countries total ${similarGroupCountries}, expected >= 8`);
for (const [group, codes] of similarGroups) {
  check(codes.length >= 2, `similarGroup "${group}" is shared by only ${codes.length} countr${codes.length === 1 ? 'y' : 'ies'} (${codes.join(', ')}), expected >= 2`);
}
check(TERRITORIES.length >= 20, `territories filter has only ${TERRITORIES.length} entries, expected >= 20`);

// --- report ------------------------------------------------------------------
if (failures.length > 0) {
  console.error(`validate-data: FAILED (${failures.length} problem${failures.length === 1 ? '' : 's'})`);
  for (const f of failures) console.error(`  FAIL: ${f}`);
  process.exit(1);
}

console.log(`validate-data: OK (195 countries, ${TERRITORIES.length} territories)`);
process.exit(0);
