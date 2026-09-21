'use strict';
// Modèle de goût. Trois niveaux (Films / Séries / Global), chacun :
//   tâche 1 : P(apprécié | œuvre)  = ❤️+👍 contre "vu sans appréciation" (les négatifs pèsent selon la qualité TMDB de l'œuvre)
//   tâche 2 : P(❤️ | apprécié)    = ce qui distingue un ❤️ d'un 👍 (apprise UNIQUEMENT sur les positifs)
//   utilité attendue : mu = P(apprécié) × (1 + (U−1)·P(❤️|apprécié)) / U   avec U = 3 (❤️ vaut 3 👍)
// Chaque tâche empile : (A) régression logistique creuse (features + interactions ordre 2/3),
// (B) prototypes/kNN/clusters multi-pôles positifs ET négatifs, puis une régression d'empilement entraînée sur des
// prédictions hors-échantillon (validation croisée) : pas de fuite, non-linéarité par seuils/saturations/combinaisons.
const { Corpus, hashedVec, encodeSparse, buildDict, rawFeatures } = require('./features');
const ml = require('./ml');

const U_LOVE = 3;
const DEFAULT_CFG = { inter: 2, triples: false, stack: true, l2: 0.02, halfLifeDays: null, folds: 4 };

const baseKeysOf = (rec, baseSet) => { const out = []; for (const k of rawFeatures(rec).keys()) if (baseSet.has(k)) out.push(k); return out; };
function combos(list, order, cb) {
  const n = list.length;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (order === 2) cb(list[i] < list[j] ? list[i] + '|' + list[j] : list[j] + '|' + list[i]);
    else for (let k = j + 1; k < n; k++) cb([list[i], list[j], list[k]].sort().join('|'));
  }
}

// Interactions (recettes) : combinaisons de 2 ou 3 caractéristiques dont la fréquence diffère nettement entre classes.
// Seuils de support + lissage : jamais de mot-clé isolé "banni".
function mineInteractions(recs, y, w, order, cap, { minSupport = 4, minAbs = 0.7 } = {}) {
  const df = new Map();
  for (const r of recs) for (const k of rawFeatures(r).keys()) if (k.startsWith('g:') || k.startsWith('k:') || k.startsWith('col:')) df.set(k, (df.get(k) || 0) + 1);
  const baseSet = new Set([...df].filter(([, c]) => c >= minSupport).sort((a, b) => b[1] - a[1]).slice(0, order === 2 ? 70 : 35).map(([k]) => k));
  let P = 0, N = 0; y.forEach((v, i) => { if (v) P += w[i]; else N += w[i]; });
  const stat = new Map();
  recs.forEach((r, i) => {
    let present = baseKeysOf(r, baseSet); if (present.length > 16) present = present.slice(0, 16);
    combos(present, order, (c) => { let s = stat.get(c); if (!s) { s = { pw: 0, nw: 0, n: 0, pn: 0, nn: 0 }; stat.set(c, s); } s.n++; if (y[i]) { s.pw += w[i]; s.pn++; } else { s.nw += w[i]; s.nn++; } });
  });
  const out = [];
  for (const [c, s] of stat) {
    if (s.n < minSupport) continue;
    const score = Math.log((s.pw + 0.5) / (P + 1)) - Math.log((s.nw + 0.5) / (N + 1));
    if (Math.abs(score) >= minAbs) out.push({ key: 'p:' + c, parts: c.split('|'), score, support: s.n, pos: s.pn, neg: s.nn });
  }
  out.sort((a, b) => Math.abs(b.score) * Math.sqrt(b.support) - Math.abs(a.score) * Math.sqrt(a.support));
  return out.slice(0, cap);
}

function interKeysFor(rec, inter) {
  if (!inter || !inter.set.size) return [];
  const out = [];
  const present = baseKeysOf(rec, inter.base).slice(0, 16);
  if (inter.orders.includes(2)) combos(present, 2, (c) => { if (inter.set.has('p:' + c)) out.push('p:' + c); });
  if (inter.orders.includes(3)) combos(present.slice(0, 12), 3, (c) => { if (inter.set.has('p:' + c)) out.push('p:' + c); });
  return out;
}

async function fitA(items, y, w, cfg, corpus, yielder) {
  const recs = items.map((it) => it.rec);
  const dict = buildDict(recs, 2);
  let inter = null;
  if (cfg.inter >= 2) {
    const orders = cfg.triples ? [2, 3] : [2];
    const mined = [];
    for (const o of orders) mined.push(...mineInteractions(recs, y, w, o, o === 2 ? 250 : 80));
    const set = new Set(mined.map((m) => m.key));
    for (const k of set) dict.set(k, dict.size);
    const base = new Set(); for (const m of mined) for (const p of m.parts) base.add(p);
    inter = { set, base, orders, mined };
  }
  const sparse = items.map((it) => encodeSparse(it.rec, dict, corpus, interKeysFor(it.rec, inter)));
  const m = await ml.fitLogistic({ sparse, y, w, nS: dict.size, l2S: cfg.l2, iters: 110, yielder });
  return { dict, inter, m, corpus };
}
const zA = (A, rec) => Math.max(-8, Math.min(8, ml.predictLogit(A.m, encodeSparse(rec, A.dict, A.corpus, interKeysFor(rec, A.inter)))));

function meanTop(sims, k) { if (!sims.length) return 0; const s = sims.slice().sort((a, b) => b - a).slice(0, k); return s.reduce((a, b) => a + b, 0) / s.length; }
async function fitBase(items, y, w, cfg, corpus, yielder) {
  const A = await fitA(items, y, w, cfg, corpus, yielder);
  const base = { A, pos: [], neg: [], cp: [], cn: [], tau: 0.5 };
  if (!cfg.stack) return base;
  items.forEach((it, i) => (y[i] ? base.pos : base.neg).push({ v: it.vec, w: w[i] }));
  if (base.pos.length) {
    base.cp = ml.kmeans(base.pos.map((p) => p.v), base.pos.map((p) => p.w), Math.max(2, Math.min(8, Math.round(Math.sqrt(base.pos.length / 10)))));
    const own = base.pos.map((p) => Math.max(...base.cp.map((c) => ml.dot(p.v, c)))).sort((a, b) => a - b);
    base.tau = own[Math.floor(own.length * 0.4)] || 0.5;
  }
  if (base.neg.length >= 4) base.cn = ml.kmeans(base.neg.map((p) => p.v), base.neg.map((p) => p.w), Math.max(1, Math.min(5, Math.round(Math.sqrt(base.neg.length / 12)))));
  return base;
}
const NF = 11;
function baseFeats(base, item) {
  const z = zA(base.A, item.rec);
  const parts = { zA: z };
  if (!base.pos.length && !base.neg.length) return { f: [z, Math.tanh(z / 3), 0, 0, 0, 0, 0, 0, 0, 0, 0], parts };
  // similarités : mémorisées par candidat quand `item._sim` (Map) existe (scoring des candidats) ; les tâches et profils partagent les mêmes vecteurs d'entraînement => 3 à 5 fois moins de produits scalaires
  const dt = item._sim instanceof Map ? (v) => { let s = item._sim.get(v); if (s === undefined) { s = ml.dot(item.vec, v); item._sim.set(v, s); } return s; } : (v) => ml.dot(item.vec, v);
  const sp = base.pos.map((p) => dt(p.v)), sn = base.neg.map((p) => dt(p.v));
  const sPos = meanTop(sp, 3), sNeg = meanTop(sn, 3);
  const all = []; base.pos.forEach((p, i) => all.push([sp[i], p.w, 1])); base.neg.forEach((p, i) => all.push([sn[i], p.w, 0]));
  all.sort((a, b) => b[0] - a[0]);
  let up = 0, ua = 0; for (const [s, ww, isPos] of all.slice(0, 12)) { const c = Math.max(0, s) ** 3 * ww; ua += c; if (isPos) up += c; }
  const knnShare = (up + 0.3) / (ua + 0.6);
  const cMax = base.cp.length ? Math.max(...base.cp.map((c) => ml.dot(item.vec, c))) : 0;
  const hits = base.cp.length ? base.cp.filter((c) => ml.dot(item.vec, c) >= base.tau).length / base.cp.length : 0;
  const nMax = base.cn.length ? Math.max(...base.cn.map((c) => ml.dot(item.vec, c))) : 0;
  const maxSim = all.length ? all[0][0] : 0;
  Object.assign(parts, { knnShare, sPos, sNeg, cMax, nMax, maxSim, hits });
  return { f: [z, Math.tanh(z / 3), ml.logit(knnShare), sPos, sNeg, sPos - sNeg, cMax, hits, nMax, cMax - nMax, maxSim], parts };
}

async function fitStack(F, y, w, yielder) {
  const nF = NF; const mean = new Float64Array(nF), sd = new Float64Array(nF);
  for (let j = 0; j < nF; j++) { let s = 0; for (const f of F) s += f[j]; mean[j] = s / F.length; let v = 0; for (const f of F) v += (f[j] - mean[j]) ** 2; sd[j] = Math.sqrt(v / F.length) || 1; }
  const Z = F.map((f) => Float64Array.from(f, (x, j) => (x - mean[j]) / sd[j]));
  const m = await ml.fitLogistic({ sparse: F.map(() => ({ idx: new Int32Array(0), val: new Float32Array(0) })), dense: Z, y, w, nS: 0, nD: nF, l2D: 0.08, iters: 160, lr: 0.06, yielder });
  return { m, mean, sd };
}
const stackP = (st, f) => ml.sigmoid(ml.predictLogit(st.m, { idx: new Int32Array(0), val: new Float32Array(0) }, Float64Array.from(f, (x, j) => (x - st.mean[j]) / st.sd[j])));

// Entraîne une tâche binaire. Renvoie {predict(item), oof:Float64Array, constant?}
async function trainTask(items, y, w, cfg, corpus, yielder) {
  const n = items.length, nPos = y.reduce((a, b) => a + b, 0);
  const prior = (nPos + 1) / (n + 2);
  if (nPos < 3 || n - nPos < 3) return { constant: true, prior, oof: new Float64Array(n).fill(prior), predict: () => ({ p: prior, parts: { zA: ml.logit(prior), knnShare: prior, maxSim: 0 } }) };
  const K = Math.max(2, Math.min(cfg.folds || 4, Math.floor(Math.min(nPos, n - nPos) / 2)));
  const fold = ml.kfold(y, K);
  const oofF = new Array(n), oofP = new Float64Array(n);
  for (let f = 0; f < K; f++) {
    const tr = [], te = [];
    for (let i = 0; i < n; i++) (fold[i] === f ? te : tr).push(i);
    const base = await fitBase(tr.map((i) => items[i]), tr.map((i) => y[i]), tr.map((i) => w[i]), cfg, corpus, yielder);
    for (const i of te) { const r = baseFeats(base, items[i]); oofF[i] = r.f; oofP[i] = ml.sigmoid(r.f[0]); }
    if (yielder) await yielder();
  }
  let stack = null;
  if (cfg.stack) { stack = await fitStack(oofF, y, w, yielder); for (let i = 0; i < n; i++) oofP[i] = stackP(stack, oofF[i]); }
  const base = await fitBase(items, y, w, cfg, corpus, yielder);
  return {
    constant: false, oof: oofP, base, stack, prior,
    predict(item) { const r = baseFeats(base, item); return { p: stack ? stackP(stack, r.f) : ml.sigmoid(r.f[0]), parts: r.parts }; }
  };
}

function sampleWeights(items, cfg, ref) {
  const tmax = ref || Math.max(0, ...items.map((i) => i.lw || 0));
  return items.map((it) => {
    let w = it.w == null ? 1 : it.w;
    if (cfg.halfLifeDays && it.lw && tmax) w *= Math.max(0.35, Math.pow(0.5, (tmax - it.lw) / (cfg.halfLifeDays * 864e5)));
    return w;
  });
}
// items : [{rec, vec, label:0|1|2, w, lw}]
async function trainProfile(items, cfg, corpus, yielder) {
  const c = { ...DEFAULT_CFG, ...cfg };
  const y1 = Uint8Array.from(items, (i) => (i.label > 0 ? 1 : 0));
  const w1 = sampleWeights(items, c);
  const task1 = await trainTask(items, y1, w1, c, corpus, yielder);
  const pos = items.filter((i) => i.label > 0);
  const nLove = pos.filter((i) => i.label === 2).length, nLike = pos.length - nLove;
  let task2 = null;
  if (nLove >= 6 && nLike >= 6) task2 = await trainTask(pos, Uint8Array.from(pos, (i) => (i.label === 2 ? 1 : 0)), pos.map(() => 1), { ...c, folds: 3, inter: c.inter, triples: false }, corpus, yielder);
  // tâche ❤️ directe : ❤️ contre tout le reste (👍 et vus sans appréciation) — comparée à la décomposition P(apprécié)·P(❤️|apprécié)
  const taskLove = await trainTask(items, Uint8Array.from(items, (i) => (i.label === 2 ? 1 : 0)), w1, c, corpus, yielder);
  return { task1, task2, taskLove, keys: items.map((i) => i.key), loveRate: (nLove + 1) / (pos.length + 2), n: items.length, nPos: pos.length, nLove, nNeg: items.length - pos.length, cfg: c };
}
// score d'une œuvre : {pPos, pLove, mu, sigma, fp, parts}
function scoreProfile(profile, item) {
  const r1 = profile.task1.predict(item);
  const pLove = profile.task2 ? profile.task2.predict(item).p : profile.loveRate;
  const mu = r1.p * (1 + (U_LOVE - 1) * pLove) / U_LOVE;
  const a = ml.sigmoid(r1.parts.zA), k = r1.parts.knnShare == null ? a : r1.parts.knnShare;
  const mean3 = (a + k + r1.p) / 3, dis = Math.sqrt(((a - mean3) ** 2 + (k - mean3) ** 2 + (r1.p - mean3) ** 2) / 3);
  const novelty = r1.parts.maxSim == null ? 0 : Math.max(0, 0.5 - r1.parts.maxSim) / 0.5;
  const pLoveDirect = profile.taskLove ? profile.taskLove.predict(item).p : null;
  return { pPos: r1.p, pLove, pLoveDirect, mu, sigma: Math.min(1, 2 * dis + 0.4 * novelty), fp: r1.parts.knnShare == null ? 0 : 1 - r1.parts.knnShare, parts: r1.parts };
}
// 70 % profil du type + 30 % profil global : ratio FIXE (exigence fonctionnelle)
const W_TYPE = 0.7, W_GLOBAL = 0.3;
function blendScores(a, g) {
  const direct = a.pLoveDirect == null || g.pLoveDirect == null ? null : W_TYPE * a.pLoveDirect + W_GLOBAL * g.pLoveDirect;
  return { pPos: W_TYPE * a.pPos + W_GLOBAL * g.pPos, pLove: W_TYPE * a.pLove + W_GLOBAL * g.pLove, pLoveDirect: direct, mu: W_TYPE * a.mu + W_GLOBAL * g.mu, sigma: W_TYPE * a.sigma + W_GLOBAL * g.sigma, fp: W_TYPE * a.fp + W_GLOBAL * g.fp, parts: a.parts };
}

// Classement orienté ❤️ : P(❤️) = (1-α)·P(apprécié)·P(❤️|apprécié) + α·P(❤️ direct) ; utilité = P(❤️) + β·P(👍 seul).
// α et β sont choisis par le backtest (taux de ❤️ dans le Top 30 sur la période de test).
const DEFAULT_RANK = { alpha: 0.5, beta: 0.33 };
function utilityOf(s, rank) {
  const { alpha, beta } = { ...DEFAULT_RANK, ...(rank || {}) };
  const dec = s.pPos * s.pLove;
  const pl = s.pLoveDirect == null ? dec : (1 - alpha) * dec + alpha * s.pLoveDirect;
  return pl + beta * Math.max(0, s.pPos - pl);
}
// Poids d'un négatif (conservé pour compatibilité ; le moteur v7.1 traite un vu-sans-note comme l'inverse d'un 👍 : poids 1) : un film mal noté par TMDB est plus probablement rejeté pour sa qualité que pour son thème.
const negWeight = (va) => 0.25 + 0.75 / (1 + Math.exp(-((Number(va) || 0) - 6.6) / 0.5));

// Recettes négatives candidates (pour analyse Gemini / règle locale) : combinaisons sur-représentées chez les négatifs,
// avec la note TMDB moyenne des œuvres concernées (pour séparer "thème toxique" et "film médiocre").
function negativeRecipes(items, cap = 24) {
  const recs = items.map((i) => i.rec);
  const y = Uint8Array.from(items, (i) => (i.label > 0 ? 1 : 0)), w = items.map((i) => i.w == null ? 1 : i.w);
  const mined = [...mineInteractions(recs, y, w, 2, 200, { minSupport: 4, minAbs: 0.6 }), ...mineInteractions(recs, y, w, 3, 100, { minSupport: 4, minAbs: 0.6 })].filter((m) => m.score < 0);
  return mined.slice(0, cap).map((m, i) => {
    const ns = items.filter((it) => it.label === 0 && m.parts.every((p) => rawFeatures(it.rec).has(p)));
    const mean = ns.length ? ns.reduce((a, it) => a + (it.rec.va || 0), 0) / ns.length : 0;
    return { id: 'R' + (i + 1), parts: m.parts, score: +m.score.toFixed(2), support: m.support, neg: m.neg, pos: m.pos, meanVa: +mean.toFixed(2) };
  });
}
function recipeMatches(rec, parts) { const f = rawFeatures(rec); return parts.every((p) => f.has(p)); }

module.exports = { DEFAULT_RANK, utilityOf, U_LOVE, DEFAULT_CFG, W_TYPE, W_GLOBAL, trainProfile, scoreProfile, blendScores, negWeight, negativeRecipes, recipeMatches, mineInteractions, hashedVec, Corpus };
