// مزامنة الوقت مع الخادم عبر رسائل ping/pong.
// sendPing(c): دالة يمررها العميل، ترسل {t:'ping', c} حيث c = performance.now().
export function computeOffset(samples) {
  if (!samples || samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a.rtt - b.rtt);
  const best = sorted.slice(0, Math.min(3, sorted.length));
  const byOffset = [...best].sort((a, b) => a.offset - b.offset);
  return byOffset[Math.floor(byOffset.length / 2)].offset;
}

export class TimeSync {
  constructor(sendPing) {
    this.sendPing = sendPing;
    this.offset = 0;
    this.lastRtt = null;
    this.samples = [];
    this._timers = [];
    this._periodic = null;
    this._visibilityBound = false;
    this._onVisibility = () => this.onVisibility();
  }

  start() {
    this.samples = [];
    for (let i = 0; i < 8; i++) {
      const t = setTimeout(() => {
        try { this.sendPing(performance.now()); } catch (_e) { /* ignore */ }
      }, i * 120);
      this._timers.push(t);
    }
  }

  handlePong(msg) {
    if (!msg || typeof msg.c !== 'number' || typeof msg.s !== 'number') return;
    const rtt = performance.now() - msg.c;
    if (!Number.isFinite(rtt) || rtt < 0) return;
    const offset = msg.s + rtt / 2 - Date.now();
    this.samples.push({ rtt, offset });
    if (this.samples.length > 12) this.samples.shift();
    this.lastRtt = rtt;
    const best = computeOffset(this.samples);
    // طبّق الإزاحة الجديدة فقط إذا تغيرت 30ms أو أكثر.
    if (Math.abs(best - this.offset) >= 30) this.offset = best;
  }

  resync() {
    for (let i = 0; i < 3; i++) {
      setTimeout(() => {
        try { this.sendPing(performance.now()); } catch (_e) { /* ignore */ }
      }, i * 120);
    }
  }

  startPeriodic() {
    this.stopPeriodic();
    this._periodic = setInterval(() => this.resync(), 20000);
  }

  stopPeriodic() {
    if (this._periodic) { clearInterval(this._periodic); this._periodic = null; }
  }

  onVisibility() {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      this.resync();
    }
  }

  bindVisibility() {
    if (!this._visibilityBound && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._onVisibility);
      this._visibilityBound = true;
    }
  }

  serverNow() {
    return Date.now() + this.offset;
  }

  quality() {
    if (this.lastRtt == null) return 'bad';
    if (this.lastRtt < 150) return 'good';
    if (this.lastRtt < 400) return 'medium';
    return 'bad';
  }

  stop() {
    for (const t of this._timers) clearTimeout(t);
    this._timers = [];
    this.stopPeriodic();
    if (this._visibilityBound && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._onVisibility);
      this._visibilityBound = false;
    }
  }
}
