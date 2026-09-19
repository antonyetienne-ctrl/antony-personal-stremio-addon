'use strict';
// Suivi de titres attendus par l'utilisateur (page de configuration, "Titres à surveiller") : pour chacun, le diagnostic indique s'il est
// trouvé, déjà vu/noté/commencé, filtré (par quelle règle), énuméré par la découverte, et son rang dans le classement complet.
const { rejectReason } = require('./filters');

// "série: Rome" / "film: Rome" lèvent l'ambiguïté ; sinon on retient le résultat TMDB le plus voté.
function parseName(raw) {
  const m = /^\s*(série|serie|series|tv|film|movie)\s*:\s*(.+)$/i.exec(String(raw));
  if (!m) return { q: String(raw).trim(), want: null };
  return { q: m[2].trim(), want: /^(série|serie|series|tv)$/i.test(m[1]) ? 'tv' : 'movie' };
}
async function resolve(tmdb, names, { gate } = {}) {
  const out = [];
  for (const raw of (names || []).slice(0, 30)) {
    const { q, want } = parseName(raw); if (!q) continue;
    try {
      const r = await tmdb.get('/search/multi', { query: q, include_adult: false, page: 1 }, { label: 'search' });
      const hits = ((r && r.results) || []).filter((x) => (x.media_type === 'tv' || x.media_type === 'movie') && (!want || x.media_type === want));
      hits.sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0));
      out.push(hits[0] ? { demande: raw, kind: hits[0].media_type, id: hits[0].id } : { demande: raw, kind: null, id: null });
    } catch (e) { out.push({ demande: raw, kind: null, id: null, erreur: String(e.message).slice(0, 80) }); }
    if (gate) await gate();
  }
  return out;
}

// ctx : { classifiedBy, statuses, effA, enumerated:{movie:Set,series:Set}, utils:{movie:[],series:[]}, scoreOne:async(rec,type)=>{util,s} }
async function inspect(entry, rec, ctx) {
  if (!rec) return { demande: entry.demande, trouve: null, statut: entry.erreur ? `recherche TMDB en échec (${entry.erreur})` : 'titre introuvable sur TMDB' };
  const type = rec.k === 's' ? 'series' : 'movie';
  const out = { demande: entry.demande, trouve: `${rec.t} (${rec.y || '?'}) — ${type === 'series' ? 'série' : 'film'}`, imdb: rec.im };
  const st = ctx.statuses.get(rec.im), c = ctx.classifiedBy.get(rec.im);
  if (st === 'love' || st === 'like') { out.statut = `déjà noté ${st === 'love' ? '❤️' : '👍'} : exclu des recommandations`; return out; }
  if (c && c.seen) { out.statut = 'marqué VU : exclu des recommandations'; out.signaux = c.why || null; return out; }
  if (c && c.started) { out.statut = 'commencé : exclu des recommandations'; out.signaux = c.why || null; return out; }
  out.statut = c ? 'dans ta bibliothèque, non vu : éligible' : 'absent de ta bibliothèque : éligible';
  const t = ctx.effA[type];
  out.qualite = { source: t.source, note: rec.ir ?? rec.va, votes: rec.iv ?? rec.vc, seuilNote: t.minRating, seuilVotes: t.minVotes };
  const why = rejectReason(rec, ctx.effA, type);
  out.filtre = why ? `ÉCARTÉ par le filtre « ${why} »` : 'passe tous les filtres';
  out.enumere = ctx.enumerated[type].has(rec.i) ? 'oui' : 'non (hors des pages parcourues ou du pré-filtre TMDB)';
  if (!why) {
    const sc = await ctx.scoreOne(rec, type);
    const u = ctx.utils[type] || [];
    out.rang = `${1 + u.filter((x) => x > sc.util).length} sur ${u.length + (ctx.enumerated[type].has(rec.i) ? 0 : 1)} candidats`;
    out.score = { utilite: +sc.util.toFixed(3), pApprecie: +sc.s.pPos.toFixed(2), pCoupDeCoeur: +sc.s.pLove.toFixed(2) };
  }
  return out;
}
module.exports = { parseName, resolve, inspect };
