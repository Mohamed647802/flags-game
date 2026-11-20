// وضع «كتابة ثم تقييم بعد الوقت» (write_then_judge):
// - الإجابة النصية تُسجَّل فقط بلا تصحيح ولا نقاط أثناء الوقت.
// - عند انتهاء الوقت يقيّم المضيف يدوياً؛ قراره نهائي.
// - من لم يجب يُحسب خطأ؛ ولا تتوقف اللعبة إن غاب المضيف (تصحيح تلقائي).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame,
  startGame,
  beginQuestion,
  submitAnswer,
  collectTextAnswers,
  applyJudgements,
  timeoutQuestion,
  isJudgeMode,
} from '../shared/engine.js';
import { byCode } from '../shared/countries.js';
import { RoomManager } from '../server/rooms.js';

const players = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `لاعب ${i + 1}` }));
const base = { flagCount: 3, durationSec: 15, answerMode: 'write_then_judge', scoring: 'simple', mode: 'fixed' };

function startJudgeGame(n = 3) {
  const game = createGame(base, players(n), 42);
  startGame(game, 1_000_000);
  if (game.phase === 'countdown') beginQuestion(game, 1_000_000);
  return game;
}

function correctText(game) {
  const q = game.current.question;
  const c = byCode(q.code ?? q.answerCode);
  return c?.nameAr ?? q.answerLabelAr;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('judge mode is detected and derived from answerMode', () => {
  const game = startJudgeGame(2);
  assert.equal(isJudgeMode(game), true);
  assert.equal(game.settings.judgeMode, 'host');
  assert.equal(game.settings.answerMode, 'write_then_judge');
});

test('text answer is recorded pending — no grading, no points, no reveal while timer runs', () => {
  const game = startJudgeGame(3);
  const text = correctText(game);
  const res = submitAnswer(game, 'p0', { text }, 1_000_500);
  assert.equal(res.accepted, true);
  assert.equal(res.pendingJudge, true);
  assert.equal(res.correct, null);
  assert.equal(res.points, 0);
  const p0 = game.players.find((p) => p.id === 'p0');
  assert.equal(p0.score, 0);
  assert.equal(p0.correct, 0);
  // إعادة الإرسال مرفوضة (إجابة واحدة فقط).
  const again = submitAnswer(game, 'p0', { text: 'مصر' }, 1_000_600);
  assert.equal(again.accepted, false);
  // إجابة اختيارية مرفوضة في هذا الوضع.
  const choice = submitAnswer(game, 'p1', { choiceIndex: 0 }, 1_000_600);
  assert.equal(choice.accepted, false);
});

test('collectTextAnswers carries the normalization suggestion as a hint', () => {
  const game = startJudgeGame(3);
  const text = correctText(game);
  submitAnswer(game, 'p0', { text }, 1_000_500);
  submitAnswer(game, 'p1', { text: 'إجابة خاطئة تماماً' }, 1_000_600);
  const list = collectTextAnswers(game);
  assert.equal(list.length, 2);
  assert.equal(list.find((a) => a.playerId === 'p0').suggestedCorrect, true);
  assert.equal(list.find((a) => a.playerId === 'p1').suggestedCorrect, false);
  assert.equal(list[0].playerId, 'p0'); // مرتبة حسب وقت الإرسال
});

test('timeout does not grade in judge mode; applyJudgements awards points and marks no-answer wrong', () => {
  const game = startJudgeGame(3);
  const text = correctText(game);
  submitAnswer(game, 'p0', { text }, 1_000_500);
  submitAnswer(game, 'p1', { text: 'خطأ' }, 1_000_600);
  // p2 لا يجيب أصلاً.
  timeoutQuestion(game, 1_016_000);
  const p0 = game.players.find((p) => p.id === 'p0');
  assert.equal(p0.score, 0, 'timeout must not award points in judge mode');
  assert.equal(game.current.answers.p0.pendingJudge, true);
  const { results, correctCount } = applyJudgements(game, [
    { playerId: 'p0', correct: true },
    { playerId: 'p1', correct: false },
  ], 1_016_000);
  assert.equal(correctCount, 1);
  assert.ok(p0.score > 0, 'correct judgement must award points');
  assert.equal(p0.correct, 1);
  const p1 = game.players.find((p) => p.id === 'p1');
  assert.equal(p1.wrong, 1);
  const p2 = game.players.find((p) => p.id === 'p2');
  assert.equal(p2.wrong, 1, 'player who never answered is marked wrong');
  assert.equal(results.find((r) => r.playerId === 'p2').noAnswer, true);
  assert.equal(game.missedCodes.length, 0, 'someone was correct: not missed');
});

test('applyJudgements with no correct answer records the question as missed', () => {
  const game = startJudgeGame(2);
  submitAnswer(game, 'p0', { text: 'خطأ' }, 1_000_500);
  submitAnswer(game, 'p1', { text: 'خطأ أيضاً' }, 1_000_600);
  applyJudgements(game, [
    { playerId: 'p0', correct: false },
    { playerId: 'p1', correct: false },
  ], 1_016_000);
  assert.equal(game.missedCodes.length, 1);
});

test('applyJudgements rejects decisions that do not cover every submitted answer', () => {
  const game = startJudgeGame(2);
  submitAnswer(game, 'p0', { text: correctText(game) }, 1_000_500);
  submitAnswer(game, 'p1', { text: 'خطأ' }, 1_000_600);
  assert.throws(() => applyJudgements(game, [{ playerId: 'p0', correct: true }], 1_016_000), /missing judgement/);
});

test('rooms: end-to-end judge flow — timer end starts judging, non-host is rejected, host judgement reveals scores', async () => {
  const broadcast = [];
  const sentTo = [];
  const mgr = new RoomManager({
    hooks: {
      broadcast: (room, msg) => { broadcast.push(msg); },
      sendTo: (room, playerId, msg) => { sentTo.push({ playerId, msg }); },
      snapshot: () => ({}),
    },
  });
  try {
    const { room, player: host } = mgr.createRoom({ hostPlayer: { name: 'المنشئ' }, settings: {} });
    mgr.playerConnected(room, host.id);
    const j1 = mgr.joinRoom(room.code, { name: 'لاعب 1' }).player;
    const j2 = mgr.joinRoom(room.code, { name: 'لاعب 2' }).player;
    mgr.setSettings(room, { answerMode: 'write_then_judge', flagCount: 2, durationSec: 15 }, host.id);
    mgr.startGame(room, Date.now(), host.id);
    await sleep(3200); // العد التنازلي 3 ثوانٍ
    // الجميع جاهزون → يبدأ السؤال فوراً.
    mgr.markReady(room, host.id, room.questionId);
    mgr.markReady(room, j1.id, room.questionId);
    mgr.markReady(room, j2.id, room.questionId);
    assert.equal(room.questionStarted, true, 'question did not start');
    const qid = room.questionId;
    const correct = byCode(room.game.current.question.code)?.nameAr
      ?? room.game.current.question.answerLabelAr;
    const a1 = mgr.submitAnswer(room, j1.id, { text: correct, questionId: qid }, Date.now());
    assert.equal(a1.pendingJudge, true, 'j1 answer must be pending-judge');
    assert.equal(a1.accepted, true);
    const a2 = mgr.submitAnswer(room, j2.id, { text: 'إجابة خاطئة', questionId: qid }, Date.now());
    assert.equal(a2.pendingJudge, true);
    const hostScoreBefore = room.game.players.find((p) => p.id === host.id)?.score ?? 0;
    assert.equal(room.game.players.find((p) => p.id === j1.id).score, 0, 'no points before judging');
    // انتهاء الوقت → يبدأ التقييم بدلاً من الكشف.
    mgr.endQuestion(room);
    assert.ok(room.judging, 'judging did not start on timer end');
    assert.ok(broadcast.some((m) => m.t === 'judging'), 'no judging broadcast');
    assert.ok(!broadcast.some((m) => m.t === 'q_reveal'), 'q_reveal leaked before judging');
    const req = sentTo.find((x) => x.msg.t === 'judge_request');
    assert.ok(req, 'no judge_request sent');
    assert.equal(req.playerId, host.id, 'judge_request must go to the host only');
    assert.equal(req.msg.answers.length, 2);
    // غير المضيف لا يقيّم.
    assert.throws(
      () => mgr.applyHostJudgement(room, j1.id, [
        { playerId: j1.id, correct: true },
        { playerId: j2.id, correct: false },
      ], qid),
      (e) => e.code === 'not_host',
    );
    // المضيف يقيّم: j1 صح، j2 خطأ.
    const result = mgr.applyHostJudgement(room, host.id, [
      { playerId: j1.id, correct: true },
      { playerId: j2.id, correct: false },
    ], qid);
    assert.equal(result.correctCount, 1);
    assert.equal(room.judging, null);
    const revealMsg = broadcast.find((m) => m.t === 'q_reveal');
    assert.ok(revealMsg, 'no q_reveal after judging');
    const s1 = revealMsg.scores.find((s) => s.playerId === j1.id);
    const s2 = revealMsg.scores.find((s) => s.playerId === j2.id);
    assert.ok(s1.score > 0, 'judged-correct player must have points in q_reveal');
    assert.equal(s2.score, 0);
    assert.equal(hostScoreBefore, 0);
  } finally {
    mgr.destroy();
  }
});

test('rooms: judging auto-grades when nobody submitted an answer', async () => {
  const broadcast = [];
  const mgr = new RoomManager({ hooks: { broadcast: (room, msg) => { broadcast.push(msg); } } });
  try {
    const { room, player: host } = mgr.createRoom({ hostPlayer: { name: 'المنشئ' }, settings: {} });
    mgr.playerConnected(room, host.id);
    mgr.joinRoom(room.code, { name: 'لاعب 1' });
    mgr.setSettings(room, { answerMode: 'write_then_judge', flagCount: 1, durationSec: 15 }, host.id);
    mgr.startGame(room, Date.now(), host.id);
    await sleep(3200);
    for (const p of mgr.connectedPlayers(room)) mgr.markReady(room, p.id, room.questionId);
    assert.equal(room.questionStarted, true);
    mgr.endQuestion(room);
    assert.equal(room.judging, null, 'no judging when nobody answered');
    assert.ok(broadcast.some((m) => m.t === 'q_reveal'), 'game must reveal even with no answers');
  } finally {
    mgr.destroy();
  }
});
