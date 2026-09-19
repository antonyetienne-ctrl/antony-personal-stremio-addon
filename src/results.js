'use strict';
// Résultats publiés : UN SEUL payload Upstash par utilisateur ({movie, series}) => publication atomique.
// RAM-first : /catalog ne lit que la RAM (hydratation Upstash bornée à 2,5 s au premier accès après démarrage).
const { clock, zurichDay, shuffleSeeded, log } = require('./util');
const { key, ENGINE_VERSION } = require('./config');

const validSection = (s) => s && Array.isArray(s.items) && s.items.length > 0 && s.items.every((x) => x && x.imdb && x.meta && x.meta.name);

class Results {
  constructor(store) { this.store = store; this.ram = new Map(); this.pending = new Set(); }
  async getFast(uid, timeoutMs = 2500) {
    if (this.ram.has(uid)) return this.ram.get(uid);
    if (!this.store.available) return null;
    const p = this.store.getJson(key.res(uid), 'result-load');
    const r = await Promise.race([p, new Promise((res) => setTimeout(() => res('timeout'), timeoutMs))]);
    if (r === 'timeout') { p.then((v) => { if (v && !this.ram.has(uid)) this._accept(uid, v); }).catch(() => {}); return null; }
    if (r) this._accept(uid, r);
    return this.ram.get(uid) || null;
  }
  _accept(uid, payload) {
    const out = { v: 1, engine: payload.engine, buildId: payload.buildId, createdAt: payload.createdAt };
    for (const t of ['movie', 'series']) if (validSection(payload[t])) out[t] = payload[t];
    if (out.movie || out.series) this.ram.set(uid, out);
  }
  // sections : {movie?, series?} déjà validées. Les types non fournis conservent la version précédente.
  async publish(uid, sections, { buildId }) {
    const prev = this.ram.get(uid) || {};
    const next = { v: 1, engine: ENGINE_VERSION, buildId, createdAt: clock.now() };
    for (const t of ['movie', 'series']) {
      if (sections[t] && validSection(sections[t])) next[t] = sections[t];
      else if (prev[t]) next[t] = prev[t];
    }
    if (!next.movie && !next.series) throw new Error('publication refusée : aucun résultat valide');
    const ok = await this.store.setJson(key.res(uid), next, 'result-publish');
    this.ram.set(uid, next);           // valide même si Upstash est indisponible
    if (ok) this.pending.delete(uid); else { this.pending.add(uid); log('warn', 'Résultat publié en RAM seulement (Upstash indisponible) : nouvelle tentative plus tard'); }
    return { persisted: ok };
  }
  async retryPending(uid) {
    if (!this.pending.has(uid) || !this.ram.has(uid)) return;
    if (await this.store.setJson(key.res(uid), this.ram.get(uid), 'result-retry')) this.pending.delete(uid);
  }
  // ordre d'affichage : pertinence, ou mélange déterministe (jour Zurich + build) appliqué APRÈS la sélection du Top 30
  ordered(uid, type, order) {
    const sec = (this.ram.get(uid) || {})[type];
    if (!sec) return [];
    const items = order === 'random' ? shuffleSeeded(sec.items, `${uid}:${sec.buildId || ''}:${zurichDay()}`) : sec.items;
    return items.map((x) => x.meta);
  }
  section(uid, type) { return (this.ram.get(uid) || {})[type] || null; }
}
module.exports = { Results, validSection };
