'use strict';
// Backtest sur l'historique réel de l'utilisateur.
//  - "dev" (80 % les plus anciens) : sélection de la variante par validation croisée (prédictions hors-échantillon) ;
//  - "test" (20 % les plus récents, ou tirage déterministe si les dates manquent) : jamais vu pendant la sélection.
// Un titre recommandé mais non regardé n'est PAS un faux positif : les métriques ne portent que sur des items étiquetés
// (❤️/👍 = positif ; vu sans appréciation = négatif explicite).
const ml = require('./ml');
const { trainProfile, scoreProfile, blendScores } = require('./model');
const { hashInt } = require('./util');

const VARIANTS = [
  { id: 'A_lineaire', label: 'Régression sur features (baseline)', cfg: { inter: 0, stack: false } },
  { id: 'B_paires', label: '+ interactions (paires)', cfg: { inter: 2, stack: false } },
  { id: 'C_prototypes', label: '+ prototypes/kNN/clusters + empilement', cfg: { inter: 2, stack: true } },
  { id: 'D_triplets', label: '+ triplets', cfg: { inter: 2, triples: true, stack: true } }
];
const GAIN_TO_ADOPT = 0.004;   // une variante plus complexe n'est adoptée que si elle gagne au moins autant en AUC

function metrics(p, y, love) {
  const n = y.length; const pos = y.reduce((a, b) => a + b, 0);
  const at = (k) => { if (n < k) return null; const top = ml.topK(p, k); return { precision: +(top.reduce((a, i) => a + y[i], 0) / k).toFixed(3), loveRate: love ? +(top.reduce((a, i) => a + (love[i] ? 1 : 0), 0) / k).toFixed(3) : null, falsePositives: +(top.reduce((a, i) => a + (1 - y[i]), 0) / k).toFixed(3) }; };
  return { n, positives: pos, baseRate: +(pos / Math.max(1, n)).toFixed(3), auc: +ml.auc(p, y).toFixed(4), logloss: +ml.logloss(p, y).toFixed(4), brier: +ml.brier(p, y).toFixed(4), p10: at(10), p30: at(30), calibration: ml.calibration(p, y) };
}

// Les ❤️/👍/vus ont été saisis à la main, sans lien fiable avec la date de visionnage : PAS de découpage temporel.
// Tirage déterministe 80/20 (par identifiant), donc reproductible.
function split(items) {
  return { mode: 'tirage déterministe 80/20 (dates de notation non fiables)', dev: items.filter((i) => hashInt(i.key) % 5 !== 0), test: items.filter((i) => hashInt(i.key) % 5 === 0) };
}

async function runBacktest(items, corpus, yielder, { onStage, afterTest } = {}) {
  const t0 = Date.now();
  const out = { at: new Date().toISOString(), n: items.length, variants: [], chosen: null, test: {}, risk: null, notes: [] };
  const usable = items.filter((i) => i.label >= 0);
  if (usable.filter((i) => i.label > 0).length < 20 || usable.filter((i) => i.label === 0).length < 20) {
    out.notes.push('Historique trop court (moins de 20 positifs ou 20 négatifs) : backtest non significatif, variante par défaut utilisée.');
    out.chosen = { id: 'C_prototypes', cfg: VARIANTS[2].cfg, byDefault: true };
    return out;
  }
  const { mode, dev, test } = split(usable);
  out.split = { mode, dev: dev.length, test: test.length };
  const ydev = dev.map((i) => (i.label > 0 ? 1 : 0));
  // 1) sélection de variante sur dev (validation croisée)
  for (const v of VARIANTS) {
    onStage && onStage(`backtest : ${v.id}`);
    const prof = await trainProfile(dev, v.cfg, corpus, yielder);
    const p = Array.from(prof.task1.oof);
    out.variants.push({ id: v.id, label: v.label, cv: metrics(p, ydev, dev.map((i) => i.label === 2 ? 1 : 0)), profile: prof });
  }
  let best = out.variants[0];
  for (const v of out.variants.slice(1)) if (v.cv.auc >= best.cv.auc + GAIN_TO_ADOPT) best = v;
  out.chosen = { id: best.id, cfg: VARIANTS.find((v) => v.id === best.id).cfg };
  // 2) évaluation sur le test (jamais vu) : modèle entraîné sur dev, blend 70/30 comme en production
  onStage && onStage('backtest : évaluation sur la période de test');
  const cfg = out.chosen.cfg;
  const profGlobal = best.profile;
  const kinds = ['m', 's'];
  const profByKind = {};
  for (const k of kinds) {
    const d = dev.filter((i) => i.rec.k === k);
    profByKind[k] = d.filter((i) => i.label > 0).length >= 10 && d.filter((i) => i.label === 0).length >= 10 ? await trainProfile(d, cfg, corpus, yielder) : null;
  }
  const scored = test.map((it) => { const g = scoreProfile(profGlobal, it); const t = profByKind[it.rec.k] ? scoreProfile(profByKind[it.rec.k], it) : g; return { it, g, b: blendScores(t, g) }; });
  const yt = (arr) => arr.map((s) => (s.it.label > 0 ? 1 : 0)), lv = (arr) => arr.map((s) => (s.it.label === 2 ? 1 : 0));
  out.test.global = metrics(scored.map((s) => s.g.pPos), yt(scored), lv(scored));
  for (const k of kinds) {
    const sub = scored.filter((s) => s.it.rec.k === k);
    if (sub.length >= 20 && new Set(yt(sub)).size === 2) out.test[k === 'm' ? 'films' : 'series'] = metrics(sub.map((s) => s.b.pPos), yt(sub), lv(sub));
  }
  // 3) classement orienté ❤️ : α (part du modèle ❤️ direct) et β (crédit accordé au 👍 seul), choisis sur le taux de ❤️ dans le Top 30
  const { utilityOf, DEFAULT_RANK } = require('./model');
  const ytArr = yt(scored), lvArr = lv(scored);
  const rankGrid = [];
  for (const alpha of [DEFAULT_RANK.alpha, 0, 1]) for (const beta of [DEFAULT_RANK.beta, 0.1, 0.5]) rankGrid.push({ alpha, beta });
  out.rankGrid = rankGrid.map((r) => {
    const u = scored.map((s) => utilityOf(s.b, r)); const m = metrics(u, ytArr, lvArr);
    return { ...r, loveRate30: m.p30 ? m.p30.loveRate : null, precision30: m.p30 ? m.p30.precision : null, loveAuc: +ml.auc(u, lvArr).toFixed(4) };
  });
  let bestR = out.rankGrid[0];                       // valeurs par défaut en tête : une alternative doit gagner nettement
  for (const r of out.rankGrid.slice(1)) if ((r.loveRate30 || 0) + r.loveAuc >= (bestR.loveRate30 || 0) + bestR.loveAuc + 0.02) bestR = r;
  out.rank = { alpha: bestR.alpha, beta: bestR.beta };
  // 4) pénalités d'incertitude / de risque (grille minuscule, la plus simple qui gagne), critère : AUC du ❤️
  const grid = []; for (const kappa of [0, 0.25, 0.5]) for (const rho of [0, 0.1, 0.2]) grid.push({ kappa, rho });
  let bestG = null;
  for (const g of grid) {
    const u = scored.map((s) => utilityOf(s.b, out.rank) - g.kappa * s.b.sigma - g.rho * s.b.fp);
    const a = ml.auc(u, lvArr);
    if (!bestG || a >= bestG.auc + 0.003) bestG = { ...g, auc: +a.toFixed(4) };
  }
  out.risk = bestG;
  out.test.blend70_30 = metrics(scored.map((s) => utilityOf(s.b, out.rank) - bestG.kappa * s.b.sigma - bestG.rho * s.b.fp), ytArr, lvArr);   // classement FINAL (Top 30 orienté ❤️)
  Object.assign(out.test.blend70_30, { logloss: null, brier: null, calibration: null, note: 'score de classement orienté ❤️ : logloss et calibration non applicables' });
  for (const v of out.variants) delete v.profile;
  if (typeof afterTest === 'function') {                       // mesure facultative (ex. apport de Gemini) : ne modifie rien au classement
    try { out.geminiEval = await afterTest({ dev, test, scored, profGlobal, rank: out.rank, risk: out.risk }); }
    catch (e) { out.geminiEval = { error: String(e && e.message || e).slice(0, 160) }; }
  }
  out.ms = Date.now() - t0;
  return out;
}

module.exports = { runBacktest, VARIANTS, metrics, split };
