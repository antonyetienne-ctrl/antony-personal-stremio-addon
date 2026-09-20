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

// RÈGLE UNIQUE : seul un titre marqué VU est exclu des recommandations. Un titre noté ❤️/👍 ou commencé mais NON marqué vu reste recommandable
// (une note sans marque "vu" est considérée comme une erreur de marquage).
//  classified : items de la bibliothèque ; cand : [{c, st}] titres étiquetés d'un type ; idMap : imdb -> id TMDB des titres étiquetés
function exclusions(classified, cand, idMap) {
  return { seenImdb: new Set(classified.filter((c) => c.seen).map((c) => c.imdb)), knownTmdb: new Set(cand.filter(({ c }) => c.seen).map(({ c }) => idMap.get(c.imdb)).filter(Boolean)) };
}

// hard filters + exclusion vus/commencés (par IMDb) sur fiches complètes
function admissible(recs, { settings, type, seenImdb }) {
  const out = []; const rejects = {};
  for (const rec of recs) {
    let why = rejectReason(rec, settings, type);
    if (!why && seenImdb.has(rec.im)) why = 'vu';
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
// adj (arbitrage Gemini par PROXIMITÉ, variante C) : Map imdb -> {fit, risk, know, incomp, note}. Pour chaque candidat, Gemini compare l'expérience du titre à celle de ses
// 3 titres ADORÉS et de ses 3 titres NON AIMÉS les plus proches ; on en tire fit = (100 + proche_des_adorés − proche_des_non_aimés) / 2 (50 = neutre, 100 = ressemble aux adorés
// et pas aux non-aimés, 0 = l'inverse) et risk = 0. Gemini agit sur la FENÊTRE frontière (les WINDOW premiers du classement local) :
//  1) MÉLANGE : score relatif = (1 − wg) × utilité locale normalisée + wg × avis Gemini normalisé, wg choisi par le backtest ; l'avis d'un titre que Gemini connaît mal
//     est ramené vers l'avis médian (au plus 60 % de son écart est effacé) : un titre inconnu ne peut plus être pénalisé par le seul synopsis ;
//  2) MALUS PROGRESSIF (pas un interrupteur) : gravité s ∈ [0,1] = fit sous `fit0` (et risque au-dessus de `risk0` si ce réglage est actif), renforcée de 0,35 en cas d'incompatibilité
//     signalée, réduite de moitié au plus si Gemini connaît mal le titre ; malus = alpha × s retiré du score. Réglages (fit0, alpha, wg) choisis PAR LE BACKTEST avec un plancher
//     (MALUS_FLOOR : jamais moins sévère). Un titre très pénalisé est remplacé par le suivant.
//  3) GARDE-FOUS : au plus 40 % de la fenêtre subit le malus complet (les plus graves d'abord, les autres sont adoucis) ; les titres hors fenêtre, non évalués, ne peuvent entrer QUE pour
//     remplacer un titre lourdement pénalisé (handicap de 0,10) ; sans avis Gemini : classement local pur ; le Top est toujours complet.
const WINDOW = 80;
const DEFAULT_MALUS = { fit0: 30, risk0: 100, alpha: 0.7, wg: 0.35 };          // point de départ avant toute calibration (risk0 = 100 : terme de risque inactif)
const MALUS_FLOOR = { fit0: 25, risk0: 100, alpha: 0.5, wg: 0.1 };             // sévérité minimale : jamais moins que ça
const MALUS_GRID = { fit0: [25, 30, 35, 40, 45], risk0: [100], alpha: [0.5, 0.7, 1.0], wg: [0.1, 0.2, 0.35] };
const clamp01 = (x) => Math.max(0, Math.min(1, x));
function severity(a, m) {
  if (!a) return 0;
  const sf = clamp01((m.fit0 - a.fit) / Math.max(1, m.fit0)), sr = m.risk0 < 100 ? clamp01((a.risk - m.risk0) / Math.max(1, 100 - m.risk0)) : 0;
  let s = Math.max(sf, sr);
  if (a.incomp) s = Math.min(1, s + 0.35);
  const know = Number.isFinite(a.know) ? clamp01(a.know / 100) : 1;
  return s * (0.5 + 0.5 * know);
}
function finalizeTop(pool, adj, { top = TOP_N, window = WINDOW, malus = DEFAULT_MALUS } = {}) {
  const wg = Number.isFinite(malus.wg) ? malus.wg : 0.35;
  const wrap = (c, idx, gem = null) => ({ c, u: c.util, gem, localRank: idx + 1, pen: 0 });
  const done = (arr, penalised = []) => { const res = arr.slice(0, top); res.penalised = penalised; res.params = malus; return res; };
  if (!adj || !adj.size) return done(pool.slice(0, top).map((c, i) => wrap(c, i)));
  const win = pool.slice(0, window).map((c, i) => { const a = adj.get(c.rec.im); return { ...wrap(c, i, a ? { fit: a.fit, risk: a.risk, know: a.know, incomp: a.incomp, note: a.note, sim: a.sim } : null), g: a ? a.fit / 100 - 0.5 * ((a.risk || 0) / 100) : null }; });
  const us = win.map((x) => x.c.util), umin = Math.min(...us), umax = Math.max(...us);
  const gs = win.filter((x) => x.g !== null).map((x) => x.g), gmin = gs.length ? Math.min(...gs) : 0, gmax = gs.length ? Math.max(...gs) : 0;
  const norm = (v, lo, hi) => (hi - lo > 1e-9 ? (v - lo) / (hi - lo) : 0.5);
  const gsN = gs.map((v) => norm(v, gmin, gmax)).sort((a, b) => a - b), gMed = gsN.length ? gsN[Math.floor(gsN.length / 2)] : 0.5;
  for (const x of win) {
    const z = norm(x.c.util, umin, umax); let gn = null;
    if (x.g !== null) { gn = norm(x.g, gmin, gmax); const kw = Number.isFinite(x.gem.know) ? clamp01(x.gem.know / 100) : 1; gn = gMed + (gn - gMed) * (0.4 + 0.6 * kw); }   // titre mal connu : avis ramené vers la médiane
    x.u = gn === null ? z : (1 - wg) * z + wg * gn; x.pen = x.gem ? malus.alpha * severity(x.gem, malus) : 0;
  }
  // garde-fou : au plus 40 % de la fenêtre subit le malus complet, les plus graves d'abord
  const hit = win.filter((x) => x.pen > 0).sort((a, b) => b.pen - a.pen || a.c.rec.i - b.c.rec.i);
  hit.slice(Math.floor(win.length * 0.4)).forEach((x) => { x.pen *= 0.3; });
  for (const x of win) x.u -= x.pen;
  // titres hors fenêtre (non évalués) : avis médian, handicap de 0,10 : ils n'entrent que si des titres de la fenêtre sont lourdement pénalisés
  const rest = pool.slice(window).map((c, i) => ({ ...wrap(c, window + i), u: (1 - wg) * Math.max(0, norm(c.util, umin, umax)) + wg * gMed - 0.1 }));
  const strip = ({ c, u, gem, localRank, pen }) => ({ c, u, gem, localRank, pen });
  const all = [...win, ...rest].sort((a, b) => b.u - a.u || b.c.util - a.c.util || a.c.rec.i - b.c.rec.i);
  const penalised = win.filter((x) => x.pen > 0).sort((a, b) => b.pen - a.pen || a.c.rec.i - b.c.rec.i).map(strip);
  return done(all.map(strip), penalised);
}
// k titres de l'historique les plus proches d'un candidat (similarité cosinus des vecteurs hachés), sous forme compacte pour un prompt
function nearestK(cand, arr, k = 3) {
  const v = cand.item.vec; const sc = [];
  for (const l of arr) { if (!l.vec) continue; let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * l.vec[i]; sc.push([s, l]); }
  sc.sort((a, b) => b[0] - a[0] || (a[1].key < b[1].key ? -1 : 1));
  return sc.slice(0, k).map(([, l]) => ({ titre: l.rec.t, annee: l.rec.y, genres: (l.rec.gn || []).slice(0, 3), mots_cles: (l.rec.kw || []).slice(0, 3).map((x) => x[1]) }));
}

module.exports = { nearestK, severity, DEFAULT_MALUS, MALUS_FLOOR, MALUS_GRID, WINDOW, exclusions, enumerateRows, discoverCandidates, admissible, scoreCandidates, nearestTitles, makeMeta, finalizeTop, PAGE_CAP };
