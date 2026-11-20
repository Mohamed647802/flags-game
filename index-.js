// server/index.js — HTTP + WebSocket server for the "أعلام الدول" flags game.
// Static files from public/; flags only via opaque /f/<token> URLs; WS at /ws.
// No framework: node:http + ws. JSON logs only, no personal data.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { RoomManager, clientStandings, clientGameStats, clientBadges } from './rooms.js';
import { validateClientMessage, MAX_MESSAGE_BYTES } from './protocol.js';
import { RateLimiter, getClientIp } from './ratelimit.js';
import * as flagsStore from './flags-store.js';
import { serializePublic } from '../shared/engine.js';
import { COUNTRIES } from '../shared/countries.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../public');

const VERSION = '1.0.0';
const PORT = Number.parseInt(process.env.PORT ?? '3000', 10) || 3000;
const NODE_ENV = process.env.NODE_ENV ?? 'development';
const MAX_ROOMS = Number.parseInt(process.env.MAX_ROOMS ?? '500', 10) || 500;
const LOG_LEVEL = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const REACT_COOLDOWN_MS = 1500;

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
function log(level, msg, meta = {}) {
  if ((LEVELS[level] ?? 2) > (LEVELS[LOG_LEVEL] ?? 2)) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta });
  if (level === 'error') console.error(line);
  else console.log(line);
}

// Daily seed: prefer shared/rng.js hashSeed when it exists, else FNV-1a.
let hashSeedFn = (input) => {
  let h = 0x811c9dc5;
  const s = String(input);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
};
try {
  const rng = await import('../shared/rng.js');
  if (typeof rng.hashSeed === 'function') hashSeedFn = rng.hashSeed;
} catch {
  log('warn', 'shared_rng_missing_using_fallback', {});
}

const flagsLoaded = flagsStore.loadFlags();
log('info', 'flags_loaded', { count: flagsLoaded.size });

// ------------------------------------------------------------------ helpers

function setSecurityHeaders(res) {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
    + "connect-src 'self' ws: wss:; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), notifications=()');
  res.setHeader('X-Frame-Options', 'DENY');
  // HSTS intentionally skipped: this server is plain HTTP unless behind TLS.
}

function sendJsonHttp(res, status, obj, cacheControl) {
  setSecurityHeaders(res);
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...(cacheControl ? { 'Cache-Control': cacheControl } : {}),
  });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const STATIC_FILES = new Set([
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/net.js',
  'js/timesync.js',
  'js/audio.js',
  'js/local-transport.js',
  'js/i18n-ar.js',
]);

function isStaticAllowed(rel) {
  if (STATIC_FILES.has(rel)) return true;
  return /^js\/ui\/[A-Za-z0-9][A-Za-z0-9._-]*\.js$/.test(rel);
}

function maybeGzip(req, body, contentType) {
  const ae = req.headers['accept-encoding'] || '';
  const compressible = /^(text\/|application\/javascript|image\/svg\+xml)/.test(contentType);
  if (ae.includes('gzip') && compressible && body.length > 0) {
    return { body: zlib.gzipSync(body), encoding: 'gzip' };
  }
  return { body, encoding: null };
}

// ------------------------------------------------------------------ WS plumbing

const limiter = new RateLimiter();
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

function sendJson(ws, obj) {
  if (!ws || ws.readyState !== 1) return false;
  const conn = ws._conn;
  const out = conn ? { ...obj, seq: ++conn.seq } : { ...obj };
  try {
    ws.send(JSON.stringify(out));
    return true;
  } catch {
    return false;
  }
}

function sendError(ws, code, message) {
  sendJson(ws, { t: 'error', code, message });
}

/**
 * The web client picks up its identity from a `welcome` message
 * (playerId/secret/name at the top level), then persists it for resume.
 */
function sendWelcome(ws, conn, player = null) {
  sendJson(ws, {
    t: 'welcome',
    version: VERSION,
    serverNow: Date.now(),
    playerId: player?.id ?? conn.playerId ?? null,
    secret: player?.secret ?? conn.secret ?? null,
    name: player?.name ?? null,
  });
}

function safeSerialize(game, forPlayerId) {
  try {
    return serializePublic(game, forPlayerId ?? null);
  } catch {
    return null;
  }
}

/**
 * The web client reads phase values 'lobby' | 'playing' | 'reveal' |
 * 'paused' | 'ended' (see normalizeSnapshot in public/js/app.js), while the
 * engine uses 'countdown' | 'question'. Map them here, at the top level of
 * the snapshot and inside room, so both agree.
 */
function clientPhase(room) {
  if (!room.game) return 'lobby';
  if (room.game.phase === 'ended') return 'ended';
  if (room.game.paused) return 'paused';
  if (room.game.phase === 'lobby') return 'lobby';
  if (room.game.phase === 'reveal') return 'reveal';
  return 'playing'; // countdown, question
}

/**
 * Strip options from the public snapshot for typing questions: the client
 * shows a text input and the options would only leak the choices.
 * (serializePublic already hides the answer before reveal.)
 */
function sanitizePublicGame(pub) {
  if (!pub?.current?.question) return pub;
  if (pub.settings?.answerMode === 'typing' && (pub.phase === 'question' || pub.phase === 'countdown')) {
    return {
      ...pub,
      current: {
        ...pub.current,
        question: { ...pub.current.question, options: [] },
      },
    };
  }
  return pub;
}

function buildSnapshot(room, forPlayerId = null, extra = {}) {
  const phase = clientPhase(room);
  const players = [...room.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    color: p.color,
    score: p.score ?? 0,
    connected: p.connected,
    role: p.role,
    team: p.team ?? null,
    alive: p.alive ?? true,
    isHost: p.id === room.hostId,
  }));
  const snap = {
    t: 'room_snapshot',
    phase,
    players,
    settings: room.settings,
    code: room.code,
    hostId: room.hostId,
    room: {
      code: room.code,
      number: room.number,
      settings: room.settings,
      phase,
      players,
      hostId: room.hostId,
    },
    game: room.game ? sanitizePublicGame(safeSerialize(room.game, forPlayerId)) : null,
    serverNow: Date.now(),
    ...extra,
  };
  if (room.game?.phase === 'ended') {
    snap.standings = clientStandings(room.game);
    snap.stats = clientGameStats(room.game);
    snap.badges = clientBadges(room.game, room.game.summary?.badges ?? []);
  }
  return snap;
}

function broadcastToRoom(room, msg, exceptPlayerId = null) {
  for (const p of room.players.values()) {
    const s = p.socket;
    if (s && s.readyState === 1 && p.id !== exceptPlayerId) sendJson(s, msg);
  }
}

function sendToPlayer(room, playerId, msg) {
  const p = room.players.get(playerId);
  if (p?.socket?.readyState === 1) sendJson(p.socket, msg);
}

const roomManager = new RoomManager({
  maxRooms: MAX_ROOMS,
  flags: flagsStore,
  hooks: {
    broadcast: broadcastToRoom,
    sendTo: sendToPlayer,
    snapshot: (room, forPlayerId) => buildSnapshot(room, forPlayerId),
  },
  onEvent: (room, type) => {
    log('debug', 'room_event', { type, rooms: roomManager.roomCount() });
  },
});

// ------------------------------------------------------------------ HTTP

async function handleRequest(req, res) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;

  if (req.method !== 'GET') {
    return sendJsonHttp(res, 405, { error: 'method_not_allowed' });
  }

  if (pathname === '/healthz') {
    return sendJsonHttp(res, 200, {
      status: 'ok',
      version: VERSION,
      rooms: roomManager.roomCount(),
      connections: wss.clients.size,
      uptimeSec: Math.floor(process.uptime()),
      countries: Array.isArray(COUNTRIES) ? COUNTRIES.length : 0,
    }, 'no-cache');
  }

  if (pathname === '/api/daily') {
    const date = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
    const seed = (hashSeedFn(date) >>> 0);
    return sendJsonHttp(res, 200, { date, seed }, 'no-cache');
  }

  if (pathname.startsWith('/f/')) {
    const token = pathname.slice(3);
    if (!/^[0-9a-f]{32}$/.test(token)) {
      return sendJsonHttp(res, 404, { error: 'not_found' });
    }
    const rec = roomManager.lookupFlagToken(token);
    if (!rec) return sendJsonHttp(res, 404, { error: 'not_found' });
    const svg = flagsStore.getFlag(rec.code);
    if (!svg) return sendJsonHttp(res, 404, { error: 'not_found' });
    setSecurityHeaders(res);
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    const { body, encoding } = maybeGzip(req, svg, 'image/svg+xml');
    if (encoding) res.setHeader('Content-Encoding', encoding);
    res.setHeader('Vary', 'Accept-Encoding');
    res.writeHead(200);
    return res.end(body);
  }

  // Flags are never served directly — only through opaque /f/ tokens.
  if (pathname.startsWith('/flags/')) {
    return sendJsonHttp(res, 404, { error: 'not_found' });
  }

  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (!isStaticAllowed(rel)) {
    return sendJsonHttp(res, 404, { error: 'not_found' });
  }
  const filePath = path.resolve(PUBLIC_DIR, rel);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJsonHttp(res, 404, { error: 'not_found' });
  }
  let data;
  try {
    data = await readFile(filePath);
  } catch {
    return sendJsonHttp(res, 404, { error: 'not_found' });
  }
  const ext = path.extname(filePath);
  const contentType = MIME[ext] ?? 'application/octet-stream';
  setSecurityHeaders(res);
  res.setHeader('Content-Type', contentType);
  // index.html is never cached; js/css are unhashed so revalidate hourly.
  res.setHeader('Cache-Control', ext === '.html' ? 'no-cache' : 'public, max-age=3600, must-revalidate');
  const { body, encoding } = maybeGzip(req, data, contentType);
  if (encoding) res.setHeader('Content-Encoding', encoding);
  res.setHeader('Vary', 'Accept-Encoding');
  res.writeHead(200);
  return res.end(body);
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((e) => {
    log('error', 'http_handler_failed', { error: String(e?.message || e) });
    if (!res.headersSent) sendJsonHttp(res, 500, { error: 'server_error' });
    else {
      try { res.end(); } catch { /* ignore */ }
    }
  });
});

// ------------------------------------------------------------------ WS upgrade

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const reqHost = req.headers.host ?? '';
  if (originHost === reqHost) return true;
  return ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes(originHost);
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  if (!originAllowed(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  const ip = getClientIp(req);
  if (!limiter.acquireConn(ip)) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, ip);
  });
});

// Heartbeat: server ping every 20s; terminate after 2 missed pongs.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    const conn = ws._conn;
    if (!conn) continue;
    if (!conn.isAlive) {
      conn.missedPongs += 1;
      if (conn.missedPongs >= 2) {
        try { ws.terminate(); } catch { /* ignore */ }
        continue;
      }
    } else {
      conn.missedPongs = 0;
    }
    conn.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 20_000);
heartbeat.unref();

// ------------------------------------------------------------------ WS messages

function currentRoom(conn) {
  if (!conn.roomCode) return null;
  return roomManager.getRoomByCode(conn.roomCode);
}

function requireRoom(ws, conn) {
  const room = currentRoom(conn);
  if (!room) sendError(ws, 'not_in_room', 'أنت لست داخل غرفة');
  return room;
}

function attachPlayer(ws, conn, room, player) {
  player.socket = ws;
  conn.playerId = player.id;
  conn.secret = player.secret;
  conn.roomCode = room.code;
  roomManager.playerConnected(room, player.id);
}

function detachConn(conn) {
  conn.playerId = null;
  conn.secret = null;
  conn.roomCode = null;
}

function handleMessage(ws, conn, msg) {
  switch (msg.t) {
    case 'hello': {
      sendWelcome(ws, conn);
      return;
    }
    case 'ping': {
      sendJson(ws, { t: 'pong', c: msg.c ?? null, s: Date.now() });
      return;
    }
    case 'create_room': {
      if (!limiter.recordRoom(conn.ip)) {
        return sendError(ws, 'too_many_rooms', 'أنشأت غرفاً كثيرة، انتظر دقيقة وحاول مجدداً');
      }
      let created;
      try {
        created = roomManager.createRoom({
          hostPlayer: { name: msg.name },
          settings: msg.settings ?? {},
          password: msg.password,
        });
      } catch (e) {
        return sendError(ws, e.code || 'create_failed', e.message || 'تعذر إنشاء الغرفة');
      }
      attachPlayer(ws, conn, created.room, created.player);
      sendWelcome(ws, conn, created.player);
      sendJson(ws, buildSnapshot(created.room, created.player.id, {
        you: { playerId: created.player.id, secret: created.player.secret },
      }));
      return;
    }
    case 'join_room': {
      if (!limiter.recordJoin(conn.ip)) {
        return sendError(ws, 'too_many_joins', 'محاولات انضمام كثيرة، انتظر قليلاً');
      }
      let res;
      try {
        res = roomManager.joinRoom(msg.code, {
          name: msg.name,
          password: msg.password,
          playerId: msg.playerId,
          secret: msg.secret,
          asSpectator: !!msg.asSpectator || msg.display === true,
          display: msg.display,
        });
      } catch (e) {
        return sendError(ws, e.code || 'join_failed', e.message || 'تعذر الانضمام');
      }
      attachPlayer(ws, conn, res.room, res.player);
      sendWelcome(ws, conn, res.player);
      sendJson(ws, buildSnapshot(res.room, res.player.id, {
        you: { playerId: res.player.id, secret: res.player.secret },
        resumed: !!res.resumed,
      }));
      broadcastToRoom(res.room, buildSnapshot(res.room), res.player.id);
      return;
    }
    case 'resume': {
      let res;
      try {
        res = roomManager.joinRoom(msg.code, { name: '', playerId: msg.playerId, secret: msg.secret });
      } catch (e) {
        return sendError(ws, e.code || 'resume_failed', e.message || 'تعذر استئناف الجلسة');
      }
      if (!res.resumed) {
        return sendError(ws, 'resume_expired', 'انتهت مهلة الاستئناف، انضم من جديد');
      }
      attachPlayer(ws, conn, res.room, res.player);
      sendWelcome(ws, conn, res.player);
      sendJson(ws, buildSnapshot(res.room, res.player.id, {
        you: { playerId: res.player.id, secret: res.player.secret },
        resumed: true,
      }));
      broadcastToRoom(res.room, buildSnapshot(res.room), res.player.id);
      return;
    }
    case 'leave': {
      const room = requireRoom(ws, conn);
      if (!room) return;
      const pid = conn.playerId;
      roomManager.leaveRoom(room, pid);
      detachConn(conn);
      sendJson(ws, { t: 'left', code: room.code });
      broadcastToRoom(room, buildSnapshot(room));
      return;
    }
    case 'set_settings': {
      const room = requireRoom(ws, conn);
      if (!room) return;
      try {
        const r = roomManager.setSettings(room, msg.settings, conn.playerId);
        broadcastToRoom(room, buildSnapshot(room));
        if (r.note) sendJson(ws, { t: 'notice', message: r.note });
      } catch (e) {
        sendError(ws, e.code || 'invalid_settings', e.message || 'الإعدادات غير صالحة');
      }
      return;
    }
    case 'set_team': {
      const room = requireRoom(ws, conn);
      if (!room) return;
      const player = room.players.get(conn.playerId);
      if (!player) return sendError(ws, 'not_in_room', 'أنت لست داخل غرفة');
      player.team = msg.team ?? null;
      const gp = room.game?.players?.find((x) => x.id === player.id);
      if (gp) gp.team = player.team;
      roomManager.touch(room);
      broadcastToRoom(room, buildSnapshot(room));
      return;
    }
    case 'kick': {
      const room = requireRoom(ws, conn);
      if (!room) return;
      try {
        const kicked = roomManager.kick(room, msg.playerId, conn.playerId);
        const s = kicked.socket;
        if (s && s.readyState === 1) {
          sendJson(s, { t: 'kicked', message: 'تم طردك من الغرفة' });
          try { s.close(1000, 'kicked'); } catch { /* ignore */ }
        }
        broadcastToRoom(room, buildSnapshot(room));
      } catch (e) {
        sendError(ws, e.code || 'kick_failed', e.message || 'تعذر الطرد');
      }
      return;
    }
    case 'transfer_host': {
      const room = requireRoom(ws, conn);
      if (!room) return;
      try {
        roomManager.transferHost(room, msg.playerId, conn.playerId);
        broadcastToRoom(room, buildSnapshot(room));
      } catch (e) {
        sendError(ws, e.code || 'transfer_failed', e.message || 'تعذر نقل الاستضافة');
      }
      return;
    }
    case 'start': {
      const room = requireRoom(ws, conn);
      if (!room) return;
      try {
        roomManager.startGame(room, Date.now(), conn.playerId);
        broadcastToRoom(room, buildSnapshot(room));
      } catch (e) {
        sendError(ws, e.code || 'start_failed', e.message || 'تعذر بدء اللعبة');
      }
      return;
    }
    case 'ready': {
      const room = requireRoom(ws, conn);
      if (!room) return;
      roomManager.markReady(room, conn.playerId, msg.questionId);
      return;
    }
    case 'answer': {
      const room = requireRoom(ws, conn);
      if (!room) return;
      const ack = roomManager.submitAnswer(room, conn.playerId, {
        choiceIndex: msg.choiceIndex,
        text: msg.text,
        questionId: msg.questionId,
      }, Date.now());
      sendJson(ws, { t: 'answer_ack', questionId: msg.questionId, ...ack });
      return;
    }
    case 'submit_text_answer': {
      const room = requireRoom(ws, conn);
      if (!room) return;
      // نص فقط: لا choiceIndex في وضع التقييم اليدوي.
      const ack = roomManager.submitAnswer(room, conn.playerId, {
        text: msg.text,
        questionId: msg.questionId,
      }, Date.now());
      sendJson(ws, { t: 'answer_ack', questionId: msg.questionId, ...ack });
      return;
    }
    case 'host_judge':
    case 'judge_answers': {
      const room = requireRoom(ws, conn);
      if (!room) return;
      try {
        roomManager.applyHostJudgement(room, conn.playerId, msg.decisions, msg.questionId);
      } catch (e) {
        sendError(ws, e.code || 'judge_failed', e.message || 'تعذر التقييم');
      }
      return;
    }
    case 'skip_vote': {
      const room = requireRoom(ws, conn);
      if (!room) return;
      roomManager.skipVote(room, conn.playerId);
      return;
    }
    case 'pause': {
      const room = requireRoom(ws, conn);
      if (!room) return;
      try {
        roomManager.pauseGame(room, conn.playerId);
      } catch (e) {
        sendError(ws, e.code || 'pause_failed', e.message || 'تعذر الإيقاف');
      }
      return;
    }
    case 'resume_game': {
      const room = requireRoom(ws, conn);
      if (!room) return;
      try {
        roomManager.resumeGame(room, conn.playerId);
      } catch (e) {
        sendError(ws, e.code || 'resume_failed', e.message || 'تعذر الاستئناف');
      }
      return;
    }
    case 'skip_flag': {
      const room = requireRoom(ws, conn);
      if (!room) return;
      try {
        roomManager.skipFlag(room, conn.playerId);
      } catch (e) {
        sendError(ws, e.code || 'skip_failed', e.message || 'تعذر التخطي');
      }
      return;
    }
    case 'rematch': {
      const room = requireRoom(ws, conn);
      if (!room) return;
      try {
        roomManager.rematch(room, conn.playerId);
        broadcastToRoom(room, buildSnapshot(room));
      } catch (e) {
        sendError(ws, e.code || 'rematch_failed', e.message || 'تعذر إعادة المباراة');
      }
      return;
    }
    case 'replay_missed': {
      const room = requireRoom(ws, conn);
      if (!room) return;
      const r = roomManager.replayMissed(room, conn.playerId);
      if (!r.ok) {
        sendError(ws, r.reason || 'replay_failed', r.message || 'تعذر إعادة الفائتة');
        return;
      }
      broadcastToRoom(room, buildSnapshot(room));
      return;
    }
    case 'react': {
      const now = Date.now();
      if (now - conn.lastReactAt < REACT_COOLDOWN_MS) return;
      conn.lastReactAt = now;
      const room = requireRoom(ws, conn);
      if (!room) return;
      broadcastToRoom(room, { t: 'reaction', playerId: conn.playerId, emoji: msg.emoji });
      return;
    }
    default: {
      sendError(ws, 'unknown_type', 'نوع الرسالة غير معروف');
    }
  }
}

function onMessage(ws, conn, data) {
  let raw;
  if (Buffer.isBuffer(data)) raw = data.toString('utf8');
  else if (typeof data === 'string') raw = data;
  else raw = String(data ?? '');
  if (Buffer.byteLength(raw, 'utf8') > MAX_MESSAGE_BYTES) {
    sendError(ws, 'too_large', 'الرسالة كبيرة جداً');
    return;
  }
  if (!limiter.checkConn(conn.id)) {
    conn.violations.push(Date.now());
    conn.violations = conn.violations.filter((t) => Date.now() - t < 10_000);
    if (conn.violations.length >= 5) {
      try { ws.close(1008, 'rate_limited'); } catch { /* ignore */ }
    }
    return;
  }
  const v = validateClientMessage(raw);
  if (!v.ok) {
    sendError(ws, v.code, v.message);
    return;
  }
  try {
    handleMessage(ws, conn, v.msg);
  } catch (e) {
    log('error', 'handle_message_failed', { t: v.msg.t, error: String(e?.message || e) });
    sendError(ws, 'server_error', 'حدث خطأ، حاول مجدداً');
  }
}

function onClose(ws, conn) {
  limiter.releaseConn(conn.ip);
  if (conn.id) limiter.removeConn(conn.id);
  if (conn.roomCode && conn.playerId) {
    const room = roomManager.getRoomByCode(conn.roomCode);
    if (room) {
      const was = roomManager.disconnectPlayer(room, conn.playerId);
      if (was) broadcastToRoom(room, buildSnapshot(room));
    }
  }
}

wss.on('connection', (ws, req, ip) => {
  const conn = {
    id: crypto.randomUUID(),
    ip,
    seq: 0,
    playerId: null,
    secret: null,
    roomCode: null,
    isAlive: true,
    missedPongs: 0,
    violations: [],
    lastReactAt: 0,
  };
  ws._conn = conn;
  ws.on('pong', () => {
    conn.isAlive = true;
    conn.missedPongs = 0;
  });
  ws.on('message', (data) => onMessage(ws, conn, data));
  ws.on('close', () => onClose(ws, conn));
  ws.on('error', () => { /* close follows */ });
});

// ------------------------------------------------------------------ shutdown

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'shutdown_started', { signal });
  for (const ws of wss.clients) {
    sendJson(ws, { t: 'error', code: 'server_shutdown', message: 'السيرفر يتوقف، شكراً للعبكم!' });
  }
  setTimeout(() => {
    for (const ws of wss.clients) {
      try { ws.close(1001, 'shutdown'); } catch { /* ignore */ }
    }
    try { wss.close(() => {}); } catch { /* ignore */ }
    server.close(() => {
      clearInterval(heartbeat);
      roomManager.destroy();
      log('info', 'shutdown_complete', {});
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  }, 200);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  log('error', 'uncaught_exception', { error: String(err?.message || err) });
});
process.on('unhandledRejection', (reason) => {
  log('error', 'unhandled_rejection', { error: String(reason?.message || reason) });
});

// ------------------------------------------------------------------ listen

server.listen(PORT, '0.0.0.0', () => {
  log('info', 'server_started', { port: PORT, env: NODE_ENV, flags: flagsStore.flagCount() });
});
