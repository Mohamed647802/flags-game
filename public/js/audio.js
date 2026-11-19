// مؤثرات صوتية مولّدة بمذبذبات Web Audio — بلا أي ملفات صوتية.
export class SoundFX {
  constructor() {
    this._ctx = null;
    this._muted = false;
    try {
      this._muted = localStorage.getItem('flags-muted') === '1';
    } catch (_e) { /* ignore */ }
  }

  get muted() { return this._muted; }

  setMuted(muted) {
    this._muted = !!muted;
    try { localStorage.setItem('flags-muted', this._muted ? '1' : '0'); } catch (_e) { /* ignore */ }
  }

  // أنشئ AudioContext عند أول إيماءة مستخدم (يُستدعى من معالجات النقر).
  ensure() {
    try {
      if (!this._ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        this._ctx = new AC();
      }
      if (this._ctx.state === 'suspended') void this._ctx.resume();
      return true;
    } catch (_e) { return false; }
  }

  _tone(freq, startAt, duration, type = 'sine', volume = 0.15) {
    const ctx = this._ctx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, startAt);
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(volume, startAt + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(startAt);
    osc.stop(startAt + duration + 0.05);
  }

  play(name) {
    try {
      if (this._muted) return;
      if (!this.ensure()) return;
      const now = this._ctx.currentTime;
      switch (name) {
        case 'correct':
          this._tone(523.25, now, 0.15, 'sine', 0.18);
          this._tone(659.25, now + 0.09, 0.15, 'sine', 0.18);
          this._tone(783.99, now + 0.18, 0.28, 'sine', 0.2);
          break;
        case 'wrong':
          this._tone(220, now, 0.2, 'sawtooth', 0.08);
          this._tone(155.56, now + 0.12, 0.3, 'sawtooth', 0.08);
          break;
        case 'tick':
          this._tone(880, now, 0.06, 'square', 0.05);
          break;
        case 'win': {
          const notes = [523.25, 659.25, 783.99, 1046.5];
          notes.forEach((f, i) => this._tone(f, now + i * 0.12, 0.25, 'triangle', 0.18));
          this._tone(1318.5, now + 0.5, 0.5, 'triangle', 0.18);
          break;
        }
        case 'click':
          this._tone(660, now, 0.05, 'sine', 0.08);
          break;
        case 'buzz':
          this._tone(440, now, 0.12, 'square', 0.07);
          break;
        default:
          this._tone(440, now, 0.08, 'sine', 0.08);
          break;
      }
    } catch (_e) { /* never throw */ }
  }
}
