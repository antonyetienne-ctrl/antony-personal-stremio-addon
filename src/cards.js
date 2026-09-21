'use strict';
// FICHES DESCRIPTIVES DE CONTENU — MESURE SEULEMENT (aucun effet sur les listes).
// Gemini décrit chaque titre de l'historique UNE FOIS avec 17 critères notés de 0 à 10 + une note de confiance ; les fiches sont mises en cache (Upstash, un document partagé).
// Quand 90 % de l'historique a une fiche, un calcul mesure si AJOUTER ces critères comme caractéristiques du modèle améliore la prédiction sur les MÊMES titres de test
// (avec / sans, mêmes procédures, intervalle de confiance par tirages appariés). Rien n'est appliqué au classement : la version suivante décidera d'après les chiffres.
const { clock, sleep, log, zurichDay, mulberry32 } = require('./util');
const { key } = require('./config');
const ml = require('./ml'); const model = require('./model'); const { Corpus } = require('./features');

const VERSION = 'c1';
const MIN_COVERAGE = 0.9;
const CRITERIA = [
  { k: 'sombre', label: 'ton sombre', def: '0 = lumineux, 10 = très sombre' },
  { k: 'humour', label: 'humour', def: '0 = aucun, 10 = comédie omniprésente' },
  { k: 'emotion', label: 'émotion', def: '0 = froid, 10 = très émouvant (drame personnel, larmes)' },
  { k: 'suspense', label: 'suspense et tension', def: '0 = aucun, 10 = tension constante' },
  { k: 'romance', label: 'romance', def: '0 = aucune, 10 = l\'intrigue amoureuse domine' },
  { k: 'action', label: 'action', def: '0 = aucune, 10 = action physique omniprésente' },
  { k: 'violence', label: 'violence', def: '0 = aucune, 10 = très violent ou âpre' },
  { k: 'rythme', label: 'rythme', def: '0 = très lent, 10 = très nerveux' },
  { k: 'complexite', label: 'complexité de l\'intrigue', def: '0 = très simple, 10 = nombreux fils entremêlés' },
  { k: 'realisme', label: 'réalisme', def: '0 = fantastique ou science-fiction pur, 10 = ancré dans le réel' },
  { k: 'epique', label: 'ampleur épique', def: '0 = histoire intime, 10 = fresque ou quête à grande échelle' },
  { k: 'univers', label: 'univers imaginaire développé', def: '0 = monde ordinaire, 10 = univers inventé riche' },
  { k: 'historique', label: 'contexte historique', def: '0 = époque actuelle, 10 = récit d\'époque' },
  { k: 'faitsReels', label: 'inspiré de faits réels', def: '0 = fiction pure, 10 = histoire vraie' },
  { k: 'public', label: 'public visé', def: '0 = enfants, 10 = adultes uniquement' },
  { k: 'introspection', label: 'introspection et psychologie', def: '0 = actions seulement, 10 = personnages très fouillés' },
  { k: 'feuilleton', label: 'feuilleton', def: 'séries seulement : 0 = épisodes indépendants, 10 = intrigue continue (films : 0)' }
];
const NC = CRITERIA.length;             // 17 ; le 18e caractère de la fiche = la confiance
const ALPHA = '0123456789a';           // 0..10 sur un caractère
const keyOf = (rec) => `${rec.k}${rec.i}`;

function cardPrompt(recs) {
  const items = recs.map((r) => JSON.stringify({ id: keyOf(r), type: r.k === 's' ? 'série' : 'film', titre: r.t || r.ot || '', annee: r.y || null, genres: (r.gn || []).slice(0, 5), motsCles: (r.kw || []).slice(0, 8).map((k) => k[1]), synopsis: String(r.ov || '').slice(0, 350), langue: r.ol || null, pays: (r.ct || []).slice(0, 2) }));
  return `FICHES_DESCRIPTIVES
Tu décris des films et des séries de façon OBJECTIVE pour une base de données. Pour chaque titre, note ces ${NC} critères par des ENTIERS de 0 à 10 :
${CRITERIA.map((c) => `- ${c.k} : ${c.def}`).join('\n')}
- confiance : 0 à 10 = à quel point tu connais réellement CE titre (10 = tu le connais bien, 0 = tu devines d'après le synopsis)

Règles : ne juge jamais la qualité ni le goût, décris seulement le contenu tel qu'il est. Appuie-toi sur ta connaissance du titre quand tu le connais vraiment ; sinon déduis du synopsis, des genres et des mots-clés et mets une confiance basse. Ne saute aucun critère. Réponds UNIQUEMENT par un objet JSON, sans texte autour ni balises :
{"fiches":[{"id":"…",${CRITERIA.map((c) => `"${c.k}":n`).join(',')},"confiance":n}]}

Titres (un par ligne) :
${items.join('\n')}`;
}
// obj -> Map id -> chaîne de 18 caractères ; fiche incomplète ou hors bornes : ignorée
function parseCards(obj, ids) {
  const out = new Map(); const want = new Set(ids); const list = obj && Array.isArray(obj.fiches) ? obj.fiches : Array.isArray(obj) ? obj : [];
  for (const f of list) {
    if (!f || typeof f.id !== 'string' || !want.has(f.id) || out.has(f.id)) continue;
    let s = '', bad = false;
    for (const c of CRITERIA) { let v = Number(f[c.k]); if (c.k === 'feuilleton' && !Number.isFinite(v)) v = 0; if (!Number.isFinite(v)) { bad = true; break; } s += ALPHA[Math.max(0, Math.min(10, Math.round(v)))]; }
    if (bad) continue;
    const conf = Number(f.confiance); s += ALPHA[Number.isFinite(conf) ? Math.max(0, Math.min(10, Math.round(conf))) : 5];
    out.set(f.id, s);
  }
  return out;
}
const valuesOf = (str) => Array.from(str, (ch) => ALPHA.indexOf(ch));

class CardStore {
  constructor(store) { this.store = store; this.map = new Map(); this.loaded = false; this.dirty = false; this.lastFlush = 0; }
  async load() {
    if (this.loaded) return true;
    if (!this.store.available) { this.loaded = true; return false; }
    const doc = await this.store.getJson(key.cards(VERSION), 'cards-load');
    if (doc === undefined) return false;                     // Upstash illisible : on retente plus tard, rien n'est écrasé
    if (doc && doc.cards) for (const [k, v] of Object.entries(doc.cards)) if (typeof v === 'string' && v.length === NC + 1) this.map.set(k, v);
    this.loaded = true; return true;
  }
  has(k) { return this.map.has(k); } get(k) { return this.map.get(k) || null; } get size() { return this.map.size; }
  set(k, v) { this.map.set(k, v); this.dirty = true; }
  async flush() {
    if (!this.dirty || !this.loaded || !this.store.available) return { skipped: true };
    const ok = await this.store.setJson(key.cards(VERSION), { v: VERSION, at: new Date(clock.now()).toISOString(), cards: Object.fromEntries(this.map) }, 'cards-save');
    if (ok) { this.dirty = false; this.lastFlush = clock.now(); } return { ok };
  }
}

// couverture de l'historique ; job.cards = { coverage, todo, stats, eval }
async function prepare({ cs, job, labeled }) {
  await cs.load();
  const total = labeled.length; const todo = labeled.filter((i) => !cs.has(keyOf(i.rec))).map((i) => keyOf(i.rec)); const have = total - todo.length;
  const coverage = total ? Math.round((have / total) * 1e4) / 1e4 : 0;
  job.cards = { ...(job.cards || {}), version: VERSION, coverage: { historique: coverage, titres: have, total }, todo };
  return { cardsOf: (rec) => cs.get(keyOf(rec)), coverage, on: coverage >= MIN_COVERAGE && cs.loaded };
}

// génération par lots (séquentielle, cadencée, sauvegardée) ; ne dépasse jamais le plafond quotidien de Gemini (une réserve reste pour le calcul)
async function generate({ cs, gem, recs, budgetMs = 180000, batch = Number(process.env.CARDS_BATCH || 25), minIntervalMs = Number(process.env.CARDS_MIN_INTERVAL_MS || 5000), reserve = Number(process.env.CARDS_RESERVE_CALLS || 40) }) {
  const t0 = clock.now(); const res = { requested: 0, added: 0, failed: 0, batches: 0, stop: null };
  const pending = recs.filter((r) => !cs.has(keyOf(r)));
  let consecFails = 0;
  for (let i = 0; i < pending.length; i += batch) {
    if (clock.now() - t0 > budgetMs) { res.stop = 'délai de la passe atteint'; break; }
    if (!gem || !gem.available) { res.stop = 'Gemini indisponible (pause ou plafond du jour)'; break; }
    if (gem._quotaLeft() <= reserve) { res.stop = 'réserve quotidienne de Gemini préservée pour le calcul'; break; }
    const group = pending.slice(i, i + batch); res.requested += group.length; res.batches++;
    let obj = null; try { obj = await gem.json(cardPrompt(group), { timeoutMs: 90000, maxTokens: 12000 }); } catch { obj = null; }
    const got = parseCards(obj, group.map(keyOf));
    if (!got.size) { res.failed += group.length; consecFails++; if (consecFails >= 3) { res.stop = '3 lots de suite sans fiche exploitable'; break; } }
    else { consecFails = 0; for (const [k, v] of got) cs.set(k, v); res.added += got.size; res.failed += group.length - got.size; }
    if (res.batches % 3 === 0) await cs.flush();
    if (minIntervalMs > 0 && i + batch < pending.length) await sleep(minIntervalMs);
  }
  await cs.flush(); res.remaining = recs.filter((r) => !cs.has(keyOf(r))).length; return res;
}

const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))]; };
function pairedBootstrap(y, sBase, sNew, B = 300) {
  const rnd = mulberry32(11), n = y.length, diffs = [];
  for (let b = 0; b < B; b++) {
    const idx = Array.from({ length: n }, () => Math.floor(rnd() * n)); const yy = idx.map((i) => y[i]); if (new Set(yy).size < 2) continue;
    diffs.push(ml.auc(idx.map((i) => sNew[i]), yy) - ml.auc(idx.map((i) => sBase[i]), yy));
  }
  return diffs.length ? [+q(diffs, 0.025).toFixed(4), +q(diffs, 0.975).toFixed(4)] : [null, null];
}
// Mesure : le modèle entraîné AVEC les critères (mêmes titres d'apprentissage/de test, même variante, même mélange 70/30, même classement final) contre le modèle de production (`scored`).
async function evaluate({ dev, test, scored, rank, risk, cfg, cardsOf, yielder }) {
  const t0 = clock.now(); const { utilityOf, blendScores, scoreProfile } = model;
  const aug = (it) => { const cd = cardsOf(it.rec); return cd ? { ...it, rec: { ...it.rec, cd } } : it; };
  const devA = dev.map(aug), testA = test.map(aug); const withCard = { dev: devA.filter((i) => i.rec.cd).length, test: testA.filter((i) => i.rec.cd).length };
  const corpus2 = new Corpus([...devA, ...testA].map((i) => i.rec));
  const profG = await model.trainProfile(devA, cfg, corpus2, yielder); const byK = {};
  for (const k of ['m', 's']) { const d = devA.filter((i) => i.rec.k === k); byK[k] = d.filter((i) => i.label > 0).length >= 10 && d.filter((i) => i.label === 0).length >= 10 ? await model.trainProfile(d, cfg, corpus2, yielder) : null; }
  const rows = testA.map((it) => { const g = scoreProfile(profG, it); const t = byK[it.rec.k] ? scoreProfile(byK[it.rec.k], it) : g; return blendScores(t, g); });
  const uNew = rows.map((b) => utilityOf(b, rank) - risk.kappa * b.sigma - risk.rho * b.fp), uBase = scored.map((s) => utilityOf(s.b, rank) - risk.kappa * s.b.sigma - risk.rho * s.b.fp);
  const yLove = test.map((i) => (i.label === 2 ? 1 : 0)), yPos = test.map((i) => (i.label > 0 ? 1 : 0));
  const pNew = rows.map((b) => b.pPos), pBase = scored.map((s) => s.b.pPos);
  const r4 = (x) => +x.toFixed(4);
  const base = { aucCoupDeCoeur: r4(ml.auc(uBase, yLove)), aucApprecie: r4(ml.auc(pBase, yPos)) }, neu = { aucCoupDeCoeur: r4(ml.auc(uNew, yLove)), aucApprecie: r4(ml.auc(pNew, yPos)) };
  const gain = { aucCoupDeCoeur: r4(neu.aucCoupDeCoeur - base.aucCoupDeCoeur), aucApprecie: r4(neu.aucApprecie - base.aucApprecie) };
  const ic = pairedBootstrap(yLove, uBase, uNew), icPos = pairedBootstrap(yPos, pBase, pNew);
  const top = (u) => { const idx = u.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).slice(0, 20).map((x) => x[1]); return idx.length ? r4(idx.filter((i) => yLove[i]).length / idx.length) : null; };
  const verdict = gain.aucCoupDeCoeur >= 0.01 && ic[0] !== null && ic[0] > 0 ? `Gain net (${gain.aucCoupDeCoeur >= 0 ? '+' : ''}${gain.aucCoupDeCoeur} d'AUC ❤️, intervalle à 95 % au-dessus de zéro) : les fiches méritent d'être étendues aux candidats.`
    : gain.aucCoupDeCoeur > 0 ? `Tendance positive (${gain.aucCoupDeCoeur >= 0 ? '+' : ''}${gain.aucCoupDeCoeur} d'AUC ❤️) mais NON concluante : l'intervalle à 95 % inclut zéro.` : `Aucun gain (${gain.aucCoupDeCoeur} d'AUC ❤️) : les fiches n'améliorent pas la prédiction.`;
  // critères qui comptent (poids du modèle linéaire, variables continues « x:<critère> »)
  let criteres = null;
  try {
    const A = profG.task1.base.A; const label = new Map(CRITERIA.map((c) => [c.k, c.label])); const arr = [];
    for (const [k, j] of A.dict) { const m = /^x:([a-zA-Z]+)$/.exec(k); if (m && label.has(m[1])) arr.push({ critere: label.get(m[1]), poids: r4(A.m.wS[j]) }); }
    arr.sort((a, b) => b.poids - a.poids); criteres = { positifs: arr.filter((x) => x.poids > 0.02).slice(0, 6), negatifs: arr.filter((x) => x.poids < -0.02).slice(-6).reverse() };
  } catch { criteres = null; }
  const confs = testA.concat(devA).filter((i) => i.rec.cd).map((i) => ALPHA.indexOf(i.rec.cd[NC])); 
  return { at: new Date(clock.now()).toISOString(), critères: NC, titresAvecFiche: withCard, testTitres: test.length, confianceMoyenne: confs.length ? +(confs.reduce((a, b) => a + b, 0) / confs.length).toFixed(1) : null,
    sans: base, avec: neu, gain, ic95GainCoupDeCoeur: ic, ic95GainApprecie: icPos, top20TauxCoeur: { sans: top(uBase), avec: top(uNew) }, criteresLesPlusLies: criteres, verdict, appliqueAuClassement: false, ms: clock.now() - t0 };
}

module.exports = { VERSION, MIN_COVERAGE, CRITERIA, NC, keyOf, cardPrompt, parseCards, valuesOf, CardStore, prepare, generate, evaluate, pairedBootstrap };
