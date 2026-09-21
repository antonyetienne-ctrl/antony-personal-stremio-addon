'use strict';
// Client TMDB (Bearer Read Access Token), TOUJOURS en fr-FR. Cache RAM-first :
//  - fiches compactes en RAM ;
//  - persistance Upstash par BLOCS (16 par type) : lecture unique au 1er calcul après démarrage,
//    écriture en fin de calcul, uniquement des blocs modifiés (≈ 30 commandes par calcul au lieu de milliers).
const { fetchJson, mapLimit, clock, log, LRU } = require('./util');
const { LANG, DETAIL_SCHEMA, key } = require('./config');

const BASE = 'https://api.themoviedb.org/3';
const SHARDS = 16;
const MAX_AGE_MS = 45 * 24 * 3600e3;
const shardOf = (id) => id % SHARDS;

function pickTrailer(videos) {
  const vs = (videos || []).filter((v) => v.site === 'YouTube' && v.key && (v.type === 'Trailer' || v.type === 'Teaser'));
  const score = (v) => (v.iso_639_1 === 'fr' ? 100 : v.iso_639_1 === 'en' ? 50 : 10) + (v.type === 'Trailer' ? 20 : 0) + (v.official ? 5 : 0);
  vs.sort((a, b) => score(b) - score(a));
  const v = vs[0];
  return v ? { k: v.key, l: v.iso_639_1 || null, ty: v.type } : null;
}

// Format compact stocké (≈ 1,3 Ko). Les noms de personnes ne sont pas conservés (seulement des ids).
function compact(kind, d) {
  const tv = kind === 'tv';
  const kws = (tv ? d.keywords && d.keywords.results : d.keywords && d.keywords.keywords) || [];
  const posters = (d.images && d.images.posters) || [];
  const frPoster = posters.filter((p) => p.iso_639_1 === 'fr').sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0))[0];
  const crew = (d.credits && d.credits.crew) || [];
  const dir = tv ? (d.created_by || []).map((c) => c.id) : crew.filter((c) => c.job === 'Director').map((c) => c.id);
  return {
    v: DETAIL_SCHEMA, i: d.id, k: tv ? 's' : 'm', im: (d.external_ids && d.external_ids.imdb_id) || d.imdb_id || null,
    t: d.title || d.name || '', ot: d.original_title || d.original_name || '', ol: d.original_language || null,
    ov: String(d.overview || '').slice(0, 800),
    g: (d.genres || []).map((g) => g.id), gn: (d.genres || []).map((g) => g.name),
    kw: kws.slice(0, 40).map((x) => [x.id, x.name]),
    y: Number(String(d.release_date || d.first_air_date || '').slice(0, 4)) || null,
    rt: d.runtime || (d.episode_run_time && d.episode_run_time[0]) || null,
    st: d.status || null, va: Number(d.vote_average) || 0, vc: Number(d.vote_count) || 0,
    po: (frPoster && frPoster.file_path) || d.poster_path || null, pl: frPoster ? 'fr' : d.poster_path ? 'def' : null,
    bg: d.backdrop_path || null,
    col: (d.belongs_to_collection && d.belongs_to_collection.id) || null,
    cast: ((d.credits && d.credits.cast) || []).slice(0, 6).map((c) => c.id), dir,
    ct: tv ? (d.origin_country || []) : (d.production_countries || []).map((c) => c.iso_3166_1),
    ad: Boolean(d.adult), ns: d.number_of_seasons || null,
    sn: tv ? (d.seasons || []).filter((s) => s.season_number > 0).map((s) => s.season_number) : undefined,
    tr: pickTrailer(d.videos && d.videos.results), ts: clock.now()
  };
}

class Tmdb {
  constructor({ token, store }) {
    this.token = token; this.store = store;
    this.ram = new Map();          // 'm123' | 's456' -> compact
    this.idmap = new Map();        // 'm:tt123' -> 'm123' | '-' ; 's:tt456' -> 's456' | '-'
    this.dirtyShards = new Set(); this.idmapDirty = false;
    this.loaded = false; this.canFlush = false;
    this.stats = { calls: 0, errors: 0, byLabel: {}, cacheHits: 0, fetched: 0 };
    this.seasonCache = new LRU(400);
    this.langUsed = new Set();
    this.consecutiveFails = 0; this.downUntil = 0;
  }
  _on = (label, status) => { this.stats.calls++; this.stats.byLabel[label] = (this.stats.byLabel[label] || 0) + 1; if (status === 'err' || status >= 400) this.stats.errors++; };
  async get(path, params = {}, { timeoutMs = 10000, label = 'tmdb' } = {}) {
    // disjoncteur : après 20 échecs consécutifs on échoue vite pendant 45 s (pas de tempête de retries sur 0,1 CPU)
    if (clock.now() < this.downUntil) throw new Error('TMDB indisponible (disjoncteur ouvert)');
    const u = new URL(BASE + path);
    const p = { language: LANG, ...params };
    this.langUsed.add(p.language);
    for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    try {
      const r = await fetchJson(u, { headers: { Authorization: `Bearer ${this.token}`, accept: 'application/json' }, timeoutMs, retries: 2, label, onCall: this._on });
      this.consecutiveFails = 0; return r;
    } catch (e) {
      if (!(e && e.status === 404) && ++this.consecutiveFails >= 20) { this.downUntil = clock.now() + 45000; this.consecutiveFails = 0; log('warn', 'TMDB : 20 échecs consécutifs, disjoncteur ouvert 45 s'); }
      throw e;
    }
  }

  // ---------- persistance par blocs ----------
  // Lecture UNIQUE partagée par tous les appelants ; après un échec, pause de 90 s (évite la tempête de relectures quand Upstash est lent).
  async loadPersisted() {
    if (this.loaded) return true;
    if (!this.store.enabled) { this.loaded = true; this.canFlush = false; return false; }
    if (this._loadP) return this._loadP;
    if (this._loadFailAt && Date.now() - this._loadFailAt < (this._loadPauseMs ?? 90000)) return false;
    this._loadP = this._loadOnce().catch(() => false).finally(() => { this._loadP = null; });
    return this._loadP;
  }
  async _loadOnce() {
    const keys = [];
    for (const kind of ['m', 's']) for (let s = 0; s < SHARDS; s++) keys.push(key.tmdb(kind, s));
    keys.push(key.idmap);
    const res = await this.store.getManyJson(keys, 'tmdb-cache-load');
    if (res === undefined || res.some((r) => r === undefined)) {                       // échec total OU partiel : on ne charge rien de partiel et on n'écrasera jamais l'existant
      if (!this._loadFailAt || Date.now() - this._loadFailAt > 5000) log('warn', 'Cache TMDB persistant illisible (Upstash) : on repart du réseau, sans écraser l\'existant');
      this.canFlush = false; this._loadFailAt = Date.now(); return false;
    }
    let n = 0;
    res.slice(0, keys.length - 1).forEach((blob) => { if (blob && typeof blob === 'object') for (const [id, rec] of Object.entries(blob)) { if (rec && rec.v === DETAIL_SCHEMA && !this.ram.has(rec.k + id)) { this.ram.set(rec.k + id, rec); n++; } } });
    const idm = res[keys.length - 1];
    if (idm && typeof idm === 'object') for (const [k, v] of Object.entries(idm)) this.idmap.set(k, v);
    this.loaded = true; this.canFlush = true;
    log('info', `Cache TMDB persistant chargé : ${n} fiches, ${this.idmap.size} correspondances IMDb`);
    return true;
  }
  async flushPersisted() {
    if (!this.store.enabled || !this.canFlush) return { written: 0, skipped: true };
    const entries = [];
    if (this.dirtyShards.size) {
      const byShard = new Map();
      for (const [k, rec] of this.ram) { const sk = key.tmdb(rec.k, shardOf(rec.i)); if (this.dirtyShards.has(sk)) { if (!byShard.has(sk)) byShard.set(sk, {}); byShard.get(sk)[rec.i] = rec; } }
      for (const [sk, obj] of byShard) entries.push([sk, obj]);
    }
    if (this.idmapDirty) entries.push([key.idmap, Object.fromEntries(this.idmap)]);
    if (!entries.length) return { written: 0 };
    const ok = await this.store.setManyJson(entries, 'tmdb-cache-flush');
    if (ok) { this.dirtyShards.clear(); this.idmapDirty = false; }
    return { written: ok ? entries.length : 0, ok };
  }
  touch(rec) { this.dirtyShards.add(key.tmdb(rec.k, shardOf(rec.i))); }          // fiche complétée après coup (personnes, recommandations) : sera réécrite au prochain enregistrement du cache
  _put(rec) { this.ram.set(rec.k + rec.i, rec); this.dirtyShards.add(key.tmdb(rec.k, shardOf(rec.i))); }

  // ---------- IMDb -> TMDB ----------
  async findMany(imdbIds, type, { gate } = {}) {
    const kc = type === 'series' ? 's' : 'm';
    const out = new Map(); const need = [];
    for (const im of imdbIds) { const v = this.idmap.get(`${kc}:${im}`); if (v) { if (v !== '-') out.set(im, Number(v.slice(1))); } else need.push(im); }
    if (need.length) {
      const { results } = await mapLimit(need, 8, async (im) => {
        const r = await this.get(`/find/${im}`, { external_source: 'imdb_id' }, { label: 'find' });
        const hit = (type === 'series' ? (r.tv_results || []) : (r.movie_results || []))[0];
        return hit ? hit.id : null;
      }, gate);
      need.forEach((im, i) => {
        const id = results[i];
        if (id === undefined) return;                       // erreur réseau : on ne mémorise rien
        this.idmap.set(`${kc}:${im}`, id ? kc + id : '-'); this.idmapDirty = true;
        if (id) out.set(im, id);
      });
    }
    return out;
  }

  // ---------- fiches détaillées ----------
  async fetchDetails(kind, id) {
    const d = await this.get(`/${kind}/${id}`, { append_to_response: 'keywords,external_ids,credits,videos,images', include_image_language: 'fr,en,null', include_video_language: 'fr,en,null' }, { label: 'details' });
    return compact(kind, d);
  }
  // Renvoie Map id -> fiche compacte. Les échecs réseau ne suppriment rien : on retombe sur une fiche périmée si elle existe.
  async ensureDetails(kind, ids, { gate, maxAgeMs = MAX_AGE_MS, onProgress } = {}) {
    await this.loadPersisted();
    const kc = kind === 'tv' ? 's' : 'm';
    const out = new Map(); const need = [];
    for (const id of new Set(ids)) {
      const c = this.ram.get(kc + id);
      if (c && clock.now() - c.ts < maxAgeMs) { out.set(id, c); this.stats.cacheHits++; } else need.push(id);
    }
    if (need.length) {
      let done = 0;
      const { results } = await mapLimit(need, 8, async (id) => { const r = await this.fetchDetails(kind, id); if (onProgress && ++done % 50 === 0) onProgress(done, need.length); return r; }, gate);
      need.forEach((id, i) => {
        const r = results[i];
        if (r) { this._put(r); out.set(id, r); this.stats.fetched++; }
        else { const old = this.ram.get(kc + id); if (old) out.set(id, old); }
      });
    }
    return out;
  }
  peek(kind, id) { return this.ram.get((kind === 'tv' ? 's' : 'm') + id) || null; }

  // ---------- listes ----------
  async discover(kind, params, opts) { return this.get(`/discover/${kind}`, { include_adult: false, ...params }, { label: 'discover', ...opts }); }
  async credits(kind, id) { return this.get(`/${kind}/${id}/credits`, {}, { label: 'credits' }); }
  async related(kind, id, what, page = 1) { return this.get(`/${kind}/${id}/${what}`, { page }, { label: what }); }
  async season(tvId, n) {
    const k = `${tvId}:${n}`; const c = this.seasonCache.get(k); if (c) return c;
    const s = await this.get(`/tv/${tvId}/season/${n}`, {}, { label: 'season', timeoutMs: 8000 });
    this.seasonCache.set(k, s); return s;
  }
}

module.exports = { Tmdb, compact, pickTrailer, SHARDS };
