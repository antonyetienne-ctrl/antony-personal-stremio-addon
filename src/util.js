'use strict';
// Utilitaires transverses : horloge injectable, HTTP borné, LRU, chronométrage haute résolution,
// compression, PRNG déterministe, journal expurgé des secrets, jour calendaire Europe/Zurich.
const zlib = require('zlib');
const crypto = require('crypto');

const TZ = 'Europe/Zurich';
const clock = { now: () => Date.now() };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- expurgation des secrets (logs, diagnostic, erreurs) ----------
const secretsSeen = new Set();
function registerSecret(s) { if (typeof s === 'string' && s.length >= 8) secretsSeen.add(s); }
function redact(text) {
  let t = String(text ?? '');
  for (const s of secretsSeen) if (t.includes(s)) t = t.split(s).join('***');
  t = t.replace(/(authToken|authKey|api[_-]?key|key|token|access_token)=([^&\s"']+)/gi, '$1=***');
  t = t.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer ***');
  t = t.replace(/(["']?(?:authKey|authToken|apiKey|x-goog-api-key)["']?\s*[:=]\s*["'])[^"']+/gi, '$1***');
  return t;
}
const LOGS = [];
function log(level, msg, data) {
  const line = { t: new Date(clock.now()).toISOString(), level, msg: redact(msg), data: data === undefined ? undefined : redact(typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 600) };
  LOGS.push(line); if (LOGS.length > 250) LOGS.shift();
  if (!process.env.QUIET_LOGS) console.log(`[${level}] ${line.msg}${line.data ? ' ' + line.data : ''}`);
}
const recentLogs = () => LOGS.slice(-80);

// ---------- HTTP JSON borné (timeout, retries, jitter, Retry-After) ----------
class HttpError extends Error {
  constructor(status, message, body) { super(message); this.name = 'HttpError'; this.status = status; this.body = body; }
}
async function fetchJson(url, opts = {}) {
  const { method = 'GET', headers, body, timeoutMs = 10000, retries = 2, label = 'http', onCall, retryStatuses = [429, 500, 502, 503, 504] } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let wait = 300 * 2 ** attempt + Math.floor(Math.random() * 250);
    let retryable = false;
    try {
      const res = await fetch(url, { method, headers, body, signal: ac.signal });
      const text = await res.text();
      onCall && onCall(label, res.status);
      if (res.ok) {
        if (!text) return null;
        try { return JSON.parse(text); } catch { throw new HttpError(res.status, `${label}: JSON invalide`); }
      }
      lastErr = new HttpError(res.status, `${label} HTTP ${res.status}`, text.slice(0, 1200));
      retryable = retryStatuses.includes(res.status);
      const ra = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
      if (ra > 0) wait = Math.min(ra * 1000, 15000);
    } catch (e) {
      lastErr = e;
      onCall && onCall(label, 'err');
      retryable = !(e instanceof HttpError);
    } finally { clearTimeout(timer); }
    if (!retryable || attempt === retries) throw lastErr;
    await sleep(wait);
  }
  throw lastErr;
}

// concurrence bornée ; renvoie {results, errors}
async function mapLimit(items, limit, fn, gate) {
  const results = new Array(items.length);
  let next = 0, errors = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try { results[i] = await fn(items[i], i); } catch { results[i] = undefined; errors++; }
      if (gate) await gate();
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return { results, errors };
}

class LRU {
  constructor(max) { this.max = max; this.m = new Map(); }
  get(k) { if (!this.m.has(k)) return undefined; const v = this.m.get(k); this.m.delete(k); this.m.set(k, v); return v; }
  set(k, v) { this.m.delete(k); this.m.set(k, v); if (this.m.size > this.max) this.m.delete(this.m.keys().next().value); }
  has(k) { return this.m.has(k); }
  delete(k) { return this.m.delete(k); }
  get size() { return this.m.size; }
  clear() { this.m.clear(); }
}

// ---------- chronométrage haute résolution ----------
class Spans {
  constructor() { this.tot = {}; this.open = {}; }
  start(n) { this.open[n] = process.hrtime.bigint(); }
  end(n) { const s = this.open[n]; if (s === undefined) return 0; delete this.open[n]; const d = Number(process.hrtime.bigint() - s) / 1e6; this.tot[n] = (this.tot[n] || 0) + d; return d; }
  async wrap(n, fn) { this.start(n); try { return await fn(); } finally { this.end(n); try { require('./memory').guard(n); } catch { /* facultatif */ } } }
  snapshot() { const o = {}; for (const [k, v] of Object.entries(this.tot)) o[k] = Math.round(v); return o; }
}
function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

// ---------- compression (valeurs Upstash) ----------
function pack(obj) {
  const raw = Buffer.from(JSON.stringify(obj), 'utf8');
  if (raw.length < 160) return 'j:' + raw.toString('utf8');
  return 'z:' + zlib.gzipSync(raw, { level: 6 }).toString('base64');
}
function unpack(s) {
  if (typeof s !== 'string') return null;
  try {
    if (s.startsWith('j:')) return JSON.parse(s.slice(2));
    if (s.startsWith('z:')) return JSON.parse(zlib.gunzipSync(Buffer.from(s.slice(2), 'base64')).toString('utf8'));
  } catch { /* corrompu */ }
  return null;
}

// ---------- jour calendaire Europe/Zurich ----------
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const zurichDay = (ts = clock.now()) => dayFmt.format(new Date(ts));
function nextZurichMidnight(ts = clock.now()) {
  const day = zurichDay(ts);
  let lo = ts, hi = ts;
  for (let i = 0; i < 30 && zurichDay(hi) === day; i++) { lo = hi; hi += 3600e3; }
  while (hi - lo > 1000) { const mid = Math.floor((lo + hi) / 2); if (zurichDay(mid) === day) lo = mid; else hi = mid; }
  return hi;
}

// ---------- PRNG / hash ----------
function hashInt(str) { return crypto.createHash('sha256').update(String(str)).digest().readUInt32BE(0); }
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function shuffleSeeded(arr, seed) { const r = mulberry32(typeof seed === 'number' ? seed : hashInt(seed)); const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const sha = (s, n = 16) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, n);

// ---------- priorité aux requêtes interactives ----------
const activity = { last: 0, mark() { this.last = Date.now(); }, recent(ms = 2000) { return Date.now() - this.last < ms; } };
function makeYielder(sliceMs = 40) {
  let t = Date.now();
  return async () => {
    if (Date.now() - t < sliceMs) return;
    if (activity.recent()) await sleep(120); else await new Promise((r) => setImmediate(r));
    t = Date.now();
  };
}
const num = (v, def, min, max) => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) && String(v ?? '').trim() !== '' ? Math.min(max, Math.max(min, n)) : def; };

module.exports = { TZ, clock, sleep, registerSecret, redact, log, recentLogs, HttpError, fetchJson, mapLimit, LRU, Spans, fmtDuration, pack, unpack, zurichDay, nextZurichMidnight, hashInt, mulberry32, shuffleSeeded, sha, activity, makeYielder, num };
