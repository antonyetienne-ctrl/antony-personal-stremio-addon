'use strict';
// Discovery (trouver) et Ranking (classer) sont séparés : la découverte ne fixe JAMAIS le classement final.
//  Canal A  : énumération exhaustive de l'univers TMDB admissible (filtres note/votes/genres) -> tout est candidat ;
//  Canal B  : voisinages TMDB (recommendations/similar) des ❤️/👍, utilisé quand l'univers dépasse le plafond d'énumération ;
//  ensuite : filtres durs sur fiches complètes, exclusion des vus/commencés, scoring 70/30 de TOUS les candidats.
const { mapLimit, log } = require('./util');
const { rowReject, rejectReason } = require('./filters');
const { hashedVec } = require('./features');
const { scoreProfile, blendScores, recipeMatches, utilityOf } = require('./model');
const { TOP_N } = require('./config');

const PAGE_CAP = 100;          // 2 000 lignes par tri
const CALL_BUDGET = 320;       // appels /discover max par type et par calcul

async function enumerateRows(tmdb, kind, settings, type, { gate, onProgress } = {}) {
  const t = settings[type];
  const numeric = t.exclude.filter((x) => typeof x === 'number');
  const base = { 'vote_average.gte': t.minRating, 'vote_count.gte': t.minVotes };
  if (numeric.length) base.without_genres = numeric.join(',');
  if (type === 'movie' && t.minRuntime) base['with_runtime.gte'] = t.minRuntime;
  if (t.minYear) base[type === 'movie' ? 'primary_release_date.gte' : 'first_air_date.gte'] = `${t.minYear}-01-01`;
  const rows = new Map(); let calls = 0, complete = false, totalResults = 0, errors = 0;
  for (const sort of ['vote_count.desc', 'vote_average.desc', 'popularity.desc']) {
    let first;
    try { first = await tmdb.discover(kind, { ...base, sort_by: sort, page: 1 }); calls++; } catch { errors++; continue; }
    totalResults = Math.max(totalResults, first.total_results || 0);
    const pages = Math.min(first.total_pages || 1, PAGE_CAP);
    for (const r of first.results || []) rows.set(r.id, r);
    const todo = []; for (let p = 2; p <= pages && calls + todo.length < CALL_BUDGET; p++) todo.push(p);
    const { results, errors: e } = await mapLimit(todo, 6, (p) => tmdb.discover(kind, { ...base, sort_by: sort, page: p }), gate);
    calls += todo.length; errors += e;
    for (const res of results) for (const r of (res && res.results) || []) rows.set(r.id, r);
    onProgress && onProgress(`énumération ${type} (${sort})`, rows.size);
    if ((first.total_pages || 1) <= PAGE_CAP) { complete = e === 0; break; }   // univers entièrement couvert par ce tri
    if (calls >= CALL_BUDGET) break;
  }
  return { rows, complete, calls, errors, totalResults };
}

async function seedRows(tmdb, kind, seedIds, { gate } = {}) {
  const jobs = []; for (const id of seedIds) { jobs.push([id, 'recommendations']); jobs.push([id, 'similar']); }
  const { results, errors } = await mapLimit(jobs, 6, ([id, what]) => tmdb.related(kind, id, what, 1), gate);
  const rows = new Map(); for (const r of results) for (const x of (r && r.results) || []) rows.set(x.id, x);
  return { rows, calls: jobs.length, errors };
}

// Renvoie {recs:[fiche], stats}. excludeTmdb : ids TMDB déjà connus comme vus/étiquetés (pré-filtre bon marché).
async function discoverCandidates({ tmdb, type, settings, seedTmdbIds, excludeTmdb, gate, onProgress }) {
  const kind = type === 'series' ? 'tv' : 'movie';
  const en = await enumerateRows(tmdb, kind, settings, type, { gate, onProgress });
  const all = new Map(en.rows);
  const stats = { enumerated: en.rows.size, universeComplete: en.complete, totalResultsReported: en.totalResults, discoverCalls: en.calls, discoverErrors: en.errors, seedRows: 0, seedCalls: 0 };
  if (!en.complete && seedTmdbIds.length) {
    const sd = await seedRows(tmdb, kind, seedTmdbIds.slice(0, 60), { gate });
    for (const [id, r] of sd.rows) if (!all.has(id)) all.set(id, r);
    stats.seedRows = sd.rows.size; stats.seedCalls = sd.calls;
  }
  const kept = [];
  const rejects = {};
  for (const [id, row] of all) {
    if (excludeTmdb.has(id)) { rejects.known = (rejects.known || 0) + 1; continue; }
    const why = rowReject(row, settings, type);
    if (why) { rejects[why] = (rejects[why] || 0) + 1; continue; }
    kept.push(id);
  }
  stats.rowRejects = rejects; stats.toFetch = kept.length;
  onProgress && onProgress(`fiches ${type}`, 0);
  const details = await tmdb.ensureDetails(kind, kept, { gate, onProgress: (d, t) => onProgress && onProgress(`fiches ${type}`, d, t) });
  stats.detailed = details.size; stats.detailErrors = kept.length - details.size;
  return { recs: [...details.values()], stats };
}

// hard filters + exclusion vus/commencés (par IMDb) sur fiches complètes
function admissible(recs, { settings, type, seenImdb }) {
  const out = []; const rejects = {};
  for (const rec of recs) {
    let why = rejectReason(rec, settings, type);
    if (!why && seenImdb.has(rec.im)) why = 'seen-or-started';
    if (why) rejects[why] = (rejects[why] || 0) + 1; else out.push(rec);
  }
  return { recs: out, rejects };
}

// Score de tous les candidats : 70 % profil du type + 30 % profil global ; utilité = mu − κσ − ρ·fp − pénalité toxique
async function scoreCandidates({ recs, corpus, profType, profGlobal, risk, toxic, rank, yielder }) {
  const out = [];
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i]; const item = { rec, vec: hashedVec(rec, corpus) };
    const s = blendScores(scoreProfile(profType, item), scoreProfile(profGlobal, item));
    let tox = 0; const hits = [];
    for (const t of toxic || []) if (recipeMatches(rec, t.parts)) { tox += t.conf * 0.06; hits.push(t.id); }
    tox = Math.min(0.12, tox);
    const util = utilityOf(s, rank) - (risk.kappa || 0) * s.sigma - (risk.rho || 0) * s.fp - tox;
    out.push({ rec, item, s, tox, toxicHits: hits, util });
    if (yielder && i % 40 === 0) await yielder();
  }
  out.sort((a, b) => b.util - a.util || a.rec.i - b.rec.i);
  return out;
}

// plus proche titre aimé / rejeté (pour l'arbitrage : "pourquoi lui plairait-il alors que X l'a déçu ?")
function nearestTitles(cand, loved, rejected) {
  const near = (arr) => { let best = null, bs = -2; for (const l of arr) { let s = 0; for (let i = 0; i < cand.item.vec.length; i++) s += cand.item.vec[i] * l.vec[i]; if (s > bs) { bs = s; best = l; } } return best ? best.rec.t : null; };
  return { aime: near(loved), rejete: near(rejected) };
}

function makeMeta(rec, type) {
  const meta = { id: rec.im, type, name: rec.t || rec.ot, description: rec.ov || '', releaseInfo: rec.y ? String(rec.y) : undefined, genres: rec.gn && rec.gn.length ? rec.gn : undefined, posterShape: 'poster' };
  if (rec.po) meta.poster = `https://image.tmdb.org/t/p/w500${rec.po}`;
  if (rec.bg) meta.background = `https://image.tmdb.org/t/p/w1280${rec.bg}`;
  if (rec.rt) meta.runtime = `${rec.rt} min`;
  return meta;
}

// Sélection finale : les TOP_N meilleurs, sans quota ni diversité artificielle.
// adj (arbitrage Gemini) : Map imdb -> {fit, risk, note}. Gemini ne peut que RÉORDONNER la fenêtre frontière (les WINDOW premiers
// du classement local) : score relatif = 65 % utilité locale normalisée + 35 % avis Gemini normalisé. Un titre hors fenêtre
// (non évalué) ne peut jamais entrer dans le Top 30 à sa place tant que la fenêtre contient au moins TOP_N titres.
const WINDOW = 45;
function finalizeTop(pool, adj) {
  const wrap = (c, idx, gem = null) => ({ c, u: c.util, gem, localRank: idx + 1 });
  if (!adj || !adj.size) return pool.slice(0, TOP_N).map((c, i) => wrap(c, i));
  const win = pool.slice(0, WINDOW).map((c, i) => { const a = adj.get(c.rec.im); return { ...wrap(c, i, a ? { fit: a.fit, risk: a.risk, note: a.note } : null), g: a ? a.fit / 100 - 0.5 * (a.risk / 100) : null }; });
  const us = win.map((x) => x.c.util), umin = Math.min(...us), umax = Math.max(...us);
  const gs = win.filter((x) => x.g !== null).map((x) => x.g), gmin = Math.min(...gs), gmax = Math.max(...gs);
  const norm = (v, lo, hi) => (hi - lo > 1e-9 ? (v - lo) / (hi - lo) : 0.5);
  for (const x of win) { const z = norm(x.c.util, umin, umax); x.u = x.g === null ? z : 0.65 * z + 0.35 * norm(x.g, gmin, gmax); }
  win.sort((a, b) => b.u - a.u || a.c.rec.i - b.c.rec.i);
  const rest = pool.slice(WINDOW).map((c, i) => wrap(c, WINDOW + i));
  return [...win.map(({ c, u, gem, localRank }) => ({ c, u, gem, localRank })), ...rest].slice(0, TOP_N);
}

module.exports = { enumerateRows, discoverCandidates, admissible, scoreCandidates, nearestTitles, makeMeta, finalizeTop, PAGE_CAP };
