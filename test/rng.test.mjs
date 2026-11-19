import test from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, shuffle, hashSeed, dailySeedFromDate } from '../shared/rng.js';

test('mulberry32: same seed => same outputs', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const seqA = Array.from({ length: 10 }, () => a());
  const seqB = Array.from({ length: 10 }, () => b());
  assert.deepEqual(seqA, seqB);
  for (const v of seqA) assert.ok(v >= 0 && v < 1, `value ${v} out of [0,1)`);
});

test('mulberry32: different seeds differ', () => {
  const a = Array.from({ length: 10 }, () => mulberry32(1)());
  const b = Array.from({ length: 10 }, () => mulberry32(2)());
  assert.notDeepEqual(a, b);
});

test('shuffle: same seed => same order, preserves elements', () => {
  const input = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const s1 = shuffle([...input], mulberry32(123));
  const s2 = shuffle([...input], mulberry32(123));
  assert.deepEqual(s1, s2);
  assert.deepEqual([...s1].sort((x, y) => x - y), input);
  // does not mutate the input array
  const orig = [1, 2, 3, 4, 5];
  const copy = [...orig];
  shuffle(orig, mulberry32(7));
  assert.deepEqual(orig, copy);
});

test('shuffle: different seeds differ (very likely)', () => {
  const input = Array.from({ length: 20 }, (_, i) => i);
  const s1 = shuffle([...input], mulberry32(11));
  const s2 = shuffle([...input], mulberry32(22));
  assert.notDeepEqual(s1, s2);
});

test('hashSeed deterministic', () => {
  assert.equal(hashSeed('hello'), hashSeed('hello'));
  assert.notEqual(hashSeed('hello'), hashSeed('world'));
  assert.equal(typeof hashSeed('x'), 'number');
});

test('dailySeedFromDate deterministic per date', () => {
  assert.equal(dailySeedFromDate('2026-11-19'), dailySeedFromDate('2026-11-19'));
  assert.notEqual(dailySeedFromDate('2026-11-19'), dailySeedFromDate('2026-11-20'));
});
