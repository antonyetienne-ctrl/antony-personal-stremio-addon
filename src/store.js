'use strict';
// Client Upstash REST minimal. Principes :
//  - RAM-first : ce module n'est appelé qu'aux frontières (lecture au démarrage/1er accès, écriture en fin de calcul).
//  - Chaque commande est comptée (total / par nom / par étiquette) et exposée par /diagnostic.
//  - Aucune méthode ne lève : échec => undefined (jamais confondu avec null = clé absente).
//  - Disjoncteur : après 3 échecs consécutifs, on n'appelle plus Upstash pendant 20 s.
const { fetchJson, pack, unpack, clock, log } = require('./util');

const MAX_VALUE_CHARS = 900 * 1024; // marge sous la limite de requête Upstash

class Store {
  constructor({ url, token } = {}) {
    this.url = String(url || '').replace(/\/$/, '');
    this.token = token || '';
    this.enabled = Boolean(this.url && this.token);
    this.stats = { commands: 0, requests: 0, byName: {}, byLabel: {}, errors: 0, lastError: null, lastErrorAt: null, bytesOut: 0, bytesIn: 0 };
    this.fails = 0;
    this.openUntil = 0;
  }
  _count(cmds, label) {
    this.stats.commands += cmds.length;
    this.stats.requests += 1;
    for (const c of cmds) {
      const n = String(c[0]).toUpperCase();
      this.stats.byName[n] = (this.stats.byName[n] || 0) + 1;
      this.stats.byLabel[label] = (this.stats.byLabel[label] || 0) + 1;
    }
  }
  _fail(e) {
    this.stats.errors++; this.stats.lastError = String(e && e.message || e).slice(0, 200); this.stats.lastErrorAt = new Date(clock.now()).toISOString();
    if (++this.fails >= 3) { this.openUntil = clock.now() + 20000; this.fails = 0; log('warn', 'Upstash indisponible : disjoncteur ouvert 20 s', this.stats.lastError); }
  }
  _ok() { this.fails = 0; }
  get available() { return this.enabled && clock.now() >= this.openUntil; }

  async exec(cmd, label = 'misc') {
    if (!this.available) return undefined;
    try {
      const body = JSON.stringify(cmd);
      this.stats.bytesOut += body.length;
      const res = await fetchJson(this.url, { method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }, body, timeoutMs: 7000, retries: 1, label: 'upstash' });
      this._count([cmd], label);
      if (res && res.error) throw new Error(res.error);
      const r = res ? (res.result ?? null) : null;
      if (typeof r === 'string') this.stats.bytesIn += r.length;
      this._ok();
      return r;
    } catch (e) { this._count([cmd], label); this._fail(e); return undefined; }
  }
  async pipeline(cmds, label = 'misc') {
    if (!cmds.length) return [];
    if (!this.available) return undefined;
    try {
      const body = JSON.stringify(cmds);
      this.stats.bytesOut += body.length;
      const res = await fetchJson(`${this.url}/pipeline`, { method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }, body, timeoutMs: 12000, retries: 1, label: 'upstash' });
      this._count(cmds, label);
      if (!Array.isArray(res)) throw new Error('pipeline: réponse invalide');
      this._ok();
      return res.map((r) => {
        if (r && r.error) { this.stats.errors++; this.stats.lastError = String(r.error).slice(0, 200); return undefined; }
        const v = r ? (r.result ?? null) : null;
        if (typeof v === 'string') this.stats.bytesIn += v.length;
        return v;
      });
    } catch (e) { this._count(cmds, label); this._fail(e); return undefined; }
  }
  // ---- helpers de haut niveau (valeurs JSON compressées) ----
  async getJson(key, label) {
    const raw = await this.exec(['GET', key], label);
    if (raw === undefined) return undefined;
    if (raw === null) return null;
    return unpack(raw);
  }
  async setJson(key, value, label, { ex } = {}) {
    const raw = pack(value);
    if (raw.length > MAX_VALUE_CHARS) { log('error', `Valeur trop grosse pour ${key} (${raw.length} car.)`); return false; }
    const cmd = ex ? ['SET', key, raw, 'EX', ex] : ['SET', key, raw];
    const r = await this.exec(cmd, label);
    return r === 'OK';
  }
  // lecture groupée : renvoie un tableau aligné sur keys (undefined = échec de la requête globale)
  async getManyJson(keys, label) {
    if (!keys.length) return [];
    const res = await this.pipeline(keys.map((k) => ['GET', k]), label);
    if (res === undefined) return undefined;
    return res.map((r) => (r == null ? null : unpack(r)));
  }
  // écriture groupée : renvoie true si tout est OK
  async setManyJson(entries, label) {
    if (!entries.length) return true;
    const cmds = [];
    for (const [k, v] of entries) {
      const raw = pack(v);
      if (raw.length > MAX_VALUE_CHARS) { log('error', `Valeur trop grosse pour ${k}`); return false; }
      cmds.push(['SET', k, raw]);
    }
    const res = await this.pipeline(cmds, label);
    return Array.isArray(res) && res.every((r) => r === 'OK');
  }
  async sadd(key, member, label) { return this.exec(['SADD', key, member], label); }
  async smembers(key, label) { return this.exec(['SMEMBERS', key], label); }
  async del(key, label) { return this.exec(['DEL', key], label); }
  snapshot() { return { enabled: this.enabled, degraded: !this.available, ...JSON.parse(JSON.stringify(this.stats)) }; }
}

module.exports = { Store };
