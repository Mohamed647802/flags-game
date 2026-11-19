// smoke.mjs — end-to-end smoke test against a real server instance.
// Spawns `node server/index.js` on PORT=3456, drives 8 WebSocket clients
// through a full 20-question game, tests resume + malformed messages,
// then verifies cleanup via /healthz. Exits non-zero on any failure.
// Overall watchdog: 120s.
//
// Adapted to the real server (read server/index.js, server/rooms.js,
// server/protocol.js first):
// - protocol.validateSettings accepts modes classic|buzzer|turns|race|
//   fixed|sudden|teams|survival|daily|kids|solo, scorings classic|streak|
//   fixed|simple|speed, answerTypes country|capital|continent|mixed|
//   choice, durationSec 0 or 5-60, revealSec 2-5.
// - rooms.js ends a round early (400ms) when the first correct answer
//   arrives in a simple-scoring game, or when every alive player has
//   answered — so 20 questions fit in the 120s budget even at
//   durationSec 15. revealSec 2 (the minimum) is added to the task's
//   settings to keep the total comfortably inside the budget.
// - 'ready' must carry the questionId from q_prepare.
// - 'answer' must carry questionId (validated) and exactly one of
//   choiceIndex/text.
// - playerId/secret for resume arrive in the snapshot's `you` field.
// - a tied game plays up to 3 extra tie-break questions (engine
//   advance), so game_end may arrive after up to 3 extra rounds and
//   total points may reach flagCount + 3.
// - rooms are NOT removed on leave; the sweep closes empty rooms after
//   10 minutes, so /healthz rooms is only asserted to be a number while
//   connections must drop to 0.
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3456;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const FLAG_COUNT = 20;
const MAX_TIEBREAK = 3; // engine advance() plays up to 3 extra flags on a tie
const DURATION_SEC = 15;
const REVEAL_SEC = 2;
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

// --- generic message scanning (server field placement may vary) -------------
function deepFind(obj, pred, seen = new Set()) {
  if (!obj || typeof obj !== 'object' || seen.has(obj)) return null;
  seen.add(obj);
  if (pred(obj)) return obj;
  for (const v of Object.values(obj)) {
    const found = deepFind(v, pred, seen);
    if (found) return found;
  }
  return null;
}

function extractPlayers(msg) {
  if (Array.isArray(msg.players)) return msg.players;
  if (Array.isArray(msg.room?.players)) return msg.room.players;
  if (Array.isArray(msg.roomSnapshot?.players)) return msg.roomSnapshot.players;
  return null;
}

function extractStandings(msg) {
  if (Array.isArray(msg.standings)) return msg.standings;
  if (Array.isArray(msg.game?.standings)) return msg.game.standings;
  if (Array.isArray(msg.result?.standings)) return msg.result.standings;
  if (Array.isArray(msg.finalStandings)) return msg.finalStandings;
  return null;
}

function scoreOf(entry) {
  if (typeof entry?.score === 'number') return entry.score;
  if (typeof entry?.points === 'number') return entry.points;
  return null;
}

function idOf(entry) {
  return entry?.id ?? entry?.playerId ?? null;
}

/** q_start/q_reveal carry questionId like 'q0', 'q1' — parse the 0-based index. */
function questionIndexOf(msg) {
  const qid = msg.questionId ?? msg.question?.id ?? msg.id;
  if (typeof qid === 'string') {
    const m = qid.match(/(\d+)\s*$/);
    if (m) return Number(m[1]);
  }
  return null;
}

// --- test client ---------------------------------------------------------------
class Client {
  constructor(idx) {
    this.idx = idx;
    this.name = idx === 0 ? 'Host' : `P${idx + 1}`;
    this.ws = null;
    this.messages = [];
    this.qStartByIndex = new Map(); // question index -> q_start payload
    this.qRevealSeen = new Set(); // question indices revealed
    this.qRevealCount = 0;
    this.gameEnd = null;
    this.errors = []; // {qIndex, revealCount, msg}
    this.playerId = null;
    this.secret = null;
    this.code = null;
    this.lastScore = null;
    this.lastSnapshot = null;
    this.currentQ = -1; // set by the driver
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(WS_URL);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (data) => {
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return; // non-JSON ignored (server should not send these)
        }
        this.messages.push(msg);
        this.onMessage(msg);
      });
    });
  }

  onMessage(msg) {
    // credentials: wherever the server puts playerId/secret for self
    // (in practice: the room_snapshot `you` field)
    const creds = deepFind(msg, (o) =>
      typeof o.playerId === 'string' && typeof o.secret === 'string');
    if (creds) {
      this.playerId = creds.playerId;
      this.secret = creds.secret;
    }
    if (typeof msg.playerId === 'string' && !this.playerId) this.playerId = msg.playerId;
    if (msg.self?.playerId) {
      this.playerId = msg.self.playerId;
      if (msg.self.secret) this.secret = msg.self.secret;
    }
    if (typeof msg.code === 'string') this.code = msg.code;
    if (typeof msg.room?.code === 'string') this.code = msg.room.code;

    // track own score from any players/standings list
    const players = extractPlayers(msg) ?? extractStandings(msg);
    if (players && this.playerId) {
      const me = players.find((p) => idOf(p) === this.playerId);
      if (me && scoreOf(me) !== null) this.lastScore = scoreOf(me);
    }

    switch (msg.t) {
      case 'room_snapshot':
        this.lastSnapshot = msg;
        break;
      case 'q_prepare':
        // ready requires the questionId (protocol validation)
        this.send({ t: 'ready', questionId: msg.questionId });
        break;
      case 'q_start': {
        const qi = questionIndexOf(msg) ?? this.qStartByIndex.size;
        this.qStartByIndex.set(qi, msg);
        const qid = msg.questionId ?? msg.question?.id ?? msg.id ?? null;
        const payload = { t: 'answer', choiceIndex: (this.idx + qi) % 4 };
        if (qid !== null && qid !== undefined) payload.questionId = qid;
        this.send(payload);
        break;
      }
      case 'q_reveal': {
        const qi = questionIndexOf(msg);
        if (qi !== null) this.qRevealSeen.add(qi);
        this.qRevealCount += 1;
        break;
      }
      case 'game_end':
        this.gameEnd = msg;
        break;
      case 'error':
        this.errors.push({ qIndex: this.currentQ, revealCount: this.qRevealCount, msg });
        break;
      default:
        break;
    }
  }

  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  sendRaw(str) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(str);
  }

  close() {
    try { this.ws?.close(); } catch { /* ignore */ }
  }

  waitFor(pred, timeoutMs, label) {
    return waitFor(() => this.messages.find(pred) ?? null, timeoutMs, label);
  }
}

// --- main ----------------------------------------------------------------------
let serverProc = null;
let serverStderr = '';
let failed = false;

const watchdog = setTimeout(() => {
  console.log('FAIL: overall 120s timeout exceeded');
  failed = true;
  cleanup(1);
}, OVERALL_TIMEOUT_MS);

async function cleanup(exitCode) {
  clearTimeout(watchdog);
  if (serverProc && !serverProc.killed) {
    serverProc.kill('SIGTERM');
    await Promise.race([new Promise((r) => serverProc.on('exit', r)), sleep(5000)]);
    if (!serverProc.killed) serverProc.kill('SIGKILL');
  }
  const fails = checks.filter((c) => !c.pass).length;
  if (fails > 0 || failed) {
    console.log(`SMOKE: FAIL (${fails} check${fails === 1 ? '' : 's'} failed)`);
    process.exit(1);
  }
  console.log('SMOKE: PASS');
  process.exit(exitCode ?? 0);
}

async function main() {
  // 1. spawn server
  serverProc = spawn('node', ['server/index.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stderr.on('data', (d) => { serverStderr += d.toString(); });
  serverProc.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      console.log(`server exited early with code ${code} signal ${signal}\nstderr: ${serverStderr}`);
    }
  });

  // 2. wait for /healthz
  let health = null;
  try {
    health = await waitFor(async () => {
      try {
        const res = await fetch(`${BASE}/healthz`);
        if (res.status === 200) return await res.json();
      } catch { /* not up yet */ }
      return null;
    }, 10_000, '/healthz 200');
  } catch (err) {
    check('server starts and /healthz returns 200', false, err.message);
    return cleanup(1);
  }
  check('server starts and /healthz returns 200', true);
  check('healthz status ok', health.status === 'ok', JSON.stringify(health));
  check('healthz reports rooms/connections numbers',
    typeof health.rooms === 'number' && typeof health.connections === 'number',
    JSON.stringify(health));

  // 3. connect 8 clients, hello -> welcome
  const clients = Array.from({ length: 8 }, (_, i) => new Client(i));
  for (const c of clients) await c.connect();
  check('8 clients connect', true);
  for (const c of clients) c.send({ t: 'hello' });
  for (const c of clients) {
    try {
      await c.waitFor((m) => m.t === 'welcome', 5000, `welcome for client ${c.idx}`);
    } catch {
      check(`client ${c.idx} receives welcome`, false, 'no welcome within 5s');
    }
  }
  check('all clients receive welcome', clients.every((c) => c.messages.some((m) => m.t === 'welcome')));

  // 4. host creates room; others join
  // Task settings, plus revealSec 2 (minimum) to stay inside the 120s
  // budget: first correct answer in a simple-scoring game ends the round
  // after 400ms (rooms.js scheduleEarlyReveal).
  const host = clients[0];
  host.send({
    t: 'create_room',
    name: 'Host',
    settings: { flagCount: FLAG_COUNT, mode: 'fixed', scoring: 'simple', durationSec: DURATION_SEC, answerType: 'choice', revealSec: REVEAL_SEC },
  });
  let roomCode;
  try {
    const snap = await host.waitFor((m) => m.t === 'room_snapshot', 5000, 'room_snapshot after create_room');
    roomCode = snap.room?.code ?? snap.code ?? host.code;
  } catch {
    check('host creates room and gets room_snapshot', false, 'no room_snapshot');
    return cleanup(1);
  }
  check('host creates room and gets room_snapshot', true, `code=${roomCode}`);
  check('room code format', /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test(roomCode ?? ''), `code=${roomCode}`);

  for (const c of clients.slice(1)) {
    c.send({ t: 'join_room', code: roomCode, name: c.name });
  }
  try {
    await waitFor(() => {
      const players = host.lastSnapshot ? extractPlayers(host.lastSnapshot) : null;
      return players && players.length === 8 ? players : null;
    }, 10_000, 'room_snapshot with 8 players');
    check('all 7 others join (8 players in snapshot)', true);
  } catch {
    check('all 7 others join (8 players in snapshot)', false,
      `host last snapshot players: ${JSON.stringify(host.lastSnapshot && extractPlayers(host.lastSnapshot))}`);
  }
  check('every client received room_snapshot',
    clients.every((c) => c.messages.some((m) => m.t === 'room_snapshot')));

  // every client knows its own playerId + secret (needed for resume)
  const missingIds = clients.filter((c) => !c.playerId);
  check('every client received its playerId',
    missingIds.length === 0,
    missingIds.length ? `missing for clients ${missingIds.map((c) => c.idx).join(',')}` : '');
  const missingSecrets = clients.filter((c) => !c.secret);
  check('every client received its resume secret',
    missingSecrets.length === 0,
    missingSecrets.length ? `missing for clients ${missingSecrets.map((c) => c.idx).join(',')}` : '');

  // 5. host starts; play 20 questions
  host.send({ t: 'start' });
  let showAtConsistent = true;
  let durationConsistent = true;
  let revealsOk = true;
  let resumeDone = false;

  for (let q = 0; q < FLAG_COUNT; q++) {
    for (const c of clients) c.currentQ = q;
    try {
      await waitFor(() => clients.every((c) => c.qStartByIndex.has(q)), 25_000, `q_start #${q} on all clients`);
    } catch {
      check(`question ${q + 1}: q_start reaches all clients`, false,
        `seen: ${clients.map((c) => [...c.qStartByIndex.keys()].join('/') || '-').join(', ')}`);
      revealsOk = false;
      break;
    }
    // showAt identical across clients; endsAt - showAt === duration
    const showAts = clients.map((c) => c.qStartByIndex.get(q)?.showAt);
    const endsAts = clients.map((c) => c.qStartByIndex.get(q)?.endsAt);
    if (new Set(showAts).size !== 1) {
      showAtConsistent = false;
      console.log(`  note: q${q + 1} showAt differs across clients: ${JSON.stringify(showAts)}`);
    }
    for (let i = 0; i < clients.length; i++) {
      if (typeof showAts[i] === 'number' && typeof endsAts[i] === 'number') {
        if (endsAts[i] - showAts[i] !== DURATION_SEC * 1000) durationConsistent = false;
      }
    }
    try {
      await waitFor(() => clients.every((c) => c.qRevealSeen.has(q)), 25_000, `q_reveal #${q} on all clients`);
    } catch {
      check(`question ${q + 1}: q_reveal reaches all clients`, false,
        `reveal counts: ${clients.map((c) => c.qRevealCount).join(',')}`);
      revealsOk = false;
      break;
    }

    // mid-game disconnect + resume for client 3 (index 2) after question 5
    if (q === 4 && !resumeDone) {
      resumeDone = true;
      const c3 = clients[2];
      const oldId = c3.playerId;
      const oldSecret = c3.secret;
      const scoreBefore = c3.lastScore;
      const oldErrors = [...c3.errors];
      c3.close();
      await sleep(300);
      const c3b = new Client(2);
      c3b.errors = oldErrors; // keep pre-disconnect errors for the final check
      clients[2] = c3b;
      c3b.currentQ = q;
      await c3b.connect();
      c3b.send({ t: 'hello' });
      c3b.send({ t: 'resume', playerId: oldId, secret: oldSecret, code: roomCode });
      try {
        const snap = await c3b.waitFor((m) => m.t === 'room_snapshot', 5000, 'room_snapshot after resume');
        const players = extractPlayers(snap) ?? [];
        const me = players.find((p) => idOf(p) === oldId);
        check('resume: reconnected client receives room_snapshot', true);
        check('resume: same seat (same playerId)', !!me, `players: ${JSON.stringify(players.map(idOf))}`);
        check('resume: playerId preserved', c3b.playerId === oldId || !!me,
          `old=${oldId} new=${c3b.playerId}`);
        if (scoreBefore !== null && me && scoreOf(me) !== null) {
          check('resume: score preserved', scoreOf(me) === scoreBefore,
            `before=${scoreBefore} after=${scoreOf(me)}`);
        } else {
          console.log('  note: score before disconnect unknown from server messages; score-preserved check skipped');
        }
      } catch (err) {
        check('resume: reconnected client receives room_snapshot', false, err.message);
      }
    }
  }
  check('all 20 questions: q_start reaches every client', revealsOk);
  check('q_start showAt identical across all clients (per question)', showAtConsistent);
  check(`q_start endsAt - showAt === duration (${DURATION_SEC * 1000}ms)`, durationConsistent);
  check('all 20 questions: q_reveal reaches every client', revealsOk);

  // 6. game_end on all clients; standings identical; points consistent
  // A tied game may play up to 3 extra tie-break questions after the 20th,
  // so allow up to 30s for game_end.
  try {
    await waitFor(() => clients.every((c) => c.gameEnd), 30_000, 'game_end on all clients');
    check('game_end reaches all clients', true);
  } catch {
    check('game_end reaches all clients', false,
      `received by: ${clients.map((c) => (c.gameEnd ? 1 : 0)).join(',')}`);
  }
  const extraQuestions = Math.max(0, ...clients.map((c) => c.qStartByIndex.size)) - FLAG_COUNT;
  console.log(`  note: extra (tie-break) questions played: ${extraQuestions}`);
  const standingsList = clients.map((c) => (c.gameEnd ? extractStandings(c.gameEnd) : null));
  const allHaveStandings = standingsList.every((s) => Array.isArray(s) && s.length === 8);
  check('game_end includes standings for all 8 players', allHaveStandings,
    standingsList.map((s) => (s ? s.length : 'none')).join(','));
  if (allHaveStandings) {
    const first = JSON.stringify(standingsList[0]);
    check('standings identical across all clients',
      standingsList.every((s) => JSON.stringify(s) === first));
    const total = standingsList[0].reduce((sum, p) => sum + (scoreOf(p) ?? 0), 0);
    check(`total points across players <= ${FLAG_COUNT + MAX_TIEBREAK} (at most 1 per round + tie-breaks)`,
      total <= FLAG_COUNT + MAX_TIEBREAK, `total=${total}`);
    check(`no player score exceeds ${FLAG_COUNT + MAX_TIEBREAK}`,
      standingsList[0].every((p) => (scoreOf(p) ?? 0) <= FLAG_COUNT + MAX_TIEBREAK));
  }

  // no suspicious errors during the game (errors before the round's reveal)
  const suspicious = clients.flatMap((c) =>
    c.errors.filter((e) => e.revealCount <= e.qIndex).map((e) => ({ client: c.idx, ...e })));
  check('no errors during the game (before each round reveal)',
    suspicious.length === 0,
    suspicious.length ? JSON.stringify(suspicious.slice(0, 3)) : '');

  // 7. malformed messages: server must reply error and stay alive
  const malformedClient = clients[0];
  const errorsBefore = malformedClient.messages.filter((m) => m.t === 'error').length;
  malformedClient.sendRaw('{bad json');
  malformedClient.send({ t: 'answer' });
  malformedClient.send({ t: 'nonsense' });
  await sleep(1500);
  const newErrors = malformedClient.messages.filter((m) => m.t === 'error').slice(errorsBefore);
  check('malformed messages get error replies',
    newErrors.length >= 2, `error replies: ${newErrors.length} (${JSON.stringify(newErrors.slice(0, 2))})`);
  malformedClient.send({ t: 'ping', c: 123 });
  try {
    const pong = await malformedClient.waitFor(
      (m) => m.t === 'pong' && (m.c === 123 || m.c === '123'), 5000, 'pong after malformed');
    check('server stays alive: ping still gets pong', true, JSON.stringify(pong));
  } catch {
    check('server stays alive: ping still gets pong', false, 'no pong within 5s');
  }

  // 8. leave all, close, verify cleanup via /healthz
  // NOTE: empty rooms are only swept after 10 min idle (rooms.js sweep),
  // so rooms is asserted to be a number, not 0; connections must drop to 0.
  for (const c of clients) {
    c.send({ t: 'leave' });
    c.close();
  }
  await sleep(2000);
  try {
    const res = await fetch(`${BASE}/healthz`);
    const h2 = await res.json();
    check('connections drop to 0 after all clients leave',
      h2.connections === 0, `connections=${h2.connections}`);
    check('healthz still reports rooms as a number after leave',
      typeof h2.rooms === 'number', `rooms=${h2.rooms} (empty rooms are swept after 10 min)`);
    check('server still healthy after game + malformed input', h2.status === 'ok');
  } catch (err) {
    check('healthz after game', false, err.message);
  }

  // 9. no unhandled errors in server stderr
  const badStderr = /Unhandled|uncaughtException|UnhandledPromiseRejection/i.test(serverStderr);
  check('no unhandled errors in server stderr', !badStderr,
    badStderr ? serverStderr.slice(0, 500) : '');

  await cleanup(0);
}

main().catch(async (err) => {
  console.log(`FAIL: smoke crashed: ${err.stack || err}`);
  failed = true;
  await cleanup(1);
});
