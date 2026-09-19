'use strict';
// Seuils automatiques note/votes : calculés sur les ❤️/👍 de l'utilisateur (10e percentile) pour laisser passer ~90 % de ce qu'il aime.
// Planchers de sécurité : note ≥ 5, votes ≥ 100 (en dessous, la note TMDB est du bruit). Le mode "manuel" garde les valeurs saisies.
const pct = (arr, p) => { if (!arr.length) return null; const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.max(0, Math.floor(p * (a.length - 1))))]; };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const describe = (arr) => ({ p10: pct(arr, 0.1), p25: pct(arr, 0.25), p50: pct(arr, 0.5), p75: pct(arr, 0.75) });

function autoThresholds(settings, labeled, { source = 'tmdb' } = {}) {
  const imdb = source === 'imdb';
  const getR = (i) => (imdb ? i.rec.ir : i.rec.va), getV = (i) => (imdb ? i.rec.iv : i.rec.vc);
  const eff = JSON.parse(JSON.stringify(settings)); const info = {};
  for (const type of ['movie', 'series']) {
    const t = eff[type]; const pos = labeled.filter((i) => i.rec.k === type[0] && i.label > 0);
    const ratings = pos.map(getR).filter((x) => x > 0), votes = pos.map(getV).filter((x) => x > 0), years = pos.map((i) => i.rec.y).filter(Boolean);
    let source = 'manuel';
    if (t.ratingMode !== 'manual') {
      if (pos.length >= 30) { t.minRating = clamp(Math.floor(pct(ratings, 0.1) * 10) / 10, 5, imdb ? 8 : 7.5); t.minVotes = clamp(Math.round(pct(votes, 0.1) / 10) * 10, 100, imdb ? 500000 : 5000); source = `automatique (10e percentile de tes ❤️/👍, ${imdb ? 'IMDb' : 'TMDB'})`; }
      else { t.minRating = 6.5; t.minVotes = 500; source = 'automatique : historique trop court, valeurs prudentes'; }
    }
    info[type] = { echelle: imdb ? 'IMDb' : 'TMDB', mode: t.ratingMode === 'manual' ? 'manuel' : 'auto', source, minRating: t.minRating, minVotes: t.minVotes, basedOn: pos.length, distribution: { note: describe(ratings), votes: describe(votes), annee: describe(years) } };
  }
  return { eff, info };
}
module.exports = { autoThresholds, pct };
