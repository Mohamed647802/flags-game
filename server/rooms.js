// server/rooms.js — room lifecycle + game flow orchestration on top of shared/engine.js.
// Broadcasting is done through the `hooks` object supplied by index.js:
//   hooks.broadcast(room, msg, exceptPlayerId?) — send to every socket in the room
//   hooks.sendTo(room, playerId, msg)           — send to one player
//   hooks.snapshot(room, forPlayerId?)          — build a room_snapshot message
// All timers live in room.timers and are cleared when the room closes.
import crypto from 'node:crypto';
import {
  DEFAULT_SETTINGS,
  createGame,
  startGame as engineStartGame,
  beginQuestion as engineBeginQuestion,
  submitAnswer as engineSubmitAnswer,
  timeoutQuestion as engineTimeoutQuestion,
  reveal as engineReveal,
  advance as engineAdvance,
  endGame as engineEndGame,
  pauseGame as enginePauseGame,
  resumeGame as engineResumeGame,
  applySkipVote as engineApplySkipVote,
  skipCurrent as engineSkipCurrent,
  serializePublic,
  getStandings,
} from '../shared/engine.js';
import { COUNTRIES, CONTINENTS, byCode } from '../shared/countries.js';
import { validateSettings as validateSettingsRanges } from './protocol.js';

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ANSWER_GRACE_MS = 250;
export const RESUME_WINDOW_MS = 90_000;
export const SOLO_END_DELAY_MS = 60_000;
export const READY_TIMEOUT_MS = 2000;
export const Q_START_DELAY_MS = 600;
export const COUNTDOWN_MS = 3000;
export const SIMPLE_REVEAL_DELAY_MS = 400;
export const MAX_PLAYERS = 8;
export const MAX_SPECTATORS = 10;

const AVATARS = ['🦊', '🦁', '🐼', '🦉', '🐸', '🦄', '🐯', '🐨', '🦅', '🐺'];
const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#e91e63'];

const FALLBACK_DEFAULTS = {
  // Mirrors the web client's defaultSettings().
  flagCount: 10,
  maxPlayers: 8,
  mode: 'classic',
  answerMode: 'choice',
  scoring: 'classic',
  durationSec: 15,
  answerType: 'country',
  continents: [],
  arabOnly: false,
  similarOnly: false,
  rareOnly: false,
  difficulty: 'mixed',
  questionTypes: ['flagToCountry'],
  hint: 'none',
  negativePoints: false,
  lateJoin: true,
  revealSec: 3,
  raceTarget: 10,
  soloMode: false,
};

const ENGINE_MODES = new Set(['race', 'fixed', 'sudden', 'teams', 'survival', 'turns', 'daily', 'kids', 'solo']);
const QUESTION_TYPE_MAP = {
  flagToCountry: 'flag-country',
  countryToFlag: 'country-flag',
  capital: 'flag-capital',
  continent: 'flag-continent',
};
const ENGINE_QUESTION_TYPES = new Set([
  'flag-country', 'country-flag', 'flag-capital', 'flag-continent', 'blurry', 'zoom', 'odd-one-out',
]);
const SCORING_MAP = { classic: 'speed', streak: 'speed', fixed: 'simple', simple: 'simple', speed: 'speed' };

/**
 * Standings shaped for the web client: { playerId, id, name, score, ... }.
 * getStandings() already sorts score desc, correct desc, fastest first.
 */
export function clientStandings(game) {
  let list = [];
  try {
    list = getStandings(game);
  } catch {
    list = game?.players ?? [];
  }
  return list.map((p) => ({
    playerId: p.id,
    id: p.id,
    name: p.name ?? null,
    score: p.score ?? 0,
    correct: p.correct ?? 0,
    wrong: p.wrong ?? 0,
    streak: p.streak ?? 0,
    bestStreak: p.bestStreak ?? 0,
    fastestMs: p.fastestMs ?? null,
    alive: p.alive ?? true,
    team: p.team ?? null,
  }));
}

/**
 * Aggregate stats object for the results screen (the client renders one
 * stats object, not a per-player array): { correct, total, accuracy,
 * bestStreak, fastestMs, mostMissed }.
 */
export function clientGameStats(game) {
  const players = game?.players ?? [];
  let correct = 0;
  let total = 0;
  let bestStreak = 0;
  let fastestMs = null;
  for (const p of players) {
    correct += p.correct ?? 0;
    total += (p.correct ?? 0) + (p.wrong ?? 0);
    bestStreak = Math.max(bestStreak, p.bestStreak ?? p.streak ?? 0);
    if (p.fastestMs !== null && p.fastestMs !== undefined) {
      fastestMs = fastestMs === null ? p.fastestMs : Math.min(fastestMs, p.fastestMs);
    }
  }
  let mostMissed = null;
  const missed = game?.missedCodes ?? [];
  if (missed.length > 0) {
    const counts = new Map();
    for (const c of missed) counts.set(c, (counts.get(c) || 0) + 1);
    let top = null;
    let topN = 0;
    for (const [c, n] of counts) if (n > topN) { top = c; topN = n; }
    if (top) {
      const entry = safeByCode(top);
      mostMissed = entry ? (entry.ar || entry.en || top) : top;
    }
  }
  return {
    correct,
    total,
    accuracy: total > 0 ? correct / total : 0,
    bestStreak,
    fastestMs,
    mostMissed,
  };
}

/** Engine badges ({playerId, badge}) -> Arabic label strings for the client. */
export function clientBadges(game, badges) {
  const out = [];
  const byId = new Map((game?.players ?? []).map((p) => [p.id, p]));
  for (const b of badges ?? []) {
    if (typeof b === 'string') { out.push(b); continue; }
    const p = byId.get(b.playerId);
    const name = p?.name ? ` — ${p.name}` : '';
    if (b.badge === 'fastest') out.push(`الأسرع${name}`);
    else if (b.badge === 'flawless') out.push(`بدون أخطاء${name}`);
    else if (b.badge === 'continent-king') {
      const cont = (CONTINENTS ?? []).find((c) => c.id === b.continent);
      out.push(`ملك قارة ${cont?.ar ?? b.continent ?? ''}${name}`);
    } else if (b.badge) out.push(String(b.badge));
  }
  return out;
}

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function cleanCode(code) {
  return String(code ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function secretsEqual(a, b) {
  try {
    const ba = Buffer.from(String(a), 'utf8');
    const bb = Buffer.from(String(b), 'utf8');
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function safeByCode(code) {
  try {
    return code ? byCode(code) : null;
  } catch {
    return null;
  }
}

export class RoomManager {
  constructor({ maxRooms = 500, flags = null, hooks = {}, onEvent = null } = {}) {
    this.maxRooms = maxRooms;
    this.flags = flags;
    this.hooks = hooks;
    this.onEvent = onEvent;
    /** roomId -> room */
    this.rooms = new Map();
    /** room code -> room */
    this.byCode = new Map();
    /** closed code -> closedAt ms (pruned after 24h) */
    this.closedCodes = new Map();
    /** flag token -> { code, roomCode, expiresAt } (global, all rooms) */
    this.tokenStore = new Map();
    this.roomCounter = 1000;
    this.sweepTimer = setInterval(() => {
      try {
        this.sweep();
      } catch {
        // Sweep must never crash the process.
      }
    }, 60_000);
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();
  }

  // ---------------------------------------------------------------- codes

  generateRoomCode(existingCodes = new Set(this.byCode.keys()), recentlyClosed = this.closedCodes) {
    for (let attempt = 0; attempt < 20; attempt++) {
      let code = '';
      for (let i = 0; i < 6; i++) {
        code += ROOM_CODE_ALPHABET[crypto.randomInt(ROOM_CODE_ALPHABET.length)];
      }
      const taken = existingCodes.has(code) || (recentlyClosed && recentlyClosed.has(code));
      if (!taken) return code;
    }
    throw new Error('تعذر توليد كود غرفة');
  }

  poolSize() {
    const flagN = this.flags?.flagCount?.() ?? 0;
    const countryN = Array.isArray(COUNTRIES) ? COUNTRIES.length : 0;
    const pool = Math.min(flagN || 195, countryN || 195);
    return pool > 0 ? pool : 195;
  }

  // ---------------------------------------------------------------- rooms

  createRoom({ hostPlayer, settings = {}, password } = {}) {
    if (this.rooms.size >= this.maxRooms) {
      throw fail('rooms_full', 'وصل السيرفر للحد الأقصى من الغرف');
    }
    const name = String(hostPlayer?.name ?? '').trim();
    if (!name) throw fail('invalid_name', 'الاسم مطلوب');
    const validated = validateSettingsRanges(settings);
    if (!validated.ok) throw fail(validated.code, validated.message);
    const code = this.generateRoomCode();
    const roomSettings = { ...FALLBACK_DEFAULTS, ...validated.settings };
    // Room settings stay in client vocabulary; the engine gets its own
    // translated copy in engineSettings(). (DEFAULT_SETTINGS is applied
    // inside the engine's normalizeSettings.)
    // The client sends the room password inside settings too (set-password
    // field); accept it as a fallback. Never keep it in stored settings —
    // snapshots echo settings to every client.
    const rawPassword = password || roomSettings.password || '';
    delete roomSettings.password;
    const pool = this.poolSize();
    if (roomSettings.flagCount > pool) roomSettings.flagCount = pool;

    let pw = null;
    if (rawPassword) {
      const salt = crypto.randomBytes(16);
      const hash = crypto.scryptSync(rawPassword, salt, 64);
      pw = { salt, hash };
    }

    const now = Date.now();
    const room = {
      id: crypto.randomUUID(),
      number: ++this.roomCounter,
      code,
      password: pw,
      hostId: null,
      players: new Map(),
      game: null,
      settings: roomSettings,
      createdAt: now,
      lastActivityAt: now,
      emptySince: null,
      timers: new Set(),
      flagTokens: new Map(),
      skipVotes: new Set(),
      readySet: new Set(),
      matchWins: new Map(),
      series: [],
      missedCodes: new Set(),
      questionTimer: null,
      readyTimer: null,
      advanceTimer: null,
      countdownTimer: null,
      earlyRevealTimer: null,
      soloTimer: null,
      currentQuestion: null,
      questionFlagUrl: null,
      questionId: null,
      questionStarted: false,
      questionEnded: false,
      questionEndsAt: null,
      questionShowAt: null,
      questionDurationMs: 0,
      pausedRemainingMs: null,
      gameEndedAt: null,
    };
    this.rooms.set(room.id, room);
    this.byCode.set(code, room);
    const player = this.addPlayer(room, { name, role: 'player' });
    room.hostId = player.id;
    this.onEvent?.(room, 'created', {});
    return { room, player };
  }

  addPlayer(room, { name, role = 'player', team = null } = {}) {
    const idx = room.players.size;
    const player = {
      id: crypto.randomUUID(),
      secret: crypto.randomBytes(16).toString('hex'),
      name: String(name).trim(),
      avatar: AVATARS[idx % AVATARS.length],
      color: COLORS[idx % COLORS.length],
      connected: false,
      socket: null,
      role,
      team: team ?? null,
      joinedAt: Date.now(),
      disconnectedAt: null,
      score: 0,
      correct: 0,
      wrong: 0,
      streak: 0,
      alive: true,
      removeTimer: null,
    };
    room.players.set(player.id, player);
    return player;
  }

  verifyPassword(room, password) {
    if (!room.password) return true;
    if (typeof password !== 'string' || password.length === 0) return false;
    try {
      const hash = crypto.scryptSync(password, room.password.salt, 64);
      if (hash.length !== room.password.hash.length) return false;
      return crypto.timingSafeEqual(hash, room.password.hash);
    } catch {
      return false;
    }
  }

  getRoomByCode(code) {
    return this.byCode.get(cleanCode(code)) ?? null;
  }

  getRoom(id) {
    return this.rooms.get(id) ?? null;
  }

  roomCount() {
    return this.rooms.size;
  }

  touch(room) {
    room.lastActivityAt = Date.now();
  }

  // ------------------------------------------------------------- joining

  joinRoom(code, { name, secret, playerId, password, asSpectator = false, display } = {}) {
    const room = this.byCode.get(cleanCode(code));
    if (!room) throw fail('room_not_found', 'الغرفة غير موجودة، تأكد من الكود');
    if (room.password && !this.verifyPassword(room, password)) {
      throw fail('wrong_password', 'كلمة المرور غير صحيحة');
    }

    // Resume a disconnected seat (90s window).
    if (playerId && secret) {
      const existing = room.players.get(playerId);
      if (existing) {
        if (existing.secret && secretsEqual(existing.secret, secret)) {
          if (!existing.connected && existing.disconnectedAt
            && Date.now() - existing.disconnectedAt <= RESUME_WINDOW_MS) {
            this.playerConnected(room, existing.id);
            this.touch(room);
            return { player: existing, room, resumed: true };
          }
          if (existing.connected) {
            throw fail('already_connected', 'هذا اللاعب متصل بالفعل');
          }
          // Seat expired: drop it and fall through to a fresh join.
          room.players.delete(playerId);
        } else {
          throw fail('bad_secret', 'بيانات الاستئناف غير صحيحة');
        }
      }
    }

    const cleanName = String(name ?? '').trim();
    if (!cleanName) throw fail('invalid_name', 'الاسم مطلوب');

    const players = [...room.players.values()];
    const playerCount = players.filter((p) => p.role === 'player').length;
    const spectatorCount = players.filter((p) => p.role === 'spectator').length;

    if (asSpectator) {
      if (spectatorCount >= MAX_SPECTATORS) throw fail('room_full', 'الغرفة ممتلئة');
      const p = this.addPlayer(room, { name: cleanName, role: 'spectator' });
      this.playerConnected(room, p.id);
      this.touch(room);
      return { player: p, room, resumed: false };
    }

    const game = room.game;
    const inGame = !!game && game.phase !== 'lobby' && game.phase !== 'ended';
    if (inGame && !room.settings.lateJoin) {
      // Late joiners watch as spectators.
      if (spectatorCount >= MAX_SPECTATORS) throw fail('room_full', 'الغرفة ممتلئة');
      const p = this.addPlayer(room, { name: cleanName, role: 'spectator' });
      this.playerConnected(room, p.id);
      this.touch(room);
      return { player: p, room, resumed: false, asSpectator: true };
    }
    if (playerCount >= (room.settings.maxPlayers ?? MAX_PLAYERS)) {
      throw fail('room_full', 'الغرفة ممتلئة');
    }
    if (playerCount + spectatorCount >= MAX_PLAYERS + MAX_SPECTATORS) {
      throw fail('room_full', 'الغرفة ممتلئة');
    }
    const player = this.addPlayer(room, { name: cleanName, role: 'player' });
    this.playerConnected(room, player.id);
    this.touch(room);
    return { player, room, resumed: false };
  }

  playerConnected(room, playerId) {
    const p = room.players.get(playerId);
    if (!p) return false;
    p.connected = true;
    p.disconnectedAt = null;
    if (p.removeTimer) {
      clearTimeout(p.removeTimer);
      room.timers.delete(p.removeTimer);
      p.removeTimer = null;
    }
    room.emptySince = null;
    if (room.soloTimer) {
      const connected = [...room.players.values()].filter((x) => x.role === 'player' && x.connected);
      if (connected.length >= 2) {
        clearTimeout(room.soloTimer);
        room.timers.delete(room.soloTimer);
        room.soloTimer = null;
      }
    }
    // If the host is gone, the oldest connected player takes over.
    const host = room.players.get(room.hostId);
    if (!host || !host.connected) this.ensureHost(room, { silent: true });
    return true;
  }

  disconnectPlayer(room, playerId) {
    const p = room.players.get(playerId);
    if (!p || !p.connected) return false;
    p.connected = false;
    p.socket = null;
    p.disconnectedAt = Date.now();
    const gp = room.game?.players?.find((x) => x.id === playerId);
    if (gp) gp.connected = false;
    this.touch(room);

    if (room.hostId === playerId) this.ensureHost(room);

    const connectedPlayers = [...room.players.values()].filter((x) => x.role === 'player' && x.connected);
    const anyConnected = [...room.players.values()].some((x) => x.connected);
    if (!anyConnected) room.emptySince = Date.now();

    // Only one player left mid-game: 60s to finish, then they win.
    if (room.game && room.game.phase !== 'ended' && room.game.phase !== 'lobby'
      && connectedPlayers.length === 1) {
      if (room.soloTimer) {
        clearTimeout(room.soloTimer);
        room.timers.delete(room.soloTimer);
      }
      const winnerId = connectedPlayers[0].id;
      const timer = setTimeout(() => {
        room.timers.delete(timer);
        room.soloTimer = null;
        this.forceEndGame(room, winnerId);
      }, SOLO_END_DELAY_MS);
      room.soloTimer = timer;
      room.timers.add(timer);
    }

    // Hold the seat for 90s so the player can resume with playerId+secret.
    if (p.removeTimer) {
      clearTimeout(p.removeTimer);
      room.timers.delete(p.removeTimer);
    }
    const removeTimer = setTimeout(() => {
      room.timers.delete(removeTimer);
      p.removeTimer = null;
      if (!p.connected) {
        room.players.delete(playerId);
        if (room.hostId === playerId) this.ensureHost(room);
        this.broadcastSnapshot(room);
      }
    }, RESUME_WINDOW_MS);
    p.removeTimer = removeTimer;
    room.timers.add(removeTimer);
    return true;
  }

  leaveRoom(room, playerId) {
    const p = room.players.get(playerId);
    if (!p) return false;
    if (p.removeTimer) {
      clearTimeout(p.removeTimer);
      room.timers.delete(p.removeTimer);
      p.removeTimer = null;
    }
    room.players.delete(playerId);
    const gp = room.game?.players?.find((x) => x.id === playerId);
    if (gp) gp.connected = false;
    this.touch(room);
    if (room.hostId === playerId) this.ensureHost(room);
    if (![...room.players.values()].some((x) => x.connected)) room.emptySince = Date.now();
    const connectedPlayers = [...room.players.values()].filter((x) => x.role === 'player' && x.connected);
    if (room.game && room.game.phase !== 'ended' && room.game.phase !== 'lobby'
      && connectedPlayers.length === 1 && !room.soloTimer) {
      const winnerId = connectedPlayers[0].id;
      const timer = setTimeout(() => {
        room.timers.delete(timer);
        room.soloTimer = null;
        this.forceEndGame(room, winnerId);
      }, SOLO_END_DELAY_MS);
      room.soloTimer = timer;
      room.timers.add(timer);
    }
    return true;
  }

  ensureHost(room, { silent = false } = {}) {
    const host = room.players.get(room.hostId);
    if (host && host.connected) return room.hostId;
    const candidates = [...room.players.values()]
      .filter((p) => p.role === 'player' && p.connected)
      .sort((a, b) => a.joinedAt - b.joinedAt);
    if (candidates.length > 0) {
      room.hostId = candidates[0].id;
      if (!silent) this.broadcastSnapshot(room);
    }
    return room.hostId;
  }

  kick(room, playerId, byHostId) {
    if (byHostId !== room.hostId) throw fail('not_host', 'فقط مضيف الغرفة يمكنه الطرد');
    if (playerId === room.hostId) throw fail('cannot_kick_host', 'لا يمكن طرد المضيف');
    const p = room.players.get(playerId);
    if (!p) throw fail('player_not_found', 'اللاعب غير موجود');
    if (p.removeTimer) {
      clearTimeout(p.removeTimer);
      room.timers.delete(p.removeTimer);
      p.removeTimer = null;
    }
    room.players.delete(playerId);
    const gp = room.game?.players?.find((x) => x.id === playerId);
    if (gp) gp.connected = false;
    this.touch(room);
    this.broadcastSnapshot(room);
    return p;
  }

  transferHost(room, newHostId, byHostId) {
    if (byHostId !== room.hostId) throw fail('not_host', 'فقط مضيف الغرفة يمكنه نقل الاستضافة');
    const target = room.players.get(newHostId);
    if (!target || target.role !== 'player') throw fail('player_not_found', 'اللاعب غير موجود');
    room.hostId = newHostId;
    this.touch(room);
    this.broadcastSnapshot(room);
    return room.hostId;
  }

  setSettings(room, settings, byHostId) {
    if (byHostId !== room.hostId) throw fail('not_host', 'فقط مضيف الغرفة يمكنه تغيير الإعدادات');
    if (room.game && room.game.phase !== 'lobby' && room.game.phase !== 'ended') {
      throw fail('game_running', 'لا يمكن تغيير الإعدادات بعد بدء اللعبة');
    }
    const validated = validateSettingsRanges(settings);
    if (!validated.ok) throw fail(validated.code, validated.message);
    const next = { ...room.settings, ...validated.settings };
    let note = null;
    // A non-empty password inside settings changes the room password.
    if (typeof validated.settings.password === 'string' && validated.settings.password.length > 0) {
      const salt = crypto.randomBytes(16);
      room.password = { salt, hash: crypto.scryptSync(validated.settings.password, salt, 64) };
    }
    delete next.password;
    const pool = this.poolSize();
    if (next.flagCount > pool) {
      next.flagCount = pool;
      note = `تم تقليل عدد الأعلام إلى ${pool} حسب المتاح`;
    }
    room.settings = next;
    this.touch(room);
    return { settings: room.settings, note };
  }

  /**
   * Translate room (client-vocabulary) settings to engine settings.
   * Room settings stay in client vocabulary so snapshots round-trip to the
   * settings form; only the engine copy is translated.
   */
  engineSettings(room, override = null) {
    const s = { ...(room.settings || {}), ...(override || {}) };
    if (s.mode === 'classic' || s.mode === 'buzzer') s.mode = 'fixed';
    if (!ENGINE_MODES.has(s.mode)) s.mode = 'fixed';
    if (s.scoring) s.scoring = SCORING_MAP[s.scoring] ?? 'simple';
    const mappedTypes = Array.isArray(s.questionTypes)
      ? s.questionTypes.map((t) => QUESTION_TYPE_MAP[t] ?? t).filter((t) => ENGINE_QUESTION_TYPES.has(t))
      : [];
    if (mappedTypes.length === 0) {
      if (s.answerType === 'capital') s.questionTypes = ['flag-capital'];
      else if (s.answerType === 'continent') s.questionTypes = ['flag-continent'];
      else if (s.answerType === 'mixed') s.questionTypes = ['flag-country', 'flag-capital', 'country-flag'];
      else s.questionTypes = ['flag-country'];
    } else {
      s.questionTypes = mappedTypes;
    }
    if (typeof s.hint === 'string') s.hint = s.hint !== 'none';
    if (s.durationSec === 0) s.noTimer = true;
    delete s.password;
    return s;
  }

  // ------------------------------------------------------------ game flow

  connectedPlayers(room) {
    return [...room.players.values()].filter((p) => p.role === 'player' && p.connected);
  }

  startGame(room, nowMs, byHostId) {
    if (byHostId !== room.hostId) throw fail('not_host', 'فقط مضيف الغرفة يبدأ اللعبة');
    if (room.game && room.game.phase !== 'ended' && room.game.phase !== 'lobby') {
      throw fail('game_running', 'اللعبة بدأت بالفعل');
    }
    const players = this.connectedPlayers(room);
    const solo = room.settings.soloMode === true || room.settings.mode === 'solo';
    if (players.length < 1) throw fail('not_enough_players', 'لا يوجد لاعبون');
    if (players.length < 2 && !solo) {
      throw fail('not_enough_players', 'يلزم لاعبان على الأقل للبدء');
    }
    this.startGameInternal(room, players, nowMs);
    return room.game;
  }

  startGameInternal(room, players, nowMs, { settingsOverride = null, deckOverride = null } = {}) {
    const enginePlayers = players.map((p) => ({ id: p.id, name: p.name, team: p.team ?? null }));
    const settings = this.engineSettings(room, settingsOverride);
    const seed = crypto.randomInt(0, 2 ** 31);
    let game;
    try {
      game = createGame(settings, enginePlayers, seed);
      if (deckOverride && Array.isArray(game.deck)) game.deck = [...deckOverride];
      if (deckOverride && typeof game.totalRounds === 'number') game.totalRounds = deckOverride.length;
      engineStartGame(game, nowMs);
    } catch (e) {
      throw fail('engine_error', 'تعذر بدء اللعبة');
    }
    room.game = game;
    room.missedCodes = new Set();
    room.skipVotes = new Set();
    room.readySet = new Set();
    room.questionStarted = false;
    room.questionEnded = false;
    room.currentQuestion = null;
    room.questionId = null;
    room.questionEndsAt = null;
    room.pausedRemainingMs = null;
    this.touch(room);
    this.hooks.broadcast?.(room, { t: 'countdown', endsAt: nowMs + COUNTDOWN_MS, durationMs: COUNTDOWN_MS });
    if (room.countdownTimer) {
      clearTimeout(room.countdownTimer);
      room.timers.delete(room.countdownTimer);
    }
    const timer = setTimeout(() => {
      room.timers.delete(timer);
      room.countdownTimer = null;
      this.beginQuestionFlow(room);
    }, COUNTDOWN_MS);
    room.countdownTimer = timer;
    room.timers.add(timer);
    return game;
  }

  beginQuestionFlow(room, presetQuestion = null) {
    if (!room.game) return;
    const now = Date.now();
    let question = presetQuestion;
    if (!question) {
      try {
        question = engineBeginQuestion(room.game, now);
      } catch {
        return;
      }
    }
    if (!question) {
      this.advanceRound(room);
      return;
    }
    room.currentQuestion = question;
    room.questionStarted = false;
    room.questionEnded = false;
    room.readySet = new Set();
    room.skipVotes = new Set();
    const q = question;
    const cur = room.game.current || {};
    const qid = q.id ?? q.questionId ?? `q${cur.index ?? room.game.round ?? 0}`;
    room.questionId = String(qid);

    // The engine sets endsAt at beginQuestion time (or null for no-timer);
    // the server's visible window starts at q_start, so the duration is
    // endsAt - startedAt. durationSec 0 / noTimer -> no server timer.
    const durationMs = cur.endsAt != null && cur.startedAt != null
      ? Math.max(0, cur.endsAt - cur.startedAt)
      : 0;
    room.questionDurationMs = durationMs;
    const endsAtGuess = cur.endsAt ?? (now + durationMs);

    // Opaque flag tokens. Only the prompt flag (flagCode) needs one, plus
    // one per option flag for country-flag questions. Codes that are not
    // real flags (e.g. continent ids in flag-continent options) get none.
    const hasFlag = (code) => {
      try {
        return this.flags?.hasFlag ? this.flags.hasFlag(code) : true;
      } catch {
        return true;
      }
    };
    const codes = new Set();
    const opts = Array.isArray(q.options) ? q.options : [];
    if (q.flagCode && hasFlag(String(q.flagCode).toLowerCase())) {
      codes.add(String(q.flagCode).toLowerCase());
    }
    if (q.type === 'country-flag') {
      for (const o of opts) {
        const c = typeof o === 'string' ? o : (o?.code ?? o?.countryCode);
        if (c && hasFlag(String(c).toLowerCase())) codes.add(String(c).toLowerCase());
      }
    }
    if (this.tokenStore.size > 1000) {
      for (const [tok, rec] of this.tokenStore) {
        if (Date.now() > rec.expiresAt) this.tokenStore.delete(tok);
      }
    }
    const flagUrls = {};
    for (const code of codes) {
      const token = crypto.randomBytes(16).toString('hex');
      const rec = { code, roomCode: room.code, expiresAt: endsAtGuess + 60_000 };
      room.flagTokens.set(token, rec);
      this.tokenStore.set(token, rec);
      flagUrls[code] = `/f/${token}`;
    }

    const type = String(q.type ?? '');
    // Typing is chosen by the client's answerMode setting; in that case the
    // client shows a text input and needs no options at all.
    const isTyping = room.game.settings?.answerMode === 'typing';
    let optionsOut = [];
    if (!isTyping) {
      optionsOut = opts.map((o) => {
        const code = typeof o === 'string' ? o : (o?.code ?? o?.countryCode);
        const entry = {
          code: code ? String(code).toLowerCase() : undefined,
          labelAr: o?.labelAr ?? o?.nameAr ?? o?.ar ?? null,
          labelEn: o?.labelEn ?? o?.nameEn ?? o?.en ?? null,
        };
        if (entry.code && flagUrls[entry.code]) entry.flagUrl = flagUrls[entry.code];
        return entry;
      });
    }
    // The client renders one main flag image from flagUrl; for country-flag
    // questions there is no single prompt flag (options carry their own).
    const flagUrl = q.flagCode && flagUrls[String(q.flagCode).toLowerCase()]
      ? flagUrls[String(q.flagCode).toLowerCase()]
      : null;
    room.questionFlagUrl = flagUrl;

    this.hooks.broadcast?.(room, {
      t: 'q_prepare',
      questionId: room.questionId,
      type: type || null,
      prompt: q.prompt ?? q.text ?? q.promptAr ?? null,
      promptAr: q.promptAr ?? null,
      promptEn: q.promptEn ?? null,
      flagUrl,
      flagUrls,
      options: optionsOut,
      durationMs,
      turnPlayerId: q.turnPlayerId ?? cur.turnPlayerId ?? null,
      index: cur.index ?? room.game.round ?? null,
      total: room.game.totalRounds ?? room.settings.flagCount ?? null,
    });

    if (room.readyTimer) {
      clearTimeout(room.readyTimer);
      room.timers.delete(room.readyTimer);
    }
    const readyTimer = setTimeout(() => {
      room.timers.delete(readyTimer);
      room.readyTimer = null;
      if (!room.questionStarted && !room.questionEnded) this.startQuestion(room);
    }, READY_TIMEOUT_MS);
    room.readyTimer = readyTimer;
    room.timers.add(readyTimer);
  }

  startQuestion(room) {
    if (room.questionStarted || room.questionEnded || !room.game) return;
    room.questionStarted = true;
    if (room.readyTimer) {
      clearTimeout(room.readyTimer);
      room.timers.delete(room.readyTimer);
      room.readyTimer = null;
    }
    const now = Date.now();
    const durationMs = room.questionDurationMs ?? 0;
    const showAt = now + Q_START_DELAY_MS;
    const endsAt = durationMs > 0 ? showAt + durationMs : null;
    room.questionShowAt = showAt;
    room.questionEndsAt = endsAt;
    // Keep the engine's deadline aligned with the visible window so pause /
    // resume and fastestMs use the same clock the clients see.
    if (room.game.current) {
      room.game.current.startedAt = showAt;
      room.game.current.endsAt = endsAt;
    }
    this.hooks.broadcast?.(room, {
      t: 'q_start',
      questionId: room.questionId,
      showAt,
      endsAt,
      flagUrl: room.questionFlagUrl ?? null,
      durationMs,
      turnPlayerId: room.game.current?.turnPlayerId ?? null,
    });
    if (endsAt) {
      const timer = setTimeout(() => {
        room.timers.delete(timer);
        room.questionTimer = null;
        this.endQuestion(room);
      }, Math.max(0, endsAt - Date.now()));
      room.questionTimer = timer;
      room.timers.add(timer);
    }
  }

  markReady(room, playerId, questionId) {
    if (!room.game || room.questionStarted || room.questionEnded) return false;
    if (questionId && room.questionId && String(questionId) !== room.questionId) return false;
    room.readySet.add(playerId);
    const connected = this.connectedPlayers(room);
    if (connected.length > 0 && connected.every((p) => room.readySet.has(p.id))) {
      this.startQuestion(room);
      return true;
    }
    return false;
  }

  submitAnswer(room, playerId, payload, nowMs) {
    if (!room.game || room.game.phase !== 'question' || !room.questionStarted || room.questionEnded) {
      return { accepted: false, reason: 'not_in_question' };
    }
    if (payload?.questionId && room.questionId && String(payload.questionId) !== room.questionId) {
      return { accepted: false, reason: 'stale' };
    }
    const endsAt = room.questionEndsAt ?? room.game.current?.endsAt ?? null;
    if (endsAt && nowMs > endsAt + ANSWER_GRACE_MS) {
      return { accepted: false, reason: 'too_late' };
    }
    const enginePayload = {};
    if (Number.isInteger(payload?.choiceIndex)) enginePayload.choiceIndex = payload.choiceIndex;
    else if (typeof payload?.text === 'string') enginePayload.text = payload.text;
    else return { accepted: false, reason: 'invalid_answer' };

    let result;
    try {
      result = engineSubmitAnswer(room.game, playerId, enginePayload, nowMs);
    } catch {
      return { accepted: false, reason: 'error' };
    }
    if (!result || !result.accepted) {
      return { accepted: false, reason: result?.reason ?? 'rejected' };
    }
    this.syncScores(room);
    const ack = {
      accepted: true,
      correct: !!result.correct,
      points: result.points ?? 0,
      locked: !!result.locked,
      first: !!result.first,
    };
    // Others only learn that this player answered — never the result.
    this.hooks.broadcast?.(room, { t: 'player_answered', playerId }, playerId);
    // End the round early when the first correct answer locks a
    // simple-scoring round, or when every alive player has answered.
    const scoring = room.game.settings?.scoring;
    const roundDone = (result.correct && result.first && scoring === 'simple') || result.allAnswered;
    if (roundDone) this.scheduleEarlyReveal(room);
    this.touch(room);
    return ack;
  }

  scheduleEarlyReveal(room) {
    if (room.questionTimer) {
      clearTimeout(room.questionTimer);
      room.timers.delete(room.questionTimer);
      room.questionTimer = null;
    }
    if (room.earlyRevealTimer) return;
    const timer = setTimeout(() => {
      room.timers.delete(timer);
      room.earlyRevealTimer = null;
      this.endQuestion(room);
    }, SIMPLE_REVEAL_DELAY_MS);
    room.earlyRevealTimer = timer;
    room.timers.add(timer);
  }

  /**
   * Move the current question to reveal. When `preReveal` is given (host
   * skip / majority skip-vote), the engine already timed out + revealed,
   * so it is reused instead of revealing twice.
   */
  endQuestion(room, preReveal = null) {
    if (room.questionEnded || !room.game) return;
    room.questionEnded = true;
    if (room.questionTimer) {
      clearTimeout(room.questionTimer);
      room.timers.delete(room.questionTimer);
      room.questionTimer = null;
    }
    if (room.readyTimer) {
      clearTimeout(room.readyTimer);
      room.timers.delete(room.readyTimer);
      room.readyTimer = null;
    }
    if (room.earlyRevealTimer) {
      clearTimeout(room.earlyRevealTimer);
      room.timers.delete(room.earlyRevealTimer);
      room.earlyRevealTimer = null;
    }
    const now = Date.now();
    let rev = preReveal;
    if (!rev) {
      try {
        engineTimeoutQuestion(room.game, now);
        rev = engineReveal(room.game, now);
      } catch {
        rev = null;
      }
    }
    this.syncScores(room);
    // The engine records missed questions in game.missedCodes (only when
    // nobody answered correctly); mirror the real country codes.
    try {
      const missed = (room.game.missedCodes ?? []).filter((c) => safeByCode(c));
      room.missedCodes = new Set(missed.map((c) => String(c).toLowerCase()));
    } catch {
      // Keep the previous mirror.
    }
    let fact = null;
    if (rev?.answerCode) {
      const c = safeByCode(rev.answerCode);
      if (c && (c.factAr || c.factEn || c.fact)) {
        fact = { ar: c.factAr ?? c.fact ?? null, en: c.factEn ?? null };
      }
    }
    const scores = (rev?.scores ?? []).map((s) => ({
      playerId: s.playerId ?? s.id,
      id: s.id ?? s.playerId,
      score: s.score ?? 0,
    }));
    this.hooks.broadcast?.(room, {
      t: 'q_reveal',
      questionId: room.questionId,
      answerCode: rev?.answerCode ?? null,
      answerLabelAr: rev?.answerLabelAr ?? null,
      answerLabelEn: rev?.answerLabelEn ?? null,
      capitalAr: rev?.capitalAr ?? null,
      capitalEn: rev?.capitalEn ?? null,
      continent: rev?.continent ?? null,
      firstCorrectId: rev?.firstCorrectId ?? null,
      scores,
      standings: clientStandings(room.game),
      fact,
    });

    // Best-effort preload: mint a token for the next deck entry so its flag
    // is already addressable when the next question starts.
    try {
      const deck = room.game.deck;
      if (Array.isArray(deck)) {
        const nextIdx = (room.game.current?.index ?? room.game.round ?? 0) + 1;
        const entry = deck[nextIdx];
        const code = typeof entry === 'string' ? entry : entry?.code;
        if (code) {
          const token = crypto.randomBytes(16).toString('hex');
          const rec = { code: String(code).toLowerCase(), roomCode: room.code, expiresAt: Date.now() + 180_000 };
          room.flagTokens.set(token, rec);
          this.tokenStore.set(token, rec);
        }
      }
    } catch {
      // Preload is optional.
    }

    const revealMs = (room.game.settings?.revealSec ?? room.settings.revealSec ?? 3) * 1000;
    const timer = setTimeout(() => {
      room.timers.delete(timer);
      room.advanceTimer = null;
      this.advanceRound(room);
    }, revealMs);
    room.advanceTimer = timer;
    room.timers.add(timer);
  }

  /** Shared game_end payload, shaped for the web client. */
  gameEndPayload(room, endResult = null, extra = {}) {
    const game = room.game;
    const standings = endResult?.standings
      ? endResult.standings.map((p) => ({
        playerId: p.playerId ?? p.id,
        id: p.id ?? p.playerId,
        name: p.name ?? null,
        score: p.score ?? 0,
        correct: p.correct ?? 0,
        wrong: p.wrong ?? 0,
        streak: p.streak ?? 0,
        bestStreak: p.bestStreak ?? 0,
        fastestMs: p.fastestMs ?? null,
        alive: p.alive ?? true,
        team: p.team ?? null,
      }))
      : clientStandings(game);
    return {
      t: 'game_end',
      standings,
      stats: clientGameStats(game),
      playerStats: (game?.players ?? []).map((p) => ({
        id: p.id,
        name: p.name ?? null,
        score: p.score ?? 0,
        correct: p.correct ?? 0,
        wrong: p.wrong ?? 0,
        accuracy: (p.correct ?? 0) + (p.wrong ?? 0) > 0
          ? (p.correct ?? 0) / ((p.correct ?? 0) + (p.wrong ?? 0)) : 0,
        bestStreak: p.bestStreak ?? 0,
        fastestMs: p.fastestMs ?? null,
      })),
      badges: clientBadges(game, endResult?.badges ?? game?.summary?.badges ?? []),
      winners: endResult?.winners ?? game?.winners ?? [],
      mostMissedCode: endResult?.mostMissedCode ?? game?.summary?.mostMissedCode ?? null,
      matchWins: Object.fromEntries(room.matchWins),
      series: [...room.series],
      ...extra,
    };
  }

  advanceRound(room) {
    if (!room.game) return;
    let res = null;
    try {
      res = engineAdvance(room.game, Date.now());
    } catch {
      res = null;
    }
    const phase = res?.phase ?? room.game.phase;
    if (phase === 'ended') {
      room.gameEndedAt = Date.now();
      // advance() already ran endGame(); use its standings/stats/badges.
      this.hooks.broadcast?.(room, this.gameEndPayload(room, res));
      return;
    }
    if (phase === 'question' && res?.question) {
      // advance() already began the next question — do not begin it again.
      this.beginQuestionFlow(room, res.question);
      return;
    }
    if (phase === 'question') {
      this.beginQuestionFlow(room);
      return;
    }
    // Unexpected phase (e.g. engine threw): try to keep the game moving.
    if (room.game.phase === 'reveal') this.beginQuestionFlow(room);
  }

  pauseGame(room, byHostId) {
    if (byHostId !== room.hostId) throw fail('not_host', 'فقط مضيف الغرفة يمكنه الإيقاف');
    if (!room.game || room.game.phase !== 'question') {
      throw fail('cannot_pause', 'لا يمكن الإيقاف الآن');
    }
    const now = Date.now();
    try {
      enginePauseGame(room.game, now);
    } catch {
      // Engine pause is best-effort; the server still freezes the timer.
    }
    let remaining = null;
    if (room.questionEndsAt) remaining = Math.max(0, room.questionEndsAt - now);
    room.pausedRemainingMs = remaining;
    // Keep the engine's own remaining value in sync with the server clock.
    try {
      room.game.pauseRemainingMs = remaining ?? 0;
    } catch {
      // Ignore.
    }
    if (room.questionTimer) {
      clearTimeout(room.questionTimer);
      room.timers.delete(room.questionTimer);
      room.questionTimer = null;
    }
    this.hooks.broadcast?.(room, { t: 'paused', remainingMs: remaining });
    this.touch(room);
    return { remainingMs: remaining };
  }

  resumeGame(room, byHostId) {
    if (byHostId !== room.hostId) throw fail('not_host', 'فقط مضيف الغرفة يمكنه الاستئناف');
    if (!room.game || !room.game.paused) {
      throw fail('cannot_resume', 'اللعبة ليست متوقفة');
    }
    const now = Date.now();
    try {
      engineResumeGame(room.game, now);
    } catch {
      // Best-effort.
    }
    const remaining = room.pausedRemainingMs;
    const resumeAt = now + 3000;
    const endsAt = remaining != null ? resumeAt + remaining : null;
    room.questionEndsAt = endsAt;
    // The engine shifts its own deadline by the paused time; override it
    // with the server's 3-2-1 resume window so both clocks agree.
    try {
      if (room.game.current) room.game.current.endsAt = endsAt;
    } catch {
      // Ignore.
    }
    this.hooks.broadcast?.(room, { t: 'resumed', resumeAt, endsAt, remainingMs: remaining });
    const timer = setTimeout(() => {
      room.timers.delete(timer);
      if (room.questionEndsAt) {
        const t2 = setTimeout(() => {
          room.timers.delete(t2);
          room.questionTimer = null;
          this.endQuestion(room);
        }, Math.max(0, room.questionEndsAt - Date.now()));
        room.questionTimer = t2;
        room.timers.add(t2);
      }
    }, 3000);
    room.timers.add(timer);
    room.pausedRemainingMs = null;
    this.touch(room);
    return { resumeAt, endsAt, remainingMs: remaining };
  }

  skipFlag(room, byHostId) {
    if (byHostId !== room.hostId) throw fail('not_host', 'فقط مضيف الغرفة يمكنه التخطي');
    if (!room.game || room.game.phase !== 'question') {
      throw fail('cannot_skip', 'لا يوجد سؤال جارٍ لتخطيه');
    }
    let skipped = null;
    try {
      skipped = engineSkipCurrent(room.game, Date.now());
    } catch {
      skipped = null;
    }
    if (skipped?.skipped) this.endQuestion(room, skipped.reveal ?? null);
    else this.endQuestion(room);
    return true;
  }

  skipVote(room, playerId) {
    if (!room.game || room.game.phase !== 'question') {
      return { votes: 0, needed: 0, skipped: false };
    }
    let result = null;
    try {
      result = engineApplySkipVote(room.game, playerId, Date.now());
    } catch {
      result = null;
    }
    if (!result || result.reason === 'not-in-question') {
      return { votes: 0, needed: 0, skipped: false };
    }
    const votes = result.votes ?? 0;
    const needed = result.needed ?? 0;
    const skipped = !!result.reached;
    this.hooks.broadcast?.(room, { t: 'skip_vote_update', votes, needed, skipped });
    if (skipped) this.endQuestion(room, result.reveal ?? null);
    this.touch(room);
    return { votes, needed, skipped };
  }

  rematch(room, byHostId) {
    if (!room.game) throw fail('no_game', 'لا توجد لعبة لإعادتها');
    let standings = [];
    try {
      standings = getStandings(room.game);
    } catch {
      standings = [];
    }
    const winnerId = standings?.[0]?.id ?? standings?.[0]?.playerId ?? null;
    if (winnerId) {
      room.matchWins.set(winnerId, (room.matchWins.get(winnerId) ?? 0) + 1);
      room.series.push({ winnerId, at: Date.now() });
    }
    const players = this.connectedPlayers(room);
    if (players.length < 1) throw fail('not_enough_players', 'لا يوجد لاعبون');
    this.startGameInternal(room, players, Date.now());
    return room.game;
  }

  replayMissed(room, byHostId) {
    // The engine tracks missed codes in game.missedCodes (questions nobody
    // answered correctly). Fall back to the room mirror for older games.
    const source = room.game?.missedCodes?.length ? room.game.missedCodes : [...room.missedCodes];
    const missed = [...new Set(source.map((c) => String(c).toLowerCase()))]
      .filter((c) => safeByCode(c));
    if (missed.length === 0) {
      return { ok: false, reason: 'no_missed', message: 'لا توجد أعلام فائتة لإعادتها' };
    }
    const players = this.connectedPlayers(room);
    if (players.length < 1) {
      return { ok: false, reason: 'not_enough_players', message: 'لا يوجد لاعبون' };
    }
    this.startGameInternal(room, players, Date.now(), {
      settingsOverride: { flagCount: missed.length },
      deckOverride: missed,
    });
    return { ok: true, count: missed.length };
  }

  forceEndGame(room, winnerId) {
    if (!room.game || room.game.phase === 'ended') return;
    if (room.questionTimer) {
      clearTimeout(room.questionTimer);
      room.timers.delete(room.questionTimer);
      room.questionTimer = null;
    }
    if (room.readyTimer) {
      clearTimeout(room.readyTimer);
      room.timers.delete(room.readyTimer);
      room.readyTimer = null;
    }
    if (room.advanceTimer) {
      clearTimeout(room.advanceTimer);
      room.timers.delete(room.advanceTimer);
      room.advanceTimer = null;
    }
    if (room.earlyRevealTimer) {
      clearTimeout(room.earlyRevealTimer);
      room.timers.delete(room.earlyRevealTimer);
      room.earlyRevealTimer = null;
    }
    let endResult = null;
    try {
      endResult = engineEndGame(room.game, Date.now());
    } catch {
      endResult = null;
      try {
        room.game.phase = 'ended';
      } catch {
        // Ignore.
      }
    }
    room.gameEndedAt = Date.now();
    this.hooks.broadcast?.(room, this.gameEndPayload(room, endResult, {
      winnerId,
      reason: 'forfeit',
    }));
  }

  // ------------------------------------------------------------ helpers

  syncScores(room) {
    if (!room.game?.players) return;
    for (const gp of room.game.players) {
      const rp = room.players.get(gp.id);
      if (!rp) continue;
      if (typeof gp.score === 'number') rp.score = gp.score;
      if (typeof gp.correct === 'number') rp.correct = gp.correct;
      if (typeof gp.wrong === 'number') rp.wrong = gp.wrong;
      if (typeof gp.streak === 'number') rp.streak = gp.streak;
      if (typeof gp.alive === 'boolean') rp.alive = gp.alive;
    }
  }

  serializePublicGame(room, forPlayerId) {
    if (!room.game) return null;
    try {
      return serializePublic(room.game, forPlayerId ?? null);
    } catch {
      return null;
    }
  }

  broadcastSnapshot(room) {
    if (this.hooks.snapshot && this.hooks.broadcast) {
      try {
        this.hooks.broadcast(room, this.hooks.snapshot(room));
      } catch {
        // Snapshot broadcast is best-effort.
      }
    }
  }

  lookupFlagToken(token) {
    const rec = this.tokenStore.get(token);
    if (!rec) return null;
    if (Date.now() > rec.expiresAt) {
      this.tokenStore.delete(token);
      return null;
    }
    return rec;
  }

  // ------------------------------------------------------------ cleanup

  clearAllTimers(room) {
    for (const t of room.timers) {
      try {
        clearTimeout(t);
      } catch {
        // Ignore.
      }
    }
    room.timers.clear();
    room.questionTimer = null;
    room.readyTimer = null;
    room.advanceTimer = null;
    room.countdownTimer = null;
    room.earlyRevealTimer = null;
    room.soloTimer = null;
  }

  closeRoom(room, reason = 'closed') {
    this.clearAllTimers(room);
    for (const p of room.players.values()) {
      if (p.removeTimer) {
        try {
          clearTimeout(p.removeTimer);
        } catch {
          // Ignore.
        }
        p.removeTimer = null;
      }
      p.socket = null;
    }
    for (const token of room.flagTokens.keys()) this.tokenStore.delete(token);
    room.flagTokens.clear();
    this.rooms.delete(room.id);
    this.byCode.delete(room.code);
    this.closedCodes.set(room.code, Date.now());
    this.onEvent?.(room, 'closed', { reason });
  }

  sweep() {
    const now = Date.now();
    for (const [code, ts] of this.closedCodes) {
      if (now - ts > 24 * 3600 * 1000) this.closedCodes.delete(code);
    }
    for (const [tok, rec] of this.tokenStore) {
      if (now > rec.expiresAt) this.tokenStore.delete(tok);
    }
    for (const room of [...this.rooms.values()]) {
      const connected = [...room.players.values()].filter((p) => p.connected).length;
      const idleMs = now - room.lastActivityAt;
      const emptyMs = room.emptySince ? now - room.emptySince : 0;
      if ((connected === 0 && room.emptySince && emptyMs > 10 * 60 * 1000) || idleMs > 2 * 3600 * 1000) {
        this.closeRoom(room, connected === 0 ? 'empty' : 'idle');
      }
    }
  }

  destroy() {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const room of [...this.rooms.values()]) this.closeRoom(room, 'shutdown');
    this.rooms.clear();
    this.byCode.clear();
  }
}
