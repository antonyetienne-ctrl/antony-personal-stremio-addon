'use strict';
// Catalogues « 📌 Votre liste de lecture » : la bibliothèque Stremio de l'utilisateur, séparée en films et en séries (TOUTE la bibliothèque, vus et non vus mêlés).
// Règles : lecture À LA DEMANDE (aucun calcul lourd, aucune écriture Upstash) avec une mémoire de 10 minutes en RAM ; passé ce délai, la liste périmée est servie
// aussitôt et rafraîchie en arrière-plan (« stale-while-revalidate ») ; si Stremio est injoignable on sert la dernière liste connue, sinon une liste vide (jamais d'erreur) ;
// aucune clé n'est journalisée. Même filtre que la bibliothèque de Stremio : ni titres retirés (removed), ni titres temporaires (temp) ;
// et on RETIRE ce qui figure déjà dans la rangée « Continuer à regarder » de Stremio (règle du cœur de Stremio : point de reprise timeOffset > 0).
const { fetchLibrary, extractImdb } = require('./stremio');
const { clock, log } = require('./util');

const PAGE = 100;                                            // taille d'une page de catalogue (paramètre skip)
const TTL_MS = 10 * 60 * 1000;
const posterFallback = (imdb) => `https://images.metahub.space/poster/small/${imdb}/img`;   // service d'images de Stremio (Cinemeta), utilisé seulement si la fiche n'a pas d'affiche

const timeMs = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : 0; };
// item brut Stremio -> fiche compacte (l'état brut est conservé pour l'outil de diagnostic)
function compactItem(it) {
  const imdb = extractImdb(it); const type = it && (it.type === 'movie' || it.type === 'series') ? it.type : null;
  if (!imdb || !type) return null;
  const s = it.state || {};
  return { imdb, type, name: typeof it.name === 'string' ? it.name : '', poster: typeof it.poster === 'string' ? it.poster : '', removed: it.removed === true, temp: it.temp === true,
    lw: timeMs(s.lastWatched) || timeMs(it._mtime) || timeMs(it._ctime), mtime: it._mtime || null, ctime: it._ctime || null, state: s };
}
// filtre de la bibliothèque de Stremio + tri par activité récente (comme le tri par défaut de Stremio), puis nom
const inContinueWatching = (x) => Number(x.state && x.state.timeOffset) > 0;
function listOf(items, type) {
  return items.filter((x) => x.type === type && !x.removed && !x.temp && !inContinueWatching(x)).sort((a, b) => b.lw - a.lw || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.imdb < b.imdb ? -1 : 1));
}
const toMeta = (x) => ({ id: x.imdb, type: x.type, name: x.name || x.imdb, poster: x.poster || posterFallback(x.imdb), posterShape: 'poster' });

class LibraryCatalog {
  constructor({ ttlMs = TTL_MS, firstLoadCapMs = 9000, fetcher = fetchLibrary, fetchTimeoutMs = 15000 } = {}) {
    this.ttlMs = ttlMs; this.firstLoadCapMs = firstLoadCapMs; this.fetcher = fetcher; this.fetchTimeoutMs = fetchTimeoutMs;
    this.cache = new Map();                                  // uid -> { at, items, p }
  }
  invalidate(uid) { this.cache.delete(uid); }               // clé Stremio modifiée
  _refresh(uid, authKey) {
    let e = this.cache.get(uid); if (!e) { e = { at: 0, items: null, p: null }; this.cache.set(uid, e); }
    if (e.p) return e.p;
    e.p = Promise.resolve().then(() => this.fetcher(authKey, { timeoutMs: this.fetchTimeoutMs })).then((raw) => {
      e.items = raw.map(compactItem).filter(Boolean); e.at = clock.now(); e.error = null; return e;
    }).catch((err) => { e.error = String(err && err.message || err).slice(0, 160); log('warn', 'Bibliothèque Stremio indisponible pour le catalogue', e.error); return e; }).finally(() => { e.p = null; });
    return e.p;
  }
  // -> { items: fiches compactes | null, at, stale, error, pending }
  async load(uid, authKey, { force = false } = {}) {
    const e = this.cache.get(uid);
    if (e && e.items && !force) {
      const fresh = clock.now() - e.at < this.ttlMs;
      if (!fresh) this._refresh(uid, authKey);              // périmée : servie tout de suite, rafraîchie en arrière-plan
      return { items: e.items, at: e.at, stale: !fresh, error: e.error || null };
    }
    const p = this._refresh(uid, authKey);
    const r = await Promise.race([p, new Promise((res) => setTimeout(() => res('cap'), force ? 30000 : this.firstLoadCapMs))]);
    if (r === 'cap') return { items: (this.cache.get(uid) || {}).items || null, at: 0, stale: true, pending: true, error: null };
    return { items: r.items, at: r.at, stale: false, error: r.error || null };
  }
  async metas(uid, authKey, type, skip = 0) {
    const r = await this.load(uid, authKey);
    if (!r.items) return [];
    return listOf(r.items, type).slice(skip, skip + PAGE).map(toMeta);
  }
}
module.exports = { LibraryCatalog, compactItem, listOf, toMeta, inContinueWatching, PAGE, TTL_MS };
