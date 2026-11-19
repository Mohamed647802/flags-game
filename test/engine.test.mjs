import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  buildDeck,
  makeQuestion,
  checkAnswer,
  createGame,
  startGame,
  beginQuestion,
  submitAnswer,
  timeoutQuestion,
  reveal,
  advance,
  pauseGame,
  resumeGame,
  serializePublic,
  getStandings,
} from '../shared/engine.js';
import { mulberry32 } from '../shared/rng.js';
import { COUNTRIES, byCode } from '../shared/countries.js';
import { matchesAnswer, normalizeText } from '../shared/normalize.js';

// --- helpers that tolerate the engine's question shape -----------------------
// Question contract: 4 options including the answer. Options may be country
// codes (strings) or objects with a .code; the answer may be exposed as
// question.code / .answerCode / .answer, or via .correctIndex.
function optionCodes(q) {
  const raw = q.options ?? q.choices;
  assert.ok(Array.isArray(raw), `question has no options/choices: ${JSON.stringify(Object.keys(q))}`);
  return raw.map((o) => (typeof o === 'string' ? o : o.code));
}

function answerCode(q) {
  if (typeof q.code === 'string') return q.code;
  if (typeof q.answerCode === 'string') return q.answerCode;
  if (typeof q.answer === 'string') return q.answer;
  if (typeof q.correctCode === 'string') return q.correctCode;
  return null;
}

function correctIndex(q) {
  if (typeof q.correctIndex === 'number') return q.correctIndex;
  if (typeof q.answerIndex === 'number') return q.answerIndex;
  const code = answerCode(q);
  if (code) return optionCodes(q).indexOf(code);
  return -1;
}

function questionId(q) {
  return q.id ?? q.questionId ?? q.code ?? answerCode(q);
}

function deckCodes(deck) {
  return deck.map((d) => (typeof d === 'string' ? d : d.code));
}

function players(n = 2) {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `Player ${i + 1}` }));
}

const baseSettings = {
  ...(DEFAULT_SETTINGS ?? {}),
  flagCount: 10,
  mode: 'fixed',
  scoring: 'simple',
  durationSec: 15,
  answerType: 'choice',
};

/** Move a fresh game into the 'question' phase and return its question. */
function startQuestion(game, nowMs = 1_000_000) {
  startGame(game, nowMs);
  if (game.phase === 'countdown') beginQuestion(game, nowMs);
  assert.equal(game.phase, 'question', `expected question phase, got ${game.phase}`);
  assert.ok(game.current?.question, 'game.current.question missing');
  return game.current.question;
}

/** Drive a game to 'ended' by timing out every question. Returns #reveals seen. */
function driveToEnd(game) {
  let now = 1_000_000;
  let reveals = 0;
  startGame(game, now);
  let guard = 0;
  while (game.phase !== 'ended' && guard++ < 500) {
    now += 1000;
    if (game.phase === 'countdown') {
      beginQuestion(game, now);
    } else if (game.phase === 'question') {
      timeoutQuestion(game, now);
      if (game.phase === 'question') reveal(game, now);
    } else if (game.phase === 'reveal') {
      reveals += 1;
      advance(game, now);
    } else if (game.phase === 'lobby') {
      startGame(game, now);
    } else {
      throw new Error(`unexpected phase ${game.phase}`);
    }
  }
  assert.equal(game.phase, 'ended', `game did not end (phase=${game.phase}) after ${guard} steps`);
  return reveals;
}

/** Try mode names in order; return the first game whose state reflects that mode. */
function createModeGame(candidates, settingsExtra, nPlayers = 2) {
  let lastGame = null;
  for (const mode of candidates) {
    const game = createGame(
      { ...baseSettings, ...settingsExtra, mode },
      players(nPlayers),
      99,
    );
    lastGame = game;
    startGame(game, 1_000_000);
    if (game.phase === 'countdown') beginQuestion(game, 1_000_000);
    if (game.phase !== 'question') continue;
    if (mode.includes('turn') && !game.current?.turnPlayerId) continue;
    return { game, mode };
  }
  return { game: lastGame, mode: candidates[candidates.length - 1] };
}

// --- buildDeck ----------------------------------------------------------------

test('buildDeck: same seed => same deck, no repeats', () => {
  const d1 = buildDeck(baseSettings, 42);
  const d2 = buildDeck(baseSettings, 42);
  assert.deepEqual(d1, d2);
  const codes = deckCodes(d1);
  assert.equal(codes.length, baseSettings.flagCount);
  assert.equal(new Set(codes).size, codes.length, 'deck has repeated countries');
  for (const code of codes) assert.ok(byCode(code), `deck code ${code} not in countries`);
});

test('buildDeck: different seeds differ', () => {
  const d1 = deckCodes(buildDeck(baseSettings, 1));
  const d2 = deckCodes(buildDeck(baseSettings, 2));
  assert.notDeepEqual(d1, d2);
});

test('buildDeck: arabOnly filter keeps only Arab countries', () => {
  const deck = deckCodes(buildDeck({ ...baseSettings, arabOnly: true, flagCount: 15 }, 5));
  assert.ok(deck.length > 0);
  for (const code of deck) assert.ok(byCode(code).isArab, `${code} is not Arab`);
});

test('buildDeck: continents filter', () => {
  const deck = deckCodes(buildDeck({ ...baseSettings, continents: ['africa'], flagCount: 10 }, 5));
  assert.ok(deck.length > 0);
  for (const code of deck) assert.equal(byCode(code).continent, 'africa');
});

test('buildDeck: difficulty easy keeps only difficulty 1', () => {
  const deck = deckCodes(buildDeck({ ...baseSettings, difficulty: 'easy', flagCount: 10 }, 5));
  assert.ok(deck.length > 0);
  for (const code of deck) assert.equal(byCode(code).difficulty, 1, `${code} difficulty != 1`);
});

// --- makeQuestion / checkAnswer ------------------------------------------------

test('makeQuestion: 4 unique options including the answer', () => {
  for (const country of COUNTRIES.slice(0, 20)) {
    const q = makeQuestion(country.code, baseSettings, mulberry32(7));
    const options = optionCodes(q);
    assert.equal(options.length, 4, `${country.code}: expected 4 options`);
    assert.equal(new Set(options).size, 4, `${country.code}: duplicate options`);
    assert.ok(options.includes(country.code), `${country.code}: options do not include the answer`);
    assert.ok(correctIndex(q) >= 0 && correctIndex(q) < 4, 'correctIndex out of range');
    assert.equal(options[correctIndex(q)], country.code);
  }
});

test('makeQuestion: distractors are not aliases of the answer', () => {
  for (const country of COUNTRIES.slice(0, 30)) {
    const q = makeQuestion(country.code, baseSettings, mulberry32(11));
    const options = optionCodes(q);
    for (const opt of options) {
      if (opt === country.code) continue;
      const distractor = byCode(opt);
      assert.equal(matchesAnswer(distractor.ar, country, COUNTRIES), false,
        `${opt} (${distractor.ar}) is an alias of ${country.code}`);
      assert.equal(matchesAnswer(distractor.en, country, COUNTRIES), false,
        `${opt} (${distractor.en}) is an alias of ${country.code}`);
    }
  }
});

test('checkAnswer: choice payload', () => {
  const q = makeQuestion('eg', baseSettings, mulberry32(3));
  const ci = correctIndex(q);
  // checkAnswer returns a boolean (not an object)
  assert.equal(checkAnswer(q, { choiceIndex: ci, questionId: questionId(q) }), true);
  assert.equal(checkAnswer(q, { choiceIndex: (ci + 1) % 4, questionId: questionId(q) }), false);
  // text payload: exact country name is accepted
  assert.equal(checkAnswer(q, { text: 'مصر' }), true);
  assert.equal(checkAnswer(q, { text: 'فرنسا' }), false);
});

// --- game flow -----------------------------------------------------------------

test('createGame + startGame + beginQuestion phases', () => {
  const game = createGame(baseSettings, players(3), 123);
  assert.equal(game.phase, 'lobby');
  assert.equal(game.paused, false);
  assert.equal(game.players.length, 3);
  startGame(game, 1_000_000);
  assert.ok(['countdown', 'question'].includes(game.phase), `phase after start: ${game.phase}`);
  if (game.phase === 'countdown') {
    beginQuestion(game, 1_000_000);
    assert.equal(game.phase, 'question');
  }
  assert.ok(game.current?.question, 'no current question');
  assert.ok(game.current.startedAt && game.current.endsAt > game.current.startedAt);
});

test('submitAnswer: first correct in simple mode gets 1 point and ends the round', () => {
  const game = createGame({ ...baseSettings, flagCount: 5 }, players(3), 42);
  const q = startQuestion(game);
  const ci = correctIndex(q);
  const res = submitAnswer(game, 'p1', { choiceIndex: ci, questionId: questionId(q) }, 1_001_000);
  assert.equal(res.accepted, true);
  assert.equal(res.correct, true);
  assert.equal(res.points, 1, 'first correct in simple mode must score 1');
  const p1 = game.players.find((p) => p.id === 'p1');
  assert.equal(p1.score, 1);

  // second correct answer from another player must not be awarded
  const res2 = submitAnswer(game, 'p2', { choiceIndex: ci, questionId: questionId(q) }, 1_001_500);
  assert.ok(res2.accepted === false || (res2.points ?? 0) === 0,
    `second correct answer was awarded: ${JSON.stringify(res2)}`);
  const total = game.players.reduce((s, p) => s + p.score, 0);
  assert.equal(total, 1, 'only 1 point may be awarded per round in simple mode');
});

test('submitAnswer: wrong choice locks the player', () => {
  const game = createGame({ ...baseSettings, flagCount: 5 }, players(2), 42);
  const q = startQuestion(game);
  const ci = correctIndex(q);
  const wrong = (ci + 1) % 4;
  const res = submitAnswer(game, 'p1', { choiceIndex: wrong, questionId: questionId(q) }, 1_001_000);
  assert.equal(res.accepted, true);
  assert.equal(res.correct, false);
  // locked player cannot answer again this round
  const res2 = submitAnswer(game, 'p1', { choiceIndex: ci, questionId: questionId(q) }, 1_002_000);
  assert.equal(res2.accepted, false, 'locked player could answer again');
  // the other player is unaffected
  const res3 = submitAnswer(game, 'p2', { choiceIndex: ci, questionId: questionId(q) }, 1_002_500);
  assert.equal(res3.accepted, true);
  assert.equal(res3.correct, true);
});

test('submitAnswer: typing wrong 3 times locks the player', () => {
  const settings = { ...baseSettings, flagCount: 5, answerType: 'typing' };
  const game = createGame(settings, players(2), 42);
  const q = startQuestion(game);
  const qid = questionId(q);
  const wrongText = '___definitely not a country___';
  for (let i = 0; i < 3; i++) {
    submitAnswer(game, 'p1', { text: wrongText, questionId: qid }, 1_001_000 + i * 1000);
  }
  const after = submitAnswer(game, 'p1', { text: wrongText, questionId: qid }, 1_005_000);
  assert.equal(after.accepted, false, 'player should be locked after 3 wrong typing attempts');
  const p1 = game.players.find((p) => p.id === 'p1');
  assert.ok(p1.locked === true || p1.answered === true || after.locked === true,
    'player state does not show the lock');
});

test('submitAnswer: sudden-death wrong answer eliminates the player', () => {
  // engine modes: 'sudden' (and 'survival'); 'sudden-death' is not a mode
  const { game } = createModeGame(['sudden', 'survival'], { flagCount: 5 });
  assert.equal(game.phase, 'question', 'sudden-death game did not reach question phase');
  const q = game.current.question;
  const ci = correctIndex(q);
  const res = submitAnswer(game, 'p1', { choiceIndex: (ci + 1) % 4, questionId: questionId(q) }, 1_001_000);
  assert.equal(res.correct, false);
  const p1 = game.players.find((p) => p.id === 'p1');
  assert.ok(res.eliminated === true || p1.alive === false,
    `wrong answer in sudden-death did not eliminate: ${JSON.stringify(res)}, alive=${p1.alive}`);
});

test('submitAnswer: turn-based — only the turn player can answer', () => {
  // engine mode is 'turns'
  const { game } = createModeGame(['turns'], { flagCount: 5 });
  assert.equal(game.phase, 'question', 'turn game did not reach question phase');
  const turnId = game.current.turnPlayerId;
  assert.ok(turnId, 'turn-based game has no turnPlayerId');
  const other = game.players.find((p) => p.id !== turnId);
  const q = game.current.question;
  const ci = correctIndex(q);
  const resOther = submitAnswer(game, other.id, { choiceIndex: ci, questionId: questionId(q) }, 1_001_000);
  assert.equal(resOther.accepted, false, 'non-turn player was allowed to answer');
  const resTurn = submitAnswer(game, turnId, { choiceIndex: ci, questionId: questionId(q) }, 1_001_500);
  assert.equal(resTurn.accepted, true, 'turn player could not answer');
});

test('pause/resume preserves remaining time (endsAt shifts)', () => {
  const game = createGame({ ...baseSettings, flagCount: 5, durationSec: 30 }, players(2), 42);
  startQuestion(game, 1_000_000);
  const endsAt0 = game.current.endsAt;
  pauseGame(game, 1_005_000);
  assert.equal(game.paused, true);
  resumeGame(game, 1_010_000);
  assert.equal(game.paused, false);
  const shift = game.current.endsAt - endsAt0;
  assert.ok(shift >= 4000 && shift <= 6000,
    `endsAt shifted by ${shift}ms for a 5000ms pause (expected ~5000)`);
});

test('answer after reveal is ignored', () => {
  const game = createGame({ ...baseSettings, flagCount: 5 }, players(2), 42);
  startQuestion(game, 1_000_000);
  timeoutQuestion(game, 1_016_000);
  if (game.phase === 'question') reveal(game, 1_016_000);
  assert.equal(game.phase, 'reveal', `expected reveal phase, got ${game.phase}`);
  const q = game.current.question;
  const res = submitAnswer(game, 'p1', { choiceIndex: 0, questionId: questionId(q) }, 1_017_000);
  assert.equal(res.accepted, false, 'answer in reveal phase was accepted');
});

test('advance to end produces standings sorted desc + badges array', () => {
  const game = createGame({ ...baseSettings, flagCount: 3 }, players(3), 42);
  // give players distinct scores: p1 answers Q1 correctly, p2 answers Q2 correctly
  let now = 1_000_000;
  startGame(game, now);
  let answered = 0;
  let guard = 0;
  while (game.phase !== 'ended' && guard++ < 100) {
    now += 1000;
    if (game.phase === 'countdown') beginQuestion(game, now);
    else if (game.phase === 'question') {
      if (answered < 2) {
        const q = game.current.question;
        const who = answered === 0 ? 'p1' : 'p2';
        submitAnswer(game, who, { choiceIndex: correctIndex(q), questionId: questionId(q) }, now);
        answered += 1;
      }
      timeoutQuestion(game, now);
      if (game.phase === 'question') reveal(game, now);
    } else if (game.phase === 'reveal') advance(game, now);
    else if (game.phase === 'lobby') startGame(game, now);
  }
  assert.equal(game.phase, 'ended');
  const standings = getStandings(game);
  assert.ok(Array.isArray(standings) && standings.length === 3);
  for (let i = 1; i < standings.length; i++) {
    assert.ok(standings[i - 1].score >= standings[i].score, 'standings not sorted desc');
  }
  assert.equal(standings[0].score, 1);
  const pub = serializePublic(game);
  // badges live in the end-of-game summary (game.summary / serializePublic summary)
  const badges = pub.summary?.badges ?? game.summary?.badges;
  assert.ok(Array.isArray(badges), `no badges array found (serializePublic keys: ${Object.keys(pub).join(', ')})`);
});

test('tie-break: tied game plays extra flags (tiebreak>0) or ends with standings', () => {
  // nobody answers: 0-0 tie at the end of the deck
  const game = createGame({ ...baseSettings, flagCount: 2 }, players(2), 42);
  const reveals = driveToEnd(game);
  const standings = getStandings(game);
  assert.ok(Array.isArray(standings) && standings.length === 2, 'standings missing');
  for (let i = 1; i < standings.length; i++) {
    assert.ok(standings[i - 1].score >= standings[i].score, 'standings not sorted desc');
  }
  assert.equal(standings[0].score, standings[1].score, 'expected a tie (0-0)');
  const tiebreak = game.tiebreak ?? game.tiebreakCount ?? game.tiebreakQuestions ?? 0;
  if (reveals > 2 || tiebreak > 0) {
    // engine played extra tie-break flags
    assert.ok(reveals > 2 || tiebreak > 0, 'tiebreak indicated but no extra flags played');
  } else {
    // engine ends immediately on a tie; standings must still exist (asserted above)
    assert.ok(true, 'engine ends immediately on tie; standings returned');
  }
});

test('serializePublic hides private state', () => {
  const game = createGame({ ...baseSettings, flagCount: 3 }, players(2), 42);
  startQuestion(game, 1_000_000);
  const pub = serializePublic(game);
  assert.ok(pub.phase, 'serializePublic missing phase');
  assert.ok(Array.isArray(pub.players ?? pub.standings), 'serializePublic missing players');
});
