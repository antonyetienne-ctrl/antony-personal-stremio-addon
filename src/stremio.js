'use strict';
// Bibliothèque Stremio + statuts ❤️/👍.
// RÈGLE CRITIQUE (bug v6) : une erreur réseau n'est JAMAIS convertie en "aucune appréciation".
// Un statut inconnu reste inconnu ; trop d'inconnus => la synchronisation est abandonnée (l'ancien Top 30 reste servi).
const { fetchJson, mapLimit, log } = require('./util');

const API = 'https://api.strem.io/api';
const LIKES = 'https://likes.stremio.com/api/get_status';

function extractImdb(item) {
  for (const v of [item && item._id, item && item.id, item && item.metaItemId]) {
    if (typeof v !== 'string') continue;
    const m = v.match(/(?:^|:)(tt\d{5,12})(?:$|:)/);
    if (m) return m[1];
  }
  return null;
}
const arr = (x) => { const y = x && typeof x === 'object' && !Array.isArray(x) ? (x.result ?? x) : x; return Array.isArray(y) ? y : Array.isArray(y && y.items) ? y.items : []; };

async function fetchLibrary(authKey, { timeoutMs = 20000 } = {}) {
  const res = await fetchJson(`${API}/datastoreGet`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authKey, collection: 'libraryItem', ids: [], all: true }), timeoutMs, retries: 2, label: 'stremio' });
  if (res && res.error) throw new Error(`Stremio: ${typeof res.error === 'string' ? res.error : res.error.message || 'erreur'}`);
  const items = arr(res);
  const dedup = new Map();
  for (const it of items) if (it && (it._id || it.id)) dedup.set(it._id || it.id, it);
  return [...dedup.values()];
}

// Classe un item de bibliothèque. Retourne null si ce n'est pas un film/série IMDb.
//  seen    : terminé / marqué vu  -> exclu des recommandations ; négatif s'il n'a ni ❤️ ni 👍
//  started : commencé sans être terminé -> exclu des recommandations, mais PAS utilisé comme négatif
// (Pour les séries, la sémantique exacte de state.* n'est pas documentée : voir la répartition dans /diagnostic.)
function classify(item) {
  const imdb = extractImdb(item);
  const type = item && (item.type === 'movie' || item.type === 'series') ? item.type : null;
  if (!imdb || !type) return null;
  const s = item.state || {};
  const dur = Number(s.duration) || 0, tw = Number(s.timeWatched) || 0, off = Number(s.timeOffset) || 0;
  const times = Number(s.timesWatched) || 0, flagged = Number(s.flaggedWatched) || 0;
  const ratio = dur > 0 ? Math.max(tw, off) / dur : 0;
  const bitfield = typeof s.watched === 'string' && s.watched.trim().length > 0;
  let seen, started;
  if (type === 'movie') {
    // FILM : le drapeau flaggedWatched SEUL est un résidu (marqué vu puis retiré : compteur à 0, drapeau à 1 ; Stremio n'affiche pas de coche).
    // Vu = compteur > 0 (y compris marque manuelle) ou ≥ 70 % d'un vrai film (≥ 30 min ; une bande-annonce de 2 min ne compte pas).
    seen = times > 0 || (dur >= 30 * 60000 && ratio >= 0.7) || s.watched === true;
    started = !seen && (off > 0 || tw > 0 || ratio > 0 || bitfield || flagged > 0);
  }
  else {
    // SÉRIE : seule compte la marque "série vue" (peu importe l'état des épisodes). Le drapeau flaggedWatched SEUL (compteur à 0) est un RÉSIDU
    // (marqué vu puis retiré ; ex. True Beauty, Crash Landing on You, Snowdrop, confirmées NON vues par l'utilisateur).
    // Stremio incrémente timesWatched à chaque épisode joué, mais un suivi d'épisodes (bitfield) n'existe que si des épisodes ont réellement été lus. Donc :
    //  - compteur > 0 ET drapeau série (F) => vue (ex. Scrubs, Malcolm, Hero Skill : confirmées vues) ;
    //  - compteur > 0 SANS suivi d'épisodes = marque manuelle "vue", même avec un vieux reste de lecture (ex. Ted Lasso) => vue ;
    //  - compteur > 0 AVEC suivi d'épisodes mais AUCUNE progression de lecture = série entière marquée vue à la main => vue ;
    //  - épisodes réellement lus (compteur + suivi d'épisodes) sans drapeau, ou drapeau seul => commencée.
    const noProgress = tw === 0 && off === 0;      // aucune progression de lecture : marquage manuel de la série entière (ex. Silo, Le Jeu de la dame, Alice in Borderland, Game of Thrones)
    seen = (times > 0 && (flagged > 0 || !bitfield || noProgress)) || s.watched === true;
    started = !seen && (times > 0 || flagged > 0 || bitfield || off > 0 || tw > 0 || ratio > 0 || Boolean(s.video_id));
  }
  const lw = Date.parse(s.lastWatched || '') || Date.parse(item._mtime || '') || 0;
  // trace de la règle qui a déclenché "vu" (T = timesWatched, F = flaggedWatched, R = part regardée, D = durée en min) : visible dans /diagnostic
  const why = `T${times} F${flagged} R${ratio.toFixed(2)} D${Math.round(dur / 60000)}m${s.watched === true ? ' W' : ''}${bitfield ? ' b' : ''}`;
  return { imdb, type, seen, started, lw, why };
}

// Normalise la réponse de likes.stremio.com : 'love' | 'like' | 'none' | null (illisible => inconnu)
function normalizeStatus(x) {
  if (x === undefined) return null;
  if (x === null) return 'none';
  if (typeof x === 'object') {
    if (Array.isArray(x)) return x.length ? normalizeStatus(x[0]) : 'none';
    let sawKey = false;
    for (const k of ['status', 'rating', 'value', 'type', 'state', 'result']) {
      if (k in x) { sawKey = true; const r = normalizeStatus(x[k]); if (r && r !== 'none') return r; if (r === 'none') return 'none'; }
    }
    return sawKey ? null : (Object.keys(x).length === 0 ? 'none' : null);
  }
  if (typeof x !== 'string') return null;
  const s = x.toLowerCase().replace(/[ _-]/g, '');
  if (['loved', 'love', 'heart', 'hearted'].includes(s)) return 'love';
  if (['liked', 'like', 'thumbsup', 'thumbup'].includes(s)) return 'like';
  if (['', 'none', 'null', 'unrated', 'watched', 'notrated'].includes(s)) return 'none';
  return null;
}
async function fetchStatus(authKey, imdb, type) {
  const u = new URL(LIKES);
  u.searchParams.set('authToken', authKey); u.searchParams.set('mediaId', imdb); u.searchParams.set('mediaType', type);
  const res = await fetchJson(u, { timeoutMs: 8000, retries: 2, label: 'likes' });
  const s = normalizeStatus(res);
  if (s === null) throw new Error('statut illisible');
  return s;
}

// Balayage de tous les items. prev = Map imdb->statut de la synchro précédente (repli pour un échec ISOLÉ).
// Renvoie {statuses, unknown, fromPrev, total}. Lève si le service est en panne ou si trop d'appels échouent :
// on abandonne alors la synchronisation (le dernier Top 30 reste servi) au lieu de deviner des statuts.
async function scanStatuses(authKey, items, { prev = new Map(), concurrency = 8, maxFailRatio = 0.05, gate, fetchStatusFn = fetchStatus } = {}) {
  const statuses = new Map();
  let unknown = 0, fromPrev = 0, done = 0, fails = 0, consecutive = 0, tripped = false;
  const { results } = await mapLimit(items, concurrency, async (it) => {
    if (tripped) return undefined;
    try { const r = await fetchStatusFn(authKey, it.imdb, it.type); consecutive = 0; return r; }
    catch (e) { fails++; if (++consecutive >= 15 && fails >= 15 && done < 60) tripped = true; return undefined; }
    finally { done++; }
  }, gate);
  if (tripped) throw new Error('Service de statuts Stremio injoignable : synchronisation abandonnée, l\'ancien Top 30 est conservé');
  items.forEach((it, i) => {
    const r = results[i];
    if (r) statuses.set(it.imdb, r);
    else if (prev.has(it.imdb) && prev.get(it.imdb) !== '?') { statuses.set(it.imdb, prev.get(it.imdb)); fromPrev++; }
    else { statuses.set(it.imdb, '?'); unknown++; }
  });
  const total = items.length;
  if (total && (unknown + fromPrev) / total > maxFailRatio) throw new Error(`Statuts Stremio incomplets (${unknown + fromPrev}/${total} appels en échec) : synchronisation abandonnée, l'ancien Top 30 est conservé`);
  return { statuses, unknown, fromPrev, total };
}

module.exports = { extractImdb, fetchLibrary, classify, normalizeStatus, fetchStatus, scanStatuses };
