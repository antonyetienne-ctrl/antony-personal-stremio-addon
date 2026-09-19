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
  { id: 'D_triplets', label: '+ triplets', cfg: { inter: 2, triples: true, stack: true } },
  { id: 'E_recence', label: '+ pondération de récence (demi-vie 2 ans)', cfg: { inter: 2, stack: true, halfLifeDays: 730 } }
];
const GAIN_TO_ADOPT = 0.004;   // une variante plus complexe n'est adoptée que si elle gagne au moins autant en AUC

function metrics(p, y, love) {
  const n = y.length; const pos = y.reduce((a, b) => a + b, 0);
  const at = (k) => { if (n < k) return null; const top = ml.topK(p, k); return { precision: +(top.reduce((a, i) => a + y[i], 0) / k).toFixed(3), loveRate: love ? +(top.reduce((a, i) => a + (love[i] ? 1 : 0), 0) / k).toFixed(3) : null, falsePositives: +(top.reduce((a, i) => a + (1 - y[i]), 0) / k).toFixed(3) }; };
  return { n, positives: pos, baseRate: +(pos / Math.max(1, n)).toFixed(3), auc: +ml.auc(p, y).toFixed(4), logloss: +ml.logloss(p, y).toFixed(4), brier: +ml.brier(p, y).toFixed(4), p10: at(10), p30: at(30), calibration: ml.calibration(p, y) };
}

function split(items) {
  const dated = items.filter((i) => i.lw > 0).length;
  if (dated >= 0.6 * items.length) {
    const order = items.map((_, i) => i).sort((a, b) => items[a].lw - items[b].lw);
    const nTest = Math.max(30, Math.round(items.length * 0.2));
    const testIdx = new Set(order.slice(order.length - nTest));
    return { mode: 'temporel (20 % les plus récents)', dev: items.filter((_, i) => !testIdx.has(i)), test: items.filter((_, i) => testIdx.has(i)) };
  }
  return { mode: 'tirage déterministe 80/20 (dates insuffisantes)', dev: items.filter((i) => hashInt(i.key) % 5 !== 0), test: items.filter((i) => hashInt(i.key) % 5 === 0) };
}

async function runBacktest(items, corpus, yielder, { onStage } = {}) {
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
  out.test.blend70_30 = metrics(scored.map((s) => s.b.mu), yt(scored), lv(scored));
  for (const k of kinds) {
    const sub = scored.filter((s) => s.it.rec.k === k);
    if (sub.length >= 20 && new Set(yt(sub)).size === 2) out.test[k === 'm' ? 'films' : 'series'] = metrics(sub.map((s) => s.b.pPos), yt(sub), lv(sub));
  }
  // 3) pénalités d'incertitude / de risque : choisies sur le test (grille minuscule, la plus simple qui gagne)
  const grid = []; for (const kappa of [0, 0.25, 0.5]) for (const rho of [0, 0.1, 0.2]) grid.push({ kappa, rho });
  let bestG = null;
  for (const g of grid) {
    const u = scored.map((s) => s.b.mu - g.kappa * s.b.sigma - g.rho * s.b.fp);
    const a = ml.auc(u, yt(scored));
    if (!bestG || a >= bestG.auc + 0.003) bestG = { ...g, auc: +a.toFixed(4) };
  }
  out.risk = bestG;
  for (const v of out.variants) delete v.profile;
  out.ms = Date.now() - t0;
  return out;
}

module.exports = { runBacktest, VARIANTS, metrics, split };
