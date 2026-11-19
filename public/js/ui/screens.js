// مساعدات عرض الشاشات ولوحة النقاط والنتائج.
// ملاحظة: لا يُستخدم innerHTML مع أي بيانات قادمة من المستخدم — textContent فقط.

export const SCREENS = ['home', 'lobby', 'play', 'results', 'display'];

export function showScreen(name) {
  for (const s of SCREENS) {
    const el = document.getElementById('screen-' + s);
    if (!el) continue;
    const active = s === name;
    el.hidden = !active;
    el.classList.toggle('active', active);
  }
  const app = document.getElementById('app');
  if (app) app.dataset.screen = name;
  window.scrollTo({ top: 0 });
}

// --- لوحة النقاط: تُبنى الصفوف مرة واحدة، ثم تُحدَّث نصاً وكلاسات فقط ---
const rowCache = new Map(); // playerId -> {row, nameEl, scoreEl, streakEl, badgeEl}

export function renderScoreboard(players, opts = {}) {
  const board = document.getElementById('scoreboard');
  if (!board) return;
  const { currentPlayerId = null, answeredIds = new Set(), turnPlayerId = null } = opts;
  const list = [...(players || [])].sort((a, b) => (b.score || 0) - (a.score || 0));
  const seen = new Set();
  for (const p of list) {
    const id = String(p.id ?? p.name);
    seen.add(id);
    let cached = rowCache.get(id);
    if (!cached) {
      const row = document.createElement('div');
      row.className = 'score-row';
      row.dataset.playerId = id;
      const nameEl = document.createElement('span');
      nameEl.className = 'score-name';
      const scoreEl = document.createElement('span');
      scoreEl.className = 'score-points';
      const tagEl = document.createElement('span');
      tagEl.className = 'score-tag';
      row.append(nameEl, tagEl, scoreEl);
      board.appendChild(row);
      cached = { row, nameEl, scoreEl, tagEl };
      rowCache.set(id, cached);
    }
    cached.nameEl.textContent = p.name || id;
    cached.scoreEl.textContent = String(p.score || 0);
    let tag = '';
    if (p.isHost) tag += '👑 ';
    if (id === String(currentPlayerId)) tag += '• أنت ';
    if (turnPlayerId && id === String(turnPlayerId)) tag += '• دوره ';
    if (answeredIds.has(id) || answeredIds.has(p.id)) tag += '✓';
    cached.tagEl.textContent = tag.trim();
    cached.row.classList.toggle('me', id === String(currentPlayerId));
    cached.row.classList.toggle('answered', answeredIds.has(id) || answeredIds.has(p.id));
    cached.row.classList.toggle('turn', !!turnPlayerId && id === String(turnPlayerId));
  }
  for (const [id, cached] of rowCache) {
    if (!seen.has(id)) {
      cached.row.remove();
      rowCache.delete(id);
    }
  }
  // أعد ترتيب الصفوف حسب النقاط دون إعادة بناء.
  for (const p of list) {
    const cached = rowCache.get(String(p.id ?? p.name));
    if (cached) board.appendChild(cached.row);
  }
}

export function clearScoreboard() {
  const board = document.getElementById('scoreboard');
  if (board) board.textContent = '';
  rowCache.clear();
}

// --- قائمة لاعبي الغرفة ---
export function renderPlayerList(players, currentPlayerId, isHost, callbacks = {}) {
  const list = document.getElementById('player-list');
  if (!list) return;
  list.textContent = '';
  for (const p of players || []) {
    const li = document.createElement('li');
    li.className = 'player-item';
    if (String(p.id) === String(currentPlayerId)) li.classList.add('me');
    const name = document.createElement('span');
    name.className = 'player-name';
    name.textContent = p.name || String(p.id);
    li.appendChild(name);
    if (p.isHost) {
      const h = document.createElement('span');
      h.className = 'player-host';
      h.textContent = 'المضيف';
      li.appendChild(h);
    }
    if (String(p.id) === String(currentPlayerId)) {
      const me = document.createElement('span');
      me.className = 'player-me';
      me.textContent = 'أنت';
      li.appendChild(me);
    }
    if (p.team) {
      const t = document.createElement('span');
      t.className = 'player-team';
      t.textContent = p.team;
      li.appendChild(t);
    }
    if (isHost && String(p.id) !== String(currentPlayerId)) {
      const actions = document.createElement('span');
      actions.className = 'player-actions';
      const kickBtn = document.createElement('button');
      kickBtn.type = 'button';
      kickBtn.className = 'btn btn-small btn-danger';
      kickBtn.textContent = 'طرد';
      kickBtn.addEventListener('click', () => callbacks.onKick && callbacks.onKick(p.id));
      actions.appendChild(kickBtn);
      const hostBtn = document.createElement('button');
      hostBtn.type = 'button';
      hostBtn.className = 'btn btn-small';
      hostBtn.textContent = 'جعله مضيفاً';
      hostBtn.addEventListener('click', () => callbacks.onTransferHost && callbacks.onTransferHost(p.id));
      actions.appendChild(hostBtn);
      li.appendChild(actions);
    }
    list.appendChild(li);
  }
}

// --- النتائج ---
export function renderStandings(standings, currentPlayerId) {
  const el = document.getElementById('standings');
  if (!el) return;
  el.textContent = '';
  const ol = document.createElement('ol');
  ol.className = 'standings-list';
  (standings || []).forEach((s, i) => {
    const li = document.createElement('li');
    li.className = 'standing-row' + (i === 0 ? ' winner' : '');
    if (String(s.playerId ?? s.id) === String(currentPlayerId)) li.classList.add('me');
    const rank = document.createElement('span');
    rank.className = 'standing-rank';
    rank.textContent = String(i + 1);
    const name = document.createElement('span');
    name.className = 'standing-name';
    name.textContent = s.name || String(s.playerId ?? s.id ?? '');
    const score = document.createElement('span');
    score.className = 'standing-score';
    score.textContent = String(s.score ?? s.points ?? 0);
    li.append(rank, name, score);
    ol.appendChild(li);
  });
  el.appendChild(ol);
}

export function renderStats(stats) {
  const el = document.getElementById('results-stats');
  if (!el || !stats) return;
  el.textContent = '';
  const entries = [
    ['أسرع إجابة', stats.fastestMs != null ? (stats.fastestMs / 1000).toFixed(1) + ' ث' : '—'],
    ['الدقة', stats.accuracy != null ? Math.round(stats.accuracy * 100) + '٪' : (stats.correct != null && stats.total ? Math.round((stats.correct / stats.total) * 100) + '٪' : '—')],
    ['أفضل سلسلة', stats.bestStreak != null ? String(stats.bestStreak) : '—'],
    ['إجابات صحيحة', stats.correct != null ? String(stats.correct) + ' / ' + String(stats.total ?? '') : '—'],
    ['الأكثر إخطاءً', stats.mostMissed ? String(stats.mostMissed) : '—'],
  ];
  for (const [label, value] of entries) {
    const div = document.createElement('div');
    div.className = 'stat-item';
    const l = document.createElement('span');
    l.className = 'stat-label';
    l.textContent = label;
    const v = document.createElement('strong');
    v.className = 'stat-value';
    v.textContent = value;
    div.append(l, v);
    el.appendChild(div);
  }
}

export function renderBadges(badges) {
  const el = document.getElementById('badges');
  if (!el) return;
  el.textContent = '';
  for (const b of badges || []) {
    const span = document.createElement('span');
    span.className = 'badge';
    span.textContent = typeof b === 'string' ? b : (b.labelAr || b.label || b.id || '');
    el.appendChild(span);
  }
}

export function renderLeaderboard(entries) {
  const el = document.getElementById('local-leaderboard');
  if (!el) return;
  el.textContent = '';
  if (!entries || entries.length === 0) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'لا توجد نتائج محفوظة بعد';
    el.appendChild(p);
    return;
  }
  const ol = document.createElement('ol');
  ol.className = 'leaderboard-list';
  for (const e of entries.slice(0, 10)) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'lb-name';
    name.textContent = e.name || '';
    const score = document.createElement('span');
    score.className = 'lb-score';
    score.textContent = String(e.score ?? 0);
    const date = document.createElement('span');
    date.className = 'lb-date muted';
    date.textContent = e.date ? new Date(e.date).toLocaleDateString('ar-EG') : '';
    li.append(name, score, date);
    ol.appendChild(li);
  }
  el.appendChild(ol);
}
