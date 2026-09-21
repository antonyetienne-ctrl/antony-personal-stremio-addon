'use strict';
// Représentation des œuvres. Aucun goût codé en dur : ce ne sont que des dimensions (genres, mots-clés, texte…)
// dont le modèle apprend les poids à partir des ❤️/👍/rejets de l'utilisateur.
const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const STOP = new Set(('le la les un une des du de d l et en a au aux ce cet cette ces son sa ses leur leurs qui que quoi dont ou pour par sur sous dans avec sans plus moins tres est sont etait etaient etre avoir ont il elle ils elles on nous vous je tu se ne pas y mais donc car ni si comme entre vers chez apres avant pendant alors aussi tout tous toute toutes meme autre autres ainsi lui eux ' +
  'the and with from that this into their they them have has for are was were his her its our your about after before through while where when will would there than then who what which how also more most some such only other first last new old').split(' ').map(norm));
const tokenize = (text) => norm(text).split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !STOP.has(t));

let RAW = new WeakMap();
const forgetRaw = (rec) => { RAW.delete(rec); }, clearRaw = () => { RAW = new WeakMap(); };      // caches recalculables : vidés après chaque candidat noté / sous pression mémoire
function rawFeatures(rec) {
  const sig = `${rec.ir}|${rec.iv}|${rec.pe ? rec.pe.length : ''}|${rec.rl === undefined ? '' : rec.rl + ':' + rec.rk}`;
  let hit = RAW.get(rec); if (hit && hit.sig === sig) return hit.f;
  const f = new Map();
  const add = (k, w) => f.set(k, (f.get(k) || 0) + w);
  for (const g of rec.g || []) add('g:' + g, 1);
  for (const [id] of rec.kw || []) add('k:' + id, 1);
  if (rec.col) add('col:' + rec.col, 0.6);
  for (const d of rec.dir || []) add('d:' + d, 0.4);
  for (const a of (rec.cast || []).slice(0, 4)) add('a:' + a, 0.15);
  if (rec.y) add('dec:' + Math.floor(rec.y / 10) * 10, 0.35);
  if (rec.ol) add('l:' + rec.ol, 0.3);
  for (const c of rec.ct || []) add('c:' + c, 0.2);
  if (rec.rt) add('rt:' + (rec.rt < 90 ? 0 : rec.rt < 120 ? 1 : rec.rt < 150 ? 2 : 3), 0.2);
  add('fmt:' + rec.k, 0.3);
  // qualité perçue : le modèle APPREND si la note/le nombre de votes comptent pour cet utilisateur (exclu des vecteurs de similarité)
  if (rec.ir != null) {                                  // note/votes IMDb (source de qualité privilégiée)
    add('q:ir' + Math.max(0, Math.min(9, Math.floor((rec.ir - 5) * 2))), 0.5);
    if (rec.iv) add('q:iv' + Math.min(13, Math.floor(Math.log10(Math.max(1, rec.iv)) * 2)), 0.3);
  } else {                                               // repli : note/votes TMDB
    if (rec.va) add('q:r' + Math.max(0, Math.min(9, Math.floor((rec.va - 5) * 2))), 0.5);
    if (rec.vc) add('q:v' + Math.min(8, Math.floor(Math.log10(Math.max(1, rec.vc)) * 2)), 0.3);
  }
  for (const p of rec.pe || []) add('pe:' + p, 0.6);                                                   // personnes (mesurées : variante E)
  if (rec.rl !== undefined) { const sc = (n) => 0.9 * Math.min(1, Math.log1p(n || 0) / Math.log(6)); add('rc:love', sc(rec.rl)); add('rc:like', sc(rec.rk)); }      // recommandations des autres reliées à tes ❤️ / 👍 (variante F)
  const tf = new Map();
  for (const t of tokenize(rec.ov)) tf.set(t, (tf.get(t) || 0) + 1);
  for (const [t, c] of tf) add('w:' + t, 0.35 * (1 + Math.log(c)));
  RAW.set(rec, { sig, f });
  return f;
}

class Corpus {
  constructor(recs) {
    this.n = recs.length; this.df = new Map();
    for (const r of recs) for (const k of rawFeatures(r).keys()) this.df.set(k, (this.df.get(k) || 0) + 1);
  }
  idf(k) { const d = this.df.get(k); return d ? 1 + Math.log((this.n + 1) / (d + 1)) : 1; }   // caractéristique jamais vue à l'entraînement : poids neutre
}

const HASH = new Map();
function fnv(str) {
  let h = HASH.get(str); if (h !== undefined) return h;
  h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  if (HASH.size < 400000) HASH.set(str, h);
  return h;
}
// vecteur dense haché (projection signée) : sert à la similarité cosinus, aux prototypes et aux clusters
function hashedVec(rec, corpus, dim = 256) {
  const v = new Float32Array(dim);
  for (const [k, w] of rawFeatures(rec)) { if (k.startsWith('q:') || k.startsWith('pe:') || k.startsWith('rc:')) continue; const h = fnv(k); v[h % dim] += ((h >>> 16) & 1 ? 1 : -1) * w * corpus.idf(k); }
  let n = 0; for (let i = 0; i < dim; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1; for (let i = 0; i < dim; i++) v[i] /= n;
  return v;
}

const SPARSE_SCALE = 3;
// dict : Map key -> index ; extra : clés supplémentaires (interactions) déjà pondérées
function encodeSparse(rec, dict, corpus, extraKeys = []) {
  const idx = [], val = [];
  let n2 = 0;
  for (const [k, w] of rawFeatures(rec)) { const j = dict.get(k); if (j === undefined) continue; const x = w * corpus.idf(k); idx.push(j); val.push(x); n2 += x * x; }
  for (const k of extraKeys) { const j = dict.get(k); if (j === undefined) continue; const x = 1.2; idx.push(j); val.push(x); n2 += x * x; }
  const s = SPARSE_SCALE / (Math.sqrt(n2) || 1);
  for (let i = 0; i < val.length; i++) val[i] *= s;
  return { idx: Int32Array.from(idx), val: Float32Array.from(val) };
}
function buildDict(recs, minDf = 2, keep = null) {
  const df = new Map();
  for (const r of recs) for (const k of rawFeatures(r).keys()) df.set(k, (df.get(k) || 0) + 1);
  const d = new Map();
  for (const [k, c] of df) if (c >= (k.startsWith('pe:') ? Math.max(minDf, 3) : minDf) && (!keep || keep(k))) d.set(k, d.size);
  return d;
}

// libellé lisible d'une clé de feature (pour l'ADN du profil et le diagnostic)
function makeNamer(recs) {
  const g = new Map(), k = new Map();
  for (const r of recs) { (r.g || []).forEach((id, i) => g.set(id, (r.gn || [])[i] || String(id))); for (const [id, name] of r.kw || []) k.set(id, name); }
  return (key) => {
    const [t, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    if (t === 'g') return `genre « ${g.get(Number(id)) || id} »`;
    if (t === 'k') return `mot-clé « ${k.get(Number(id)) || id} »`;
    if (t === 'w') return `mot « ${id} »`;
    if (t === 'dec') return `années ${id}`;
    if (t === 'l') return `langue ${id}`;
    if (t === 'c') return `pays ${id}`;
    if (t === 'col') return 'saga';
    if (t === 'd') return 'réalisateur récurrent';
    if (t === 'a') return 'acteur récurrent';
    if (t === 'rt') return ['court', 'moyen', 'long', 'très long'][Number(id)] || 'durée';
    if (t === 'fmt') return id === 'm' ? 'film' : 'série';
    return key;
  };
}
function nameOfKey(namer, key) {
  if (key.startsWith('p:')) return key.slice(2).split('|').map((x) => namer(x)).join(' + ');
  return namer(key);
}

module.exports = { forgetRaw, clearRaw, tokenize, rawFeatures, Corpus, hashedVec, encodeSparse, buildDict, makeNamer, nameOfKey, fnv };
