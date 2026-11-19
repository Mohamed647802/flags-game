// نقل محلي (وضع فردي / جهاز واحد) بنفس واجهة WebSocketTransport وبنفس أشكال
// رسائل الخادم، حتى يستخدمه app.js بالتبادل مع النقل الشبكي دون أي فرع خاص.
//
// يستورد محرك اللعبة المشترك من ../../shared/engine.js ويحاول استخدامه أولاً
// (probe لعبة تجريبية عند الإنشاء للتحقق من شكل الدوال). إن فشل المحرك أو كان
// شكله مختلفاً، ينتقل تلقائياً إلى محرك احتياطي مدمج صغير بنفس السلوك، حتى
// يبقى الوضع المحلي يعمل حتى قبل اكتمال المحرك المشترك.
// ملاحظة: app.js يستورد هذا الملف ديناميكياً فقط عند اختيار وضع محلي/فردي،
// فلا يؤثر غياب المحرك المشترك على الوضع الأونلاين.
import {
  DEFAULT_SETTINGS,
  createGame,
  startGame,
  beginQuestion,
  submitAnswer,
  reveal,
  advance,
  serializePublic,
  checkAnswer,
} from '../../shared/engine.js';

// --- قائمة احتياطية صغيرة (تُستخدم فقط إن تعذر المحرك المشترك) ---
const FALLBACK_COUNTRIES = [
  { code: 'eg', ar: 'مصر', en: 'Egypt', capitalAr: 'القاهرة', capitalEn: 'Cairo', continent: 'africa' },
  { code: 'sa', ar: 'السعودية', en: 'Saudi Arabia', capitalAr: 'الرياض', capitalEn: 'Riyadh', continent: 'asia' },
  { code: 'ae', ar: 'الإمارات', en: 'United Arab Emirates', capitalAr: 'أبوظبي', capitalEn: 'Abu Dhabi', continent: 'asia' },
  { code: 'jo', ar: 'الأردن', en: 'Jordan', capitalAr: 'عمّان', capitalEn: 'Amman', continent: 'asia' },
  { code: 'ma', ar: 'المغرب', en: 'Morocco', capitalAr: 'الرباط', capitalEn: 'Rabat', continent: 'africa' },
  { code: 'tn', ar: 'تونس', en: 'Tunisia', capitalAr: 'تونس', capitalEn: 'Tunis', continent: 'africa' },
  { code: 'dz', ar: 'الجزائر', en: 'Algeria', capitalAr: 'الجزائر', capitalEn: 'Algiers', continent: 'africa' },
  { code: 'iq', ar: 'العراق', en: 'Iraq', capitalAr: 'بغداد', capitalEn: 'Baghdad', continent: 'asia' },
  { code: 'fr', ar: 'فرنسا', en: 'France', capitalAr: 'باريس', capitalEn: 'Paris', continent: 'europe' },
  { code: 'de', ar: 'ألمانيا', en: 'Germany', capitalAr: 'برلين', capitalEn: 'Berlin', continent: 'europe' },
  { code: 'it', ar: 'إيطاليا', en: 'Italy', capitalAr: 'روما', capitalEn: 'Rome', continent: 'europe' },
  { code: 'es', ar: 'إسبانيا', en: 'Spain', capitalAr: 'مدريد', capitalEn: 'Madrid', continent: 'europe' },
  { code: 'gb', ar: 'بريطانيا', en: 'United Kingdom', capitalAr: 'لندن', capitalEn: 'London', continent: 'europe' },
  { code: 'tr', ar: 'تركيا', en: 'Turkey', capitalAr: 'أنقرة', capitalEn: 'Ankara', continent: 'asia' },
  { code: 'jp', ar: 'اليابان', en: 'Japan', capitalAr: 'طوكيو', capitalEn: 'Tokyo', continent: 'asia' },
  { code: 'cn', ar: 'الصين', en: 'China', capitalAr: 'بكين', capitalEn: 'Beijing', continent: 'asia' },
  { code: 'in', ar: 'الهند', en: 'India', capitalAr: 'نيودلهي', capitalEn: 'New Delhi', continent: 'asia' },
  { code: 'kr', ar: 'كوريا الجنوبية', en: 'South Korea', capitalAr: 'سيول', capitalEn: 'Seoul', continent: 'asia' },
  { code: 'us', ar: 'الولايات المتحدة', en: 'United States', capitalAr: 'واشنطن', capitalEn: 'Washington', continent: 'north-america' },
  { code: 'ca', ar: 'كندا', en: 'Canada', capitalAr: 'أوتاوا', capitalEn: 'Ottawa', continent: 'north-america' },
  { code: 'mx', ar: 'المكسيك', en: 'Mexico', capitalAr: 'مكسيكو سيتي', capitalEn: 'Mexico City', continent: 'north-america' },
  { code: 'br', ar: 'البرازيل', en: 'Brazil', capitalAr: 'برازيليا', capitalEn: 'Brasilia', continent: 'south-america' },
  { code: 'ar', ar: 'الأرجنتين', en: 'Argentina', capitalAr: 'بوينس آيرس', capitalEn: 'Buenos Aires', continent: 'south-america' },
  { code: 'cl', ar: 'تشيلي', en: 'Chile', capitalAr: 'سانتياغو', capitalEn: 'Santiago', continent: 'south-america' },
  { code: 'ng', ar: 'نيجيريا', en: 'Nigeria', capitalAr: 'أبوجا', capitalEn: 'Abuja', continent: 'africa' },
  { code: 'ke', ar: 'كينيا', en: 'Kenya', capitalAr: 'نيروبي', capitalEn: 'Nairobi', continent: 'africa' },
  { code: 'za', ar: 'جنوب أفريقيا', en: 'South Africa', capitalAr: 'بريتوريا', capitalEn: 'Pretoria', continent: 'africa' },
  { code: 'au', ar: 'أستراليا', en: 'Australia', capitalAr: 'كانبرا', capitalEn: 'Canberra', continent: 'oceania' },
  { code: 'nz', ar: 'نيوزيلندا', en: 'New Zealand', capitalAr: 'ويلينغتون', capitalEn: 'Wellington', continent: 'oceania' },
  { code: 'ru', ar: 'روسيا', en: 'Russia', capitalAr: 'موسكو', capitalEn: 'Moscow', continent: 'europe' },
  { code: 'se', ar: 'السويد', en: 'Sweden', capitalAr: 'ستوكهولم', capitalEn: 'Stockholm', continent: 'europe' },
  { code: 'gr', ar: 'اليونان', en: 'Greece', capitalAr: 'أثينا', capitalEn: 'Athens', continent: 'europe' },
];

function shuffle(arr, rand = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function normText(s) {
  return String(s ?? '').trim().toLowerCase()
    .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .replace(/[\u064B-\u0652\u0670]/g, '');
}

// ---------------------------------------------------------------------------
// المحرك الاحتياطي المدمج (نفس أشكال رسائل الخادم)
// ---------------------------------------------------------------------------
class FallbackHost {
  constructor(emit) {
    this.emit = emit;
    this.settings = { ...(DEFAULT_SETTINGS || {}), flagCount: 10, durationSec: 15 };
    this.players = [];
    this.deck = [];
    this.qi = 0;
    this.current = null;
    this.timer = null;
    this.revealTimer = null;
    this.phase = 'lobby';
    this.buzzLock = null;
    this.firstCorrectId = null;
    this.questionId = 0;
    this.missed = [];
  }

  clearTimers() {
    if (this.timer) clearTimeout(this.timer);
    if (this.revealTimer) clearTimeout(this.revealTimer);
    this.timer = null;
    this.revealTimer = null;
  }

  snapshot() {
    return {
      t: 'room_snapshot',
      code: 'LOCAL',
      room: { code: 'LOCAL', settings: this.settings, players: this.publicPlayers(), phase: this.phase },
      players: this.publicPlayers(),
      settings: this.settings,
      phase: this.phase,
      hostId: this.players[0] ? this.players[0].id : null,
    };
  }

  publicPlayers() {
    return this.players.map((p) => ({
      id: p.id, name: p.name, score: p.score, isHost: p.isHost,
      connected: true, team: p.team || null, answered: p.answered,
    }));
  }

  scores() {
    return this.players.map((p) => ({ playerId: p.id, name: p.name, score: p.score }));
  }

  create(settings, names) {
    this.settings = { ...this.settings, ...(settings || {}) };
    const count = Math.min(this.settings.flagCount || 10, FALLBACK_COUNTRIES.length);
    this.deck = shuffle(FALLBACK_COUNTRIES).slice(0, count);
    this.players = (names || ['لاعب 1']).map((name, i) => ({
      id: 'local-p' + i, name: String(name || ('لاعب ' + (i + 1))),
      score: 0, isHost: i === 0, correct: 0, answeredCount: 0,
      bestStreak: 0, streak: 0, fastestMs: null, answered: false, team: null,
    }));
    this.qi = 0;
    this.phase = 'lobby';
    this.missed = [];
    return this.snapshot();
  }

  start() {
    if (this.phase !== 'lobby' && this.phase !== 'ended') return;
    this.phase = 'playing';
    for (const p of this.players) { p.score = 0; p.correct = 0; p.bestStreak = 0; p.streak = 0; p.fastestMs = null; p.answeredCount = 0; }
    this.qi = 0;
    this.missed = [];
    this.nextQuestion();
  }

  nextQuestion() {
    if (this.qi >= this.deck.length) { this.endGame(); return; }
    const country = this.deck[this.qi];
    const pool = shuffle(FALLBACK_COUNTRIES.filter((c) => c.code !== country.code));
    const options = shuffle([country, ...pool.slice(0, 3)]).map((c) => ({
      code: c.code, labelAr: c.ar, labelEn: c.en,
    }));
    const durationMs = (this.settings.durationSec || 15) * 1000;
    const showAt = Date.now() + 600;
    const endsAt = showAt + durationMs;
    this.questionId += 1;
    this.current = { country, options, durationMs, showAt, endsAt, answered: new Set(), firstCorrectId: null, startAt: showAt };
    this.buzzLock = null;
    for (const p of this.players) p.answered = false;
    this.phase = 'playing';
    this.emit({ t: 'q_prepare', questionId: this.questionId, flagUrl: '/flags/' + country.code + '.svg', options, durationMs, turnPlayerId: null });
    this.emit({ t: 'q_start', questionId: this.questionId, showAt, endsAt });
    this.clearTimers();
    this.timer = setTimeout(() => this.revealNow(), endsAt - Date.now() + 50);
  }

  buzz(playerIndex) {
    if (!this.current || this.phase !== 'playing') return null;
    if (this.buzzLock) return this.buzzLock;
    const p = this.players[playerIndex];
    if (!p) return null;
    this.buzzLock = p.id;
    this.emit({ t: 'buzz', playerId: p.id, name: p.name });
    return p.id;
  }

  answer(playerId, payload) {
    const p = this.players.find((x) => x.id === playerId);
    const q = this.current;
    if (!p || !q || this.phase !== 'playing') {
      this.emit({ t: 'answer_ack', accepted: false, correct: false, points: 0, locked: false, questionId: this.questionId });
      return;
    }
    // قفل الجرس ينطبق فقط في وضع buzzer؛ في الوضع الكلاسيكي يجيب كل لاعب مستقلاً.
    const buzzerMode = this.settings.mode === 'buzzer';
    if (buzzerMode && this.buzzLock && this.buzzLock !== playerId) {
      this.emit({ t: 'answer_ack', accepted: false, correct: false, points: 0, locked: false, questionId: this.questionId, playerId });
      return;
    }
    if (q.answered.has(playerId)) {
      this.emit({ t: 'answer_ack', accepted: false, correct: false, points: 0, locked: true, questionId: this.questionId, playerId });
      return;
    }
    if (buzzerMode && this.buzzLock == null) this.buzzLock = playerId;
    q.answered.add(playerId);
    p.answered = true;
    p.answeredCount += 1;
    const now = Date.now();
    const elapsed = Math.max(0, now - q.startAt);
    let correct = false;
    if (typeof payload.choiceIndex === 'number') {
      const opt = q.options[payload.choiceIndex];
      correct = !!opt && opt.code === q.country.code;
    } else if (typeof payload.text === 'string') {
      const t = normText(payload.text);
      correct = t !== '' && (normText(q.country.ar) === t || normText(q.country.en) === t);
    }
    let points = 0;
    if (correct) {
      const remaining = Math.max(0, q.endsAt - now);
      points = 100 + Math.round((remaining / q.durationMs) * 100);
      p.score += points;
      p.correct += 1;
      p.streak += 1;
      p.bestStreak = Math.max(p.bestStreak, p.streak);
      if (p.fastestMs == null || elapsed < p.fastestMs) p.fastestMs = elapsed;
      if (!q.firstCorrectId) q.firstCorrectId = playerId;
    } else {
      p.streak = 0;
      if (this.settings.negativePoints) { points = -50; p.score = Math.max(0, p.score + points); }
    }
    this.emit({ t: 'answer_ack', accepted: true, correct, points, locked: true, questionId: this.questionId, playerId });
    this.emit({ t: 'player_answered', playerId, questionId: this.questionId });
    this.emit({ t: 'scores', scores: this.scores() });
    // في وضع الجرس تكفي إجابة واحدة للكشف؛ وإلا ننتظر إجابة الجميع.
    const allAnswered = this.players.every((x) => q.answered.has(x.id));
    if (buzzerMode || allAnswered) this.revealNow();
  }

  revealNow() {
    if (!this.current || this.phase !== 'playing') return;
    this.clearTimers();
    const q = this.current;
    if (q.firstCorrectId == null) this.missed.push(q.country.code);
    this.emit({
      t: 'q_reveal',
      questionId: this.questionId,
      answerCode: q.country.code,
      answerLabelAr: q.country.ar,
      answerLabelEn: q.country.en,
      capitalAr: q.country.capitalAr,
      capitalEn: q.country.capitalEn,
      continent: q.country.continent,
      firstCorrectId: q.firstCorrectId,
      scores: this.scores(),
    });
    this.phase = 'reveal';
    this.qi += 1;
    this.revealTimer = setTimeout(() => { this.current = null; this.nextQuestion(); }, 5000);
  }

  endGame() {
    this.phase = 'ended';
    this.clearTimers();
    const standings = [...this.players]
      .sort((a, b) => b.score - a.score)
      .map((p) => ({ playerId: p.id, name: p.name, score: p.score }));
    const me = this.players[0];
    const total = this.deck.length;
    const stats = me ? {
      correct: me.correct, total,
      accuracy: total ? me.correct / total : 0,
      bestStreak: me.bestStreak,
      fastestMs: me.fastestMs,
      mostMissed: null,
    } : {};
    const badges = [];
    if (me && total > 0 && me.correct === total) badges.push('علامة كاملة');
    if (me && me.bestStreak >= 3) badges.push('سلسلة ذهبية');
    if (me && me.fastestMs != null && me.fastestMs < 3000) badges.push('البرق');
    this.emit({ t: 'game_end', standings, stats, badges, missed: this.missed });
  }

  pause() {
    if (this.phase !== 'playing' || !this.current) return;
    this.clearTimers();
    const remainingMs = Math.max(0, this.current.endsAt - Date.now());
    this.phase = 'paused';
    this._pausedRemaining = remainingMs;
    this.emit({ t: 'paused', remainingMs });
  }

  resumeGame() {
    if (this.phase !== 'paused' || !this.current) return;
    const endsAt = Date.now() + (this._pausedRemaining || 5000);
    this.current.endsAt = endsAt;
    this.phase = 'playing';
    this.emit({ t: 'resumed', endsAt, resumeAt: Date.now() });
    this.timer = setTimeout(() => this.revealNow(), this._pausedRemaining || 5000);
  }

  skipFlag() { this.revealNow(); }
}

// ---------------------------------------------------------------------------
// محاولة استخدام المحرك المشترك: probe سريع عند الإنشاء.
// يعيد true إن بدا المحرك صالحاً للاستخدام.
// ---------------------------------------------------------------------------
function probeEngine(settings) {
  try {
    if (typeof createGame !== 'function' || typeof beginQuestion !== 'function') return false;
    const g = createGame({ ...(DEFAULT_SETTINGS || {}), ...(settings || {}) });
    if (!g || typeof g !== 'object') return false;
    if (typeof startGame === 'function') startGame(g);
    const q = beginQuestion(g);
    if (!q || typeof q !== 'object') return false;
    const flagUrl = q.flagUrl || q.flag || (q.code ? '/flags/' + q.code + '.svg' : null);
    const options = q.options || q.choices;
    if (!flagUrl || !Array.isArray(options) || options.length === 0) return false;
    return true;
  } catch (_e) {
    return false;
  }
}

// محرك يستخدم المحرك المشترك مباشرة (يُستخدم فقط بعد نجاح probe).
class EngineHost {
  constructor(emit) {
    this.emit = emit;
    this.game = null;
    this.settings = { ...(DEFAULT_SETTINGS || {}) };
    this.players = [];
    this.timer = null;
    this.revealTimer = null;
    this.phase = 'lobby';
    this.questionId = 0;
    this.current = null;
    this.missed = [];
  }

  clearTimers() {
    if (this.timer) clearTimeout(this.timer);
    if (this.revealTimer) clearTimeout(this.revealTimer);
    this.timer = null; this.revealTimer = null;
  }

  _publicPlayers() {
    try {
      const pub = typeof serializePublic === 'function' ? serializePublic(this.game) : null;
      const arr = pub?.players || pub?.room?.players || this.game?.players;
      if (Array.isArray(arr)) return arr;
    } catch (_e) { /* ignore */ }
    return this.players;
  }

  snapshot() {
    return {
      t: 'room_snapshot', code: 'LOCAL',
      room: { code: 'LOCAL', settings: this.settings, players: this._publicPlayers(), phase: this.phase },
      players: this._publicPlayers(), settings: this.settings, phase: this.phase,
      hostId: this.players[0] ? this.players[0].id : null,
    };
  }

  create(settings, names) {
    this.settings = { ...(DEFAULT_SETTINGS || {}), ...(settings || {}) };
    this.game = createGame(this.settings);
    this.players = (names || ['لاعب 1']).map((name, i) => ({
      id: 'local-p' + i, name: String(name || ('لاعب ' + (i + 1))),
      score: 0, isHost: i === 0, correct: 0, bestStreak: 0, fastestMs: null,
    }));
    if (typeof this.game.addPlayer === 'function') {
      for (const p of this.players) { try { this.game.addPlayer(p); } catch (_e) { /* ignore */ } }
    } else if (Array.isArray(this.game.players) && this.game.players.length === 0) {
      for (const p of this.players) this.game.players.push(p);
    }
    this.phase = 'lobby';
    this.missed = [];
    return this.snapshot();
  }

  start() {
    try { startGame(this.game); } catch (_e) { /* ignore */ }
    this.phase = 'playing';
    this.questionId = 0;
    this._begin();
  }

  _begin() {
    let q;
    try { q = beginQuestion(this.game); } catch (_e) { q = null; }
    if (!q) { this._endGame(); return; }
    const durationMs = q.durationMs || (this.settings.durationSec || 15) * 1000;
    const showAt = Date.now() + 600;
    const endsAt = showAt + durationMs;
    this.questionId += 1;
    this.current = { q, durationMs, showAt, endsAt, answered: new Set() };
    const flagUrl = q.flagUrl || q.flag || (q.code ? '/flags/' + q.code + '.svg' : '');
    const options = (q.options || q.choices || []).map((o) => (
      typeof o === 'string' ? { code: o, labelAr: o, labelEn: o } : o
    ));
    this.emit({ t: 'q_prepare', questionId: this.questionId, flagUrl, options, durationMs, turnPlayerId: q.turnPlayerId || null });
    this.emit({ t: 'q_start', questionId: this.questionId, showAt, endsAt });
    this.clearTimers();
    this.timer = setTimeout(() => this._reveal(), endsAt - Date.now() + 50);
  }

  answer(playerId, payload) {
    if (!this.current) return;
    const q = this.current;
    if (q.answered.has(playerId)) {
      this.emit({ t: 'answer_ack', accepted: false, correct: false, points: 0, locked: true, questionId: this.questionId, playerId });
      return;
    }
    q.answered.add(playerId);
    let res = null;
    try {
      const ans = payload.choiceIndex != null ? payload.choiceIndex : payload.text;
      res = submitAnswer(this.game, playerId, ans);
    } catch (_e) { res = null; }
    let correct = !!(res && (res.correct === true || res.isCorrect === true));
    if (res == null && typeof checkAnswer === 'function') {
      try {
        const ans = payload.choiceIndex != null ? payload.choiceIndex : payload.text;
        correct = !!checkAnswer(q.q, ans);
      } catch (_e) { /* ignore */ }
    }
    const points = (res && typeof res.points === 'number') ? res.points : (correct ? 100 : 0);
    this.emit({ t: 'answer_ack', accepted: true, correct, points, locked: true, questionId: this.questionId, playerId });
    this.emit({ t: 'player_answered', playerId, questionId: this.questionId });
    this.emit({ t: 'scores', scores: this._publicPlayers().map((p) => ({ playerId: p.id, name: p.name, score: p.score || 0 })) });
    if (this._publicPlayers().every((p) => q.answered.has(String(p.id)))) this._reveal();
  }

  _reveal() {
    if (!this.current) return;
    this.clearTimers();
    let info = null;
    try { info = reveal(this.game); } catch (_e) { info = null; }
    const q = this.current.q;
    const code = info?.answerCode || info?.code || q.answerCode || q.code || '';
    this.emit({
      t: 'q_reveal', questionId: this.questionId,
      answerCode: code,
      answerLabelAr: info?.answerLabelAr || info?.labelAr || q.answerLabelAr || '',
      answerLabelEn: info?.answerLabelEn || info?.labelEn || q.answerLabelEn || '',
      capitalAr: info?.capitalAr || q.capitalAr || '',
      capitalEn: info?.capitalEn || q.capitalEn || '',
      continent: info?.continent || q.continent || '',
      firstCorrectId: info?.firstCorrectId || null,
      scores: this._publicPlayers().map((p) => ({ playerId: p.id, name: p.name, score: p.score || 0 })),
    });
    this.phase = 'reveal';
    this.revealTimer = setTimeout(() => {
      this.current = null;
      let next = null;
      try { next = advance(this.game); } catch (_e) { next = null; }
      if (next === false || next === null || next === 'end' || next?.ended) this._endGame();
      else this._begin();
    }, 5000);
  }

  _endGame() {
    this.phase = 'ended';
    this.clearTimers();
    const players = this._publicPlayers();
    const standings = [...players].sort((a, b) => (b.score || 0) - (a.score || 0))
      .map((p) => ({ playerId: p.id, name: p.name, score: p.score || 0 }));
    this.emit({ t: 'game_end', standings, stats: {}, badges: [], missed: this.missed });
  }

  buzz(playerIndex) {
    const p = this.players[playerIndex];
    if (!p) return null;
    this.emit({ t: 'buzz', playerId: p.id, name: p.name });
    return p.id;
  }

  pause() { this.emit({ t: 'paused', remainingMs: this.current ? Math.max(0, this.current.endsAt - Date.now()) : 0 }); }
  resumeGame() {
    if (!this.current) return;
    const endsAt = Date.now() + Math.max(1000, this.current.endsAt - Date.now());
    this.emit({ t: 'resumed', endsAt, resumeAt: Date.now() });
  }
  skipFlag() { this._reveal(); }
}

// ---------------------------------------------------------------------------
// النقل المحلي نفسه
// ---------------------------------------------------------------------------
export class LocalTransport {
  constructor() {
    this.kind = 'local';
    this.onmessage = null;
    this.onstatus = null;
    this.onSeqGap = null;
    this._seq = 0;
    this._timers = [];
    this._host = null;
    this._settings = null;
    this._names = null;
    this._closed = false;
  }

  connect() {
    if (typeof this.onstatus === 'function') { try { this.onstatus('connected'); } catch (_e) { /* ignore */ } }
    return Promise.resolve();
  }

  _emit(msg) {
    if (this._closed) return;
    const out = { ...msg, seq: ++this._seq };
    if (typeof this.onmessage === 'function') {
      try { this.onmessage(out); } catch (_e) { /* ignore */ }
    }
  }

  _later(fn, ms) {
    const t = setTimeout(fn, ms);
    this._timers.push(t);
    return t;
  }

  _ensureHost(settings, names) {
    if (this._host) return this._host;
    const useEngine = probeEngine(settings);
    this._host = useEngine ? new EngineHost((m) => this._emit(m)) : new FallbackHost((m) => this._emit(m));
    return this._host;
  }

  send(msg) {
    if (!msg || typeof msg.t !== 'string') return;
    try {
      switch (msg.t) {
        case 'hello':
          break;
        case 'create_room': {
          const names = Array.isArray(msg.localPlayers) && msg.localPlayers.length > 0
            ? msg.localPlayers
            : [msg.name || 'لاعب 1'];
          this._settings = msg.settings || {};
          this._names = names;
          const host = this._ensureHost(this._settings, names);
          const snap = host.create(this._settings, names);
          this._emit({ ...snap, t: 'room_snapshot' });
          break;
        }
        case 'join_local': {
          const names = [msg.name || 'لاعب 1'];
          this._settings = msg.settings || {};
          this._names = names;
          const host = this._ensureHost(this._settings, names);
          const snap = host.create(this._settings, names);
          this._emit({ ...snap, t: 'room_snapshot' });
          break;
        }
        case 'start':
          if (this._host) this._host.start();
          break;
        case 'answer':
          if (this._host) {
            const playerId = msg.playerId || (this._host.players && this._host.players[0] ? this._host.players[0].id : 'local-p0');
            this._host.answer(playerId, { choiceIndex: msg.choiceIndex, text: msg.text });
          }
          break;
        case 'buzz':
          if (this._host && typeof msg.playerIndex === 'number') this._host.buzz(msg.playerIndex);
          break;
        case 'pause':
          if (this._host) this._host.pause();
          break;
        case 'resume_game':
          if (this._host) this._host.resumeGame();
          break;
        case 'skip_flag':
          if (this._host) this._host.skipFlag();
          break;
        case 'skip_vote':
          if (this._host) this._host.skipFlag();
          break;
        case 'rematch':
          if (this._host) this._host.start();
          break;
        case 'replay_missed': {
          // إعادة الأعلام الخاطئة: ابدأ لعبة جديدة بنفس اللاعبين.
          if (this._host && this._names) {
            const host = this._host;
            const missed = host.missed || [];
            if (missed.length > 0 && host instanceof FallbackHost) {
              host.deck = host.deck.filter((c) => missed.includes(c.code));
              if (host.deck.length === 0) host.deck = shuffle(FALLBACK_COUNTRIES).slice(0, 10);
              host.start();
            } else if (this._names) {
              host.start();
            }
          }
          break;
        }
        case 'leave':
          if (this._host) { this._host.clearTimers(); }
          this._host = null;
          break;
        case 'set_settings':
          if (msg.settings) {
            this._settings = { ...(this._settings || {}), ...msg.settings };
            if (this._host) this._host.settings = this._settings;
          }
          break;
        case 'react':
          this._emit({ t: 'reaction', playerId: msg.playerId || 'local-p0', emoji: msg.emoji });
          break;
        case 'ready':
        case 'ping':
          break;
        default:
          break;
      }
    } catch (_e) {
      this._emit({ t: 'error', code: 'local_error', message: 'خطأ في اللعبة المحلية' });
    }
  }

  buzz(playerIndex) {
    if (this._host && typeof this._host.buzz === 'function') return this._host.buzz(playerIndex);
    return null;
  }

  sendResume() {
    if (this._host) this._emit({ ...this._host.snapshot(), t: 'room_snapshot' });
  }

  close() {
    this._closed = true;
    if (this._host) { try { this._host.clearTimers(); } catch (_e) { /* ignore */ } }
    for (const t of this._timers) clearTimeout(t);
    this._timers = [];
    this._host = null;
  }
}
