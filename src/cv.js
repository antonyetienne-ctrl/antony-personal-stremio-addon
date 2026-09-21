'use strict';
// VALIDATION CROISÉE de tout l'historique (❤️, 👍, vus sans note) : chaque titre est noté par un modèle qui ne l'a jamais vu (4 parties : on apprend sur 3, on note la 4e, on tourne).
// On reproduit la production (profil du type 70 % + profil global 30 %, variante retenue par le backtest). Ce qui en sort :
//  1) les RÉGLAGES DE SÉCURITÉ par type (Films / Séries) : part du modèle ❤️ direct (α), pénalités d'incertitude (κ, ρ) et SEUIL DE RISQUE τ (risque estimé de pouce en bas au-delà duquel un titre est
//     fortement rétrogradé), choisis pour maximiser la valeur moyenne des K premiers titres avec un pouce en bas très pénalisé (❤️ +3, 👍 +1, vu sans note −4 : la sécurité passe d'abord) ;
//     les réglages par défaut ne sont abandonnés que pour un gain net (le bruit ne décide jamais) ;
//  2) la COURBE DE SÉCURITÉ (part des titres gardés et pouces en bas réellement observés selon le seuil) et la calibration du risque estimé ;
//  3) les PERTES PAR ÉTAGE : combien de tes ❤️ / 👍 les filtres écarteraient, combien le classement local laisserait hors des premiers 5 / 10 / 25 %, et ce que rattraperait un repêchage
//     sémantique par rang (mesure seulement : le repêchage est désactivé par défaut).
// Rien ici ne modifie l'historique ni les listes ; le résultat est mis en cache (job.cv) tant que l'historique ne change pas de plus de 40 titres.
const { hashInt } = require('./util');
const model = require('./model'); const embed = require('./embed');
const { scoreProfile, blendScores, utilityOf, DEFAULT_RANK } = model;

const LAMBDA = model.SAFETY_LAMBDA;                          // sévérité de la rétrogradation au-delà du seuil de risque
const VALUE = { 2: 3, 1: 1, 0: -4 };                        // valeur de réglage : ❤️ +3, 👍 +1, pouce en bas −4 (sécurité d'abord)
const DEFAULTS = { alpha: DEFAULT_RANK.alpha, kappa: 0, rho: 0, tau: 0.2 };
const GRID = { alpha: [DEFAULT_RANK.alpha, 0, 1], kappa: [0, 0.25, 0.5, 1], rho: [0, 0.1, 0.2], tau: [0.1, 0.15, 0.2, 0.25, 0.3, 1] };
const MIN_GAIN = 0.08;                                       // un réglage ne remplace le défaut que s'il gagne au moins autant (en valeur moyenne)
const TAUS = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 1];
const r3 = (x) => Math.round(x * 1e3) / 1e3;

// util de sélection d'un titre noté hors échantillon pour un jeu de réglages
const scoreOf = (b, p) => utilityOf(b, { alpha: p.alpha }) - p.kappa * b.sigma - p.rho * b.fp - LAMBDA * Math.max(0, 1 - b.pPos - p.tau);
const topIdx = (u, K) => u.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).slice(0, K).map((x) => x[1]);

async function crossValidate({ items, cfg, corpus, yielder, folds = 4, onStage }) {
  const usable = items.filter((i) => i.label >= 0 && i.vec);
  const rows = [];
  for (let f = 0; f < folds; f++) {
    onStage && onStage(`validation croisée : partie ${f + 1}/${folds}`);
    const train = usable.filter((i) => hashInt('cv' + i.key) % folds !== f), test = usable.filter((i) => hashInt('cv' + i.key) % folds === f);
    const g = await model.trainProfile(train, cfg, corpus, yielder); const byK = {};
    for (const k of ['m', 's']) { const d = train.filter((i) => i.rec.k === k); byK[k] = d.filter((i) => i.label > 0).length >= 10 && d.filter((i) => i.label === 0).length >= 10 ? await model.trainProfile(d, cfg, corpus, yielder) : null; }
    for (const it of test) { const sg = scoreProfile(g, it); const st = byK[it.rec.k] ? scoreProfile(byK[it.rec.k], it) : sg; rows.push({ it, type: it.rec.k === 'm' ? 'movie' : 'series', label: it.label, b: blendScores(st, sg) }); }
    if (yielder) await yielder();
  }
  return rows;
}

function evalParams(rows, p, K) {
  const u = rows.map((r) => scoreOf(r.b, p)); const top = topIdx(u, K);
  let v = 0, thumbs = 0, loves = 0, s = 0; for (const i of top) { const l = rows[i].label; v += VALUE[l]; s += l === 2 ? 3 : l === 1 ? 1 : -1; if (l === 0) thumbs++; if (l === 2) loves++; }
  return { J: v / K, valeurMoyenne: s / K, pouceBas: thumbs / K, coeurs: loves / K };
}
function selectParams(rows, K) {
  const base = evalParams(rows, DEFAULTS, K); let best = { p: DEFAULTS, ...base };
  for (const alpha of GRID.alpha) for (const kappa of GRID.kappa) for (const rho of GRID.rho) for (const tau of GRID.tau) {
    const p = { alpha, kappa, rho, tau }; const e = evalParams(rows, p, K); if (e.J > best.J + 1e-9) best = { p, ...e };
  }
  const adopt = best.J >= base.J + MIN_GAIN; const chosen = adopt ? best : { p: DEFAULTS, ...base };
  return { params: chosen.p, adopte: adopt, K, parDefaut: { J: r3(base.J), pouceBas: r3(base.pouceBas), valeurMoyenne: r3(base.valeurMoyenne), coeurs: r3(base.coeurs) }, retenu: { J: r3(chosen.J), pouceBas: r3(chosen.pouceBas), valeurMoyenne: r3(chosen.valeurMoyenne), coeurs: r3(chosen.coeurs) } };
}
function safetyCurve(rows, alpha) {
  return TAUS.map((tau) => {
    const pass = rows.filter((r) => 1 - r.b.pPos <= tau); const n = pass.length;
    return { seuilDeRisque: tau, titresGardes: r3(n / Math.max(1, rows.length)), pouceBasObserve: n ? r3(pass.filter((r) => r.label === 0).length / n) : null, coeursObserves: n ? r3(pass.filter((r) => r.label === 2).length / n) : null };
  });
}
function riskCalibration(rows) {
  const bins = [[0, 0.1], [0.1, 0.2], [0.2, 0.3], [0.3, 0.5], [0.5, 1.01]];
  return bins.map(([lo, hi]) => { const b = rows.filter((r) => { const p = 1 - r.b.pPos; return p >= lo && p < hi; }); return { risqueEstime: `${lo}–${Math.min(hi, 1)}`, n: b.length, estime: b.length ? r3(b.reduce((a, r) => a + (1 - r.b.pPos), 0) / b.length) : null, observe: b.length ? r3(b.filter((r) => r.label === 0).length / b.length) : null }; });
}
// rappel : part des titres aimés (❤️ / ❤️+👍) parmi les premiers p % d'un classement
function recall(rank, rows, pct, wanted) {
  const n = rows.length, cut = Math.max(1, Math.round(n * pct / 100)); const set = new Set(rank.slice(0, cut)); const pool = rows.map((r, i) => [r, i]).filter(([r]) => wanted(r.label));
  return pool.length ? r3(pool.filter(([, i]) => set.has(i)).length / pool.length) : null;
}
function stageLosses({ rows, passes, vecOf, pctList = [5, 10, 25] }) {
  const out = { filtres: {}, rangLocal: {}, semantique: null };
  const usable = rows.filter((r) => r.label > 0);
  for (const [name, lab] of [['coeurs', 2], ['aimes', 1]]) { const sel = usable.filter((r) => r.label === lab); out.filtres[name] = { total: sel.length, ecartes: sel.filter((r) => !passes(r.it.rec)).length }; }
  for (const type of ['movie', 'series']) {
    const rs = rows.filter((r) => r.type === type); if (rs.length < 30) continue;
    const local = topIdx(rs.map((r) => utilityOf(r.b, DEFAULTS)), rs.length);
    const loc = {}; for (const p of pctList) loc[`top${p}pct`] = { coeurs: recall(local, rs, p, (l) => l === 2), aimes: recall(local, rs, p, (l) => l > 0) };
    out.rangLocal[type] = { titres: rs.length, ...loc };
    if (vecOf) {
      const pool = embed.poolOf(rs.map((r) => r.it), (i) => vecOf(i.rec)); const prior = embed.priorOf(pool);
      const sem = rs.map((r) => { const v = vecOf(r.it.rec); const p = v && pool.length > 5 ? embed.knnProbs(v, pool, { prior, skipKey: r.it.key }) : null; return p ? embed.uKnn(p) : -9; });
      const semRank = topIdx(sem, rs.length); const res = {};
      for (const p of pctList) {
        const cut = Math.max(1, Math.round(rs.length * p / 100)), cutL = Math.max(1, Math.round(cut * 0.75)), set = new Set(local.slice(0, cutL));
        for (const i of semRank) { if (set.size >= cut) break; set.add(i); }                           // repêchage : 75 % du budget au modèle local, 25 % aux meilleurs voisins sémantiques non déjà retenus
        const inU = (wanted) => { const sel = rs.map((r, i) => [r, i]).filter(([r]) => wanted(r.label)); return sel.length ? r3(sel.filter(([, i]) => set.has(i)).length / sel.length) : null; };
        res[`top${p}pct`] = { semantiqueSeul: { coeurs: recall(semRank, rs, p, (l) => l === 2), aimes: recall(semRank, rs, p, (l) => l > 0) }, repechage: { coeurs: inU((l) => l === 2), aimes: inU((l) => l > 0) } };
      }
      out.semantique = { ...(out.semantique || {}), [type]: res };
    }
  }
  return out;
}
function summarize({ rows, key, passes, vecOf, folds }) {
  const out = { key, at: new Date().toISOString(), folds, titres: rows.length, params: {}, selection: {}, courbeSecurite: {}, calibrationRisque: {}, methode: 'valeur de réglage : ❤️ +3, 👍 +1, pouce en bas −4 ; K premiers titres = 3 % du type (au moins 15)' };
  for (const type of ['movie', 'series']) {
    const rs = rows.filter((r) => r.type === type); if (rs.length < 40) { out.params[type] = DEFAULTS; out.selection[type] = { ignore: 'historique trop court' }; continue; }
    const K = Math.max(15, Math.round(rs.length * 0.03)); const sel = selectParams(rs, K);
    out.params[type] = sel.params; out.selection[type] = { adopte: sel.adopte, K: sel.K, parDefaut: sel.parDefaut, retenu: sel.retenu };
    out.courbeSecurite[type] = safetyCurve(rs, sel.params.alpha); out.calibrationRisque[type] = riskCalibration(rs);
  }
  out.pertes = stageLosses({ rows, passes, vecOf });
  return out;
}
module.exports = { crossValidate, summarize, selectParams, evalParams, safetyCurve, riskCalibration, stageLosses, scoreOf, LAMBDA, VALUE, DEFAULTS, GRID, MIN_GAIN };
