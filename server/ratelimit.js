// server/ratelimit.js — per-connection token buckets + per-IP sliding windows.
import process from 'node:process';

export const CONN_MSG_PER_SEC = 20;
export const MAX_ROOMS_PER_MIN_PER_IP = 5;
export const MAX_JOINS_PER_MIN_PER_IP = 20;
export const MAX_CONNS_PER_IP = 10;

/** Client IP: first X-Forwarded-For entry only when TRUST_PROXY=1, else the socket address. */
export function getClientIp(req) {
  if (process.env.TRUST_PROXY === '1') {
    const xff = req.headers?.['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim().length > 0) {
      return xff.split(',')[0].trim();
    }
    if (Array.isArray(xff) && xff.length > 0) {
      return String(xff[0]).split(',')[0].trim();
    }
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

export class RateLimiter {
  constructor({
    connCapacity = CONN_MSG_PER_SEC,
    connRefillPerSec = CONN_MSG_PER_SEC,
    maxRoomsPerMin = MAX_ROOMS_PER_MIN_PER_IP,
    maxJoinsPerMin = MAX_JOINS_PER_MIN_PER_IP,
    maxConnsPerIp = MAX_CONNS_PER_IP,
  } = {}) {
    this.connCapacity = connCapacity;
    this.connRefillPerSec = connRefillPerSec;
    this.maxRoomsPerMin = maxRoomsPerMin;
    this.maxJoinsPerMin = maxJoinsPerMin;
    this.maxConnsPerIp = maxConnsPerIp;
    /** connId -> { tokens, lastMs } */
    this.connBuckets = new Map();
    /** ip -> number[] timestamps (ms) */
    this.roomCreates = new Map();
    this.joins = new Map();
    /** ip -> concurrent WS count */
    this.ipConns = new Map();
  }

  // ---- per-connection token bucket (20 msg/sec, burst 20) ----
  allow(connId, n = 1) {
    const now = Date.now();
    let bucket = this.connBuckets.get(connId);
    if (!bucket) {
      bucket = { tokens: this.connCapacity, lastMs: now };
      this.connBuckets.set(connId, bucket);
    }
    const elapsedSec = Math.max(0, (now - bucket.lastMs) / 1000);
    bucket.tokens = Math.min(this.connCapacity, bucket.tokens + elapsedSec * this.connRefillPerSec);
    bucket.lastMs = now;
    if (bucket.tokens >= n) {
      bucket.tokens -= n;
      return true;
    }
    return false;
  }

  /** Backwards-compatible alias used by index.js. */
  checkConn(connId, n = 1) {
    return this.allow(connId, n);
  }

  removeConn(connId) {
    this.connBuckets.delete(connId);
  }

  // ---- per-IP sliding windows ----
  _record(map, ip, windowMs, max) {
    const now = Date.now();
    let arr = map.get(ip);
    if (!arr) {
      arr = [];
      map.set(ip, arr);
    }
    const cutoff = now - windowMs;
    let i = 0;
    while (i < arr.length && arr[i] <= cutoff) i++;
    if (i > 0) arr.splice(0, i);
    if (arr.length >= max) return false;
    arr.push(now);
    return true;
  }

  /** Max 5 rooms created per minute per IP. */
  recordRoom(ip) {
    return this._record(this.roomCreates, ip, 60_000, this.maxRoomsPerMin);
  }

  /** Max 20 joins per minute per IP. */
  recordJoin(ip) {
    return this._record(this.joins, ip, 60_000, this.maxJoinsPerMin);
  }

  // ---- per-IP concurrent WS connections ----
  acquireConn(ip) {
    const n = this.ipConns.get(ip) ?? 0;
    if (n >= this.maxConnsPerIp) return false;
    this.ipConns.set(ip, n + 1);
    return true;
  }

  releaseConn(ip) {
    const n = this.ipConns.get(ip) ?? 0;
    if (n <= 1) {
      this.ipConns.delete(ip);
    } else {
      this.ipConns.set(ip, n - 1);
    }
  }

  connCount(ip) {
    return this.ipConns.get(ip) ?? 0;
  }
}
