'use strict';
// MESURE + CALIBRATION AUTOMATIQUE de l'arbitrage Gemini par PROXIMITÉ (variante C). Aucune validation manuelle : le backtest règle seul le malus et le poids de Gemini.
// Protocole sans fuite de données, IDENTIQUE à la production (même prompt, mêmes cartes ; ni ADN rédigé, ni filtres, ni score local) :
//  1. pour chaque titre de TEST (respectant les filtres actuels), on cherche dans les titres d'APPRENTISSAGE seulement les 3 titres ADORÉS et les 3 titres NON AIMÉS les plus proches ;
//  2. Gemini compare l'expérience du titre à ces voisins : proche_des_adores, proche_des_non_aimes, connaissance ;
//  3. on compare le modèle local (entraîné sans ces titres), Gemini seul et des mélanges (AUC) ;
//  4. on CALIBRE le malus (fit0, alpha) et le poids de Gemini (wg) en simulant la vraie sélection : mêmes règles que la production, part de ❤️ du haut de liste après remplacement.
//     Plancher de sévérité, petits pas d'un calcul à l'autre, réglage précédent conservé sans gain net, repli sur le plancher si Gemini n'aide pas.
// Coût : 1 requête par lot de 50 titres de test (≈ 4 à 6), une fois par changement d'historique (ou Forcer un rebuild).
const ml = require('./ml');
const { utilityOf } = require('./model');
const { nearestK, finalizeTop, MALUS_FLOOR, MALUS_GRID, DEFAULT_MALUS } = require('./pipeline');
const { comparePrompt, parseEvaluations } = require('./gemini');
const { hashInt, mulberry32 } = require('./util');

const WEIGHTS = [0, 0.15, 0.25, 0.35, 0.5, 0.75, 1];
const BATCH = 50, MAX_ITEMS = 300, MIN_MATCHED = 60, BOOT = 300;
const WINDOW_FRACTIONS = [0.4, 0.5, 0.6], TOP_SHARE = 0.375;      // 30 sur 80 en production

const rankNorm = (arr) => {                       // rang moyen normalisé dans [0,1] (ex æquo => rang moyen)
  const n = arr.length; const idx = arr.map((v, i) => i).sort((a, b) => arr[a] - arr[b]); const out = new Array(n);
  for (let r = 0; r < n;) { let e = r; while (e + 1 < n && arr[idx[e + 1]] === arr[idx[r]]) e++; const v = (r + e) / 2 / Math.max(1, n - 1); for (let k = r; k <= e; k++) out[idx[k]] = v; r = e + 1; }
  return out;
};
const pctl = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))]; };
const r4 = (x) => (Number.isFinite(x) ? +x.toFixed(4) : null);
const topStats = (score, y, k) => {
  const ix = score.map((v, i) => i).sort((a, b) => score[b] - score[a]).slice(0, k);
  if (!ix.length) return { precision: null, loveRate: null };
  return { precision: +(ix.reduce((a, i) => a + (y.pos[i] ? 1 : 0), 0) / ix.length).toFixed(3), loveRate: +(ix.reduce((a, i) => a + (y.love[i] ? 1 : 0), 0) / ix.length).toFixed(3) };
};

// ---------- calibration du malus et du poids de Gemini ----------
// rows : [{ label, localUtil, key }] ; adj : Map key -> évaluation Gemini ; renvoie les indices de rows retenus dans le haut de liste simulé
function simulate(rows, order, adj, malus, Wm, K) {
  const pool = order.map((ri, idx) => ({ rec: { im: rows[ri].key, i: idx + 1 }, util: rows[ri].localUtil, ri }));
  return finalizeTop(pool, adj, { top: K, window: Wm, malus }).map((x) => x.c.ri);
}
const objective = (rows, sel) => (sel.length ? sel.filter((i) => rows[i].label === 2).length / sel.length + 0.3 * (sel.filter((i) => rows[i].label > 0).length / sel.length) : 0);
const sameParams = (a, b) => a && b && a.fit0 === b.fit0 && a.risk0 === b.risk0 && a.alpha === b.alpha && a.wg === b.wg;
const gridIndex = (p) => (p ? [MALUS_GRID.fit0.indexOf(p.fit0), MALUS_GRID.risk0.indexOf(p.risk0 === undefined ? 100 : p.risk0), MALUS_GRID.alpha.indexOf(p.alpha), MALUS_GRID.wg.indexOf(p.wg === undefined ? 0.35 : p.wg)] : null);

function calibrateMalus(rows, adj, previous) {
  const n = rows.length; const order = rows.map((r, i) => i).sort((a, b) => rows[b].localUtil - rows[a].localUtil || a - b);
  const wins = WINDOW_FRACTIONS.map((f) => { const Wm = Math.max(20, Math.round(f * n)); return { Wm, K: Math.max(5, Math.round(TOP_SHARE * Wm)) }; });
  const score = (malus) => wins.reduce((a, { Wm, K }) => a + objective(rows, simulate(rows, order, adj, malus, Wm, K)), 0) / wins.length;
  const local = wins.reduce((a, { K }) => a + objective(rows, order.slice(0, K)), 0) / wins.length;
  const blendOnly = score({ ...DEFAULT_MALUS, alpha: 0 });
  const cfgs = [];
  MALUS_GRID.fit0.forEach((f, fi) => MALUS_GRID.risk0.forEach((r, ri) => MALUS_GRID.alpha.forEach((a, ai) => MALUS_GRID.wg.forEach((w, wi) => { const p = { fit0: f, risk0: r, alpha: a, wg: w }; cfgs.push({ p, idx: [fi, ri, ai, wi], obj: score(p) }); }))));
  const pIdx = gridIndex(previous); const prevOk = pIdx && pIdx.every((v) => v >= 0);
  const reach = prevOk ? cfgs.filter((c) => c.idx.every((v, k) => Math.abs(v - pIdx[k]) <= 1)) : cfgs;     // petits pas d'un calcul à l'autre
  const best = reach.reduce((a, c) => (c.obj > a.obj ? c : a), reach[0]);
  const plateau = reach.filter((c) => c.obj >= best.obj - 0.01);                                            // configurations équivalentes : médiane en sévérité
  const sev = (c) => c.idx[0] + c.idx[2] + c.idx[3];
  const sorted = plateau.slice().sort((a, b) => sev(a) - sev(b) || a.obj - b.obj);
  let chosen = sorted[Math.floor((sorted.length - 1) / 2)], source = prevOk ? 'petit pas depuis le réglage précédent' : 'grille complète';
  const prevCfg = prevOk ? cfgs.find((c) => sameParams(c.p, { ...previous, risk0: previous.risk0 === undefined ? 100 : previous.risk0, wg: previous.wg === undefined ? 0.35 : previous.wg })) : null;
  if (prevCfg && chosen.obj - prevCfg.obj < 0.005) { chosen = prevCfg; source = 'réglage précédent conservé (pas de gain net)'; }
  const floorCfg = cfgs.find((c) => sameParams(c.p, MALUS_FLOOR));
  let helps = true;
  if (chosen.obj < local - 0.02) { chosen = floorCfg; source = 'PLANCHER (Gemini n\'améliore pas le haut de liste sur ces titres : sévérité minimale et poids minimal)'; helps = false; }
  return { params: chosen.p, source, objectif: r4(chosen.obj), objectifLocalSeul: r4(local), objectifMelangeSeul: r4(blendOnly), objectifPlancher: r4(floorCfg.obj), configurationsEquivalentes: plateau.length, fenetres: wins, geminiAide: helps };
}

// effet du réglage retenu : titres retirés / entrés dans le haut de liste simulé (fenêtre médiane), par rapport au classement local seul
function effect(rows, adj, params, ex) {
  const n = rows.length; const order = rows.map((r, i) => i).sort((a, b) => rows[b].localUtil - rows[a].localUtil || a - b);
  const Wm = Math.max(20, Math.round(0.5 * n)), K = Math.max(5, Math.round(TOP_SHARE * Wm));
  const a = new Set(order.slice(0, K)), b = new Set(simulate(rows, order, adj, params, Wm, K));
  const out = [...a].filter((i) => !b.has(i)), inn = [...b].filter((i) => !a.has(i));
  const cnt = (ix) => ({ total: ix.length, nonAimes: ix.filter((i) => rows[i].label === 0).length, aimes: ix.filter((i) => rows[i].label === 1).length, coupsDeCoeur: ix.filter((i) => rows[i].label === 2).length });
  const o = cnt(out), e = cnt(inn);
  const love = (s) => Math.round((100 * [...s].filter((i) => rows[i].label === 2).length) / K);
  const txt = out.length ? `Par rapport au classement local seul, ${o.total} titres sortent du haut de liste : ${o.nonAimes} ne sont pas aimés (${Math.round((100 * o.nonAimes) / o.total)} %) et ${o.coupsDeCoeur} sont des coups de cœur ; ${e.total} entrent : ${e.nonAimes} non aimés, ${e.coupsDeCoeur} coups de cœur. Part de ❤️ du haut de liste : ${love(a)} % -> ${love(b)} %.` : 'Le réglage retenu ne change rien au haut de liste sur ces données (effet nul).';
  return { tailleHautDeListe: K, fenetre: Wm, sortent: o, entrent: e, partCoeurAvant: love(a), partCoeurApres: love(b), resume: txt, exemplesSortis: out.slice(0, 8).map(ex), exemplesEntres: inn.slice(0, 8).map(ex) };
}

// ctx : { gem, dev, test, scored, rank, previousMalus, passes }
// passes(rec) : le titre respecte les filtres ACTUELS de la page de configuration. Comme les candidats de la production, seuls ces titres sont mesurés.
async function evaluate(ctx) {
  const { gem, dev, rank, previousMalus, passes } = ctx;
  const scoredAll = ctx.scored; const scored = passes ? scoredAll.filter((s) => { try { return passes(s.it.rec); } catch { return true; } }) : scoredAll; const horsFiltres = scoredAll.length - scored.length;
  if (scored.length < MIN_MATCHED) return { error: `trop peu de titres de test respectent les filtres actuels (${scored.length}/${scoredAll.length}, minimum ${MIN_MATCHED}) : mesure impossible`, titresHorsFiltres: horsFiltres };
  try {
    if (!gem || !gem.available) return { skipped: 'Gemini indisponible ou désactivé' };
    const nItems = Math.min(scored.length, MAX_ITEMS), need = Math.ceil(nItems / BATCH);
    const left = typeof gem._quotaLeft === 'function' ? gem._quotaLeft() : 99;
    if (left < need) return { skipped: `quota quotidien Gemini insuffisant (${left} requête(s) restante(s), il en faut ${need})` };
    const lovedDev = dev.filter((i) => i.label === 2 && i.vec), rejDev = dev.filter((i) => i.label === 0 && i.vec);
    if (lovedDev.length < 10 || rejDev.length < 10) return { skipped: 'historique d\'apprentissage trop court pour trouver des voisins (moins de 10 adorés ou de 10 non aimés)' };
    // titres de TEST, ordre pseudo-aléatoire reproductible, en lots de 50
    const items = scored.slice().sort((a, b) => hashInt('geval' + a.it.key) - hashInt('geval' + b.it.key)).slice(0, MAX_ITEMS);
    const got = new Map(); let batches = 0;
    for (let i = 0; i < items.length; i += BATCH) {
      const chunk = items.slice(i, i + BATCH); const byId = new Map();
      const cards = chunk.map((s, j) => {
        const id = 't' + (i + j + 1); byId.set(id, s.it.key); const r = s.it.rec; const c = { item: s.it };
        return { id, titre: r.t, annee: r.y, genres: r.gn || [], mots_cles: (r.kw || []).slice(0, 8).map((k) => k[1]), synopsis: (r.ov || '').slice(0, 180), adores: nearestK(c, lovedDev, 3), non_aimes: nearestK(c, rejDev, 3) };
      });
      const res = await gem.json(comparePrompt({ candidats: cards })); batches++;
      const pe = parseEvaluations(res, byId);
      for (const [k, v] of pe.map) got.set(k, v);
    }
    const rows = items.filter((s) => got.has(s.it.key)).map((s) => ({ s, gm: got.get(s.it.key) }));
    if (rows.length < MIN_MATCHED) return { error: `réponse Gemini incomplète (${rows.length}/${items.length} titres évalués, minimum ${MIN_MATCHED}) : mesure non concluante`, calls: batches };
    const y = { pos: rows.map((r) => (r.s.it.label > 0 ? 1 : 0)), love: rows.map((r) => (r.s.it.label === 2 ? 1 : 0)) };
    const local = { love: rows.map((r) => utilityOf(r.s.b, rank)), pos: rows.map((r) => r.s.b.pPos) };
    const gemi = rows.map((r) => r.gm.fit);                                 // fit = (100 + proche des adorés − proche des non-aimés) / 2
    const rk = { lLove: rankNorm(local.love), gLove: rankNorm(gemi), lPos: rankNorm(local.pos), gPos: rankNorm(gemi) };
    const blend = (a, b, w) => a.map((v, i) => (1 - w) * v + w * b[i]);
    const table = WEIGHTS.map((w) => {
      const sl = blend(rk.lLove, rk.gLove, w), sp = blend(rk.lPos, rk.gPos, w);
      return { poidsGemini: w, aucCoupDeCoeur: r4(ml.auc(sl, y.love)), aucApprecie: r4(ml.auc(sp, y.pos)), top20: topStats(sl, y, 20) };
    });
    const base = table[0], gemOnly = table[table.length - 1];
    let best = table[0]; for (const t of table) if (t.aucCoupDeCoeur > best.aucCoupDeCoeur + 0.005) best = t;
    const rnd = mulberry32(hashInt('boot' + rows.length)); const n = rows.length;
    const bl = blend(rk.lLove, rk.gLove, best.poidsGemini); const A = [], B = [], D = [];
    for (let b = 0; b < BOOT; b++) {
      const ix = Array.from({ length: n }, () => Math.floor(rnd() * n)); const yy = ix.map((i) => y.love[i]);
      const a1 = ml.auc(ix.map((i) => rk.lLove[i]), yy), a2 = ml.auc(ix.map((i) => rk.gLove[i]), yy), a3 = ml.auc(ix.map((i) => bl[i]), yy);
      if (Number.isFinite(a1) && Number.isFinite(a2) && Number.isFinite(a3)) { A.push(a1); B.push(a2); D.push(a3 - a1); }
    }
    const ic = (v) => (v.length >= 30 ? [r4(pctl(v, 0.025)), r4(pctl(v, 0.975))] : null);
    const diff = best.aucCoupDeCoeur - base.aucCoupDeCoeur; const icDiff = ic(D);
    let verdict;
    if (best.poidsGemini === 0) verdict = 'Gemini (par proximité) n\'apporte pas de gain mesurable sur le classement global de ces titres : son poids par mélange doit rester faible.';
    else if (icDiff && icDiff[0] > 0) verdict = `Gemini (par proximité) améliore le classement de façon significative (gain d'AUC ${diff.toFixed(3)}, intervalle à 95 % ${icDiff[0]} à ${icDiff[1]}) : poids conseillé ${Math.round(best.poidsGemini * 100)} %.`;
    else verdict = `Tendance positive (gain d'AUC ${diff.toFixed(3)} au poids ${Math.round(best.poidsGemini * 100)} %) mais NON concluante avec ${n} titres : l'intervalle à 95 % inclut zéro.`;
    // calibration automatique du malus et du poids
    const lab = (l) => (l === 2 ? '❤️ Love' : l === 1 ? '👍 Like' : 'vu sans note');
    const crows = rows.map((r, i) => ({ label: r.s.it.label, localUtil: local.love[i], key: r.s.it.key, r }));
    const adj = new Map(rows.map((r) => [r.s.it.key, r.gm]));
    const cal = calibrateMalus(crows, adj, previousMalus);
    const ex = (i) => { const r = crows[i].r; return { titre: r.s.it.rec.t, annee: r.s.it.rec.y, reel: lab(r.s.it.label), procheDesAdores: r.gm.sim ? Math.round(r.gm.sim.adores) : null, procheDesNonAimes: r.gm.sim ? Math.round(r.gm.sim.nonAimes) : null, connaissance: r.gm.know === null ? null : Math.round(r.gm.know), motif: r.gm.note || undefined }; };
    const eff = effect(crows, adj, cal.params, ex);
    // désaccords : ❤️ que Gemini juge très éloignés des adorés / titres non aimés qu'il juge très proches des adorés
    const dis = rows.map((r, i) => ({ titre: r.s.it.rec.t, annee: r.s.it.rec.y, reel: lab(r.s.it.label), net: Math.round(r.gm.fit), procheDesAdores: r.gm.sim ? Math.round(r.gm.sim.adores) : null, procheDesNonAimes: r.gm.sim ? Math.round(r.gm.sim.nonAimes) : null, rangLocalPct: Math.round(rk.lLove[i] * 100), motif: r.gm.note || undefined }));
    return {
      at: new Date().toISOString(), model: gem.model || null, variante: 'C (proximité)', titresEvalues: n, titresHorsFiltres: horsFiltres, lots: batches, requetesGemini: batches,
      protocole: 'production : mêmes prompt et mêmes cartes (3 adorés et 3 non aimés les plus proches, tirés de l\'apprentissage seulement), ni ADN rédigé, ni filtres, ni score local ; seuls les titres qui respectent les filtres actuels sont mesurés',
      aucCoupDeCoeur: { local: base.aucCoupDeCoeur, geminiSeul: gemOnly.aucCoupDeCoeur, ic95Local: ic(A), ic95GeminiSeul: ic(B) },
      aucApprecie: { local: base.aucApprecie, geminiSeul: gemOnly.aucApprecie },
      melanges: table, meilleur: { poidsGemini: best.poidsGemini, gainAuc: r4(diff), ic95Gain: icDiff }, verdict,
      malus: { ...cal, effet: eff, at: new Date().toISOString() },
      desaccords: { coeursJugesEloignes: dis.filter((d) => d.reel === '❤️ Love').sort((a, b) => a.net - b.net).slice(0, 6), nonAimesJugesProches: dis.filter((d) => d.reel === 'vu sans note').sort((a, b) => b.net - a.net).slice(0, 6) }
    };
  } catch (e) { return { error: String(e && e.message || e).slice(0, 160) }; }
}

module.exports = { evaluate, calibrateMalus, effect, simulate, rankNorm, WEIGHTS };
