'use strict';
// GRAND TEST DE GEMINI : les comparaisons « ressemble aux adorés / aux non aimés » sont-elles meilleures AVEC ou SANS les titres 👍 ?
// Protocole (MESURE SEULEMENT, aucun effet sur les listes) :
//  - échantillon équilibré de l'historique : jusqu'à 100 titres par (type × note) = 600 titres (films et séries × ❤️, 👍, vu sans note), ordre pseudo-aléatoire reproductible ;
//  - pour chaque titre, voisins tirés du RESTE de l'historique (le titre lui-même en est exclu) : les 3 adorés et les 3 non aimés sont IDENTIQUES dans les deux variantes ;
//    la variante B ajoute en plus les 2 titres 👍 les plus proches ; la variante A est le prompt de la 7.7.0 (sans 👍) ;
//  - chaque variante est jouée DEUX fois (mesure de l'aléa de Gemini) ; lots de 12 titres ; reprise possible d'un jour à l'autre (quota) ;
//  - analyse : AUC de la note de Gemini seule (❤️ contre le reste, apprécié contre non, ❤️ contre 👍), moyenne des deux répétitions, écart entre répétitions, différence B − A avec
//    intervalle à 95 % par tirages appariés des titres. Verdict : gain net / perte nette / non concluant.
const { clock, sleep, log, hashInt, mulberry32 } = require('./util');
const { comparePrompt, comparePromptSans, parseEvaluations } = require('./gemini');
const { nearestK } = require('./pipeline');
const ml = require('./ml');

const CELL = Number(process.env.GEMAB_CELL || 100), BATCH = Number(process.env.GEMAB_BATCH || 12);
const RUNS = ['A1', 'B1', 'A2', 'B2'];
const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1e3) / 1e3 : null);

// échantillon + cartes (voisins hors titre lui-même). neighborsFor : voisins sémantiques (sinon « genres + mots-clés »)
function prepare({ items, neighborsFor, key }) {
  const usable = items.filter((i) => i.vec && i.label >= 0);
  const loved = usable.filter((i) => i.label === 2), liked = usable.filter((i) => i.label === 1), rej = usable.filter((i) => i.label === 0);
  const picked = [];
  for (const k of ['m', 's']) for (const l of [2, 1, 0]) picked.push(...usable.filter((i) => i.rec.k === k && i.label === l).sort((a, b) => hashInt('gemab' + a.key) - hashInt('gemab' + b.key)).slice(0, CELL));
  picked.sort((a, b) => hashInt('gemab-o' + a.key) - hashInt('gemab-o' + b.key));
  const cards = {}; const excl = (arr, x) => arr.filter((z) => z.key !== x.key);
  for (const x of picked) {
    const L = excl(loved, x), K = excl(liked, x), R = excl(rej, x); const c = { item: x };
    const nb = neighborsFor ? neighborsFor(x, L, R, K) : null; const r = x.rec;
    const base = { titre: r.t, annee: r.y, genres: r.gn || [], mots_cles: (r.kw || []).slice(0, 8).map((k) => k[1]), synopsis: (r.ov || '').slice(0, 180) };
    const adores = nb ? nb.adores : nearestK(c, L, 3), non_aimes = nb ? nb.non_aimes : nearestK(c, R, 3), apprecies = nb ? nb.apprecies : nearestK(c, K, 2);
    cards[x.key] = { type: r.k === 's' ? 'series' : 'movie', label: x.label, A: { ...base, adores, non_aimes }, B: { ...base, adores, apprecies, non_aimes } };
  }
  const order = picked.map((x) => x.key), batches = []; for (let i = 0; i < order.length; i += BATCH) batches.push(order.slice(i, i + BATCH));
  return { key, at: new Date(clock.now()).toISOString(), n: order.length, batches, cards, results: { A1: {}, B1: {}, A2: {}, B2: {} }, done: {}, requests: 0, failed: 0 };
}
const pending = (st) => { const out = []; for (const run of RUNS) st.batches.forEach((_, i) => { if (!(st.done[run] || {})[i]) out.push([run, i]); }); return out; };
const progress = (st) => { const total = RUNS.length * st.batches.length; return { fait: total - pending(st).length, total }; };

// joue des lots jusqu'au budget ; s'arrête si Gemini est indisponible ; conserve tout ce qui est fait
async function runPass({ st, gem, budgetMs = 180000, minIntervalMs = Number(process.env.GEMAB_MIN_INTERVAL_MS || 5000), reserve = Number(process.env.GEMAB_RESERVE_CALLS || 60) }) {
  const t0 = clock.now(); const res = { requests: 0, ok: 0, failed: 0, stop: null };
  for (const [run, bi] of pending(st)) {
    if (clock.now() - t0 > budgetMs) { res.stop = 'délai de la passe atteint'; break; }
    if (!gem || !gem.available) { res.stop = 'Gemini indisponible (pause ou plafond du jour)'; break; }
    if (typeof gem._quotaLeft === 'function' && gem._quotaLeft() <= reserve) { res.stop = 'réserve quotidienne de Gemini préservée pour le calcul'; break; }
    const keys = st.batches[bi]; const byId = new Map(); const variant = run[0];
    const candidats = keys.map((k, j) => { const id = 't' + (j + 1); byId.set(id, k); return { id, ...st.cards[k][variant] }; });
    let out = null; try { out = await gem.json((variant === 'A' ? comparePromptSans : comparePrompt)({ candidats })); } catch { out = null; }
    res.requests++; st.requests++;
    const pe = out ? parseEvaluations(out, byId) : { map: new Map() };
    if (pe.map.size >= Math.ceil(keys.length * 0.6)) { for (const [k, v] of pe.map) st.results[run][k] = Math.round(v.fit * 10) / 10; (st.done[run] = st.done[run] || {})[bi] = true; res.ok++; } else { res.failed++; st.failed++; if (res.failed >= 3 && !res.ok) { res.stop = '3 lots de suite sans réponse exploitable'; break; } }
    if (minIntervalMs > 0) await sleep(minIntervalMs);
  }
  return res;
}

const aucOf = (fit, keys, st, pos, neg) => { const s = [], y = []; for (const k of keys) { const l = st.cards[k].label; if (fit[k] === undefined) continue; if (pos(l)) { s.push(fit[k]); y.push(1); } else if (neg(l)) { s.push(fit[k]); y.push(0); } } return y.length > 5 && new Set(y).size === 2 ? ml.auc(s, y) : null; };
const METRICS = { coeurContreReste: [(l) => l === 2, (l) => l !== 2], apprecieContreNon: [(l) => l > 0, (l) => l === 0], coeurContreLike: [(l) => l === 2, (l) => l === 1] };
function analyze(st, { B = 400 } = {}) {
  const all = Object.keys(st.cards); const out = { at: new Date(clock.now()).toISOString(), titres: all.length, requetes: st.requests, echecs: st.failed, parType: {}, global: {} };
  const scopes = { global: all, movie: all.filter((k) => st.cards[k].type === 'movie'), series: all.filter((k) => st.cards[k].type === 'series') };
  const rnd = mulberry32(99);
  for (const [scope, keys] of Object.entries(scopes)) {
    const res = {};
    for (const [mn, [pos, neg]] of Object.entries(METRICS)) {
      const perRun = {}; for (const run of RUNS) perRun[run] = aucOf(st.results[run], keys, st, pos, neg);
      const avg = (v) => { const a = [perRun[v + '1'], perRun[v + '2']].filter((x) => x !== null); return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; };
      const A = avg('A'), Bv = avg('B'); if (A === null || Bv === null) { res[mn] = { indisponible: true }; continue; }
      const gains = []; const fitOf = (v, k) => { const a = [st.results[v + '1'][k], st.results[v + '2'][k]].filter((x) => x !== undefined); return a.length ? a.reduce((s, x) => s + x, 0) / a.length : undefined; };
      const fA = {}, fB = {}; for (const k of keys) { fA[k] = fitOf('A', k); fB[k] = fitOf('B', k); }
      for (let b = 0; b < B; b++) { const idx = keys.map(() => keys[Math.floor(rnd() * keys.length)]); const cnt = {}; const bk = []; for (const k of idx) { cnt[k] = (cnt[k] || 0) + 1; bk.push(k + '#' + cnt[k]); } const cardsB = Object.fromEntries(bk.map((id, i) => [id, st.cards[idx[i]]])); const sA = {}, sB = {}; bk.forEach((id, i) => { sA[id] = fA[idx[i]]; sB[id] = fB[idx[i]]; }); const stub = { cards: cardsB }; const a1 = aucOf(sA, bk, stub, pos, neg), b1 = aucOf(sB, bk, stub, pos, neg); if (a1 !== null && b1 !== null) gains.push(b1 - a1); }
      gains.sort((a, b) => a - b); const ci = gains.length > 50 ? [r3(gains[Math.floor(0.025 * gains.length)]), r3(gains[Math.floor(0.975 * gains.length) - 1])] : null;
      const noise = (v) => (perRun[v + '1'] !== null && perRun[v + '2'] !== null ? r3(Math.abs(perRun[v + '1'] - perRun[v + '2'])) : null);
      res[mn] = { sans: r3(A), avec: r3(Bv), gain: r3(Bv - A), ic95Gain: ci, aleaEntreRepetitions: { sans: noise('A'), avec: noise('B') } };
    }
    if (scope === 'global') out.global = res; else out.parType[scope] = res;
  }
  const g = out.global.coeurContreReste; const p = out.global.apprecieContreNon;
  const decide = (m) => (!m || m.indisponible || !m.ic95Gain ? 'non mesuré' : m.ic95Gain[0] > 0 ? 'avec les 👍 : nettement meilleur' : m.ic95Gain[1] < 0 ? 'sans les 👍 : nettement meilleur' : 'différence non concluante');
  out.verdict = { coeurContreReste: decide(g), apprecieContreNon: decide(p), resume: `❤️ contre le reste : ${decide(g)} ; apprécié contre non : ${decide(p)}.` };
  return out;
}
module.exports = { prepare, runPass, analyze, pending, progress, RUNS, CELL, BATCH };
