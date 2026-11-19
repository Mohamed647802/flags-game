// rng.js — Pure deterministic randomness helpers for the flags game.
// No Node / DOM / network dependencies. ES2022.

/**
 * mulberry32: small fast seeded PRNG.
 * @param {number} seed - uint32 seed
 * @returns {() => number} function returning a float in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * FNV-1a 32-bit hash of a string -> uint32.
 * @param {string} str
 * @returns {number} uint32
 */
export function hashSeed(str) {
  const s = String(str);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Create an rng from a seed.
 * - number -> used directly (as uint32)
 * - string -> hashed with FNV-1a
 * - null / undefined -> random seed from Math.random
 * @param {number|string|null|undefined} seed
 * @returns {() => number}
 */
export function createRng(seed) {
  if (seed === null || seed === undefined) {
    return mulberry32((Math.random() * 0xffffffff) >>> 0);
  }
  if (typeof seed === 'string') return mulberry32(hashSeed(seed));
  return mulberry32(seed >>> 0);
}

/**
 * Fisher-Yates shuffle. Returns a NEW array; the input is untouched.
 * @template T
 * @param {T[]} array
 * @param {() => number} rng
 * @returns {T[]}
 */
export function shuffle(array, rng) {
  const out = [...array];
  const rand = rng || Math.random;
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Pick one random element (undefined for an empty array).
 * @template T
 * @param {T[]} array
 * @param {() => number} rng
 * @returns {T|undefined}
 */
export function pick(array, rng) {
  if (!array || array.length === 0) return undefined;
  const rand = rng || Math.random;
  return array[Math.floor(rand() * array.length)];
}

/**
 * Deterministic daily seed from a UTC date string 'YYYY-MM-DD'.
 * @param {string} utcDateString
 * @returns {number} uint32
 */
export function dailySeedFromDate(utcDateString) {
  return hashSeed(String(utcDateString));
}
