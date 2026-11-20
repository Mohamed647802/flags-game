// engine.js — Pure game engine for the flags game.
// No timers, no network, no DOM. All time is passed in as nowMs.
// Imports only from ./countries.js, ./normalize.js, ./rng.js, ./scoring.js. ES2022.

import { COUNTRIES, TERRITORIES, CONTINENTS, byCode, ALL } from './countries.js';
import { normalizeText, levenshtein, matchesAnswer } from './normalize.js';
import { createRng, shuffle, pick, dailySeedFromDate } from './rng.js';
import { scoreSimple, speedScore } from './scoring.js';

export const MODES = ['race', 'fixed', 'sudden', 'teams', 'survival', 'turns', 'daily', 'kids', 'solo'];
export const QUESTION_TYPES = ['flag-country', 'country-flag', 'flag-capital', 'flag-continent', 'blurry', 'zoom', 'odd-one-out'];

export const DEFAULT_SETTINGS = {
  flagCount: 20,
  maxPlayers: 8,
  mode: 'fixed',
  raceTarget: 10,
  answerMode: 'race',
  scoring: 'simple',
  durationSec: 15,
  noTimer: false,
  answerType: 'choice',
  continents: [],
  arabOnly: false,
  similarOnly: false,
  rareOnly: false,
  difficulty: 'mixed',
  questionTypes: ['flag-country'],
  hint: true,
  judgeMode: 'auto',
  negativePoints: false,
  lateJoin: false,
  seed: null,
  revealSec: 3,
};

function normalizeSettings(input) {
  const s = { ...DEFAULT_SETTINGS, ...(input || {}) };
  // وضع «كتابة ثم تقييم»: الإجابات نصية وتُصحَّح يدوياً من المضيف بعد الوقت.
  if (s.answerMode === 'write_then_judge') s.judgeMode = 'host';
  if (s.judgeMode === 'host') s.answerMode = 'write_then_judge';
  s.continents = [...(s.continents || [])];
  s.questionTypes = [...(s.questionTypes || ['flag-country'])];
  if (s.questionTypes.length === 0) s.questionTypes = ['flag-country'];
  if (s.mode === 'kids') {
    s.difficulty = 'easy';
    s.answerType = 'choice';
    s.noTimer = true;
    s.questionTypes = ['flag-country'];
  }
  if (s.mode === 'daily') {
    s.flagCount = 10;
  }
  return s;
}

/** Filtered pool of country entries for a settings object. */
function poolEntries(settings) {
  let pool = settings.rareOnly ? [...TERRITORIES] : [...COUNTRIES];
  if (settings.mode === 'daily') pool = [...COUNTRIES];
  if (settings.mode === 'kids') pool = pool.filter((c) => c.difficulty === 1);
  if (settings.arabOnly) pool = pool.filter((c) => c.isArab);
  if (settings.similarOnly) pool = pool.filter((c) => c.similarGroup);
  if (settings.continents && settings.continents.length > 0) {
    pool = pool.filter((c) => settings.continents.includes(c.continent));
  }
  if (settings.difficulty === 'easy') pool = pool.filter((c) => c.difficulty === 1);
  else if (settings.difficulty === 'medium') pool = pool.filter((c) => c.difficulty === 2);
  else if (settings.difficulty === 'hard') pool = pool.filter((c) => c.difficulty === 3);
  return pool;
}

function poolCodes(settings) {
  return poolEntries(settings).map((c) => c.code);
}

/**
 * Build a shuffled deck of country codes for the given settings.
 * - race / survival: the whole pool (long deck, refilled when exhausted)
 * - daily: 10 codes from all 195 countries
 * - otherwise: min(flagCount, pool size) codes, no repeats
 * @param {object} settings
 * @param {number|string|null|undefined} seed
 * @returns {string[]}
 */
export function buildDeck(settings, seed) {
  const s = normalizeSettings(settings);
  const rng = createRng(seed ?? s.seed ?? null);
  const pool = poolCodes(s);
  const shuffled = shuffle(pool, rng);
  if (s.mode === 'race' || s.mode === 'survival') return shuffled;
  const count = Math.min(s.flagCount, shuffled.length);
  return shuffled.slice(0, count);
}

/**
 * Re-shuffle the game's pool into a fresh deck (race / survival modes).
 * Avoids starting the new deck with the code that just ended the old one.
 * @param {object} game
 */
export function refillDeck(game) {
  const rng = game._rng || createRng(null);
  const last = game.deck && game.deck.length > 0 ? game.deck[game.deck.length - 1] : null;
  let deck = shuffle([...game._pool], rng);
  if (last && deck.length > 1 && deck[0] === last) {
    [deck[0], deck[1]] = [deck[1], deck[0]];
  }
  game.deck = deck;
  game.deckIndex = 0;
  game._tiebreakPool = [];
}

// ---------------------------------------------------------------------------
// Question building
// ---------------------------------------------------------------------------

function optionFor(entry) {
  return { code: entry.code, labelAr: entry.ar, labelEn: entry.en };
}

/** Distractors for a subject entry: same similarGroup first, then same continent, then the rest. */
function pickDistractors(answer, pool, count, rng, preferSimilar) {
  const sameGroup = [];
  const sameContinent = [];
  const rest = [];
  for (const e of pool) {
    if (e.code === answer.code) continue;
    if (preferSimilar && answer.similarGroup && e.similarGroup === answer.similarGroup) sameGroup.push(e);
    else if (e.continent === answer.continent) sameContinent.push(e);
    else rest.push(e);
  }
  const ordered = [
    ...shuffle(sameGroup, rng),
    ...shuffle(sameContinent, rng),
    ...shuffle(rest, rng),
  ];
  return ordered.slice(0, count);
}

function continentOption(continentId) {
  const c = CONTINENTS.find((x) => x.id === continentId);
  return { code: c.id, labelAr: c.ar, labelEn: c.en };
}

function makeOddOneOut(answer, pool, rng) {
  // Two mates sharing the subject's similarGroup (fallback: same continent).
  let mates = [];
  if (answer.similarGroup) {
    mates = pool.filter((e) => e.code !== answer.code && e.similarGroup === answer.similarGroup);
  }
  if (mates.length < 2) {
    mates = pool.filter((e) => e.code !== answer.code && e.continent === answer.continent);
  }
  mates = shuffle(mates, rng).slice(0, 2);
  const used = new Set([answer.code, ...mates.map((m) => m.code)]);
  let oddPool = pool.filter(
    (e) => !used.has(e.code) && e.continent !== answer.continent && e.similarGroup !== answer.similarGroup,
  );
  if (oddPool.length === 0) oddPool = pool.filter((e) => !used.has(e.code));
  const odd = pick(oddPool, rng);
  if (!odd || mates.length < 2) return null;
  const options = shuffle([answer, ...mates, odd], rng).map(optionFor);
  return {
    type: 'odd-one-out',
    flagCode: null,
    promptAr: 'أي علم مختلف عن البقية؟',
    promptEn: 'Which flag is the odd one out?',
    options,
    answerCode: odd.code,
    answerLabelAr: odd.ar,
    answerLabelEn: odd.en,
    code: answer.code,
  };
}

/**
 * Build one question for a country code.
 * @param {string} code - subject country code
 * @param {object} settings
 * @param {() => number} rng
 * @param {Array} allPool - entries to draw distractors from
 * @returns {object} question
 */
export function makeQuestion(code, settings, rng, allPool) {
  const s = normalizeSettings(settings);
  const rand = rng || createRng(null);
  const pool = allPool && allPool.length > 0 ? allPool : ALL;
  const subject = byCode(code);
  if (!subject) throw new Error(`Unknown country code: ${code}`);

  let type = pick(s.questionTypes, rand) || 'flag-country';
  if (type === 'flag-capital' && subject.capitalAmbiguous) type = 'flag-country';
  if ((type === 'odd-one-out' || type === 'flag-capital') && pool.length < 4) type = 'flag-country';

  const preferSimilar = subject.difficulty === 3 || s.difficulty === 'hard';
  const distractors = (n) => pickDistractors(subject, pool, n, rand, preferSimilar);

  if (type === 'odd-one-out') {
    const q = makeOddOneOut(subject, pool, rand);
    if (q) return q;
    type = 'flag-country';
  }

  if (type === 'country-flag') {
    const options = shuffle([subject, ...distractors(3)], rand).map(optionFor);
    return {
      type: 'country-flag',
      flagCode: null,
      promptAr: `ما هو علم ${subject.ar}؟`,
      promptEn: `Which flag belongs to ${subject.en}?`,
      options,
      answerCode: subject.code,
      answerLabelAr: subject.ar,
      answerLabelEn: subject.en,
      code: subject.code,
    };
  }

  if (type === 'flag-capital') {
    const chosen = [subject, ...distractors(3)];
    const seen = new Set();
    const options = [];
    for (const e of chosen) {
      const key = normalizeText(e.capitalAr) + '|' + normalizeText(e.capitalEn);
      if (seen.has(key)) continue;
      seen.add(key);
      options.push({ code: e.code, labelAr: e.capitalAr, labelEn: e.capitalEn });
    }
    // If two capitals collided, top up from the pool.
    let i = 0;
    const extra = shuffle(pool.filter((e) => !chosen.includes(e)), rand);
    while (options.length < 4 && i < extra.length) {
      const e = extra[i++];
      const key = normalizeText(e.capitalAr) + '|' + normalizeText(e.capitalEn);
      if (seen.has(key)) continue;
      seen.add(key);
      options.push({ code: e.code, labelAr: e.capitalAr, labelEn: e.capitalEn });
    }
    return {
      type: 'flag-capital',
      flagCode: subject.code,
      promptAr: 'ما عاصمة الدولة صاحبة هذا العلم؟',
      promptEn: 'What is the capital of the country this flag belongs to?',
      options: shuffle(options, rand),
      answerCode: subject.code,
      answerLabelAr: subject.capitalAr,
      answerLabelEn: subject.capitalEn,
      code: subject.code,
    };
  }

  if (type === 'flag-continent') {
    const others = shuffle(CONTINENTS.filter((c) => c.id !== subject.continent), rand).slice(0, 3);
    const options = shuffle([continentOption(subject.continent), ...others.map((c) => continentOption(c.id))], rand);
    const cont = CONTINENTS.find((c) => c.id === subject.continent);
    return {
      type: 'flag-continent',
      flagCode: subject.code,
      promptAr: 'في أي قارة تقع الدولة صاحبة هذا العلم؟',
      promptEn: 'On which continent is the country this flag belongs to?',
      options,
      answerCode: subject.continent,
      answerLabelAr: cont.ar,
      answerLabelEn: cont.en,
      code: subject.code,
    };
  }

  // 'flag-country', 'blurry', 'zoom' — all show a flag and ask for the country.
  const options = shuffle([subject, ...distractors(3)], rand).map(optionFor);
  const q = {
    type: 'flag-country',
    flagCode: subject.code,
    promptAr: 'ما اسم الدولة صاحبة هذا العلم؟',
    promptEn: 'Which country does this flag belong to?',
    options,
    answerCode: subject.code,
    answerLabelAr: subject.ar,
    answerLabelEn: subject.en,
    code: subject.code,
  };
  if (type === 'blurry') q.effect = 'blurry';
  if (type === 'zoom') q.effect = 'zoom';
  return q;
}

// ---------------------------------------------------------------------------
// Answer checking
// ---------------------------------------------------------------------------

function typoTolerance(len) {
  if (len >= 9) return 2;
  if (len >= 5) return 1;
  return 0;
}

/** True when text names the target and no other name in the list matches as well. */
function textMatchesName(text, targetNames, otherNamesList) {
  const n = normalizeText(text);
  if (!n) return false;
  const tol = typoTolerance(n.length);
  const best = (names) => Math.min(...names.map((name) => levenshtein(n, normalizeText(name))));
  const d1 = best(targetNames);
  if (d1 > tol) return false;
  for (const names of otherNamesList) {
    const d2 = best(names);
    if (d2 <= d1 && d2 <= tol) return false;
  }
  return true;
}

/**
 * Check a submitted answer.
 * @param {object} question
 * @param {{choiceIndex?:number, text?:string}} payload
 * @returns {boolean}
 */
export function checkAnswer(question, payload) {
  if (!question || !payload) return false;
  if (payload.choiceIndex !== undefined && payload.choiceIndex !== null) {
    const opt = question.options && question.options[payload.choiceIndex];
    return !!opt && opt.code === question.answerCode;
  }
  if (typeof payload.text === 'string') {
    if (question.type === 'flag-continent') {
      const cont = CONTINENTS.find((c) => c.id === question.answerCode);
      if (!cont) return false;
      const others = CONTINENTS.filter((c) => c.id !== cont.id).map((c) => [c.ar, c.en]);
      return textMatchesName(payload.text, [cont.ar, cont.en], others);
    }
    if (question.type === 'flag-capital') {
      const subject = byCode(question.code);
      if (!subject) return false;
      const others = ALL.filter((e) => e.code !== subject.code).map((e) => [e.capitalAr, e.capitalEn]);
      return textMatchesName(payload.text, [subject.capitalAr, subject.capitalEn], others);
    }
    const subject = byCode(question.answerCode);
    return matchesAnswer(payload.text, subject, ALL);
  }
  return false;
}

// ---------------------------------------------------------------------------
// التقييم اليدوي (وضع write_then_judge)
// ---------------------------------------------------------------------------

/** True when this game is in host-judged write mode. */
export function isJudgeMode(game) {
  return game?.settings?.judgeMode === 'host' || game?.settings?.answerMode === 'write_then_judge';
}

/** Text answers submitted for the current question, with a suggested verdict. */
export function collectTextAnswers(game) {
  const cur = game?.current;
  if (!cur) return [];
  const out = [];
  for (const p of game.players) {
    const a = cur.answers[p.id];
    if (a && a.pendingJudge && typeof a.text === 'string') {
      out.push({
        playerId: p.id, name: p.name, text: a.text, atMs: a.atMs,
        suggestedCorrect: checkAnswer(cur.question, { text: a.text }),
      });
    }
  }
  out.sort((x, y) => x.atMs - y.atMs);
  return out;
}

/**
 * Apply the host's judgements for the current question.
 * decisions: [{ playerId, correct }] — must cover every submitted answer.
 * Players who submitted nothing are marked wrong. Points use the same
 * scoring as a normal correct answer, timed from the submission moment.
 * Returns { results, correctCount }.
 */
export function applyJudgements(game, decisions, nowMs) {
  const cur = game.current;
  if (!cur) throw new Error('no current question');
  const byId = new Map((decisions || []).map((d) => [d.playerId, d]));
  const results = [];
  let correctCount = 0;
  const sudden = game.settings.mode === 'sudden' || game.settings.mode === 'survival';
  const kids = game.settings.mode === 'kids';
  const ordered = [...game.players].sort((a, b) => {
    const aa = cur.answers[a.id]?.atMs ?? Infinity;
    const bb = cur.answers[b.id]?.atMs ?? Infinity;
    return aa - bb;
  });
  for (const player of ordered) {
    const ans = cur.answers[player.id];
    if (ans && ans.pendingJudge) {
      const d = byId.get(player.id);
      if (!d || typeof d.correct !== 'boolean') throw new Error(`missing judgement for ${player.id}`);
      ans.pendingJudge = false;
      ans.locked = true;
      if (d.correct) {
        correctCount += 1;
        const streakBefore = player.streak;
        let points;
        if (game.settings.scoring === 'speed') {
          const dur = durationMs(game) || game.settings.durationSec * 1000;
          const remaining = cur.endsAt === null ? dur : Math.max(0, cur.endsAt - ans.atMs);
          points = speedScore(remaining, dur, streakBefore, false);
        } else {
          points = scoreSimple();
        }
        player.score += points;
        player.correct += 1;
        player.streak = streakBefore + 1;
        player.bestStreak = Math.max(player.bestStreak, player.streak);
        const elapsed = ans.atMs - cur.startedAt;
        if (player.fastestMs === null || elapsed < player.fastestMs) player.fastestMs = elapsed;
        const cont = byCode(cur.question.code)?.continent;
        if (cont) player.correctByContinent[cont] = (player.correctByContinent[cont] || 0) + 1;
        if (cur.firstCorrectId === null) cur.firstCorrectId = player.id;
        ans.correct = true;
        ans.points = points;
        game.history.push({ round: game.round, playerId: player.id, correct: true, points, atMs: ans.atMs, type: cur.question.type });
        if (game.settings.scoring === 'simple') cur.roundOver = true;
        if (game.settings.mode === 'race' && player.score >= game.settings.raceTarget) game.pendingEnd = true;
        results.push({ playerId: player.id, correct: true, points });
      } else {
        player.wrong += 1;
        player.streak = 0;
        let points = 0;
        if (game.settings.negativePoints && game.settings.scoring === 'speed' && !kids) {
          player.score = Math.max(0, player.score - 25);
          points = -25;
        }
        ans.correct = false;
        ans.points = points;
        if (sudden && !kids) player.alive = false;
        game.history.push({ round: game.round, playerId: player.id, correct: false, points, atMs: ans.atMs, type: cur.question.type });
        results.push({ playerId: player.id, correct: false, points });
      }
    } else if (!ans) {
      // لم يجب أصلاً: خطأ بدون نقاط.
      player.wrong += 1;
      player.streak = 0;
      cur.answers[player.id] = { correct: false, points: 0, atMs: nowMs, attempts: 0, locked: true, lastAttemptAt: nowMs, timedOut: true };
      if (sudden && !kids) player.alive = false;
      results.push({ playerId: player.id, correct: false, points: 0, noAnswer: true });
    }
    // إجابات choice/locked قديمة في هذا السؤال لا تحدث في وضع التقييم.
  }
  if (correctCount === 0 && cur.question.code) game.missedCodes.push(cur.question.code);
  return { results, correctCount };
}

// ---------------------------------------------------------------------------
// Game lifecycle
// ---------------------------------------------------------------------------

/**
 * Create a new game state.
 * @param {object} settings
 * @param {{id:string, name:string, team?:string}[]} players
 * @param {number|string|null|undefined} seed
 * @returns {object}
 */
export function createGame(settings, players, seed) {
  const s = normalizeSettings(settings);
  let gameSeed = seed ?? s.seed ?? null;
  if (s.mode === 'daily' && (gameSeed === null || gameSeed === undefined)) {
    gameSeed = dailySeedFromDate(new Date().toISOString().slice(0, 10));
  }
  const rng = createRng(gameSeed);
  const pool = poolCodes(s);
  const deck = buildDeck(s, gameSeed);
  const tiebreakPool = shuffle(pool.filter((c) => !deck.includes(c)), rng);
  const game = {
    settings: s,
    phase: 'lobby',
    players: (players || []).map((p, i) => ({
      id: p.id,
      name: p.name,
      score: 0,
      correct: 0,
      wrong: 0,
      streak: 0,
      bestStreak: 0,
      fastestMs: null,
      alive: true,
      team: p.team || (s.mode === 'teams' ? (i % 2 === 0 ? 'red' : 'blue') : null),
      answered: false,
      connected: true,
      correctByContinent: {},
    })),
    deck,
    deckIndex: 0,
    round: 0,
    totalRounds: deck.length,
    current: null,
    winners: [],
    tiebreak: 0,
    missedCodes: [],
    history: [],
    paused: false,
    pauseRemainingMs: 0,
    startedAt: null,
    endedAt: null,
    countdownEndsAt: null,
    revealEndsAt: null,
    pendingEnd: false,
    summary: null,
    _rng: rng,
    _pool: pool,
    _tiebreakPool: tiebreakPool,
    _skipVotes: [],
  };
  return game;
}

/** Move the game from lobby to the 3-second countdown. */
export function startGame(game, nowMs) {
  game.phase = 'countdown';
  game.startedAt = nowMs;
  game.countdownEndsAt = nowMs + 3000;
  return game;
}

function durationMs(game) {
  return game.settings.noTimer ? null : game.settings.durationSec * 1000;
}

/**
 * Start the next question. Returns the question (server strips the answer
 * before sending it to clients), or null when the deck is exhausted.
 */
export function beginQuestion(game, nowMs) {
  if (game.deckIndex >= game.deck.length) {
    if (game.settings.mode === 'race' || game.settings.mode === 'survival') {
      refillDeck(game);
    } else {
      return null;
    }
  }
  const code = game.deck[game.deckIndex];
  game.deckIndex += 1;
  const pool = game._pool.map((c) => byCode(c)).filter(Boolean);
  const question = makeQuestion(code, game.settings, game._rng, pool.length >= 4 ? pool : ALL);
  game.round += 1;
  const alive = game.players.filter((p) => p.alive);
  let turnPlayerId = null;
  if (game.settings.mode === 'turns' && alive.length > 0) {
    turnPlayerId = alive[(game.round - 1) % alive.length].id;
  }
  for (const p of game.players) p.answered = false;
  const dur = durationMs(game);
  game.current = {
    question,
    index: game.round - 1,
    startedAt: nowMs,
    endsAt: dur === null ? null : nowMs + dur,
    answers: {},
    firstCorrectId: null,
    roundOver: false,
    turnPlayerId,
  };
  game.phase = 'question';
  game._skipVotes = [];
  return question;
}

function allAliveAnswered(game) {
  const alive = game.players.filter((p) => p.alive && p.connected);
  if (alive.length === 0) return false;
  return alive.every((p) => {
    const a = game.current.answers[p.id];
    return a && (a.correct || a.locked || a.pendingJudge || a.submitted);
  });
}

/**
 * Submit an answer for a player.
 * @returns {{accepted:boolean, reason?:string, correct?:boolean, points?:number, first?:boolean, locked?:boolean, eliminated?:boolean, allAnswered?:boolean}}
 */
export function submitAnswer(game, playerId, payload, nowMs) {
  const cur = game.current;
  if (game.phase !== 'question' || !cur) return { accepted: false, reason: 'not-in-question' };
  const player = game.players.find((p) => p.id === playerId);
  if (!player) return { accepted: false, reason: 'unknown-player' };
  if (!player.alive) return { accepted: false, reason: 'eliminated' };
  if (!player.connected) return { accepted: false, reason: 'disconnected' };
  if (game.settings.mode === 'turns' && cur.turnPlayerId !== playerId) {
    return { accepted: false, reason: 'not-your-turn' };
  }
  const prev = cur.answers[playerId];
  if (prev && prev.correct) return { accepted: false, reason: 'already-answered' };
  if (prev && prev.locked) return { accepted: false, reason: 'locked' };
  if (prev && prev.pendingJudge) return { accepted: false, reason: 'already-answered' };
  // --- وضع التقييم اليدوي: تُسجَّل الإجابة النصية فقط، بلا تصحيح ولا نقاط ---
  if (game.settings.judgeMode === 'host') {
    if (payload?.choiceIndex !== undefined && payload?.choiceIndex !== null) {
      return { accepted: false, reason: 'invalid_answer' };
    }
    const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
    if (!text) return { accepted: false, reason: 'invalid_answer' };
    cur.answers[playerId] = {
      text, submitted: true, pendingJudge: true, correct: null, points: 0,
      atMs: nowMs, attempts: 1, locked: true, lastAttemptAt: nowMs,
    };
    player.answered = true;
    return { accepted: true, correct: null, points: 0, pendingJudge: true, first: false, locked: true, eliminated: false, allAnswered: allAliveAnswered(game) };
  }
  if (cur.roundOver && game.settings.scoring === 'simple') {
    return { accepted: false, reason: 'round-over' };
  }

  const isChoice = payload && payload.choiceIndex !== undefined && payload.choiceIndex !== null;
  const correct = checkAnswer(cur.question, payload);
  const elapsed = nowMs - cur.startedAt;
  const kids = game.settings.mode === 'kids';
  const sudden = game.settings.mode === 'sudden' || game.settings.mode === 'survival';

  if (correct) {
    const streakBefore = player.streak;
    let points;
    if (game.settings.scoring === 'speed') {
      const dur = durationMs(game) || game.settings.durationSec * 1000;
      const remaining = cur.endsAt === null ? dur : Math.max(0, cur.endsAt - nowMs);
      points = speedScore(remaining, dur, streakBefore, !!payload.hintUsed);
    } else {
      points = scoreSimple();
    }
    player.score += points;
    player.correct += 1;
    player.streak = streakBefore + 1;
    player.bestStreak = Math.max(player.bestStreak, player.streak);
    if (player.fastestMs === null || elapsed < player.fastestMs) player.fastestMs = elapsed;
    const cont = byCode(cur.question.code)?.continent;
    if (cont) player.correctByContinent[cont] = (player.correctByContinent[cont] || 0) + 1;
    const first = cur.firstCorrectId === null;
    if (first) cur.firstCorrectId = playerId;
    cur.answers[playerId] = {
      correct: true,
      points,
      atMs: nowMs,
      attempts: (prev?.attempts || 0) + 1,
      locked: false,
      lastAttemptAt: nowMs,
    };
    player.answered = true;
    game.history.push({ round: game.round, playerId, correct: true, points, atMs: nowMs, type: cur.question.type });
    if (game.settings.scoring === 'simple') cur.roundOver = true;
    if (game.settings.mode === 'race' && player.score >= game.settings.raceTarget) {
      game.pendingEnd = true;
    }
    return { accepted: true, correct: true, points, first, locked: false, eliminated: false, allAnswered: allAliveAnswered(game) };
  }

  // Wrong answer.
  const attempts = (prev?.attempts || 0) + 1;
  if (!isChoice) {
    const lastAt = prev?.lastAttemptAt;
    if (lastAt !== undefined && nowMs - lastAt < 1000) {
      return { accepted: false, reason: 'too-fast' };
    }
  }
  let locked = false;
  if (isChoice) locked = !kids;
  else if (!kids && attempts >= 3) locked = true;

  let eliminated = false;
  if (sudden && !kids) {
    player.alive = false;
    eliminated = true;
    locked = true;
  }
  let points = 0;
  if (game.settings.negativePoints && game.settings.scoring === 'speed' && locked && !kids) {
    player.score = Math.max(0, player.score - 25);
    points = -25;
  }
  player.wrong += 1;
  player.streak = 0;
  cur.answers[playerId] = {
    correct: false,
    points,
    atMs: nowMs,
    attempts,
    locked,
    lastAttemptAt: nowMs,
  };
  player.answered = true;
  game.history.push({ round: game.round, playerId, correct: false, points, atMs: nowMs, type: cur.question.type });
  return { accepted: true, correct: false, points, first: false, locked, eliminated, allAnswered: allAliveAnswered(game) };
}

/**
 * Time ran out on the current question. Unanswered players count as wrong;
 * in sudden / survival they are eliminated. Records missed questions.
 * @returns {{eliminatedIds:string[]}}
 */
export function timeoutQuestion(game, nowMs) {
  const cur = game.current;
  const eliminatedIds = [];
  if (!cur) return { eliminatedIds };
  const sudden = game.settings.mode === 'sudden' || game.settings.mode === 'survival';
  const kids = game.settings.mode === 'kids';
  // في وضع التقييم اليدوي: لا يُحسم شيء هنا؛ التصحيح (ومن لم يجب أصلاً)
  // يتم في applyJudgements بعد انتهاء الوقت، وإلا ضاعت الإجابات.
  if (game.settings.judgeMode === 'host') {
    cur.roundOver = true;
    return { eliminatedIds, pendingJudge: true };
  }
  const anyoneCorrect = Object.values(cur.answers).some((a) => a.correct);
  if (!anyoneCorrect && cur.question.code) game.missedCodes.push(cur.question.code);
  for (const p of game.players) {
    if (!p.alive) continue;
    const a = cur.answers[p.id];
    if (a && a.correct) continue;
    if (!a) {
      p.wrong += 1;
      p.streak = 0;
      p.answered = true;
      cur.answers[p.id] = { correct: false, points: 0, atMs: nowMs, attempts: 0, locked: true, lastAttemptAt: nowMs, timedOut: true };
    }
    if (sudden && !kids) {
      p.alive = false;
      eliminatedIds.push(p.id);
    }
  }
  cur.roundOver = true;
  return { eliminatedIds };
}

/**
 * Move to the reveal phase and return the answer + scores.
 */
export function reveal(game, nowMs) {
  const cur = game.current;
  if (!cur) return null;
  game.phase = 'reveal';
  game.revealEndsAt = nowMs + game.settings.revealSec * 1000;
  const subject = byCode(cur.question.code);
  return {
    answerCode: cur.question.answerCode,
    answerLabelAr: cur.question.answerLabelAr,
    answerLabelEn: cur.question.answerLabelEn,
    capitalAr: subject?.capitalAr || null,
    capitalEn: subject?.capitalEn || null,
    continent: subject?.continent || null,
    firstCorrectId: cur.firstCorrectId,
    scores: getStandings(game).map((p) => ({ id: p.id, score: p.score })),
  };
}

/** Sorted copy of the players: score desc, then correct desc, then fastest first. */
export function getStandings(game) {
  return [...game.players].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.correct !== a.correct) return b.correct - a.correct;
    const fa = a.fastestMs === null ? Infinity : a.fastestMs;
    const fb = b.fastestMs === null ? Infinity : b.fastestMs;
    return fa - fb;
  });
}

function mostFrequent(codes) {
  if (!codes || codes.length === 0) return null;
  const counts = new Map();
  for (const c of codes) counts.set(c, (counts.get(c) || 0) + 1);
  let best = null;
  let bestN = 0;
  for (const [c, n] of counts) {
    if (n > bestN) {
      best = c;
      bestN = n;
    }
  }
  return best;
}

/**
 * End the game: final ranking, per-player stats and badges.
 * @returns {{phase:string, winners:string[], standings:object[], stats:object[], badges:object[], mostMissedCode:string|null}}
 */
export function endGame(game, nowMs) {
  game.phase = 'ended';
  game.endedAt = nowMs;
  const standings = getStandings(game);
  const topScore = standings.length > 0 ? standings[0].score : 0;
  const winners = standings.filter((p) => p.score === topScore).map((p) => p.id);
  game.winners = winners;
  const stats = game.players.map((p) => {
    const total = p.correct + p.wrong;
    return {
      id: p.id,
      score: p.score,
      correct: p.correct,
      wrong: p.wrong,
      accuracy: total > 0 ? p.correct / total : 0,
      bestStreak: p.bestStreak,
      fastestMs: p.fastestMs,
    };
  });
  const badges = [];
  const withTime = game.players.filter((p) => p.fastestMs !== null);
  if (withTime.length > 0) {
    const fastest = withTime.reduce((a, b) => (a.fastestMs <= b.fastestMs ? a : b));
    badges.push({ playerId: fastest.id, badge: 'fastest', fastestMs: fastest.fastestMs });
  }
  for (const p of game.players) {
    if (p.correct > 0 && p.wrong === 0) badges.push({ playerId: p.id, badge: 'flawless' });
  }
  let king = null;
  let kingCount = 0;
  let kingContinent = null;
  for (const p of game.players) {
    for (const [cont, n] of Object.entries(p.correctByContinent)) {
      if (n > kingCount) {
        king = p;
        kingCount = n;
        kingContinent = cont;
      }
    }
  }
  if (king && kingCount >= 2) {
    badges.push({ playerId: king.id, badge: 'continent-king', continent: kingContinent, count: kingCount });
  }
  const mostMissedCode = mostFrequent(game.missedCodes);
  game.summary = { winners, standings, stats, badges, mostMissedCode };
  return { phase: 'ended', winners, standings, stats, badges, mostMissedCode };
}

/**
 * Advance after a reveal: next question, a tie-break question, or the end.
 * @returns {{phase:string, question?:object, winners?:string[], standings?:object[], stats?:object[], badges?:object[], mostMissedCode?:string|null}}
 */
export function advance(game, nowMs) {
  if (game.phase !== 'reveal' && game.phase !== 'question') return { phase: game.phase };
  if (game.pendingEnd) return endGame(game, nowMs);
  if (game.deckIndex >= game.deck.length) {
    const endless = game.settings.mode === 'race' || game.settings.mode === 'survival';
    if (endless) {
      refillDeck(game);
    } else {
      const standings = getStandings(game);
      const top = standings.length > 0 ? standings[0].score : 0;
      const tied = standings.filter((p) => p.score === top).length > 1;
      if (tied && game.tiebreak < 3 && game._tiebreakPool.length > 0) {
        game.tiebreak += 1;
        game.deck.push(game._tiebreakPool.shift());
        const q = beginQuestion(game, nowMs);
        return q ? { phase: 'question', question: q, tiebreak: game.tiebreak } : endGame(game, nowMs);
      }
      return endGame(game, nowMs);
    }
  }
  const q = beginQuestion(game, nowMs);
  if (!q) return endGame(game, nowMs);
  return { phase: 'question', question: q };
}

// ---------------------------------------------------------------------------
// Pause / resume / skip
// ---------------------------------------------------------------------------

/** Pause the current question timer. Only valid during the question phase. */
export function pauseGame(game, nowMs) {
  if (game.phase !== 'question' || game.paused || !game.current) return { paused: false, reason: 'not-in-question' };
  game.pauseRemainingMs = game.current.endsAt === null ? 0 : Math.max(0, game.current.endsAt - nowMs);
  game.paused = true;
  return { paused: true };
}

/** Resume after a pause, shifting the deadline by the paused time. */
export function resumeGame(game, nowMs) {
  if (!game.paused || !game.current) return { paused: false, reason: 'not-paused' };
  if (game.current.endsAt !== null) game.current.endsAt = nowMs + game.pauseRemainingMs;
  game.pauseRemainingMs = 0;
  game.paused = false;
  return { paused: false };
}

/** Votes needed for a majority of connected, alive players to skip. */
export function skipVotesNeeded(game) {
  const n = game.players.filter((p) => p.alive && p.connected).length;
  return Math.floor(n / 2) + 1;
}

/**
 * Record one player's skip vote. When a majority is reached the current
 * question is skipped (timed out + revealed).
 */
export function applySkipVote(game, playerId, nowMs) {
  const needed = skipVotesNeeded(game);
  if (game.phase !== 'question') return { votes: game._skipVotes.length, needed, reached: false, reason: 'not-in-question' };
  if (!game._skipVotes.includes(playerId)) game._skipVotes.push(playerId);
  const votes = game._skipVotes.length;
  const reached = votes >= needed;
  if (!reached) return { votes, needed, reached };
  const skipped = skipCurrent(game, nowMs);
  return { votes, needed, reached, skipped: skipped.skipped, reveal: skipped.reveal };
}

/** Skip the current question: time it out and go to reveal. */
export function skipCurrent(game, nowMs) {
  if (game.phase !== 'question') return { skipped: false, reason: 'not-in-question' };
  timeoutQuestion(game, nowMs);
  const r = reveal(game, nowMs);
  return { skipped: true, reveal: r };
}

// ---------------------------------------------------------------------------
// Public snapshot
// ---------------------------------------------------------------------------

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    score: p.score,
    correct: p.correct,
    wrong: p.wrong,
    streak: p.streak,
    bestStreak: p.bestStreak,
    fastestMs: p.fastestMs,
    alive: p.alive,
    team: p.team,
    answered: p.answered,
    connected: p.connected,
  };
}

/**
 * Snapshot safe to send to clients. Before the reveal the answer is hidden
 * (no answerCode / answerLabel, and no per-player correctness).
 */
export function serializePublic(game, forPlayerId) {
  const showAnswer = game.phase === 'reveal' || game.phase === 'ended';
  let current = null;
  if (game.current) {
    const q = game.current.question;
    const publicQuestion = {
      type: q.type,
      flagCode: q.flagCode,
      promptAr: q.promptAr,
      promptEn: q.promptEn,
      options: q.options,
    };
    if (q.effect) publicQuestion.effect = q.effect;
    if (showAnswer) {
      publicQuestion.answerCode = q.answerCode;
      publicQuestion.answerLabelAr = q.answerLabelAr;
      publicQuestion.answerLabelEn = q.answerLabelEn;
    }
    const answers = {};
    for (const [pid, a] of Object.entries(game.current.answers)) {
      answers[pid] = showAnswer
        ? { correct: a.correct, points: a.points, atMs: a.atMs, locked: !!a.locked }
        : { answered: true, locked: !!a.locked };
    }
    current = {
      index: game.current.index,
      startedAt: game.current.startedAt,
      endsAt: game.current.endsAt,
      firstCorrectId: showAnswer ? game.current.firstCorrectId : null,
      turnPlayerId: game.current.turnPlayerId,
      roundOver: game.current.roundOver,
      answers,
      question: publicQuestion,
    };
  }
  const { seed: _seed, ...publicSettings } = game.settings;
  return {
    yourId: forPlayerId || null,
    settings: publicSettings,
    phase: game.phase,
    round: game.round,
    totalRounds: game.totalRounds,
    tiebreak: game.tiebreak,
    paused: game.paused,
    players: game.players.map(publicPlayer),
    current,
    winners: game.winners,
    missedCodes: game.phase === 'ended' ? game.missedCodes : [],
    startedAt: game.startedAt,
    endedAt: game.endedAt,
    countdownEndsAt: game.countdownEndsAt,
    revealEndsAt: game.revealEndsAt,
    summary: game.phase === 'ended' ? game.summary : null,
  };
}
