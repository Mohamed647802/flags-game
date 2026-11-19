import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COUNTRIES, TERRITORIES, byCode, CONTINENTS } from '../shared/countries.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VALID_CONTINENTS = new Set([
  'africa', 'asia', 'europe', 'north-america', 'south-america', 'oceania',
]);

test('195 countries', () => {
  assert.equal(COUNTRIES.length, 195);
});

test('territories >= 20', () => {
  assert.ok(Array.isArray(TERRITORIES));
  assert.ok(TERRITORIES.length >= 20, `only ${TERRITORIES.length} territories`);
});

test('all codes unique across countries + territories', () => {
  const codes = [...COUNTRIES, ...TERRITORIES].map((c) => c.code);
  assert.equal(new Set(codes).size, codes.length, 'duplicate codes found');
});

test('all SVGs exist in public/flags', async () => {
  const files = new Set(await readdir(path.join(root, 'public', 'flags')));
  const missing = [];
  for (const entry of [...COUNTRIES, ...TERRITORIES]) {
    if (!files.has(`${entry.code}.svg`) && !files.has(`${entry.code.toLowerCase()}.svg`)) {
      missing.push(entry.code);
    }
  }
  assert.deepEqual(missing, [], `missing SVGs: ${missing.join(', ')}`);
});

test('byCode works', () => {
  assert.equal(byCode('eg').ar, 'مصر');
  assert.equal(byCode('us').en, 'United States');
  assert.equal(byCode('fr').continent, 'europe');
  assert.equal(byCode('xx'), undefined);
  // every code resolves to itself
  for (const entry of [...COUNTRIES, ...TERRITORIES]) {
    assert.equal(byCode(entry.code)?.code, entry.code);
  }
});

test('continents valid', () => {
  for (const entry of COUNTRIES) {
    assert.ok(VALID_CONTINENTS.has(entry.continent), `${entry.code}: bad continent ${entry.continent}`);
  }
  if (CONTINENTS !== undefined) {
    assert.ok(Array.isArray(CONTINENTS));
    assert.equal(CONTINENTS.length, 6, 'CONTINENTS should list the 6 continents');
    for (const c of CONTINENTS) {
      // entries may be plain ids ('africa') or objects ({id, ar, en})
      const id = typeof c === 'string' ? c : c.id;
      assert.ok(VALID_CONTINENTS.has(id), `CONTINENTS has bad value ${JSON.stringify(c)}`);
    }
  }
});

test('required fields present and well-typed', () => {
  for (const entry of [...COUNTRIES, ...TERRITORIES]) {
    for (const f of ['code', 'ar', 'en', 'continent', 'capitalAr', 'capitalEn']) {
      assert.equal(typeof entry[f], 'string', `${entry.code}: ${f} not a string`);
      assert.ok(entry[f].trim().length > 0, `${entry.code}: ${f} empty`);
    }
    assert.ok(Number.isInteger(entry.difficulty) && entry.difficulty >= 1 && entry.difficulty <= 3,
      `${entry.code}: difficulty ${entry.difficulty}`);
    assert.equal(typeof entry.isArab, 'boolean', `${entry.code}: isArab not boolean`);
    assert.ok(entry.capitalAmbiguous === undefined || typeof entry.capitalAmbiguous === 'boolean',
      `${entry.code}: capitalAmbiguous bad type`);
  }
});
