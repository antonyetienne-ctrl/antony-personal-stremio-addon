'use strict';
// SIGNAUX SUPPLÉMENTAIRES, MESURÉS par le backtest et adoptés seulement s'ils gagnent (variantes E, F, G de src/backtest.js) :
//  - PERSONNES (`rec.pe`) : réalisateur (d…), compositeur (c…) et 5 premiers acteurs (a…), identifiants TMDB seulement (aucun nom n'est conservé) ; une personne ne devient une caractéristique
//    que si elle apparaît dans au moins 3 titres de l'historique (pas de bruit) ; le modèle en apprend le poids ;
//  - CE QUE RECOMMANDENT LES AUTRES (`rec.rc` = 20 recommandations TMDB ; `rec.rl`, `rec.rk` = nombre de tes ❤️ / de tes 👍 reliés au titre, dans un sens ou dans l'autre) : seulement les ❤️ et les 👍,
//    JAMAIS les vus sans note. Deux signaux séparés (❤️, 👍), le modèle apprend leur poids.
const { mapLimit } = require('./util');

// récupère les données manquantes (TMDB, en cache persistant ensuite) ; maxCalls borne le travail d'un calcul, le reste vient au calcul suivant
async function ensure(tmdb, recs, { gate, maxCalls = 6000 } = {}) {
  const need = recs.filter((r) => r.pe === undefined || r.rc === undefined); const todo = need.slice(0, Math.floor(maxCalls / 2)); let calls = 0, errors = 0;
  await mapLimit(todo, 6, async (r) => {
    const kind = r.k === 's' ? 'tv' : 'movie';
    if (r.pe === undefined) {
      try { const c = await tmdb.credits(kind, r.i); const pe = []; for (const p of (c.crew || [])) if (p.job === 'Director' || p.job === 'Original Music Composer') pe.push((p.job === 'Director' ? 'd' : 'c') + p.id); for (const p of (c.cast || []).slice(0, 5)) pe.push('a' + p.id); r.pe = pe.slice(0, 10); } catch { errors++; } calls++;
    }
    if (r.rc === undefined) {
      try { const x = await tmdb.related(kind, r.i, 'recommendations', 1); r.rc = (x.results || []).slice(0, 20).map((y) => y.id); } catch { errors++; } calls++;
    }
  }, gate);
  if (typeof tmdb.touch === 'function') for (const r of todo) if (r.pe !== undefined || r.rc !== undefined) tmdb.touch(r);
  return { manquants: need.length, traites: todo.length, appels: calls, erreurs: errors, restant: need.length - todo.length };
}
// rl / rk : liens (recommandation dans un sens ou dans l'autre) avec les ❤️ / 👍 de l'historique, le titre lui-même exclu
function edges(recs, lovedRecs, likedRecs) {
  const key = (r) => r.k + r.i; const loveSet = new Set(lovedRecs.map(key)), likeSet = new Set(likedRecs.map(key)); const revL = new Map(), revK = new Map();
  for (const r of lovedRecs) for (const id of (r.rc || [])) { const k = r.k + id; revL.set(k, (revL.get(k) || 0) + 1); }
  for (const r of likedRecs) for (const id of (r.rc || [])) { const k = r.k + id; revK.set(k, (revK.get(k) || 0) + 1); }
  for (const r of recs) {
    const self = key(r); let l = revL.get(self) || 0, k = revK.get(self) || 0;
    for (const id of (r.rc || [])) { const o = r.k + id; if (o === self) continue; if (loveSet.has(o)) l++; if (likeSet.has(o)) k++; }
    r.rl = l; r.rk = k;
  }
}
module.exports = { ensure, edges };
