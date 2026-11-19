// scoring.js — Pure scoring helpers for the flags game. ES2022.

/**
 * Simple scoring: every correct answer is worth 1 point.
 * @returns {number}
 */
export function scoreSimple() {
  return 1;
}

/**
 * Combo bonus from the streak BEFORE this answer.
 * 2nd consecutive correct answer earns +10, then +10 per extra
 * consecutive correct answer, capped at +50.
 * @param {number} streakBefore - consecutive correct answers before this one
 * @returns {number}
 */
export function comboBonus(streakBefore) {
  if (streakBefore >= 2) return Math.min(50, (streakBefore - 1) * 10);
  return 0;
}

/**
 * Speed scoring: 100 base + up to 100 for remaining time + combo bonus,
 * minus 20 when a hint was used. Never below 0.
 * @param {number} remainingMs - time left when the answer arrived
 * @param {number} durationMs - total time allowed for the question
 * @param {number} streakBefore - consecutive correct answers before this one
 * @param {boolean} hintUsed
 * @returns {number}
 */
export function speedScore(remainingMs, durationMs, streakBefore, hintUsed) {
  const ratio = durationMs > 0 ? Math.max(0, Math.min(1, remainingMs / durationMs)) : 0;
  const points = 100 + Math.round(100 * ratio) + comboBonus(streakBefore) + (hintUsed ? -20 : 0);
  return Math.max(0, points);
}
