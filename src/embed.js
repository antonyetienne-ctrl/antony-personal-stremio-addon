'use strict';
// EMBEDDINGS SÉMANTIQUES (Gemini). Un embedding représente le SENS d'un synopsis par un vecteur de 256 nombres : deux titres à l'histoire proche ont des vecteurs proches.
// Sert à trois choses, TOUTES mesurées par le backtest avant d'être adoptées (jamais de changement automatique sans gain mesuré) :
//  1) trouver de VRAIS voisins (titres adorés / non aimés les plus proches) pour la comparaison Gemini, à la place des voisins « genres + mots-clés » ;
//  2) un score par voisins sémantiques (kNN) mélangé au modèle local, poids choisi sur les titres de test ;
//  3) comparer objectivement les deux façons de trouver des voisins sur TOUT l'historique (validation « un contre tous », plus de 1 300 titres).
// Contraintes : plan gratuit (cadence et plafond quotidien), tout est mis en CACHE (Upstash, vecteurs quantifiés sur 8 bits), vectorisation étalée sur plusieurs calculs si besoin,
// aucune erreur ne bloque le calcul : sans embeddings on retombe exactement sur le comportement précédent.
const { fetchJson, clock, sleep, log, zurichDay, hashInt, mulberry32, sha } = require('./util');
const { fnv } = require('./features');
const { key } = require('./config');
const ml = require('./ml');

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DIM = () => Number(process.env.EMBED_DIM || 256);
const MODELS = () => (process.env.GEMINI_EMBED_MODEL ? [process.env.GEMINI_EMBED_MODEL] : ['gemini-embedding-001', 'gemini-embedding-2']);
const SHARDS = 12;
const MIN_COVERAGE = 0.9;                      // part minimale de l'historique vectorisé pour utiliser les embeddings
const K_NEIGHBORS = 12, TAU_EMB = 0.04, TAU_HASH = 0.08, PRIOR_W = 0.7;
const TOP_CANDIDATES = 250;                    // candidats vectorisés par type (les mieux classés par le modèle local)

// ---------- texte à vectoriser (français : c'est la langue des synopsis) ----------
function embeddingText(rec) {
  const lines = [`${rec.k === 's' ? 'Série' : 'Film'} : ${rec.t}${rec.y ? ` (${rec.y})` : ''}`];
  if (rec.gn && rec.gn.length) lines.push(`Genres : ${rec.gn.join(', ')}`);
  if (rec.ov) lines.push(String(rec.ov));
  const kws = (rec.kw || []).slice(0, 12).map((k) => k[1]).filter(Boolean);
  if (kws.length) lines.push(`Mots-clés : ${kws.join(', ')}`);
  return lines.join('\n').slice(0, 1800);
}
const idOf = (rec) => `${rec.k}${rec.i}`;
const hashOfText = (text) => fnv(text);

// ---------- vecteurs : normalisation, quantification 8 bits (échelle propre à chaque vecteur) ----------
function normalize(v) { let n = 0; for (let i = 0; i < v.length; i++) n += v[i] * v[i]; n = Math.sqrt(n) || 1; for (let i = 0; i < v.length; i++) v[i] /= n; return v; }
function quantize(v) {
  let m = 0; for (let i = 0; i < v.length; i++) m = Math.max(m, Math.abs(v[i]));
  const s = m || 1; const q = new Int8Array(v.length); for (let i = 0; i < v.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round(v[i] / s * 127)));
  return { s, b64: Buffer.from(q.buffer, q.byteOffset, q.byteLength).toString('base64') };
}
function dequantize(s, b64) {
  const buf = Buffer.from(b64, 'base64'); const q = new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength); const v = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) v[i] = q[i] * s / 127;
  return normalize(v);
}

// ---------- stockage persistant (Upstash) : lecture UNIQUE partagée, pause après un échec, jamais d'écrasement d'un cache illisible ----------
class EmbedStore {
  constructor({ store, model, dim }) {
    this.store = store; this.model = model; this.dim = dim; this.tag = `${model}:${dim}`;
    this.ram = new Map();                       // id -> { h, s, b64, v? }
    this.loaded = false; this.canFlush = false; this.dirty = new Set(); this._p = null; this._failAt = 0;
  }
  shardOf(id) { return fnv(id) % SHARDS; }
  async load() {
    if (this.loaded) return true;
    if (!this.store.enabled) { this.loaded = true; this.canFlush = false; return false; }
    if (this._p) return this._p;
    if (this._failAt && clock.now() - this._failAt < 60000) return false;
    this._p = (async () => {
      const keys = []; for (let s = 0; s < SHARDS; s++) keys.push(key.emb(this.tag, s));
      const res = await this.store.getManyJson(keys, 'embed-load');
      if (res === undefined || res.some((r) => r === undefined)) { this._failAt = clock.now(); this.canFlush = false; log('warn', 'Cache des embeddings illisible (Upstash) : vectorisation en mémoire seulement, sans écraser l\'existant'); return false; }
      for (const blob of res) if (blob && typeof blob === 'object') for (const [id, e] of Object.entries(blob)) if (Array.isArray(e) && e.length === 3 && !this.ram.has(id)) this.ram.set(id, { h: e[0], s: e[1], b64: e[2] });
      this.loaded = true; this.canFlush = true; return true;
    })().catch(() => false).finally(() => { this._p = null; });
    return this._p;
  }
  has(id, h) { const e = this.ram.get(id); return Boolean(e) && (h === undefined || e.h === h); }
  vec(id) { const e = this.ram.get(id); if (!e) return null; if (!e.v) e.v = dequantize(e.s, e.b64); return e.v; }
  put(id, h, v) { const q = quantize(v); this.ram.set(id, { h, s: q.s, b64: q.b64, v: dequantize(q.s, q.b64) }); this.dirty.add(this.shardOf(id)); }
  get size() { return this.ram.size; }
  async flush() {
    if (!this.store.enabled || !this.canFlush || !this.dirty.size) return { written: 0 };
    const by = new Map(); for (const sh of this.dirty) by.set(sh, {});
    for (const [id, e] of this.ram) { const sh = this.shardOf(id); if (by.has(sh)) by.get(sh)[id] = [e.h, +e.s.toFixed(6), e.b64]; }
    const ok = await this.store.setManyJson([...by].map(([sh, obj]) => [key.emb(this.tag, sh), obj]), 'embed-flush');
    if (ok) this.dirty.clear();
    return { written: ok ? by.size : 0, ok };
  }
}

// ---------- appels à l'API (cadence, plafond quotidien, repli automatique) ----------
class Embedder {
  constructor({ key: apiKey, dim = DIM(), calls = null, minIntervalMs = Number(process.env.EMBED_MIN_INTERVAL_MS ?? 4500), maxBatch = Number(process.env.EMBED_BATCH || 100),
    maxPerDay = Number(process.env.EMBED_MAX_CALLS_PER_DAY || 300), minBatch = 8, backoffMs = Number(process.env.EMBED_BACKOFF_MS ?? 65000), model = null } = {}) {
    this.key = apiKey; this.dim = dim; this.model = model; this.minIntervalMs = minIntervalMs; this.maxBatch = maxBatch; this.minBatch = minBatch; this.maxPerDay = maxPerDay; this.backoff0 = backoffMs;
    this.calls = calls && calls.day === zurichDay() ? { ...calls } : { day: zurichDay(), count: 0 };
    this.batch = maxBatch; this.nextAt = 0; this.okStreak = 0; this.consec429 = 0; this.consecErr = 0; this.backoffMs = backoffMs; this.pausedUntil = 0;
    this.stats = { requests: 0, ok: 0, rate429: 0, errors: 0, texts: 0 }; this.lastError = null;
  }
  quotaLeft() { if (this.calls.day !== zurichDay()) this.calls = { day: zurichDay(), count: 0 }; return this.maxPerDay - this.calls.count; }
  get available() { return Boolean(this.key) && this.quotaLeft() > 0 && clock.now() >= this.pausedUntil; }
  async _post(model, texts) {
    const res = await fetchJson(`${BASE}/models/${model}:batchEmbedContents`, {
      method: 'POST', headers: { 'x-goog-api-key': this.key, 'content-type': 'application/json' }, timeoutMs: 60000, retries: 0, label: 'gemini-embed',
      body: JSON.stringify({ requests: texts.map((t) => ({ model: `models/${model}`, content: { parts: [{ text: t }] }, taskType: 'SEMANTIC_SIMILARITY', outputDimensionality: this.dim })) })
    });
    const list = res && res.embeddings;
    if (!Array.isArray(list) || list.length !== texts.length) throw Object.assign(new Error('réponse d\'embeddings incomplète'), { status: 502 });
    return list.map((e) => {
      const vals = e && (e.values || (e.embedding && e.embedding.values));
      if (!Array.isArray(vals) || vals.length < this.dim) throw Object.assign(new Error('vecteur invalide'), { status: 502 });
      return normalize(Float32Array.from(vals.slice(0, this.dim)));                    // modèles à représentation emboîtée : la troncature est valide
    });
  }
  // choisit le premier modèle utilisable (1 requête) ; renvoie son nom ou null
  async probe() {
    for (const m of MODELS()) {
      if (!this.available) return null;
      try { this.calls.count++; this.stats.requests++; await this._post(m, ['test']); this.stats.ok++; this.model = m; return m; }
      catch (e) {
        this._err(e);
        if (e.status === 429) { this.model = m; return m; }                            // le modèle existe, seule la cadence est en cause
        if (![400, 404].includes(e.status)) return null;
      }
    }
    return null;
  }
  _err(e) { this.stats.errors++; this.lastError = { at: new Date(clock.now()).toISOString(), status: e.status || null, message: String(e.message || e).slice(0, 140) }; }
  // list : [{id, text, h}] -> vectorise et range dans `es` ; s'arrête au délai (deadline, ms absolus) ; cadence et gestion de quota adaptatives
  async run(list, { es, deadline, onProgress } = {}) {
    const res = { embedded: 0, requests: 0, stop: null }; let i = 0;
    while (i < list.length) {
      if (!this.available) { res.stop = this.quotaLeft() <= 0 ? 'plafond quotidien atteint' : 'pause (quota ou erreur récente)'; break; }
      const wait = Math.max(0, this.nextAt - clock.now());
      if (clock.now() + wait > deadline) { res.stop = 'délai du calcul atteint'; break; }
      if (wait) await sleep(wait);
      const chunk = list.slice(i, i + this.batch);
      try {
        this.calls.count++; this.stats.requests++; res.requests++;
        const vecs = await this._post(this.model, chunk.map((x) => x.text));
        chunk.forEach((x, j) => es.put(x.id, x.h, vecs[j]));
        i += chunk.length; res.embedded += chunk.length; this.stats.ok++; this.stats.texts += chunk.length;
        this.okStreak++; this.consec429 = 0; this.consecErr = 0; this.backoffMs = this.backoff0;
        if (this.okStreak >= 3 && this.batch < this.maxBatch) this.batch = Math.min(this.maxBatch, this.batch * 2);
        this.nextAt = clock.now() + this.minIntervalMs;
      } catch (e) {
        this._err(e);
        if (e.status === 429) {                                                        // quota : on réduit la taille des lots et on attend (recul exponentiel)
          this.stats.rate429++; this.consec429++; this.okStreak = 0; this.batch = Math.max(this.minBatch, Math.floor(this.batch / 2));
          this.nextAt = clock.now() + this.backoffMs; this.backoffMs = Math.min(this.backoffMs * 2, 300000);
          if (this.consec429 >= 4) { this.pausedUntil = clock.now() + 30 * 60e3; res.stop = 'quota dépassé (429 répétés) : reprise au prochain calcul'; break; }
        } else if ([400, 401, 403, 404].includes(e.status)) { this.pausedUntil = clock.now() + 60 * 60e3; res.stop = `refus de l'API (${e.status})`; break; }
        else { this.consecErr++; if (this.consecErr >= 2) { this.pausedUntil = clock.now() + 10 * 60e3; res.stop = 'API indisponible'; break; } this.nextAt = clock.now() + 8000; }
      }
      if (onProgress) onProgress(i, list.length);
    }
    res.remaining = list.length - i; return res;
  }
}

// ---------- voisins et score par voisins ----------
function dotF(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
// pool : [{ key, v, label, rec }] -> k plus proches (similarité cosinus), hors `skipKey`
function topK(v, pool, k, skipKey) {
  const best = [];
  for (let j = 0; j < pool.length; j++) {
    const p = pool[j]; if (p.key === skipKey) continue;
    const s = dotF(v, p.v);
    if (best.length < k) { best.push([s, j]); if (best.length === k) best.sort((a, b) => a[0] - b[0]); }
    else if (s > best[0][0]) { best[0] = [s, j]; let m = 0; while (m + 1 < k && best[m][0] > best[m + 1][0]) { const t = best[m]; best[m] = best[m + 1]; best[m + 1] = t; m++; } }
  }
  return best.sort((a, b) => b[0] - a[0] || (pool[a[1]].key < pool[b[1]].key ? -1 : 1)).map(([sim, j]) => ({ sim, item: pool[j] }));
}
function priorOf(pool) { const n = pool.length || 1; return { pos: pool.filter((p) => p.label > 0).length / n, love: pool.filter((p) => p.label === 2).length / n }; }
function knnProbs(v, pool, { k = K_NEIGHBORS, tau = TAU_EMB, prior, skipKey } = {}) {
  const nb = topK(v, pool, k, skipKey); if (!nb.length) return null;
  const s1 = nb[0].sim; let sw = 0, sp = 0, sl = 0;
  for (const { sim, item } of nb) { const w = Math.exp((sim - s1) / tau); sw += w; if (item.label > 0) sp += w; if (item.label === 2) sl += w; }
  return { pPos: (sp + PRIOR_W * prior.pos) / (sw + PRIOR_W), pLove: (sl + PRIOR_W * prior.love) / (sw + PRIOR_W), top: s1 };
}
const uKnn = (p, beta) => p.pLove + beta * Math.max(0, p.pPos - p.pLove);          // même forme que l'utilité du modèle local
const cardOf = (rec) => ({ titre: rec.t, annee: rec.y, genres: (rec.gn || []).slice(0, 3), mots_cles: (rec.kw || []).slice(0, 3).map((x) => x[1]) });
function neighborCards(v, lovedPool, rejPool, k = 3) { return { adores: topK(v, lovedPool, k).map((n) => cardOf(n.item.rec)), non_aimes: topK(v, rejPool, k).map((n) => cardOf(n.item.rec)) }; }
function makeNeighborsFor(vecOf) {                                                   // voisins sémantiques d'un titre de test (pools mémorisés) ; null si le titre n'a pas de vecteur
  let src = null, L = null, R = null;
  return (it, lovedDev, rejDev) => { const v = vecOf(it.rec); if (!v) return null; if (src !== lovedDev) { src = lovedDev; L = poolOf(lovedDev, (i) => vecOf(i.rec)); R = poolOf(rejDev, (i) => vecOf(i.rec)); } return neighborCards(v, L, R); };
}
const poolOf = (items, vecOf) => items.map((i) => ({ key: i.key, v: vecOf(i), label: i.label, rec: i.rec })).filter((p) => p.v);

// ---------- évaluation : voisins sémantiques contre voisins « genres + mots-clés » (validation un-contre-tous sur l'historique) ----------
const r4 = (x) => Math.round(x * 1e4) / 1e4;
async function evaluateSpaces({ items, embOf, beta, gate, cap = 1000 }) {
  const pe = poolOf(items.filter((i) => i.vec), (i) => embOf(i.rec)); const keyed = new Set(pe.map((p) => p.key));
  const sub = items.filter((i) => i.vec && keyed.has(i.key));
  const poolE = pe.map((p) => p); const poolH = sub.map((i) => ({ key: i.key, v: i.vec, label: i.label, rec: i.rec }));
  const priorE = priorOf(poolE), priorH = priorOf(poolH);
  const sample = sub.length > cap ? sub.slice().sort((a, b) => hashInt('loo' + a.key) - hashInt('loo' + b.key)).slice(0, cap) : sub;
  const uE = [], uH = [], yL = [], yP = []; const embByKey = new Map(poolE.map((p) => [p.key, p.v]));
  let n = 0;
  for (const it of sample) {
    const pe1 = knnProbs(embByKey.get(it.key), poolE, { tau: TAU_EMB, prior: priorE, skipKey: it.key }), ph1 = knnProbs(it.vec, poolH, { tau: TAU_HASH, prior: priorH, skipKey: it.key });
    if (!pe1 || !ph1) continue;
    uE.push(uKnn(pe1, beta)); uH.push(uKnn(ph1, beta)); yL.push(it.label === 2 ? 1 : 0); yP.push(it.label > 0 ? 1 : 0);
    if (gate && ++n % 25 === 0) await gate();
  }
  if (uE.length < 60) return { skipped: `trop peu de titres vectorisés (${uE.length})` };
  return { n: uE.length, poolSize: poolE.length, emb: { aucCoupDeCoeur: r4(ml.auc(uE, yL)), aucApprecie: r4(ml.auc(uE, yP)) }, hash: { aucCoupDeCoeur: r4(ml.auc(uH, yL)), aucApprecie: r4(ml.auc(uH, yP)) } };
}

// ---------- évaluation : poids du score par voisins sémantiques dans le classement local (titres de TEST, voisins pris dans l'apprentissage seulement) ----------
async function evaluateBlend({ dev, test, scores, embOf, beta, gate, grid = [0, 0.1, 0.2, 0.3, 0.4] }) {
  const pool = poolOf(dev, (i) => embOf(i.rec)); if (pool.length < 30) return { skipped: 'historique d\'apprentissage trop peu vectorisé', chosenWk: 0 };
  const prior = priorOf(pool); const rows = [];
  for (const it of test) {
    const u = scores.get(it.key), v = embOf(it.rec); if (u === undefined || !v) continue;
    const p = knnProbs(v, pool, { tau: TAU_EMB, prior }); if (!p) continue;
    rows.push({ y: it.label, u, k: uKnn(p, beta) });
    if (gate && rows.length % 25 === 0) await gate();
  }
  if (rows.length < 60) return { skipped: `trop peu de titres de test vectorisés (${rows.length})`, chosenWk: 0 };
  const yL = rows.map((r) => (r.y === 2 ? 1 : 0)), yP = rows.map((r) => (r.y > 0 ? 1 : 0));
  const top = (s) => { const idx = ml.topK(s, Math.min(20, s.length)); return { precision: +(idx.reduce((a, i) => a + yP[i], 0) / idx.length).toFixed(3), loveRate: +(idx.reduce((a, i) => a + yL[i], 0) / idx.length).toFixed(3) }; };
  const table = grid.map((wk) => { const s = rows.map((r) => (1 - wk) * r.u + wk * r.k); return { poidsEmbeddings: wk, aucCoupDeCoeur: r4(ml.auc(s, yL)), aucApprecie: r4(ml.auc(s, yP)), top20: top(s) }; });
  const base = table[0]; let best = base; for (const t of table.slice(1)) if (t.aucCoupDeCoeur >= best.aucCoupDeCoeur + 0.006) best = t;
  const rnd = mulberry32(hashInt('embboot' + rows.length)); const n = rows.length; const gains = [];
  const sBase = rows.map((r) => r.u), sBest = rows.map((r) => (1 - best.poidsEmbeddings) * r.u + best.poidsEmbeddings * r.k);
  for (let b = 0; b < 200; b++) { const ix = Array.from({ length: n }, () => Math.floor(rnd() * n)); const yy = ix.map((i) => yL[i]); if (new Set(yy).size < 2) continue; gains.push(ml.auc(ix.map((i) => sBest[i]), yy) - ml.auc(ix.map((i) => sBase[i]), yy)); }
  gains.sort((a, b) => a - b); const ic = gains.length ? [r4(gains[Math.floor(gains.length * 0.025)]), r4(gains[Math.floor(gains.length * 0.975)])] : [0, 0];
  const gain = r4(best.aucCoupDeCoeur - base.aucCoupDeCoeur);
  const adopt = best.poidsEmbeddings > 0 && gain >= 0.01 && ic[0] > -0.01;
  return { n, table, meilleur: { poidsEmbeddings: best.poidsEmbeddings, gainAuc: gain, ic95Gain: ic }, adopte: adopt, chosenWk: adopt ? best.poidsEmbeddings : 0,
    verdict: adopt ? `Gain d'AUC ${gain} au poids ${Math.round(best.poidsEmbeddings * 100)} % : adopté.` : best.poidsEmbeddings > 0 ? `Gain d'AUC ${gain} (${gain < 0.01 ? 'trop faible' : 'incertain'}) : non adopté, le classement local reste inchangé.` : 'Aucun gain mesurable : le classement local reste inchangé.' };
}

// ---------- application au classement des candidats : mélange (1 − wk) × utilité locale + wk × utilité par voisins ----------
function applyBlend(scored, { wk, pool, beta, vecOf, topN = TOP_CANDIDATES, minCoverage = MIN_COVERAGE }) {
  const N = Math.min(topN, scored.length); if (!N || !pool.length) return { applied: false, coverage: 0, N };
  const prior = priorOf(pool); const upd = [];
  for (let i = 0; i < N; i++) { const v = vecOf(scored[i].rec); if (!v) continue; const p = knnProbs(v, pool, { tau: TAU_EMB, prior }); if (p) upd.push([i, uKnn(p, beta), p]); }
  const coverage = upd.length / N;
  if (coverage < minCoverage) return { applied: false, coverage: r4(coverage), N };          // couverture insuffisante : classement local inchangé (jamais de mélange partiel incohérent)
  for (const [i, u, p] of upd) { const c = scored[i]; c.utilLocal = c.util; c.util = (1 - wk) * c.util + wk * u; c.knn = { pPos: r4(p.pPos), pLove: r4(p.pLove), top: r4(p.top) }; }
  scored.sort((a, b) => b.util - a.util || a.rec.i - b.rec.i);
  return { applied: true, coverage: r4(coverage), N };
}

// ---------- étape « embeddings » d'un calcul ----------
// Renvoie un contexte { enabled, es, embedder, coverage, useNeighbors, vecOf, ... } ; ne lève jamais.
async function prepare({ store, apiKey, allowed, job, labeled, gate, setStage, spaces, budgetMs = Number(process.env.EMBED_BUDGET_MS || 240000), embedderOpts = {}, force = false }) {
  const S = job.embed = job.embed || {};
  const off = (why) => { S.status = why; S.useNeighbors = false; return { enabled: false, useNeighbors: false, wk: 0, why }; };
  try {
    if (!allowed) return off('inactif : Gemini désactivé dans la configuration');
    if (!apiKey) return off('inactif : aucune clé Gemini enregistrée');
    const embedder = new Embedder({ key: apiKey, calls: S.calls, ...embedderOpts });
    if (S.pausedUntil && S.pausedUntil > clock.now()) embedder.pausedUntil = S.pausedUntil;
    if (!S.model) { S.model = await embedder.probe(); S.calls = embedder.calls; if (!S.model) { S.pausedUntil = embedder.pausedUntil || 0; return off(`indisponible : aucun modèle d'embeddings utilisable (${embedder.lastError ? embedder.lastError.message : 'clé sans accès'})`); } }
    embedder.model = S.model; S.dim = embedder.dim;
    const tag = `${S.model}:${embedder.dim}`; let es = spaces.get(tag); if (!es) { es = new EmbedStore({ store, model: S.model, dim: embedder.dim }); spaces.set(tag, es); }
    await es.load();
    // vectorisation de l'historique (étalée sur plusieurs calculs si le plan gratuit l'impose)
    const items = labeled.map((i) => ({ id: idOf(i.rec), text: embeddingText(i.rec), h: 0 })); items.forEach((x) => { x.h = hashOfText(x.text); });
    const need = items.filter((x) => !es.has(x.id, x.h));
    const run = { need: need.length, embedded: 0, requests: 0, stop: null };
    if (need.length) {
      setStage && setStage(`vectorisation de l'historique (${need.length} titres)`);
      const t0 = clock.now(); const r = await embedder.run(need, { es, deadline: t0 + budgetMs, onProgress: (d, t) => setStage && setStage(`vectorisation de l'historique (${d}/${t})`) });
      Object.assign(run, r, { ms: clock.now() - t0 }); await es.flush();
    }
    S.lastRun = { at: new Date(clock.now()).toISOString(), ...run }; S.calls = embedder.calls; S.stats = { ...embedder.stats }; S.lastError = embedder.lastError; S.pausedUntil = embedder.pausedUntil > clock.now() ? embedder.pausedUntil : 0; S.batch = embedder.batch;
    const vecOf = (rec) => es.vec(idOf(rec));
    const have = labeled.filter((i) => vecOf(i.rec)).length; const coverage = have / Math.max(1, labeled.length);
    S.coverage = { historique: r4(coverage), titres: have, total: labeled.length, cache: es.size };
    const ctx = { enabled: true, es, embedder, vecOf, coverage, useNeighbors: false, wk: 0, tag, S, gate };
    // comparaison des deux façons de trouver des voisins (mise en cache : refaite seulement si l'historique ou la couverture change)
    if (coverage >= 0.5) {
      const beta = (job.backtest && job.backtest.rank && job.backtest.rank.beta) || 0.33;
      const looKey = sha(`${tag}|${labeled.length}|${have}|${labeled.reduce((a, i) => (a + hashInt(i.key + i.label)) % 1e9, 0)}|${beta}`);
      if (S.looKey !== looKey || force || !S.loo) { setStage && setStage('embeddings : comparaison des voisins sur tout l\'historique'); S.loo = await evaluateSpaces({ items: labeled, embOf: vecOf, beta, gate }); S.looKey = looKey; }
      const L = S.loo;
      S.useNeighbors = Boolean(!L.skipped && coverage >= MIN_COVERAGE && L.emb.aucCoupDeCoeur >= L.hash.aucCoupDeCoeur - 0.005);
      S.neighborsVerdict = L.skipped ? L.skipped : coverage < MIN_COVERAGE ? `couverture ${Math.round(coverage * 100)} % < ${Math.round(MIN_COVERAGE * 100)} % : voisins « genres + mots-clés » conservés`
        : S.useNeighbors ? `voisins sémantiques adoptés (AUC ❤️ ${L.emb.aucCoupDeCoeur} contre ${L.hash.aucCoupDeCoeur})` : `voisins sémantiques non adoptés (AUC ❤️ ${L.emb.aucCoupDeCoeur} contre ${L.hash.aucCoupDeCoeur})`;
    } else { S.useNeighbors = false; S.neighborsVerdict = `couverture ${Math.round(coverage * 100)} % : voisins « genres + mots-clés » conservés`; }
    ctx.useNeighbors = S.useNeighbors; S.status = coverage >= MIN_COVERAGE ? 'actif' : `vectorisation en cours (${Math.round(coverage * 100)} %)`;
    return ctx;
  } catch (e) { log('warn', 'Embeddings indisponibles pour ce calcul', String(e && e.message || e).slice(0, 160)); return off(`erreur : ${String(e && e.message || e).slice(0, 120)}`); }
}

// Poids du score par voisins sémantiques : choisi sur les titres de test (résultat mis en cache tant que le backtest et l'historique sont identiques)
async function decideBlend({ ctx, job, labeled, testScores, split, beta, gate, force = false }) {
  const S = job.embed || {};
  const none = (why) => { S.wk = 0; S.blend = { skipped: why, chosenWk: 0 }; S.blendKey = null; return 0; };
  try {
    if (!ctx || !ctx.enabled) return 0;
    if (ctx.coverage < MIN_COVERAGE) return none(`couverture ${Math.round(ctx.coverage * 100)} % < ${Math.round(MIN_COVERAGE * 100)} % : classement local inchangé`);
    if (!Array.isArray(testScores) || !testScores.length) return none('scores de test indisponibles');
    const key2 = sha(`${S.looKey}|${job.backtest && job.backtest.key}|${beta}`);
    if (S.blendKey === key2 && S.blend && !force) return S.wk || 0;
    const scores = new Map(testScores.map((t) => [t[0], t[2]]));
    S.blend = await evaluateBlend({ dev: split.dev, test: split.test, scores, embOf: ctx.vecOf, beta, gate }); S.blendKey = key2; S.wk = S.blend.chosenWk || 0;
    return S.wk;
  } catch (e) { log('warn', 'Choix du poids des embeddings impossible', String(e && e.message || e).slice(0, 160)); return none(`erreur : ${String(e && e.message || e).slice(0, 100)}`); }
}

// Vectorise les candidats les mieux classés d'un type (budget de temps borné) ; ne lève jamais
async function ensureRecs(ctx, recs, { budgetMs = Number(process.env.EMBED_CAND_BUDGET_MS || 90000), setStage } = {}) {
  if (!ctx || !ctx.enabled) return { embedded: 0, skipped: true };
  try {
    const list = recs.map((r) => ({ id: idOf(r), text: embeddingText(r), h: 0 })); list.forEach((x) => { x.h = hashOfText(x.text); });
    const need = list.filter((x) => !ctx.es.has(x.id, x.h)); if (!need.length) return { embedded: 0, need: 0 };
    setStage && setStage(`vectorisation des candidats (${need.length})`);
    const t0 = clock.now(); const r = await ctx.embedder.run(need, { es: ctx.es, deadline: t0 + budgetMs });      // l'écriture Upstash se fait une seule fois en fin d'étape (ctx.es.flush)
    ctx.S.calls = ctx.embedder.calls; ctx.S.stats = { ...ctx.embedder.stats }; ctx.S.lastError = ctx.embedder.lastError; ctx.S.pausedUntil = ctx.embedder.pausedUntil > clock.now() ? ctx.embedder.pausedUntil : 0;
    return { need: need.length, ...r };
  } catch (e) { return { error: String(e && e.message || e).slice(0, 100) }; }
}

module.exports = { embeddingText, idOf, EmbedStore, Embedder, topK, knnProbs, uKnn, neighborCards, makeNeighborsFor, poolOf, priorOf, evaluateSpaces, evaluateBlend, applyBlend, prepare, decideBlend, ensureRecs, quantize, dequantize, normalize, MIN_COVERAGE, TOP_CANDIDATES };
