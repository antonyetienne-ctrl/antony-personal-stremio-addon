'use strict';
// Filtres durs (configurables). Tout se fait sur des IDENTIFIANTS de genres ; les genres "virtuels"
// (v:horror, v:romance, v:music) compensent l'absence de ces genres côté séries TMDB via des mots-clés.
const VIRT = {
  'v:horror': new Set(['horror', 'slasher', 'gore', 'splatter', 'supernatural horror', 'body horror', 'psychological horror', 'folk horror', 'creature feature', 'haunted house', 'demonic possession', 'found footage', 'zombie']),
  'v:romance': new Set(['romance', 'romantic comedy', 'love triangle', 'forbidden love', 'teen romance', 'romantic drama']),
  'v:music': new Set(['musical', 'music', 'concert', 'singer', 'musician', 'k-pop'])
};
const KIDS_KW = new Set(['kids', 'kid', "children's", 'children', 'preschool', 'preschoolers', 'toddler', 'nursery', 'for children', 'educational', 'kindergarten']);
const kwNames = (rec) => (rec.kw || []).map((x) => String(x[1] || '').toLowerCase());
const has = (rec, id) => (rec.g || []).includes(id);

function virtualTags(rec) {
  const names = kwNames(rec); const out = [];
  if ((rec.g || []).includes(10762) || hasKidsKeyword(rec)) out.push('v:kids');
  for (const [tag, set] of Object.entries(VIRT)) if (names.some((n) => set.has(n))) out.push(tag);
  return out;
}
const isAnime = (rec) => rec.ol === 'ja' || (rec.ct || []).includes('JP') || kwNames(rec).some((n) => n === 'anime' || n === 'manga');
const hasKidsKeyword = (rec) => kwNames(rec).some((n) => KIDS_KW.has(n));
const isKids = (rec) => has(rec, 10762) || hasKidsKeyword(rec);
// "animation occidentale pour enfants" : animation non-anime ET (familial OU enfants). Arcane, Invincible... ne sont pas touchés.
const isWesternKidsAnimation = (rec) => has(rec, 16) && !isAnime(rec) && (has(rec, 10751) || isKids(rec));

// Renvoie une raison de rejet (string) ou null si la fiche est admissible.
function rejectReason(rec, settings, type) {
  const t = settings[type], c = settings.common;
  if (!rec.im) return 'no-imdb';
  if (rec.ad) return 'adult';
  const useImdb = t.source === 'imdb';                       // source de qualité fixée par le moteur (IMDb si disponible, sinon TMDB)
  const rating = useImdb ? rec.ir : rec.va, votes = useImdb ? rec.iv : rec.vc;
  if (useImdb && (rating == null || votes == null)) return 'imdb-inconnu';
  if (rating < t.minRating) return 'rating';
  if (votes < t.minVotes) return 'votes';
  const numeric = t.exclude.filter((x) => typeof x === 'number');
  if ((rec.g || []).some((g) => numeric.includes(g))) return 'genre';
  const virt = t.exclude.filter((x) => typeof x === 'string');
  if (virt.length && virtualTags(rec).some((v) => virt.includes(v))) return 'virtual-genre';
  if (t.noWesternAnimation && has(rec, 16) && !isAnime(rec)) return 'animation-non-japonaise';
  if (type === 'series' && c.excludeCancelled && String(rec.st || '').toLowerCase().startsWith('cancel')) return 'cancelled';
  if (type === 'movie' && t.minRuntime && rec.rt && rec.rt < t.minRuntime) return 'runtime';
  if (t.minYear && rec.y && rec.y < t.minYear) return 'year';
  return null;
}
// Pré-filtre bon marché sur une ligne de /discover (avant de télécharger la fiche)
function rowReject(row, settings, type) {
  const t = settings[type], c = settings.common;
  if (row.vote_average < t.minRating || row.vote_count < t.minVotes) return 'quality';
  const yr = Number(String(row.release_date || row.first_air_date || '').slice(0, 4));
  if (t.minYear && yr && yr < t.minYear) return 'year';
  const g = row.genre_ids || [];
  if (g.some((x) => t.exclude.includes(x))) return 'genre';
  if (t.exclude.includes('v:kids') && g.includes(10762)) return 'kids';
  if (t.noWesternAnimation && g.includes(16) && row.original_language !== 'ja') return 'animation-non-japonaise';
  return null;
}
module.exports = { virtualTags, isAnime, isKids, isWesternKidsAnimation, rejectReason, rowReject };
