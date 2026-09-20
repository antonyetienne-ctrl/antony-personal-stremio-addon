'use strict';
// Tableau de PREUVES calculé sur l'historique (rien n'est deviné par Gemini) + texte des FILTRES ACTIFS de la page de configuration.
//  - chaque titre est décrit par sa signature COMPLÈTE (tous ses genres, ses mots-clés) ;
//  - le tableau liste les combinaisons de 1 à 3 genres, les mots-clés seuls et les couples « un genre + un mot-clé » qui ont assez de titres ;
//    une signature trop rare se replie sur ses sous-combinaisons (celles-ci sont comptées séparément), rien n'est jamais conclu sur trop peu de titres ;
//  - fiabilité : « suffisante » à partir de 8 titres, « faible » de 5 à 7 ; en dessous, la combinaison n'est pas listée (= preuve insuffisante).
const { MOVIE_GENRES, TV_GENRES } = require('./config');

const MIN_LISTED = 5, SUFFICIENT = 8, PER_SIDE = 14, WEAK_LINES = 4;

function subsets(arr, maxK) {
  const out = [], n = arr.length;
  const rec = (start, cur) => { if (cur.length) out.push(cur.slice()); if (cur.length >= maxK) return; for (let i = start; i < n; i++) { cur.push(arr[i]); rec(i + 1, cur); cur.pop(); } };
  rec(0, []); return out;
}
// signatures d'un titre : { clé, libellé, composants }
function signatures(rec) {
  const genres = [...new Set(rec.gn || [])].sort().slice(0, 5);
  const kws = [...new Set((rec.kw || []).map((k) => String(k[1] || '').trim()).filter(Boolean))].slice(0, 8);
  const out = [];
  for (const c of subsets(genres, 3)) out.push({ key: 'g:' + c.join('+'), label: c.join(' + '), parts: c.length });
  for (const k of kws) out.push({ key: 'k:' + k, label: `mot-clé « ${k} »`, parts: 1 });
  for (const g of genres) for (const k of kws) out.push({ key: `gk:${g}|${k}`, label: `${g} + mot-clé « ${k} »`, parts: 2 });
  return out;
}

// labeled : [{ rec, label }] avec label 2 (❤️), 1 (👍), 0 (vu sans être aimé)
function buildEvidence(labeled) {
  const res = {};
  for (const [kind, name] of [['m', 'FILMS'], ['s', 'SÉRIES']]) {
    const items = labeled.filter((i) => i.rec.k === kind);
    const N = items.length; const pos = items.filter((i) => i.label > 0).length;
    const p0 = N ? pos / N : 0;
    const stats = new Map();
    for (const it of items) for (const s of signatures(it.rec)) {
      let e = stats.get(s.key); if (!e) { e = { label: s.label, parts: s.parts, n: 0, love: 0, like: 0, rej: 0 }; stats.set(s.key, e); }
      e.n++; if (it.label === 2) e.love++; else if (it.label === 1) e.like++; else e.rej++;
    }
    const rows = [...stats.values()].filter((e) => e.n >= MIN_LISTED).map((e) => {
      const rate = (e.love + e.like) / e.n; const z = p0 > 0 && p0 < 1 ? (rate - p0) / Math.sqrt((p0 * (1 - p0)) / e.n) : 0;
      return { ...e, rate, z, fiabilite: e.n >= SUFFICIENT ? 'suffisante' : 'faible' };
    });
    // ensembles identiques (mêmes décomptes) : on garde le libellé le plus court
    const seen = new Map();
    for (const r of rows.sort((a, b) => a.parts - b.parts || a.label.length - b.label.length || (a.label < b.label ? -1 : 1))) { const k = `${r.n}|${r.love}|${r.like}|${r.rej}`; if (!seen.has(k)) seen.set(k, r); }
    const uniq = [...seen.values()];
    const by = (a, b) => Math.abs(b.z) - Math.abs(a.z) || (a.label < b.label ? -1 : 1);
    const solid = uniq.filter((r) => r.fiabilite === 'suffisante');
    const up = solid.filter((r) => r.z > 0).sort(by).slice(0, PER_SIDE), down = solid.filter((r) => r.z < 0).sort(by).slice(0, PER_SIDE);
    const weak = uniq.filter((r) => r.fiabilite === 'faible' && Math.abs(r.z) > 1.5).sort(by).slice(0, WEAK_LINES);
    res[kind] = { nom: name, titres: N, tauxAppreciation: p0, lignes: [...up, ...down, ...weak] };
  }
  return res;
}
const line = (r) => `${r.label} | ${r.n} vus | ❤️ ${r.love} | 👍 ${r.like} | ✗ ${r.rej} | ${Math.round(r.rate * 100)} % | ${r.fiabilite}`;
function evidenceText(ev) {
  return ['m', 's'].filter((k) => ev[k] && ev[k].titres).map((k) => `${ev[k].nom} (${ev[k].titres} titres, appréciation moyenne ${Math.round(ev[k].tauxAppreciation * 100)} %) :\n${ev[k].lignes.map(line).join('\n') || '(aucune combinaison assez documentée)'}`).join('\n\n');
}
function overall(ev) { const n = (ev.m ? ev.m.titres : 0) + (ev.s ? ev.s.titres : 0); const pos = (ev.m ? ev.m.tauxAppreciation * ev.m.titres : 0) + (ev.s ? ev.s.tauxAppreciation * ev.s.titres : 0); return { n, taux: n ? Math.round((pos / n) * 100) : 0 }; }

// ---------- FILTRES ACTIFS (page de configuration) ----------
const VIRTUAL = { 'v:kids': 'contenus pour enfants', 'v:horror': 'horreur', 'v:romance': 'romance', 'v:music': 'musique' };
function genreNames(ids, table) {
  const map = new Map(table); return (ids || []).map((g) => (typeof g === 'string' && VIRTUAL[g]) || map.get(g) || String(g));
}
function activeFiltersText(settings, { vfActive = false } = {}) {
  const m = settings.movie || {}, s = settings.series || {}, c = settings.common || {};
  const list = (arr) => (arr.length ? `genres exclus : ${arr.join(', ')}` : 'aucun genre exclu');
  const out = [];
  out.push(`- Films : ${list(genreNames(m.exclude, MOVIE_GENRES))}${m.minYear ? ` ; sortis depuis ${m.minYear}` : ''}${m.minRuntime ? ` ; durée d'au moins ${m.minRuntime} min` : ''}${m.noWesternAnimation ? ' ; animation non japonaise exclue' : ''}.`);
  out.push(`- Séries : ${list(genreNames(s.exclude, TV_GENRES))}${s.minYear ? ` ; depuis ${s.minYear}` : ''}${c.excludeCancelled ? ' ; séries annulées exclues' : ''}${s.noWesternAnimation ? ' ; animation non japonaise exclue' : ''}.`);
  out.push('- Qualité : seuils minimaux de note et de votes déterminés automatiquement à partir de ses coups de cœur.');
  if (vfActive) out.push('- Disponibilité : séries d\'origine asiatique ou turque sans version française exclues.');
  return out.join('\n');
}

module.exports = { buildEvidence, evidenceText, overall, activeFiltersText, signatures, subsets, MIN_LISTED, SUFFICIENT };
