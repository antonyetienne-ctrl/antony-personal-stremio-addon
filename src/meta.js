'use strict';
// /meta en français : fiche TMDB fr-FR (titre, synopsis, genres, poster FR sinon défaut, trailer FR sinon repli)
// + liste d'épisodes (videos) pour les séries, afin de ne jamais dégrader la fiche par rapport à Cinemeta.
const { mapLimit, LRU, clock } = require('./util');

const cache = new LRU(300);
const TTL = 6 * 3600e3;
const kindOf = (t) => (t === 'series' ? 'tv' : 'movie');

async function buildMeta(tmdb, type, imdb) {
  const ck = `${type}:${imdb}`; const hit = cache.get(ck);
  if (hit && clock.now() - hit.at < TTL) return hit.meta;
  const ids = await tmdb.findMany([imdb], type); const id = ids.get(imdb); if (!id) return null;
  const rec = (await tmdb.ensureDetails(kindOf(type), [id])).get(id); if (!rec) return null;
  const meta = { id: imdb, type, name: rec.t || rec.ot, description: rec.ov || '', releaseInfo: rec.y ? String(rec.y) : undefined, genres: rec.gn && rec.gn.length ? rec.gn : undefined, posterShape: 'poster' };
  if (rec.po) meta.poster = `https://image.tmdb.org/t/p/w500${rec.po}`;
  if (rec.bg) meta.background = `https://image.tmdb.org/t/p/w1280${rec.bg}`;
  if (rec.rt) meta.runtime = `${rec.rt} min`;
  if (rec.tr) { meta.trailers = [{ source: rec.tr.k, type: 'Trailer' }]; meta.trailerStreams = [{ title: rec.t, ytId: rec.tr.k }]; }
  if (type === 'series' && rec.sn && rec.sn.length) {
    const seasons = rec.sn.slice(0, 40);
    const { results } = await mapLimit(seasons, 4, (n) => tmdb.season(id, n));
    const videos = [];
    seasons.forEach((n, i) => { const s = results[i]; if (!s || !Array.isArray(s.episodes)) return; for (const ep of s.episodes) { const v = { id: `${imdb}:${n}:${ep.episode_number}`, title: ep.name || `Épisode ${ep.episode_number}`, season: n, episode: ep.episode_number, overview: ep.overview || '' }; if (ep.air_date) v.released = `${ep.air_date}T00:00:00.000Z`; if (ep.still_path) v.thumbnail = `https://image.tmdb.org/t/p/w300${ep.still_path}`; videos.push(v); } });
    if (videos.length) meta.videos = videos;
  }
  cache.set(ck, { at: clock.now(), meta });
  return meta;
}
module.exports = { buildMeta };
