'use strict';
// MESURE (rien n'est modifié dans le classement de production) : Gemini améliore-t-il le classement ?
// Protocole sans fuite de données :
//  1. l'ADN du profil est régénéré à partir des titres d'APPRENTISSAGE seulement (jamais les titres de test) ;
//  2. Gemini note ensuite des titres de TEST (que tu as réellement notés ❤️ / 👍 / vu sans note), SANS voir le score du modèle local ni les titres voisins ;
//  3. on compare, sur ces mêmes titres, le modèle local (entraîné sans eux), Gemini seul et des mélanges (poids de 0 à 100 % pour Gemini),
//     avec des intervalles de confiance (rééchantillonnage) : le verdict dit si le gain est significatif ou non.
// Coût : 3 requêtes Gemini (1 ADN + 2 lots de 100 titres), une fois par changement d'historique (ou Forcer un rebuild).
const ml = require('./ml');
const { utilityOf } = require('./model');
const { makeNamer } = require('./features');
const { dnaPrompt, evalPrompt, parseEvaluations } = require('./gemini');
const { hashInt, mulberry32 } = require('./util');

const WEIGHTS = [0, 0.15, 0.25, 0.35, 0.5, 0.75, 1];
const BATCH = 100, MAX_ITEMS = 200, MIN_MATCHED = 60, BOOT = 300;

const rankNorm = (arr) => {                       // rang moyen normalisé dans [0,1] (ex æquo => rang moyen)
  const n = arr.length; const idx = arr.map((v, i) => i).sort((a, b) => arr[a] - arr[b]); const out = new Array(n);
  for (let r = 0; r < n;) { let e = r; while (e + 1 < n && arr[idx[e + 1]] === arr[idx[r]]) e++; const v = (r + e) / 2 / Math.max(1, n - 1); for (let k = r; k <= e; k++) out[idx[k]] = v; r = e + 1; }
  return out;
};
const pctl = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))]; };
const r4 = (x) => (Number.isFinite(x) ? +x.toFixed(4) : null);
const top = (score, y, k) => { const t = ml.topK(score, Math.min(k, score.length)); return { precision: +(t.reduce((a, i) => a + (y.pos[i] ? 1 : 0), 0) / t.length).toFixed(3), loveRate: +(t.reduce((a, i) => a + (y.love[i] ? 1 : 0), 0) / t.length).toFixed(3) }; };

// ctx : { gem, dev, test, scored, profGlobal, rank, explain }  ; scored = [{ it, g, b }] scores locaux des titres de TEST (modèle entraîné sur "dev")
async function evaluate(ctx) {
  const { gem, dev, test, scored, profGlobal, rank, explain } = ctx;
  try {
    if (!gem || !gem.available) return { skipped: 'Gemini indisponible ou désactivé' };
    const left = typeof gem._quotaLeft === 'function' ? gem._quotaLeft() : 99;
    if (left < 3) return { skipped: `quota quotidien Gemini insuffisant (${left} requête(s) restante(s), il en faut 3)` };
    const namer = makeNamer([...dev, ...test].map((i) => i.rec));
    const pick = (arr, n) => arr.slice().sort((a, b) => b.lw - a.lw || (a.key < b.key ? -1 : 1)).slice(0, n).map((i) => i.rec);
    const trait = explain ? explain(profGlobal, namer) : { positive: [], negative: [] };
    // 1) ADN construit UNIQUEMENT sur les titres d'apprentissage
    const dnaRes = await gem.json(dnaPrompt({ loves: pick(dev.filter((i) => i.label === 2), 40), likes: pick(dev.filter((i) => i.label === 1), 30), rejects: pick(dev.filter((i) => i.label === 0 && i.rec.va >= 6.8), 40), positiveTraits: (trait.positive || []).map((x) => x.name), negativeTraits: (trait.negative || []).map((x) => x.name), recipes: [] }));
    if (!dnaRes || typeof dnaRes.adn !== 'string') return { error: 'ADN de mesure non obtenu (Gemini indisponible ou réponse illisible)' };
    const adn = String(dnaRes.adn).slice(0, 900), evite = [].concat(dnaRes.evite || []).slice(0, 8).map(String);
    // 2) titres de TEST, ordre pseudo-aléatoire reproductible, en lots de 100
    const items = scored.slice().sort((a, b) => hashInt('geval' + a.it.key) - hashInt('geval' + b.it.key)).slice(0, MAX_ITEMS);
    const got = new Map(); let batches = 0;
    for (let i = 0; i < items.length; i += BATCH) {
      const chunk = items.slice(i, i + BATCH); const byId = new Map();
      const cards = chunk.map((s, j) => { const id = 't' + (i + j + 1); byId.set(id, s.it.key); const r = s.it.rec; return { id, titre: r.t, annee: r.y, genres: (r.gn || []).slice(0, 4), mots_cles: (r.kw || []).slice(0, 7).map((k) => k[1]), synopsis: (r.ov || '').slice(0, 180) }; });
      const res = await gem.json(evalPrompt({ adn, evite, candidats: cards })); batches++;
      const pe = parseEvaluations(res, byId);
      for (const [k, v] of pe.map) got.set(k, v);
    }
    const rows = items.filter((s) => got.has(s.it.key)).map((s) => ({ s, gm: got.get(s.it.key) }));
    if (rows.length < MIN_MATCHED) return { error: `réponse Gemini incomplète (${rows.length}/${items.length} titres évalués, minimum ${MIN_MATCHED}) : mesure non concluante`, calls: batches + 1 };
    const y = { pos: rows.map((r) => (r.s.it.label > 0 ? 1 : 0)), love: rows.map((r) => (r.s.it.label === 2 ? 1 : 0)) };
    const local = { love: rows.map((r) => utilityOf(r.s.b, rank)), pos: rows.map((r) => r.s.b.pPos) };
    const gemi = { love: rows.map((r) => r.gm.fit), pos: rows.map((r) => r.gm.fit - 0.5 * r.gm.risk) };
    const rk = { lLove: rankNorm(local.love), gLove: rankNorm(gemi.love), lPos: rankNorm(local.pos), gPos: rankNorm(gemi.pos) };
    const blend = (a, b, w) => a.map((v, i) => (1 - w) * v + w * b[i]);
    const table = WEIGHTS.map((w) => {
      const sl = blend(rk.lLove, rk.gLove, w), sp = blend(rk.lPos, rk.gPos, w);
      return { poidsGemini: w, aucCoupDeCoeur: r4(ml.auc(sl, y.love)), aucApprecie: r4(ml.auc(sp, y.pos)), top20: top(sl, y, 20) };
    });
    const base = table[0], gemOnly = table[table.length - 1];
    // meilleur poids : plus grande AUC "coup de cœur" ; à moins de 0,005 près, on préfère le poids le plus faible
    let best = table[0]; for (const t of table) if (t.aucCoupDeCoeur > best.aucCoupDeCoeur + 0.005) best = t;
    // intervalles de confiance à 95 % (rééchantillonnage) pour l'AUC locale, l'AUC de Gemini seul et le gain du meilleur mélange
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
    if (best.poidsGemini === 0) verdict = 'Gemini n\'apporte pas de gain mesurable sur ces titres : son influence dans le classement doit rester faible.';
    else if (icDiff && icDiff[0] > 0) verdict = `Gemini améliore le classement de façon significative (gain d'AUC ${diff.toFixed(3)}, intervalle à 95 % ${icDiff[0]} à ${icDiff[1]}) : poids conseillé ${Math.round(best.poidsGemini * 100)} %.`;
    else verdict = `Tendance positive (gain d'AUC ${diff.toFixed(3)} au poids ${Math.round(best.poidsGemini * 100)} %) mais NON concluante avec ${n} titres : l'intervalle à 95 % inclut zéro.`;
    // désaccords les plus parlants (pour comprendre où Gemini se trompe / où le modèle local se trompe)
    const lab = (l) => (l === 2 ? '❤️ Love' : l === 1 ? '👍 Like' : 'vu sans note');
    const dis = rows.map((r, i) => ({ titre: r.s.it.rec.t, annee: r.s.it.rec.y, reel: lab(r.s.it.label), gemini: Math.round(r.gm.fit), rangLocalPct: Math.round(rk.lLove[i] * 100), note: r.gm.note || undefined }));
    const gemTropOptimiste = dis.filter((d) => d.reel === 'vu sans note').sort((a, b) => b.gemini - a.gemini).slice(0, 6);
    const gemTropSevere = dis.filter((d) => d.reel === '❤️ Love').sort((a, b) => a.gemini - b.gemini).slice(0, 6);
    return {
      at: new Date().toISOString(), model: gem.model || null, titresEvalues: n, lots: batches, requetesGemini: batches + 1,
      protocole: 'ADN régénéré sur les titres d\'apprentissage seulement ; Gemini note des titres de test sans voir le score local',
      aucCoupDeCoeur: { local: base.aucCoupDeCoeur, geminiSeul: gemOnly.aucCoupDeCoeur, ic95Local: ic(A), ic95GeminiSeul: ic(B) },
      aucApprecie: { local: base.aucApprecie, geminiSeul: gemOnly.aucApprecie },
      melanges: table, meilleur: { poidsGemini: best.poidsGemini, gainAuc: r4(diff), ic95Gain: icDiff },
      poidsActuelEnProduction: 0.35, verdict, adnDeMesure: adn.slice(0, 300), desaccords: { geminiTropOptimiste: gemTropOptimiste, geminiTropSevere: gemTropSevere }
    };
  } catch (e) { return { error: String(e && e.message || e).slice(0, 160) }; }
}

module.exports = { evaluate, rankNorm, WEIGHTS };
