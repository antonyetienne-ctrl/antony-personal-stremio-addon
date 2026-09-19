'use strict';
const { num, sha } = require('./util');

const ENGINE_VERSION = '7.0.0';
const NS = 'av7';            // préfixe de toutes les clés Upstash (incompatible avec v6 = 'antony:v6:')
const LANG = 'fr-FR';        // langue TMDB, présente dans les clés de cache
const DETAIL_SCHEMA = 1;     // version du format compact des fiches TMDB
const TOP_N = 30;

// Genres TMDB (identifiants stables). Les filtres se font sur les IDENTIFIANTS, jamais sur les noms traduits.
const MOVIE_GENRES = [[28, 'Action'], [12, 'Aventure'], [16, 'Animation'], [35, 'Comédie'], [80, 'Crime'], [99, 'Documentaire'], [18, 'Drame'], [10751, 'Familial'], [14, 'Fantastique'], [36, 'Histoire'], [27, 'Horreur'], [10402, 'Musique'], [9648, 'Mystère'], [10749, 'Romance'], [878, 'Science-Fiction'], [10770, 'Téléfilm'], [53, 'Thriller'], [10752, 'Guerre'], [37, 'Western']];
// TMDB n'a PAS de genre Horreur/Romance/Musique pour les séries : on les détecte par mots-clés (genres "virtuels").
const TV_GENRES = [[10759, 'Action & Aventure'], [16, 'Animation'], [35, 'Comédie'], [80, 'Crime'], [99, 'Documentaire'], [18, 'Drame'], [10751, 'Familial'], [10762, 'Enfants'], [9648, 'Mystère'], [10763, 'Actualités'], [10764, 'Téléréalité'], [10765, 'Science-Fiction & Fantastique'], [10766, 'Feuilleton'], [10767, 'Talk-show'], [10768, 'Guerre & Politique'], [37, 'Western'], ['v:horror', 'Horreur (détectée par mots-clés)'], ['v:romance', 'Romance (détectée par mots-clés)'], ['v:music', 'Musique (détectée par mots-clés)']];

function defaultSettings() {
  return {
    movie: { minRating: 7.2, minVotes: 2000, minRuntime: 0, exclude: [35, 10749, 10402, 27], order: 'score' },
    series: { minRating: 7.2, minVotes: 2000, exclude: [35, 'v:romance', 'v:music', 'v:horror'], order: 'score' },
    common: { excludeKids: true, excludeWesternKidsAnimation: true, excludeCancelled: true, movieCatalog: true, seriesCatalog: true, frMeta: true, useGemini: true }
  };
}

const parseExclude = (arr, allowed) => {
  const ok = new Set(allowed.map(([id]) => String(id)));
  const out = [];
  for (const v of arr || []) { const s = String(v); if (ok.has(s)) out.push(/^\d+$/.test(s) ? Number(s) : s); }
  return [...new Set(out)];
};

// input : objet {movie:{...},series:{...},common:{...}} (déjà structuré) ; prev : réglages précédents
function normalizeSettings(input = {}, prev = defaultSettings()) {
  const p = JSON.parse(JSON.stringify(prev));
  const m = input.movie || {}, s = input.series || {}, c = input.common || {};
  if ('minRating' in m) p.movie.minRating = num(m.minRating, p.movie.minRating, 0, 10);
  if ('minVotes' in m) p.movie.minVotes = Math.round(num(m.minVotes, p.movie.minVotes, 0, 1e7));
  if ('minRuntime' in m) p.movie.minRuntime = Math.round(num(m.minRuntime, p.movie.minRuntime, 0, 600));
  if ('exclude' in m) p.movie.exclude = parseExclude(m.exclude, MOVIE_GENRES);
  if ('order' in m) p.movie.order = m.order === 'random' ? 'random' : 'score';
  if ('minRating' in s) p.series.minRating = num(s.minRating, p.series.minRating, 0, 10);
  if ('minVotes' in s) p.series.minVotes = Math.round(num(s.minVotes, p.series.minVotes, 0, 1e7));
  if ('exclude' in s) p.series.exclude = parseExclude(s.exclude, TV_GENRES);
  if ('order' in s) p.series.order = s.order === 'random' ? 'random' : 'score';
  for (const k of ['excludeKids', 'excludeWesternKidsAnimation', 'excludeCancelled', 'movieCatalog', 'seriesCatalog', 'frMeta', 'useGemini']) if (k in c) p.common[k] = Boolean(c[k]);
  return p;
}

// Empreinte des réglages qui changent le CONTENU du Top 30 (pas l'ordre d'affichage).
function settingsFingerprint(settings, type) {
  const t = settings[type];
  const c = settings.common;
  return sha(JSON.stringify({ type, minRating: t.minRating, minVotes: t.minVotes, minRuntime: t.minRuntime || 0, exclude: [...t.exclude].map(String).sort(), kids: c.excludeKids, west: c.excludeWesternKidsAnimation, canc: c.excludeCancelled, gem: c.useGemini }), 12);
}

const key = {
  user: (id) => `${NS}:user:${id}`,
  users: `${NS}:users`,
  job: (id) => `${NS}:job:${id}`,
  res: (id) => `${NS}:res:${id}`,          // UN seul payload : {movie, series} (publication atomique)
  snap: (id) => `${NS}:snap:${id}`,
  ckpt: (id) => `${NS}:ckpt:${id}`,
  tmdb: (kind, shard) => `${NS}:tmdb:${LANG}:${kind}:${shard}`,
  idmap: `${NS}:idmap`
};

module.exports = { ENGINE_VERSION, NS, LANG, DETAIL_SCHEMA, TOP_N, MOVIE_GENRES, TV_GENRES, defaultSettings, normalizeSettings, settingsFingerprint, key };
