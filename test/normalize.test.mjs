import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeText, levenshtein, matchesAnswer } from '../shared/normalize.js';
import { COUNTRIES, byCode } from '../shared/countries.js';

test('normalizeText strips diacritics and tatweel', () => {
  assert.equal(normalizeText('مُحَمَّد'), 'محمد');
  assert.equal(normalizeText('مـرحـبا'), 'مرحبا');
  // 'السلام' also loses its ال prefix (stripped from every word)
  assert.equal(normalizeText('السَّلَامُ'), 'سلام');
});

test('normalizeText unifies alef variants', () => {
  assert.equal(normalizeText('أحمد'), 'احمد');
  // 'إلى' -> alef unified to 'الى', then the ال prefix is stripped, leaving 'ي'
  assert.equal(normalizeText('إلى'), 'ي');
  assert.equal(normalizeText('آسيا'), 'اسيا');
});

test('normalizeText maps ى→ي, ة→ه, ؤ→و, ئ→ي', () => {
  assert.equal(normalizeText('مصرى'), 'مصري');
  assert.equal(normalizeText('مدرسة'), 'مدرسه');
  assert.equal(normalizeText('مؤمن'), 'مومن');
  assert.equal(normalizeText('شئ'), 'شي');
  assert.equal(normalizeText('رئيس'), 'رييس');
});

test('normalizeText strips ال prefix', () => {
  assert.equal(normalizeText('المغرب'), 'مغرب');
  // ال is stripped from every word, and ة -> ه applies too
  assert.equal(normalizeText('الولايات المتحدة'), 'ولايات متحده');
  // but does not strip ال from the middle of a word
  assert.equal(normalizeText('مالك'), 'مالك');
});

test('normalizeText lowercases English and collapses spaces', () => {
  assert.equal(normalizeText('United   States'), 'united states');
  assert.equal(normalizeText('  USA  '), 'usa');
  assert.equal(normalizeText('New\tYork'), 'new york');
});

test('levenshtein basics', () => {
  assert.equal(levenshtein('abc', 'abc'), 0);
  assert.equal(levenshtein('abc', 'abd'), 1);
  assert.equal(levenshtein('kitten', 'sitting'), 3);
  assert.equal(levenshtein('', 'abc'), 3);
});

test('matchesAnswer accepts aliases for USA', () => {
  const us = byCode('us');
  assert.ok(matchesAnswer('امريكا', us, COUNTRIES));
  assert.ok(matchesAnswer('USA', us, COUNTRIES));
  assert.ok(matchesAnswer('الولايات المتحدة', us, COUNTRIES));
  assert.ok(matchesAnswer('أمريكا', us, COUNTRIES));
  assert.ok(matchesAnswer('United States', us, COUNTRIES));
});

test('matchesAnswer accepts aliases for Myanmar and Czechia', () => {
  assert.ok(matchesAnswer('بورما', byCode('mm'), COUNTRIES));
  assert.ok(matchesAnswer('Myanmar', byCode('mm'), COUNTRIES));
  assert.ok(matchesAnswer('التشيك', byCode('cz'), COUNTRIES));
  assert.ok(matchesAnswer('Czechia', byCode('cz'), COUNTRIES));
});

test('matchesAnswer accepts one typo in long names', () => {
  assert.ok(matchesAnswer('Germay', byCode('de'), COUNTRIES), 'one-letter deletion in Germany');
  assert.ok(matchesAnswer('فرنصا', byCode('fr'), COUNTRIES), 'one-letter substitution in فرنسا');
  assert.ok(matchesAnswer('البرازير', byCode('br'), COUNTRIES), 'one-letter substitution in البرازيل');
});

test('matchesAnswer rejects Niger vs Nigeria confusion', () => {
  // النيجر (Niger, ne) must NOT match Nigeria (ng), and vice versa
  assert.equal(matchesAnswer('النيجر', byCode('ng'), COUNTRIES), false);
  assert.equal(matchesAnswer('نيجيريا', byCode('ne'), COUNTRIES), false);
  assert.equal(matchesAnswer('Niger', byCode('ng'), COUNTRIES), false);
  assert.equal(matchesAnswer('Nigeria', byCode('ne'), COUNTRIES), false);
  // ...while each matches its own country
  assert.ok(matchesAnswer('النيجر', byCode('ne'), COUNTRIES));
  assert.ok(matchesAnswer('نيجيريا', byCode('ng'), COUNTRIES));
});

test('matchesAnswer rejects unrelated names', () => {
  assert.equal(matchesAnswer('مصر', byCode('fr'), COUNTRIES), false);
  assert.equal(matchesAnswer('Japan', byCode('kr'), COUNTRIES), false);
  assert.equal(matchesAnswer('', byCode('eg'), COUNTRIES), false);
});
