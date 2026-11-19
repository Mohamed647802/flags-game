import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreSimple, speedScore, comboBonus } from '../shared/scoring.js';

test('scoreSimple() === 1', () => {
  assert.equal(scoreSimple(), 1);
});

test('speedScore: full time beats half time', () => {
  const full = speedScore(15000, 15000, 0, false);
  const half = speedScore(7500, 15000, 0, false);
  const low = speedScore(1000, 15000, 0, false);
  assert.ok(full > half, `full (${full}) should beat half (${half})`);
  assert.ok(half > low, `half (${half}) should beat low (${low})`);
  assert.ok(full > 0 && half > 0 && low >= 0);
});

test('speedScore: streak increases score', () => {
  const noStreak = speedScore(10000, 15000, 0, false);
  const streak = speedScore(10000, 15000, 5, false);
  assert.ok(streak >= noStreak, `streak score (${streak}) should be >= no-streak (${noStreak})`);
});

test('comboBonus: 1 => 0, 2 => 10, capped at 50', () => {
  assert.equal(comboBonus(0), 0);
  assert.equal(comboBonus(1), 0);
  assert.equal(comboBonus(2), 10);
  assert.equal(comboBonus(10), 50);
  assert.equal(comboBonus(100), 50, 'combo bonus must cap at 50');
  assert.ok(comboBonus(5) > comboBonus(2) && comboBonus(5) < 50);
});

test('speedScore: hint reduces score', () => {
  const noHint = speedScore(10000, 15000, 3, false);
  const withHint = speedScore(10000, 15000, 3, true);
  assert.ok(withHint < noHint, `hint score (${withHint}) should be < no-hint (${noHint})`);
  assert.ok(withHint >= 0);
});
