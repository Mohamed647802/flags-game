// نقل WebSocket مع إعادة اتصال تلقائية وترقيم تسلسلي للرسائل.
// الواجهة المشتركة مع LocalTransport:
//   { connect(), send(msg), onmessage, onstatus, onSeqGap, close(), kind, sendResume(...) }
export class WebSocketTransport {
  constructor(url) {
    this.url = url;
    this.kind = 'ws';
    this.onmessage = null;
    this.onstatus = null;
    this.onSeqGap = null;
    this._ws = null;
    this._queue = [];
    this._lastSeq = -1;
    this._attempts = 0;
    this._closed = false;
    this._reconnectTimer = null;
    this._status = 'connecting';
    this._manualClose = false;
  }

  _setStatus(s) {
    this._status = s;
    if (typeof this.onstatus === 'function') {
      try { this.onstatus(s); } catch (_e) { /* ignore */ }
    }
  }

  connect() {
    this._closed = false;
    this._manualClose = false;
    this._openSocket();
    return Promise.resolve();
  }

  _openSocket() {
    if (this._closed) return;
    this._setStatus(this._attempts === 0 ? 'connecting' : 'reconnecting');
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (_e) {
      this._scheduleReconnect();
      return;
    }
    this._ws = ws;

    ws.addEventListener('open', () => {
      this._attempts = 0;
      this._setStatus('connected');
      this._flush();
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_e) { return; }
      if (msg && typeof msg.seq === 'number') {
        if (this._lastSeq >= 0 && msg.seq > this._lastSeq + 1) {
          if (typeof this.onSeqGap === 'function') {
            try { this.onSeqGap(this._lastSeq, msg.seq); } catch (_e) { /* ignore */ }
          }
        }
        if (msg.seq > this._lastSeq) this._lastSeq = msg.seq;
      }
      if (typeof this.onmessage === 'function') {
        try { this.onmessage(msg); } catch (_e) { /* ignore */ }
      }
    });

    ws.addEventListener('close', () => {
      this._ws = null;
      if (this._manualClose || this._closed) return;
      this._scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // سيتبع حدث close عادةً؛ لا نفعل شيئاً هنا لتجنب إعادة جدولة مزدوجة.
    });
  }

  _scheduleReconnect() {
    if (this._closed || this._manualClose) return;
    if (this._reconnectTimer) return;
    this._setStatus('reconnecting');
    const base = Math.min(8000, 500 * Math.pow(2, this._attempts));
    const jitter = Math.random() * 400;
    const delay = base + jitter;
    this._attempts += 1;
    if (this._attempts > 12) {
      this._setStatus('failed');
      return;
    }
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._openSocket();
    }, delay);
  }

  send(obj) {
    const data = JSON.stringify(obj);
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      try { this._ws.send(data); } catch (_e) { this._queue.push(data); }
    } else {
      this._queue.push(data);
    }
  }

  _flush() {
    while (this._queue.length > 0 && this._ws && this._ws.readyState === WebSocket.OPEN) {
      const data = this._queue.shift();
      try { this._ws.send(data); } catch (_e) { this._queue.unshift(data); break; }
    }
  }

  sendResume(playerId, secret, code) {
    this.send({ t: 'resume', playerId, secret, code });
  }

  close() {
    this._closed = true;
    this._manualClose = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this._ws) {
      try { this._ws.close(); } catch (_e) { /* ignore */ }
      this._ws = null;
    }
  }
}
