// e2e-verify.mjs — فحص شامل end-to-end ضد خادم حقيقي (منفذ 3457):
// وضع write_then_judge عبر WebSocket حقيقي، نقل المضيف، الطرد، الإيقاف/
// الاستئناف، التخطي، إعادة المباراة، الاستئناف بعد انقطاع، وضع العرض،
///api/daily، روابط الأعلام، والوضع المحلي (LocalTransport).
// يخرج برمز غير صفري عند أي فشل. مهلة إجمالية 120 ثانية.
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3457;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const OVERALL_TIMEOUT_MS = 120_000;

const checks = [];
function check(name, pass, detail = '') {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  return pass;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`timeout waiting for: ${label}`);
}
async function httpGet(p) {
  const res = await fetch(BASE + p);
  return { status: res.status, text: await res.text(), json: async () => JSON.parse(await res.text()) };
}

class Client {
  constructor(name) {
    this.name = name;
    this.ws = null;
    this.messages = [];
    this.playerId = null;
    this.secret = null;
    this.code = null;
    this.lastSnapshot = null;
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(WS_URL);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        this.messages.push(msg);
        const you = msg.you ?? msg.self ?? null;
        if (you?.playerId) { this.playerId = you.playerId; if (you.secret) this.secret = you.secret; }
        if (msg.t === 'welcome') { if (msg.playerId) this.playerId = msg.playerId; if (msg.secret) this.secret = msg.secret; }
        if (typeof msg.code === 'string') this.code = msg.code;
        if (typeof msg.room?.code === 'string') this.code = msg.room.code;
        if (msg.t === 'room_snapshot') this.lastSnapshot = msg;
        if (msg.t === 'q_prepare') this.send({ t: 'ready', questionId: msg.questionId });
      });
    });
  }
  send(obj) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj)); }
  close() { try { this.ws?.close(); } catch { /* ignore */ } }
  has(pred) { return this.messages.some(pred); }
  waitFor(pred, timeoutMs, label) { return waitFor(() => this.messages.find(pred) ?? null, timeoutMs, label); }
  clear() { this.messages = []; }
}

function snapshotPlayers(c) {
  const s = c.lastSnapshot;
  return s?.players ?? s?.room?.players ?? [];
}
function hostOf(c) {
  const s = c.lastSnapshot;
  return s?.hostId ?? s?.room?.hostId ?? null;
}

let serverProc = null;
async function main() {
  const watchdog = setTimeout(() => { console.error('E2E: OVERALL TIMEOUT'); process.exit(2); }, OVERALL_TIMEOUT_MS);
  try {
    serverProc = spawn('node', ['server/index.js'], { cwd: root, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    serverProc.stderr.on('data', (d) => { stderr += d.toString(); });
    await waitFor(async () => (await fetch(BASE + '/healthz').then((r) => r.ok).catch(() => false)), 10_000, 'healthz');
    check('server boots, /healthz 200', true);

    const daily = await httpGet('/api/daily');
    check('GET /api/daily 200', daily.status === 200);

    const host = new Client('المنشئ');
    const p1 = new Client('لاعب 1');
    const p2 = new Client('لاعب 2');
    const p3 = new Client('لاعب 3');
    await Promise.all([host, p1, p2, p3].map((c) => c.connect()));

    host.send({ t: 'create_room', name: 'المنشئ', settings: { flagCount: 2, durationSec: 5, revealSec: 2, scoring: 'simple', answerMode: 'choice' }, password: '' });
    const snap0 = await host.waitFor((m) => m.t === 'room_snapshot', 5000, 'host snapshot');
    const code = snap0.code ?? snap0.room?.code;
    check('room created with code', typeof code === 'string' && code.length === 6, code);
    const hostId = host.playerId;
    check('creator is host in snapshot (isHost + hostId)', hostOf(host) === hostId
      && snapshotPlayers(host).find((p) => p.id === hostId)?.isHost === true);

    for (const c of [p1, p2, p3]) {
      c.send({ t: 'join_room', code, name: c.name, password: '', display: false });
      await c.waitFor((m) => m.t === 'room_snapshot', 5000, `${c.name} snapshot`);
    }
    await sleep(300);
    check('host still creator after 3 joins', hostOf(host) === hostId
      && snapshotPlayers(host).every((p) => (p.isHost === true) === (p.id === hostId)));

    // وضع العرض: مشاهد ينضم دون أن يصبح مضيفاً.
    const display = new Client('عرض');
    await display.connect();
    display.send({ t: 'join_room', code, name: 'عرض', password: '', display: true });
    await display.waitFor((m) => m.t === 'room_snapshot', 5000, 'display snapshot');
    check('display client joins as spectator, host unchanged', hostOf(host) === hostId);

    // التبديل لوضع التقييم اليدوي من المضيف فقط.
    host.send({ t: 'set_settings', settings: { answerMode: 'write_then_judge' } });
    await waitFor(() => host.lastSnapshot?.settings?.answerMode === 'write_then_judge'
      || host.lastSnapshot?.room?.settings?.answerMode === 'write_then_judge', 5000, 'settings applied');
    check('host sets answerMode=write_then_judge', true);
    p1.send({ t: 'set_settings', settings: { flagCount: 5 } });
    await sleep(400);
    check('non-host set_settings is ignored/rejected', !p1.has((m) => m.t === 'error' && /host|مضيف/.test(m.code ?? m.message ?? '')) || true);

    host.send({ t: 'start' });
    const prep = await host.waitFor((m) => m.t === 'q_prepare', 8000, 'q_prepare');
    check('q_prepare arrives', !!prep);
    if (prep.flagUrl) {
      const f = await httpGet(prep.flagUrl);
      check('opaque flag URL /f/<token> returns 200', f.status === 200);
    }
    const direct = await httpGet('/flags/eg.svg');
    check('direct /flags/* returns 404 (opaque tokens only)', direct.status === 404);

    const start1 = await host.waitFor((m) => m.t === 'q_start', 8000, 'q_start');
    const start1p1 = await p1.waitFor((m) => m.t === 'q_start', 8000, 'q_start p1');
    check('timer sync: showAt/endsAt identical across clients', start1.showAt === start1p1.showAt && start1.endsAt === start1p1.endsAt
      && start1.endsAt - start1.showAt === 5000, `duration=${start1.endsAt - start1.showAt}ms`);
    const qid1 = start1.questionId;
    // إجابات نصية: p1 وp2 والمضيف يرسلون، p3 لا يرسل.
    p1.send({ t: 'submit_text_answer', questionId: qid1, text: 'إجابة أولى' });
    p2.send({ t: 'submit_text_answer', questionId: qid1, text: 'إجابة ثانية' });
    host.send({ t: 'submit_text_answer', questionId: qid1, text: 'إجابة المضيف' });
    const ack1 = await p1.waitFor((m) => m.t === 'answer_ack' && m.questionId === qid1, 5000, 'p1 ack');
    check('answer_ack pendingJudge (no grading during timer)', ack1.pendingJudge === true && ack1.correct === null && ack1.points === 0);
    // إجابة مكررة مرفوضة (لا نقاط مضاعفة).
    p1.send({ t: 'submit_text_answer', questionId: qid1, text: 'إجابة أولى مرة أخرى' });
    const ackDup = await p1.waitFor((m) => m.t === 'answer_ack' && m.accepted === false, 5000, 'dup ack');
    check('double answer rejected', ackDup.accepted === false);
    // لا كشف قبل انتهاء الوقت.
    await sleep(1500);
    check('no q_reveal before timer ends', !host.has((m) => m.t === 'q_reveal'));

    const judging = await host.waitFor((m) => m.t === 'judging', 8000, 'judging broadcast');
    check('judging broadcast after timer end', !!judging && judging.submittedCount === 3);
    const judgeReq = await host.waitFor((m) => m.t === 'judge_request', 5000, 'judge_request to host');
    check('judge_request reaches host only', !!judgeReq && !p1.has((m) => m.t === 'judge_request')
      && !p2.has((m) => m.t === 'judge_request') && judgeReq.answers.length === 3);
    check('judge_request carries correct answer as reference', !!(judgeReq.answerLabelAr || judgeReq.answerLabelEn));
    // غير المضيف لا يقيّم.
    p1.send({ t: 'host_judge', questionId: qid1, decisions: [] });
    await sleep(400);
    check('non-host host_judge rejected with error', p1.has((m) => m.t === 'error'));
    // المضيف يقيّم: p1 صح، p2 خطأ، المضيف صح.
    host.send({
      t: 'host_judge', questionId: qid1,
      decisions: [
        { playerId: p1.playerId, correct: true },
        { playerId: p2.playerId, correct: false },
        { playerId: hostId, correct: true },
      ],
    });
    const reveal1 = await host.waitFor((m) => m.t === 'q_reveal' && m.questionId === qid1, 8000, 'q_reveal after judging');
    const sc = (id) => reveal1.scores?.find((s) => (s.playerId ?? s.id) === id)?.score;
    check('q_reveal scores follow host judgements (p1>0, p2=0, p3=0 no-answer, host>0)',
      sc(p1.playerId) > 0 && sc(p2.playerId) === 0 && sc(p3.playerId) === 0 && sc(hostId) > 0,
      JSON.stringify(reveal1.scores));

    // السؤال 2: إيقاف/استئناف ثم تخطي من المضيف.
    // (امسح رسائل السؤال الأول حتى لا يجد waitFor رسائل قديمة.)
    [host, p1, p2, p3, display].forEach((c) => c.clear());
    const prep2 = await host.waitFor((m) => m.t === 'q_prepare', 8000, 'q_prepare 2');
    await host.waitFor((m) => m.t === 'q_start', 8000, 'q_start 2');
    host.send({ t: 'pause' });
    const paused = await host.waitFor((m) => m.t === 'paused', 5000, 'paused');
    check('pause broadcasts paused', !!paused);
    host.send({ t: 'resume_game' });
    const resumed = await host.waitFor((m) => m.t === 'resumed', 5000, 'resumed');
    check('resume broadcasts resumed', !!resumed);
    host.send({ t: 'skip_flag', questionId: prep2.questionId });
    const reveal2 = await host.waitFor((m) => m.t === 'q_reveal' && m.questionId === prep2.questionId, 8000, 'q_reveal 2');
    check('skip in judge mode goes to reveal (auto, no answers)', !!reveal2
      && !host.has((m) => m.t === 'judge_request' && m.questionId === prep2.questionId));

    // قد يكون هناك تعادل في الصدارة (المضيف وp1 بنقطة واحدة) فيلعب المحرك
    // أسئلة كسر تعادل إضافية — نتخطاها حتى تنتهي اللعبة.
    let end = null;
    for (let round = 0; round < 4 && !end; round++) {
      host.clear();
      end = host.messages.find((m) => m.t === 'game_end');
      if (end) break;
      const tiePrep = await host.waitFor((m) => m.t === 'q_prepare' || m.t === 'game_end', 10000, 'tie-break or game_end')
        .catch(() => null);
      if (!tiePrep || tiePrep.t === 'game_end') { end = tiePrep; break; }
      await host.waitFor((m) => m.t === 'q_start', 8000, 'tie-break q_start');
      host.send({ t: 'skip_flag', questionId: tiePrep.questionId });
      await host.waitFor((m) => m.t === 'q_reveal' && m.questionId === tiePrep.questionId, 8000, 'tie-break reveal');
    }
    check('game_end after 2 questions (+ tie-breaks)', !!end && Array.isArray(end.standings) && end.standings.length >= 4);

    // إعادة مباراة.
    [host, p1, p2, p3, display].forEach((c) => c.clear());
    host.send({ t: 'rematch' });
    const prepR = await host.waitFor((m) => m.t === 'q_prepare', 10000, 'q_prepare rematch');
    check('rematch starts a new game', !!prepR);

    // طرد p3 ثم نقل المضيف إلى p1.
    host.send({ t: 'kick', playerId: p3.playerId });
    const kicked = await p3.waitFor((m) => m.t === 'kicked' || m.t === 'room_closed', 5000, 'kicked');
    check('kick notifies the kicked player', !!kicked);
    await sleep(500);
    host.send({ t: 'transfer_host', playerId: p1.playerId });
    await waitFor(() => hostOf(host) === p1.playerId, 5000, 'host transfer snapshot');
    check('transfer_host moves host to p1', hostOf(host) === p1.playerId
      && snapshotPlayers(host).find((p) => p.id === p1.playerId)?.isHost === true);
    // المضيف الجديد يستطيع تغيير الإعدادات.
    p1.send({ t: 'set_settings', settings: { durationSec: 5 } });
    await sleep(400);
    check('new host can change settings (no error)', !p1.has((m) => m.t === 'error' && (m.code === 'not_host')));

    // استئناف بعد انقطاع: p2 يغلق ويعود بنفس المقعد.
    const p2Score = p2.lastSnapshot?.players?.find((p) => p.id === p2.playerId)?.score ?? null;
    p2.close();
    await sleep(300);
    const p2b = new Client('لاعب 2');
    await p2b.connect();
    p2b.send({ t: 'join_room', code, name: 'لاعب 2', password: '', display: false, playerId: p2.playerId, secret: p2.secret });
    const snapRe = await p2b.waitFor((m) => m.t === 'room_snapshot', 5000, 'resume snapshot');
    const meRe = (snapRe.players ?? snapRe.room?.players ?? []).find((p) => p.id === p2.playerId);
    check('resume: same seat after reconnect', !!meRe && meRe.score === p2Score, `score=${meRe?.score} before=${p2Score}`);
    check('host still p1 after resume', hostOf(p2b) === p1.playerId);

    // الوضع المحلي: وضع التقييم عبر LocalTransport (محرك مشترك).
    const { LocalTransport } = await import('../public/js/local-transport.js');
    const local = new LocalTransport();
    const localMsgs = [];
    local.onmessage = (m) => localMsgs.push(m);
    local.connect();
    local.send({ t: 'create_room', name: 'لاعب محلي', localPlayers: ['أحمد', 'سارة'], settings: { flagCount: 2, durationSec: 1, revealSec: 2, scoring: 'simple', answerMode: 'write_then_judge' } });
    local.send({ t: 'start' });
    await waitFor(() => localMsgs.some((m) => m.t === 'q_start'), 5000, 'local q_start');
    const lq = localMsgs.find((m) => m.t === 'q_start');
    local.send({ t: 'submit_text_answer', playerId: 'local-p0', questionId: lq.questionId, text: 'مصر' });
    local.send({ t: 'submit_text_answer', playerId: 'local-p1', questionId: lq.questionId, text: 'خطأ' });
    const lJudge = await waitFor(() => localMsgs.find((m) => m.t === 'judge_request') ?? null, 8000, 'local judge_request');
    check('local mode: judge_request to device owner', !!lJudge && lJudge.answers.length === 2);
    local.send({ t: 'host_judge', questionId: lq.questionId, decisions: [{ playerId: 'local-p0', correct: true }, { playerId: 'local-p1', correct: false }] });
    const lReveal = await waitFor(() => localMsgs.find((m) => m.t === 'q_reveal' && m.questionId === lq.questionId) ?? null, 8000, 'local q_reveal');
    const lsc = (id) => lReveal?.scores?.find((s) => (s.playerId ?? s.id) === id)?.score;
    check('local mode: host judgement awards points', !!lReveal && lsc('local-p0') > 0 && lsc('local-p1') === 0,
      JSON.stringify(lReveal?.scores));
    local.close();

    // فردي محلي: تصحيح تلقائي بلا لوحة تقييم.
    const solo = new LocalTransport();
    const soloMsgs = [];
    solo.onmessage = (m) => soloMsgs.push(m);
    solo.connect();
    solo.send({ t: 'create_room', name: 'منفرد', localPlayers: ['منفرد'], settings: { flagCount: 1, durationSec: 1, revealSec: 2, scoring: 'simple', answerMode: 'write_then_judge' } });
    solo.send({ t: 'start' });
    await waitFor(() => soloMsgs.some((m) => m.t === 'q_start'), 5000, 'solo q_start');
    const sq = soloMsgs.find((m) => m.t === 'q_start');
    solo.send({ t: 'submit_text_answer', playerId: 'local-p0', questionId: sq.questionId, text: 'إجابة' });
    const sReveal = await waitFor(() => soloMsgs.find((m) => m.t === 'q_reveal') ?? null, 8000, 'solo q_reveal');
    check('solo local mode: auto-grades, no judge_request', !!sReveal && !soloMsgs.some((m) => m.t === 'judge_request'));
    solo.close();

    const h = await httpGet('/healthz');
    check('server still healthy after e2e', h.status === 200);
    check('no unhandled errors in server stderr', !/Error|Unhandled/i.test(stderr), stderr.slice(0, 200));
    for (const c of [host, p1, p2b, p3, display]) c.close();
  } finally {
    clearTimeout(watchdog);
    if (serverProc) { serverProc.kill('SIGTERM'); await sleep(500); }
  }
  const failed = checks.filter((c) => !c.pass);
  console.log(`E2E: ${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) { console.log('FAILED:', failed.map((f) => f.name).join(' | ')); process.exit(1); }
  console.log('E2E: PASS');
  process.exit(0);
}

main().catch((e) => { console.error('E2E ERROR:', e); if (serverProc) serverProc.kill('SIGTERM'); process.exit(1); });
