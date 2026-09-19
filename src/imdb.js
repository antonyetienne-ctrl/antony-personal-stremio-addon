'use strict';
// Notes et votes IMDb depuis le jeu de données public "title.ratings.tsv.gz" (usage personnel non commercial, mis à jour chaque jour).
// Le fichier est lu en flux ; on ne garde que les identifiants utiles (étiquetés + candidats : quelques milliers) => mémoire négligeable.
// Cache : une copie compacte est persistée dans Upstash (1 commande). Repli : téléchargement impossible => dernière copie ;
// aucune copie => le moteur retombe sur les notes TMDB (le diagnostic l'indique).
const zlib = require('zlib');
const { Readable } = require('stream');
const readline = require('readline');
const { clock, log } = require('./util');
const { key } = require('./config');

const URL_RATINGS = process.env.IMDB_RATINGS_URL || 'https://datasets.imdbws.com/title.ratings.tsv.gz';
const MAX_AGE_MS = 7 * 24 * 3600e3;
const MAX_KEPT = 60000;

class Imdb {
  constructor({ store }) { this.store = store; this.map = new Map(); this.at = 0; this.loaded = false; }
  async load() {
    if (this.loaded) return;
    const s = await this.store.getJson(key.imdb, 'imdb-load');
    if (s === undefined) return;                                   // Upstash indisponible : on réessaiera
    this.loaded = true;
    if (s && s.items) { for (const [id, v] of Object.entries(s.items)) this.map.set(id, v); this.at = s.at || 0; }
  }
  get(id) { return this.map.get(id) || null; }

  async _download(want, gate) {
    const t0 = Date.now(); const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 240000);
    try {
      const res = await fetch(URL_RATINGS, { signal: ac.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let input, bytes = Number(res.headers && res.headers.get && res.headers.get('content-length')) || 0;
      if (res.body && typeof res.body.getReader === 'function') input = Readable.fromWeb(res.body).pipe(zlib.createGunzip());
      else { const buf = Buffer.from(await res.arrayBuffer()); bytes = buf.length; input = Readable.from([zlib.gunzipSync(buf)]); }
      const rl = readline.createInterface({ input, crlfDelay: Infinity });
      const out = new Map(); let lines = 0, first = true;
      for await (const line of rl) {
        if (first) { first = false; if (!line.startsWith('tconst')) throw new Error('format inattendu (en-tête absent)'); continue; }
        lines++;
        if (gate && lines % 50000 === 0) await gate();
        const i = line.indexOf('\t'); if (i < 0) continue;
        const id = line.slice(0, i); if (!want.has(id)) continue;
        const j = line.indexOf('\t', i + 1);
        const r = Number(line.slice(i + 1, j)), v = Number(line.slice(j + 1));
        if (Number.isFinite(r) && Number.isFinite(v)) out.set(id, [r, v]);
      }
      return { out, lines, bytes, ms: Date.now() - t0 };
    } finally { clearTimeout(timer); }
  }

  // wantIds : identifiants IMDb dont on a besoin. Renvoie {active, info}. Ne lève jamais.
  async ensure(wantIds, { gate, force = false, minLines = Number(process.env.IMDB_MIN_LINES || 500000) } = {}) {
    await this.load();
    const want = new Set(wantIds);
    const missing = [...want].filter((id) => !this.map.has(id)).length;
    const fresh = clock.now() - this.at < MAX_AGE_MS;
    const info = { source: 'jeu de données IMDb (title.ratings)', at: this.at ? new Date(this.at).toISOString() : null, wanted: want.size, missing, fetch: null, stale: false, error: null };
    if (!force && fresh && missing <= 0.02 * want.size && this.map.size > 0) { info.fetch = 'copie récente réutilisée (aucun téléchargement)'; return { active: true, info }; }
    try {
      const keep = new Set(want); let n = 0; for (const id of this.map.keys()) { if (n++ >= MAX_KEPT) break; keep.add(id); }
      const d = await this._download(keep, gate);
      if (d.lines < minLines) throw new Error(`fichier trop court (${d.lines} lignes) : téléchargement ignoré`);
      this.map = d.out; this.at = clock.now();
      info.at = new Date(this.at).toISOString(); info.missing = [...want].filter((id) => !this.map.has(id)).length;
      info.fetch = { ok: true, lines: d.lines, bytes: d.bytes, kept: d.out.size, ms: d.ms };
      const saved = await this.store.setJson(key.imdb, { v: 1, at: this.at, items: Object.fromEntries(this.map) }, 'imdb-save');
      info.persisted = saved;
    } catch (e) {
      info.error = String(e && e.message || e).slice(0, 200); info.fetch = { ok: false }; info.stale = this.map.size > 0;
      log('warn', `IMDb indisponible (${info.error}) : ${this.map.size ? 'dernière copie utilisée' : 'repli sur les notes TMDB'}`);
    }
    return { active: this.map.size > 0, info };
  }
}

// Attache la note/les votes IMDb aux fiches (propriétés NON énumérables : jamais écrites dans le cache TMDB persistant).
// imdb = null => on efface (les critères de qualité retombent sur TMDB).
function attach(recs, imdb) {
  for (const rec of recs) {
    const v = imdb && rec.im ? imdb.get(rec.im) : null;
    Object.defineProperty(rec, 'ir', { value: v ? v[0] : undefined, writable: true, configurable: true, enumerable: false });
    Object.defineProperty(rec, 'iv', { value: v ? v[1] : undefined, writable: true, configurable: true, enumerable: false });
  }
}

module.exports = { Imdb, attach, URL_RATINGS };
