// المتحكم الرئيسي للعبة «أعلام الدول» — يعمل مع النقل الشبكي أو المحلي بالتبادل.
// لا يثق العميل أبداً بحالة اللعبة في الوضع الأونلاين: كل الحقائق تأتي من الخادم.
import { STR } from './i18n-ar.js';
import { TimeSync } from './timesync.js';
import { WebSocketTransport } from './net.js';
import { SoundFX } from './audio.js';
import { showScreen, renderScoreboard, renderPlayerList, renderStandings, renderStats, renderBadges, renderLeaderboard, clearScoreboard } from './ui/screens.js';
import { startConfetti } from './ui/confetti.js';
import { showToast } from './ui/toast.js';

const $ = (id) => document.getElementById(id);
const CIRCUMFERENCE = 2 * Math.PI * 54;

const state = {
  transport: null,
  transportKind: null, // 'ws' | 'local'
  room: null,
  code: null,
  playerId: null,
  secret: null,
  name: '',
  isHost: false,
  judging: false,
  judgeDecisions: {},
  isDisplay: false,
  settings: {},
  players: [],
  currentQuestion: null,
  pendingQuestion: null,
  endsAt: 0,
  showAt: 0,
  answered: false,
  myChoiceIndex: null,
  myCorrect: null,
  myPoints: 0,
  answeredIds: new Set(),
  timerRaf: 0,
  showTimer: 0,
  lastTickSecond: -1,
  lastReactionAt: 0,
  localAnswerer: 0,
  localNames: [],
  countdown: null,
  dailyDate: null,
  preloaded: new Map(),
  countriesData: null,
};

const sfx = new SoundFX();
let timeSync = null;
let stopConfetti = null;

// ---------- أدوات مساعدة ----------
function myPlayer() {
  return state.players.find((p) => String(p.id) === String(state.playerId)) || null;
}

function saveSession() {
  try {
    if (state.playerId && state.code) {
      localStorage.setItem('flags-session', JSON.stringify({
        playerId: state.playerId, secret: state.secret, code: state.code, name: state.name,
      }));
    }
  } catch (_e) { /* ignore */ }
}

function loadSession() {
  try {
    const raw = localStorage.getItem('flags-session');
    return raw ? JSON.parse(raw) : null;
  } catch (_e) { return null; }
}

function clearSession() {
  try { localStorage.removeItem('flags-session'); } catch (_e) { /* ignore */ }
}

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return proto + '//' + location.host + '/ws';
}

function setConnDot(quality) {
  const dot = $('conn-dot');
  if (!dot) return;
  dot.className = 'conn-dot ' + quality;
  dot.title = quality === 'good' ? STR.connGood : quality === 'medium' ? STR.connMedium : quality === 'bad' ? STR.connBad : STR.connOffline;
}

function setStatus(text) {
  const el = $('status-line');
  if (el) el.textContent = text || '';
}

// ---------- التفضيلات: السمة / حجم الخط / الصوت ----------
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('flags-theme', theme); } catch (_e) { /* ignore */ }
  const btn = $('btn-theme');
  if (btn) btn.textContent = theme === 'light' ? STR.themeDark : STR.themeLight;
}

function applyFont(size) {
  document.documentElement.dataset.font = size;
  try { localStorage.setItem('flags-font', size); } catch (_e) { /* ignore */ }
  const sel = $('font-size');
  if (sel) sel.value = size;
}

function applyMute() {
  const btn = $('btn-sound');
  if (btn) btn.textContent = sfx.muted ? STR.soundOff : STR.soundOn;
  btn?.setAttribute('aria-pressed', String(!sfx.muted));
}

// ---------- النقل ----------
function ensureTimeSync() {
  if (!timeSync) {
    timeSync = new TimeSync((c) => {
      if (state.transport) state.transport.send({ t: 'ping', c });
    });
    timeSync.bindVisibility();
  }
  return timeSync;
}

function attachTransport(transport, kind) {
  state.transport = transport;
  state.transportKind = kind;
  transport.onmessage = (msg) => handleMessage(msg);
  transport.onstatus = (s) => handleStatus(s);
  transport.onSeqGap = () => {
    // فجوة في التسلسل: اطلب لقطة جديدة عبر resume.
    const sess = loadSession();
    if (sess && state.transportKind === 'ws') {
      state.transport.sendResume(sess.playerId, sess.secret, sess.code);
    }
  };
}

async function ensureWs() {
  if (state.transportKind === 'ws' && state.transport) return state.transport;
  if (state.transport) { try { state.transport.close(); } catch (_e) { /* ignore */ } }
  ensureTimeSync();
  const t = new WebSocketTransport(wsUrl());
  attachTransport(t, 'ws');
  await t.connect();
  t.send({ t: 'hello', version: 1 });
  timeSync.start();
  timeSync.startPeriodic();
  return t;
}

async function ensureLocal() {
  if (state.transportKind === 'local' && state.transport) return state.transport;
  if (state.transport) { try { state.transport.close(); } catch (_e) { /* ignore */ } }
  const { LocalTransport } = await import('./local-transport.js');
  const t = new LocalTransport();
  attachTransport(t, 'local');
  await t.connect();
  return t;
}

function send(msg) {
  if (!state.transport) return;
  try { state.transport.send(msg); } catch (_e) { /* ignore */ }
}

function handleStatus(s) {
  const banner = $('reconnect-banner');
  if (s === 'connected') {
    setConnDot(timeSync ? timeSync.quality() : 'good');
    if (banner) banner.hidden = true;
    const sess = loadSession();
    if (sess && state.transportKind === 'ws' && state.code) {
      send({ t: 'resume', playerId: sess.playerId, secret: sess.secret, code: sess.code });
    }
  } else if (s === 'reconnecting') {
    setConnDot('bad');
    if (banner) {
      banner.hidden = false;
      banner.textContent = STR.reconnecting;
    }
  } else if (s === 'failed') {
    setConnDot('bad');
    if (banner) {
      banner.hidden = false;
      banner.textContent = STR.reconnectFailed;
    }
  } else {
    setConnDot('bad');
  }
}

// ---------- تطبيع لقطة الغرفة ----------
function normalizeSnapshot(msg) {
  const room = msg.room || msg.state || {};
  const players = msg.players || room.players || msg.state?.players || [];
  const settings = msg.settings || room.settings || msg.state?.settings || {};
  const code = msg.code || room.code || state.code;
  const phase = msg.phase || room.phase || msg.state?.phase || 'lobby';
  return { players, settings, code, phase, room };
}

function refreshHostFlag() {
  const me = myPlayer();
  const snapHost = state.room?.hostId;
  state.isHost = !!(me && (me.isHost === true || (snapHost && String(snapHost) === String(state.playerId))));
  const startBtn = $('btn-start');
  if (startBtn) startBtn.disabled = !state.isHost;
  const panel = $('settings-panel');
  if (panel) {
    const controls = panel.querySelectorAll('input, select, button');
    controls.forEach((c) => { c.disabled = !state.isHost; });
  }
}

// ---------- معالجة رسائل الخادم ----------
function handleMessage(msg) {
  if (!msg || typeof msg.t !== 'string') return;
  switch (msg.t) {
    case 'welcome':
      if (msg.playerId) state.playerId = msg.playerId;
      if (msg.secret) state.secret = msg.secret;
      if (msg.name) state.name = msg.name;
      saveSession();
      break;

    case 'pong':
      ensureTimeSync().handlePong(msg);
      setConnDot(timeSync.quality());
      break;

    case 'room_snapshot': {
      const snap = normalizeSnapshot(msg);
      state.players = snap.players;
      state.settings = snap.settings;
      state.code = snap.code;
      state.room = snap.room;
      if (msg.hostId) state.room.hostId = msg.hostId;
      saveSession();
      refreshHostFlag();
      if (state.isDisplay) {
        renderDisplayScores();
        showScreen('display');
      } else if (snap.phase === 'lobby') {
        renderLobby();
        showScreen('lobby');
      } else if (snap.phase === 'playing' || snap.phase === 'reveal' || snap.phase === 'paused') {
        renderLobby();
        renderScoreboard(state.players, { currentPlayerId: state.playerId, answeredIds: state.answeredIds });
        showScreen('play');
      } else if (snap.phase === 'ended' && msg.standings) {
        renderResults(msg);
      }
      break;
    }

    case 'player_update': {
      const snap = normalizeSnapshot(msg);
      if (snap.players.length) state.players = snap.players;
      if (snap.settings && Object.keys(snap.settings).length) state.settings = snap.settings;
      refreshHostFlag();
      renderLobby();
      renderScoreboard(state.players, { currentPlayerId: state.playerId, answeredIds: state.answeredIds });
      break;
    }

    case 'scores':
      if (Array.isArray(msg.scores)) {
        for (const s of msg.scores) {
          const p = state.players.find((x) => String(x.id) === String(s.playerId));
          if (p) p.score = s.score ?? s.points ?? p.score;
        }
        renderScoreboard(state.players, { currentPlayerId: state.playerId, answeredIds: state.answeredIds });
        renderDisplayScores();
      }
      break;

    case 'q_prepare': {
      const q = {
        questionId: msg.questionId,
        flagUrl: msg.flagUrl,
        options: msg.options || [],
        durationMs: msg.durationMs || (state.settings.durationSec || 15) * 1000,
        turnPlayerId: msg.turnPlayerId || null,
      };
      state.pendingQuestion = q;
      preloadFlag(q.flagUrl, q.questionId);
      send({ t: 'ready', questionId: msg.questionId });
      setStatus(STR.getReady);
      break;
    }

    case 'q_start': {
      const base = state.pendingQuestion && state.pendingQuestion.questionId === msg.questionId
        ? state.pendingQuestion
        : { questionId: msg.questionId, flagUrl: msg.flagUrl, options: msg.options || [], durationMs: msg.durationMs, turnPlayerId: msg.turnPlayerId || null };
      state.currentQuestion = base;
      state.showAt = msg.showAt || Date.now();
      state.endsAt = msg.endsAt || (state.showAt + (base.durationMs || 15000));
      state.answered = false;
      state.myChoiceIndex = null;
      state.myCorrect = null;
      state.answeredIds = new Set();
      state.lastTickSecond = -1;
      clearTimeout(state.showTimer);
      const now = ensureTimeSync().serverNow();
      const delay = Math.max(0, state.showAt - now);
      if (state.isDisplay) {
        showScreen('display');
        renderDisplayQuestion(base);
        startTimerLoop();
      } else {
        showScreen('play');
        setStatus(STR.getReady);
        renderCountdown(delay);
        state.showTimer = setTimeout(() => showQuestion(base), delay);
        startTimerLoop();
      }
      break;
    }

    case 'answer_ack': {
      if (msg.questionId !== state.currentQuestion?.questionId) break;
      state.answered = true;
      state.myCorrect = msg.correct === true ? true : msg.correct === false ? false : null;
      state.myPoints = msg.points || 0;
      // وضع التقييم اليدوي: الإجابة وصلت فقط؛ لا صح/خطأ قبل انتهاء الوقت والتقييم.
      setStatus(msg.pendingJudge ? STR.judgeSubmitted : (msg.accepted ? STR.answerReceived : STR.errorTooLate));
      if (msg.accepted === false && msg.correct === false && state.myChoiceIndex != null) {
        markOption(state.myChoiceIndex, 'wrong');
      }
      lockOptions(true);
      break;
    }

    case 'player_answered': {
      if (msg.playerId) state.answeredIds.add(String(msg.playerId));
      renderScoreboard(state.players, { currentPlayerId: state.playerId, answeredIds: state.answeredIds, turnPlayerId: state.currentQuestion?.turnPlayerId });
      break;
    }

    case 'buzz': {
      const p = state.players.find((x) => String(x.id) === String(msg.playerId));
      setStatus((p ? p.name : '') + ' — ' + STR.playerBuzzed);
      break;
    }

    case 'q_reveal': {
      stopTimerLoop();
      state.judging = false;
      hideJudgePanel();
      if (msg.scores) {
        for (const s of msg.scores) {
          const p = state.players.find((x) => String(x.id) === String(s.playerId));
          if (p) p.score = s.score ?? s.points ?? p.score;
        }
      }
      renderScoreboard(state.players, { currentPlayerId: state.playerId, answeredIds: state.answeredIds });
      renderDisplayScores();
      showReveal(msg);
      if (state.myCorrect === true) sfx.play('correct');
      else if (state.myCorrect === false) sfx.play('wrong');
      break;
    }

    case 'judging': {
      // انتهى الوقت: الإجابات تُجمَع والمضيف يقيّمها. لا كشف للنتائج بعد.
      state.judging = true;
      hideJudgePanel();
      setStatus(STR.judgeWaiting);
      break;
    }

    case 'judge_request': {
      // أنت المضيف: قيّم إجابات اللاعبين.
      state.judging = true;
      if (state.isHost) renderJudgePanel(msg);
      else setStatus(STR.judgeWaiting);
      break;
    }

    case 'judged': {
      state.judging = false;
      hideJudgePanel();
      setStatus(msg.auto ? STR.judgeAuto : STR.judgeDone);
      if (Array.isArray(msg.results)) {
        const mine = msg.results.find((r) => String(r.playerId) === String(state.playerId));
        if (mine) { state.myCorrect = !!mine.correct; state.myPoints = mine.points || 0; }
      }
      break;
    }

    case 'paused': {
      stopTimerLoop();
      setStatus(STR.paused + (msg.remainingMs != null ? ' — ' + Math.ceil(msg.remainingMs / 1000) + ' ' + STR.seconds : ''));
      break;
    }

    case 'resumed': {
      if (msg.endsAt) state.endsAt = msg.endsAt;
      setStatus('');
      startTimerLoop();
      break;
    }

    case 'game_end':
      stopTimerLoop();
      renderResults(msg);
      break;

    case 'reaction':
      if (msg.emoji) renderFloatingReaction(msg.emoji);
      break;

    case 'error': {
      const code = msg.code || '';
      const map = {
        room_not_found: STR.errorRoomNotFound,
        room_full: STR.errorRoomFull,
        wrong_password: STR.errorWrongPassword,
        not_host: STR.errorNotHost,
        game_started: STR.errorGameStarted,
        too_late: STR.errorTooLate,
        already_answered: STR.errorAlreadyAnswered,
      };
      showToast(map[code] || msg.message || STR.errorGeneric);
      break;
    }

    default:
      break;
  }
}

// ---------- الغرفة ----------
function renderLobby() {
  const codeEl = $('room-code');
  if (codeEl) codeEl.textContent = state.code || '—';
  const numEl = $('room-number');
  if (numEl) numEl.textContent = state.code ? STR.roomNumber + ': ' + state.code : '';
  renderPlayerList(state.players, state.playerId, state.isHost, {
    onKick: (id) => { if (window.confirm(STR.confirmKick)) send({ t: 'kick', playerId: id }); },
    onTransferHost: (id) => send({ t: 'transfer_host', playerId: id }),
  });
  fillSettingsForm(state.settings);
  updateAvailableFlags();
  refreshHostFlag();
}

function readSettingsFromForm() {
  const get = (id) => $(id);
  const checkedValues = (name) => [...document.querySelectorAll('input[name="' + name + '"]:checked')].map((c) => c.value);
  const s = { ...(state.settings || {}) };
  if (get('set-flagCount')) s.flagCount = get('set-flagCount').value === 'custom' ? Number(get('set-flagCount-custom')?.value || 10) : Number(get('set-flagCount').value);
  if (get('set-maxPlayers')) s.maxPlayers = Number(get('set-maxPlayers').value);
  if (get('set-mode')) s.mode = get('set-mode').value;
  if (get('set-answerMode')) s.answerMode = get('set-answerMode').value;
  if (get('set-scoring')) s.scoring = get('set-scoring').value;
  if (get('set-durationSec')) s.durationSec = Number(get('set-durationSec').value);
  if (get('set-answerType')) s.answerType = get('set-answerType').value;
  s.continents = checkedValues('continent');
  if (get('set-arabOnly')) s.arabOnly = get('set-arabOnly').checked;
  if (get('set-similarOnly')) s.similarOnly = get('set-similarOnly').checked;
  if (get('set-rareOnly')) s.rareOnly = get('set-rareOnly').checked;
  if (get('set-difficulty')) s.difficulty = get('set-difficulty').value;
  s.questionTypes = checkedValues('questionType');
  if (get('set-hint')) s.hint = get('set-hint').value;
  if (get('set-negativePoints')) s.negativePoints = get('set-negativePoints').checked;
  if (get('set-lateJoin')) s.lateJoin = get('set-lateJoin').checked;
  if (get('set-password')) s.password = get('set-password').value;
  if (get('set-seed')) s.seed = get('set-seed').value;
  return s;
}

function fillSettingsForm(s) {
  if (!s) return;
  const setVal = (id, v) => { const el = $(id); if (el && v !== undefined && v !== null) el.value = String(v); };
  const setChk = (id, v) => { const el = $(id); if (el) el.checked = !!v; };
  setVal('set-flagCount', [10, 20, 30, 50, 195].includes(Number(s.flagCount)) ? s.flagCount : 'custom');
  if (s.flagCount && ![10, 20, 30, 50, 195].includes(Number(s.flagCount))) setVal('set-flagCount-custom', s.flagCount);
  setVal('set-maxPlayers', s.maxPlayers);
  setVal('set-mode', s.mode);
  setVal('set-answerMode', s.answerMode);
  setVal('set-scoring', s.scoring);
  setVal('set-durationSec', s.durationSec);
  setVal('set-answerType', s.answerType);
  setVal('set-difficulty', s.difficulty);
  setVal('set-hint', s.hint);
  setChk('set-arabOnly', s.arabOnly);
  setChk('set-similarOnly', s.similarOnly);
  setChk('set-rareOnly', s.rareOnly);
  setChk('set-negativePoints', s.negativePoints);
  setChk('set-lateJoin', s.lateJoin);
  setVal('set-password', s.password);
  setVal('set-seed', s.seed);
  if (Array.isArray(s.continents)) {
    document.querySelectorAll('input[name="continent"]').forEach((c) => { c.checked = s.continents.includes(c.value); });
  }
  if (Array.isArray(s.questionTypes)) {
    document.querySelectorAll('input[name="questionType"]').forEach((c) => { c.checked = s.questionTypes.includes(c.value); });
  }
}

async function loadCountriesData() {
  if (state.countriesData) return state.countriesData;
  try {
    const mod = await import('../../shared/countries.js');
    state.countriesData = mod.COUNTRIES || mod.default || null;
  } catch (_e) {
    state.countriesData = null;
  }
  return state.countriesData;
}

async function updateAvailableFlags() {
  const el = $('available-flags');
  if (!el) return;
  const data = await loadCountriesData();
  if (!data || !Array.isArray(data)) {
    el.textContent = '';
    return;
  }
  const s = readSettingsFromForm();
  let list = data;
  if (s.arabOnly) list = list.filter((c) => c.arab === true || c.arabOnly === true);
  if (s.continents && s.continents.length) list = list.filter((c) => s.continents.includes(c.continent));
  el.textContent = STR.flagsAvailable + ': ' + list.length;
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => fallbackCopy(text));
  }
  return Promise.resolve(fallbackCopy(text));
}

function fallbackCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    return true;
  } catch (_e) { return false; }
}

async function shareRoom() {
  const url = location.origin + location.pathname + '?room=' + encodeURIComponent(state.code || '');
  const text = STR.shareRoomText + ' ' + (state.code || '');
  if (navigator.share) {
    try { await navigator.share({ title: STR.appTitle, text, url }); return; } catch (_e) { /* fallback */ }
  }
  const ok = await copyText(url);
  showToast(ok ? STR.linkCopied : STR.shareFailed);
}

// ---------- اللعب ----------
function preloadFlag(flagUrl, questionId) {
  if (!flagUrl) return;
  try {
    const img = new Image();
    img.src = flagUrl;
    if (img.decode) img.decode().catch(() => {});
    if (questionId != null) state.preloaded.set(questionId, img);
  } catch (_e) { /* ignore */ }
}

function renderCountdown(delayMs) {
  const cd = $('countdown');
  if (!cd) return;
  const n = Math.max(1, Math.ceil(delayMs / 1000));
  cd.hidden = false;
  cd.textContent = String(n);
}

function showQuestion(q) {
  const cd = $('countdown');
  if (cd) cd.hidden = true;
  const img = $('flag-img');
  if (img) {
    img.classList.remove('flag-enter');
    void img.offsetWidth;
    img.src = q.flagUrl || '';
    img.alt = STR.playTitle;
    img.classList.add('flag-enter');
  }
  const prompt = $('question-prompt');
  if (prompt) {
    const at = state.settings.answerType || 'country';
    prompt.textContent = at === 'capital' ? STR.playCapital : at === 'continent' ? STR.playContinent : STR.playTitle;
  }
  const reveal = $('reveal-info');
  if (reveal) reveal.hidden = true;
  buildOptions(q);
  updateBuzzRow();
  const isMyTurn = !q.turnPlayerId || String(q.turnPlayerId) === String(state.playerId)
    || (state.transportKind === 'local' && String(q.turnPlayerId) === String(state.players[state.localAnswerer]?.id));
  setStatus(q.turnPlayerId
    ? (isMyTurn ? STR.yourTurn : STR.waitTurn)
    : '');
  lockOptions(!isMyTurn);
  renderScoreboard(state.players, { currentPlayerId: state.playerId, answeredIds: state.answeredIds, turnPlayerId: q.turnPlayerId });
}

function buildOptions(q) {
  const grid = $('options');
  const typingWrap = $('typing-wrap');
  const input = $('answer-input');
  const useTyping = !q.options || q.options.length === 0 || state.settings.answerMode === 'typing' || state.settings.answerMode === 'write_then_judge';
  if (grid) grid.textContent = '';
  if (useTyping) {
    if (grid) grid.hidden = true;
    if (typingWrap) typingWrap.hidden = false;
    if (input) { input.value = ''; input.disabled = false; setTimeout(() => input.focus({ preventScroll: true }), 50); }
    return;
  }
  if (grid) grid.hidden = false;
  if (typingWrap) typingWrap.hidden = true;
  (q.options || []).forEach((opt, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'option-btn';
    btn.dataset.index = String(i);
    btn.dataset.code = opt.code || '';
    const label = document.createElement('span');
    label.className = 'option-label';
    label.textContent = opt.labelAr || opt.label || opt.labelEn || opt.code || '';
    btn.appendChild(label);
    if (opt.labelEn && opt.labelEn !== label.textContent) {
      const sub = document.createElement('small');
      sub.className = 'option-sub';
      sub.textContent = opt.labelEn;
      btn.appendChild(sub);
    }
    btn.addEventListener('click', () => onChoose(i));
    grid.appendChild(btn);
  });
}

function lockOptions(locked) {
  document.querySelectorAll('#options .option-btn').forEach((b) => { b.disabled = locked; });
  const input = $('answer-input');
  if (input) input.disabled = locked;
  const submit = $('btn-answer-submit');
  if (submit) submit.disabled = locked;
}

function markOption(index, cls) {
  const btn = document.querySelector('#options .option-btn[data-index="' + index + '"]');
  if (btn) btn.classList.add(cls);
}

function currentAnswerPlayerId() {
  if (state.transportKind === 'local') {
    const p = state.players[state.localAnswerer];
    return p ? p.id : state.playerId;
  }
  return state.playerId;
}

function onChoose(index) {
  if (state.answered || !state.currentQuestion) return;
  sfx.ensure();
  sfx.play('click');
  state.myChoiceIndex = index;
  markOption(index, 'selected');
  const msg = { t: 'answer', questionId: state.currentQuestion.questionId, choiceIndex: index };
  if (state.transportKind === 'local') msg.playerId = currentAnswerPlayerId();
  send(msg);
  state.answered = true;
  lockOptions(true);
  setStatus(STR.answerReceived);
}

function onSubmitTyping() {
  if (state.answered || !state.currentQuestion) return;
  const input = $('answer-input');
  const text = (input?.value || '').trim();
  if (!text) return;
  sfx.ensure();
  const isJudge = state.settings.answerMode === 'write_then_judge';
  const msg = { t: isJudge ? 'submit_text_answer' : 'answer', questionId: state.currentQuestion.questionId, text };
  if (state.transportKind === 'local') msg.playerId = currentAnswerPlayerId();
  send(msg);
  state.answered = true;
  lockOptions(true);
  setStatus(isJudge ? STR.judgeSubmitted : STR.answerReceived);
}

// ---------- لوحة تقييم المضيف (وضع write_then_judge) ----------
function hideJudgePanel() {
  const panel = $('judge-panel');
  if (panel) panel.hidden = true;
}

function renderJudgePanel(msg) {
  const panel = $('judge-panel');
  if (!panel) return;
  const list = $('judge-list');
  const ref = $('judge-correct-answer');
  if (ref) ref.textContent = msg.answerLabelAr || msg.answerLabelEn || '';
  if (list) list.textContent = '';
  state.judgeDecisions = {};
  (msg.answers || []).forEach((a) => {
    const row = document.createElement('div');
    row.className = 'judge-row';
    const nameEl = document.createElement('span');
    nameEl.className = 'judge-name';
    nameEl.textContent = a.name || a.playerId;
    const textEl = document.createElement('span');
    textEl.className = 'judge-answer';
    textEl.textContent = a.text || '—';
    const hintEl = document.createElement('span');
    hintEl.className = 'judge-hint';
    hintEl.textContent = a.suggestedCorrect ? STR.judgeHintCorrect : STR.judgeHintWrong;
    const btns = document.createElement('span');
    btns.className = 'judge-buttons';
    const mk = (label, val) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-small judge-btn';
      b.textContent = label;
      b.addEventListener('click', () => {
        state.judgeDecisions[a.playerId] = val;
        btns.querySelectorAll('.judge-btn').forEach((x) => x.classList.remove('selected'));
        b.classList.add('selected');
      });
      return b;
    };
    btns.appendChild(mk(STR.judgeCorrect, true));
    btns.appendChild(mk(STR.judgeWrong, false));
    row.appendChild(nameEl);
    row.appendChild(textEl);
    row.appendChild(hintEl);
    row.appendChild(btns);
    if (list) list.appendChild(row);
  });
  panel.hidden = false;
  const confirm = $('btn-judge-confirm');
  if (confirm) {
    confirm.onclick = () => {
      const decisions = (msg.answers || []).map((a) => {
        const v = state.judgeDecisions[a.playerId];
        return { playerId: a.playerId, correct: v === true };
      });
      send({ t: 'host_judge', questionId: msg.questionId, decisions });
      hideJudgePanel();
      setStatus(STR.judgeDone);
    };
  }
}

function showReveal(msg) {
  const info = $('reveal-info');
  if (info) {
    info.hidden = false;
    const setText = (id, v) => { const el = $(id); if (el) el.textContent = v || '—'; };
    setText('reveal-answer', msg.answerLabelAr || msg.answerLabelEn || '');
    setText('reveal-capital', (msg.capitalAr || msg.capitalEn || ''));
    setText('reveal-continent', msg.continent || '');
  }
  // أبرز الخيار الصحيح، وعلّم اختيارك الخاطئ إن وجد.
  const opts = state.currentQuestion?.options || [];
  const correctIdx = opts.findIndex((o) => o.code && msg.answerCode && String(o.code).toLowerCase() === String(msg.answerCode).toLowerCase());
  if (correctIdx >= 0) markOption(correctIdx, 'correct');
  if (state.myChoiceIndex != null && state.myChoiceIndex !== correctIdx && state.myCorrect === false) {
    markOption(state.myChoiceIndex, 'wrong');
  }
  lockOptions(true);
  setStatus(state.myCorrect === true
    ? STR.correct + (state.myPoints ? ' +' + state.myPoints : '')
    : state.myCorrect === false ? STR.wrong : '');
}

// ---------- حلقة المؤقت ----------
function startTimerLoop() {
  stopTimerLoop();
  const ring = document.querySelector('#timer-ring circle.progress');
  const num = $('timer-num');
  const tick = () => {
    const now = ensureTimeSync().serverNow();
    const total = state.currentQuestion?.durationMs || (state.settings.durationSec || 15) * 1000;
    let remaining;
    if (now < state.showAt) {
      remaining = total;
      renderCountdown(Math.max(0, state.showAt - now));
    } else {
      remaining = Math.max(0, state.endsAt - now);
      const cd = $('countdown');
      if (cd) cd.hidden = true;
    }
    const frac = total > 0 ? remaining / total : 0;
    if (ring) ring.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - frac));
    if (num) {
      num.textContent = String(Math.ceil(remaining / 1000));
      num.classList.toggle('urgent', remaining <= 3000 && remaining > 0);
    }
    const sec = Math.ceil(remaining / 1000);
    if (remaining <= 3000 && remaining > 0 && sec !== state.lastTickSecond) {
      state.lastTickSecond = sec;
      sfx.play('tick');
    }
    if (remaining > 0 && (state.currentQuestion || state.isDisplay)) {
      state.timerRaf = requestAnimationFrame(tick);
    }
  };
  state.timerRaf = requestAnimationFrame(tick);
}

function stopTimerLoop() {
  if (state.timerRaf) cancelAnimationFrame(state.timerRaf);
  state.timerRaf = 0;
}

// ---------- وضع العرض (شاشة تلفاز) ----------
function renderDisplayScores() {
  const el = $('display-scores');
  if (!el) return;
  el.textContent = '';
  const sorted = [...state.players].sort((a, b) => (b.score || 0) - (a.score || 0));
  for (const p of sorted) {
    const row = document.createElement('div');
    row.className = 'display-score-row';
    const n = document.createElement('span');
    n.textContent = p.name || '';
    const s = document.createElement('strong');
    s.textContent = String(p.score || 0);
    row.append(n, s);
    el.appendChild(row);
  }
}

function renderDisplayQuestion(q) {
  const img = $('display-flag');
  if (img) img.src = q.flagUrl || '';
  const t = $('display-timer');
  if (t) t.textContent = '';
}

// ---------- النتائج ----------
function loadLeaderboard() {
  try {
    const raw = localStorage.getItem('flags-leaderboard');
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (_e) { return []; }
}

function saveLeaderboardEntry(entry) {
  const list = loadLeaderboard();
  list.push(entry);
  list.sort((a, b) => (b.score || 0) - (a.score || 0));
  const top = list.slice(0, 10);
  try { localStorage.setItem('flags-leaderboard', JSON.stringify(top)); } catch (_e) { /* ignore */ }
  return top;
}

function renderResults(msg) {
  stopTimerLoop();
  const standings = msg.standings || msg.results || [];
  renderStandings(standings, state.playerId);
  renderStats(msg.stats || {});
  renderBadges(msg.badges || []);
  const me = standings.find((s) => String(s.playerId ?? s.id) === String(state.playerId));
  if (me) {
    const top = saveLeaderboardEntry({
      name: state.name || me.name || '',
      score: me.score ?? me.points ?? 0,
      total: msg.stats?.total ?? standings.length,
      date: new Date().toISOString(),
    });
    renderLeaderboard(top);
  } else {
    renderLeaderboard(loadLeaderboard());
  }
  showScreen('results');
  const isWinner = standings.length > 0 && String(standings[0].playerId ?? standings[0].id) === String(state.playerId);
  if (isWinner) sfx.play('win');
  if (stopConfetti) stopConfetti();
  const canvas = $('confetti-canvas');
  if (canvas) stopConfetti = startConfetti(canvas);
  if (state.dailyDate) {
    try { localStorage.setItem('flags-daily-' + state.dailyDate, JSON.stringify({ score: me?.score || 0, date: state.dailyDate })); } catch (_e) { /* ignore */ }
    state.dailyDate = null;
  }
}

// ---------- التفاعلات ----------
function renderFloatingReaction(emoji) {
  const layer = $('reaction-layer');
  if (!layer) return;
  const span = document.createElement('span');
  span.className = 'reaction-float';
  span.textContent = emoji;
  span.style.right = (10 + Math.random() * 70) + '%';
  layer.appendChild(span);
  setTimeout(() => span.remove(), 2200);
}

function onReact(emoji) {
  const now = Date.now();
  if (now - state.lastReactionAt < 1500) return;
  state.lastReactionAt = now;
  sfx.ensure();
  send({ t: 'react', emoji, playerId: state.playerId });
  renderFloatingReaction(emoji);
}

// ---------- صف الجرس (وضع محلي) ----------
function updateBuzzRow() {
  const row = $('buzz-row');
  if (!row) return;
  const show = state.transportKind === 'local' && state.players.length > 1 && state.settings.mode !== 'turns';
  row.hidden = !show;
  if (!show) return;
  row.querySelectorAll('.buzz-btn').forEach((btn, i) => {
    const p = state.players[i];
    btn.disabled = !p;
    btn.textContent = p ? (STR.buzz + ' — ' + p.name) : STR.buzz;
  });
}

function buzzPlayer(i) {
  if (state.transportKind !== 'local') return;
  state.localAnswerer = i;
  sfx.ensure();
  sfx.play('buzz');
  send({ t: 'buzz', playerIndex: i });
  const p = state.players[i];
  if (p) setStatus(p.name + ' — ' + STR.playerBuzzed);
}

// ---------- بدء الألعاب ----------
function readName() {
  const input = $('player-name');
  const name = (input?.value || '').trim();
  if (!name) {
    showToast(STR.nameRequired);
    input?.focus({ preventScroll: true });
    return null;
  }
  state.name = name;
  try { localStorage.setItem('flags-name', name); } catch (_e) { /* ignore */ }
  return name;
}

function defaultSettings() {
  return {
    flagCount: 10, maxPlayers: 8, mode: 'classic', answerMode: 'choice',
    scoring: 'classic', durationSec: 15, answerType: 'country',
    continents: [], arabOnly: false, similarOnly: false, rareOnly: false,
    difficulty: 'mixed', questionTypes: ['flagToCountry'], hint: 'none',
    negativePoints: false, lateJoin: true, password: '', seed: '',
  };
}

async function createRoom() {
  const name = readName();
  if (!name) return;
  sfx.ensure();
  try {
    const t = await ensureWs();
    state.playerId = null;
    state.secret = null;
    t.send({ t: 'create_room', name, settings: defaultSettings(), password: '' });
    showToast(STR.toastGameStarting);
  } catch (_e) {
    showToast(STR.errorNetwork);
  }
}

async function joinRoom(codeOverride) {
  const name = readName();
  if (!name) return;
  const code = (codeOverride || $('join-code')?.value || '').trim().toUpperCase();
  if (!code) { showToast(STR.codeRequired); $('join-code')?.focus({ preventScroll: true }); return; }
  sfx.ensure();
  try {
    const t = await ensureWs();
    state.code = code;
    const sess = loadSession();
    t.send({
      t: 'join_room', code, name,
      password: '', display: false,
      playerId: sess && sess.code === code ? sess.playerId : undefined,
      secret: sess && sess.code === code ? sess.secret : undefined,
    });
  } catch (_e) {
    showToast(STR.errorNetwork);
  }
}

async function startLocalGame(names, settings, isDaily, dailyDate) {
  sfx.ensure();
  const t = await ensureLocal();
  state.localNames = names;
  state.localAnswerer = 0;
  state.dailyDate = dailyDate || null;
  state.playerId = 'local-p0';
  state.name = names[0] || '';
  t.send({ t: 'create_room', name: names[0], settings, localPlayers: names });
  // ابدأ بعد وصول اللقطة بقليل.
  setTimeout(() => t.send({ t: 'start' }), 150);
  void isDaily;
}

async function startSolo() {
  const name = readName();
  if (!name) return;
  await startLocalGame([name], { ...defaultSettings(), flagCount: 10, mode: 'classic' }, false, null);
}

async function startDaily() {
  const name = readName();
  if (!name) return;
  let daily = null;
  try {
    const res = await fetch('/api/daily');
    if (res.ok) daily = await res.json();
  } catch (_e) { /* ignore */ }
  const date = daily?.date || new Date().toISOString().slice(0, 10);
  let done = null;
  try { done = localStorage.getItem('flags-daily-' + date); } catch (_e) { /* ignore */ }
  if (done) {
    showToast(STR.dailyDone);
    return;
  }
  await startLocalGame([name], {
    ...defaultSettings(), flagCount: 10, mode: 'classic', seed: daily?.seed || String(date),
  }, true, date);
}

async function startLocalMode() {
  const name = readName();
  if (!name) return;
  const count = Number($('local-count')?.value || 2);
  const names = [name];
  for (let i = 2; i <= count; i++) names.push('لاعب ' + i);
  await startLocalGame(names, { ...defaultSettings(), flagCount: 10, mode: 'buzzer' }, false, null);
}

async function joinDisplay(code) {
  state.isDisplay = true;
  const t = await ensureWs();
  state.code = code;
  t.send({ t: 'join_room', code, name: STR.spectator, display: true });
  showScreen('display');
}

function leaveRoom() {
  send({ t: 'leave' });
  stopTimerLoop();
  clearTimeout(state.showTimer);
  clearSession();
  state.room = null;
  state.code = null;
  state.players = [];
  state.currentQuestion = null;
  state.isDisplay = false;
  clearScoreboard();
  showScreen('home');
  showToast(STR.toastLeft);
}

// ---------- ربط الأحداث ----------
function bindEvents() {
  $('btn-create')?.addEventListener('click', () => { sfx.ensure(); createRoom(); });
  $('btn-join')?.addEventListener('click', () => { sfx.ensure(); joinRoom(); });
  $('join-code')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
  $('btn-solo')?.addEventListener('click', () => { sfx.ensure(); startSolo(); });
  $('btn-daily')?.addEventListener('click', () => { sfx.ensure(); startDaily(); });
  $('btn-local')?.addEventListener('click', () => { sfx.ensure(); startLocalMode(); });
  $('btn-stats')?.addEventListener('click', () => {
    renderLeaderboard(loadLeaderboard());
    showScreen('results');
  });

  $('btn-copy-code')?.addEventListener('click', async () => {
    const ok = await copyText(state.code || '');
    showToast(ok ? STR.codeCopied : STR.copyFailed);
  });
  $('btn-share-room')?.addEventListener('click', () => shareRoom());
  $('btn-start')?.addEventListener('click', () => { sfx.ensure(); sfx.play('click'); send({ t: 'start' }); });
  $('btn-leave-lobby')?.addEventListener('click', () => {
    if (window.confirm(STR.confirmLeave)) leaveRoom();
  });

  // تغييرات إعدادات المضيف تُرسل فوراً.
  // ROOT FIX (scroll bug, form): لوحة الإعدادات <form> بلا معالج submit؛
  // Enter داخل حقل كان يرسل النموذج ويعيد تحميل الصفحة إلى الأعلى.
  $('settings-panel')?.addEventListener('submit', (e) => e.preventDefault());
  document.querySelectorAll('#settings-panel input, #settings-panel select').forEach((el) => {
    el.addEventListener('change', () => {
      if (!state.isHost) return;
      const s = readSettingsFromForm();
      state.settings = s;
      send({ t: 'set_settings', settings: s });
      updateAvailableFlags();
    });
  });

  $('btn-answer-submit')?.addEventListener('click', () => onSubmitTyping());
  $('answer-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') onSubmitTyping(); });
  $('btn-skip-vote')?.addEventListener('click', () => send({ t: 'skip_vote', questionId: state.currentQuestion?.questionId }));
  $('btn-pause')?.addEventListener('click', () => {
    const paused = document.body.dataset.paused === '1';
    if (paused) { document.body.dataset.paused = '0'; send({ t: 'resume_game' }); }
    else { document.body.dataset.paused = '1'; send({ t: 'pause' }); }
  });
  $('btn-skip-flag')?.addEventListener('click', () => send({ t: 'skip_flag', questionId: state.currentQuestion?.questionId }));

  document.querySelectorAll('#reactions .reaction-btn').forEach((btn) => {
    btn.addEventListener('click', () => onReact(btn.dataset.emoji || btn.textContent.trim()));
  });
  document.querySelectorAll('#buzz-row .buzz-btn').forEach((btn, i) => {
    btn.addEventListener('click', () => buzzPlayer(i));
  });

  $('btn-rematch')?.addEventListener('click', () => { sfx.ensure(); send({ t: 'rematch' }); });
  $('btn-replay-missed')?.addEventListener('click', () => send({ t: 'replay_missed' }));
  $('btn-share-result')?.addEventListener('click', async () => {
    const me = state.players.find((p) => String(p.id) === String(state.playerId));
    const text = STR.shareResultText + ': ' + (me ? me.score : 0) + ' ' + STR.points;
    if (navigator.share) {
      try { await navigator.share({ title: STR.appTitle, text }); return; } catch (_e) { /* fallback */ }
    }
    const ok = await copyText(text);
    showToast(ok ? STR.toastCopied : STR.shareFailed);
  });
  $('btn-back-lobby')?.addEventListener('click', () => {
    if (state.code) { renderLobby(); showScreen('lobby'); }
    else showScreen('home');
  });
  $('btn-back-home')?.addEventListener('click', () => { showScreen('home'); });

  $('btn-sound')?.addEventListener('click', () => {
    sfx.ensure();
    sfx.setMuted(!sfx.muted);
    applyMute();
    if (!sfx.muted) sfx.play('click');
  });
  $('btn-theme')?.addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  });
  $('font-size')?.addEventListener('change', (e) => applyFont(e.target.value));

  $('btn-display-join')?.addEventListener('click', () => {
    const code = ($('display-code')?.value || '').trim().toUpperCase();
    if (!code) { showToast(STR.codeRequired); return; }
    joinDisplay(code);
  });

  document.addEventListener('keydown', (e) => {
    const screen = document.getElementById('app')?.dataset.screen;
    if (screen !== 'play') return;
    if (e.key >= '1' && e.key <= '4') {
      const idx = Number(e.key) - 1;
      const btn = document.querySelector('#options .option-btn[data-index="' + idx + '"]');
      if (btn && !btn.disabled) { e.preventDefault(); onChoose(idx); }
    } else if (e.key === ' ') {
      e.preventDefault();
      send({ t: 'skip_vote', questionId: state.currentQuestion?.questionId });
    } else if (state.transportKind === 'local') {
      const map = { q: 0, Q: 0, p: 1, P: 1, z: 2, Z: 2, m: 3, M: 3 };
      if (e.key in map) buzzPlayer(map[e.key]);
    }
    if (e.key === 'Escape' && screen === 'results') showScreen('home');
  });

  window.addEventListener('beforeunload', () => {
    if (state.transportKind === 'local' && state.transport) { try { state.transport.close(); } catch (_e) { /* ignore */ } }
  });
}

// ---------- تهيئة ----------
function init() {
  let theme = 'dark';
  let font = 'medium';
  let savedName = '';
  try {
    theme = localStorage.getItem('flags-theme') || 'dark';
    font = localStorage.getItem('flags-font') || 'medium';
    savedName = localStorage.getItem('flags-name') || '';
  } catch (_e) { /* ignore */ }
  applyTheme(theme);
  applyFont(font);
  applyMute();
  if (savedName) {
    const input = $('player-name');
    if (input) input.value = savedName;
    state.name = savedName;
  }
  renderLeaderboard(loadLeaderboard());
  bindEvents();

  const params = new URLSearchParams(location.search);
  const roomParam = params.get('room');
  const displayParam = params.get('display');
  if (roomParam) {
    const codeInput = $('join-code');
    if (codeInput) codeInput.value = roomParam.toUpperCase();
  }
  if (displayParam === '1') {
    state.isDisplay = true;
    showScreen('display');
    if (roomParam) joinDisplay(roomParam.toUpperCase());
  } else {
    showScreen('home');
    if (roomParam) showToast(STR.joinRoom + ': ' + roomParam.toUpperCase());
  }
  setConnDot('bad');
}

init();
