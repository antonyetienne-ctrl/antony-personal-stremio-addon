'use strict';
// Briques d'apprentissage en JS pur (aucune dépendance) : régression logistique L2 (Adam, poids d'échantillons),
// métriques, folds stratifiés, k-means cosinus. Toutes les boucles longues cèdent la main (yielder).
const { mulberry32 } = require('./util');

const sigmoid = (z) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));
const logit = (p) => { const q = Math.min(1 - 1e-6, Math.max(1e-6, p)); return Math.log(q / (1 - q)); };
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

// sparse : [{idx,val}] ; dense : [Float64Array|Float32Array] | null ; y : 0/1 ; w : poids
async function fitLogistic({ sparse, dense = null, y, w, nS, nD = 0, l2S = 0.01, l2D = 0.05, iters = 110, lr = 0.12, yielder }) {
  const n = y.length;
  const wS = new Float64Array(nS), wD = new Float64Array(nD);
  let W = 0, pos = 0; for (let i = 0; i < n; i++) { W += w[i]; pos += w[i] * y[i]; }
  let b = logit((pos + 1) / (W + 2));
  const mS = new Float64Array(nS), vS = new Float64Array(nS), mD = new Float64Array(nD), vD = new Float64Array(nD);
  const gS = new Float64Array(nS), gD = new Float64Array(nD);
  let mb = 0, vb = 0;
  const b1 = 0.9, b2 = 0.999, eps = 1e-8;
  for (let it = 1; it <= iters; it++) {
    gS.fill(0); gD.fill(0); let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b; const sp = sparse[i];
      for (let j = 0; j < sp.idx.length; j++) z += wS[sp.idx[j]] * sp.val[j];
      let d = null;
      if (nD) { d = dense[i]; for (let k = 0; k < nD; k++) z += wD[k] * d[k]; }
      const e = (sigmoid(z) - y[i]) * w[i] / W;
      gb += e;
      for (let j = 0; j < sp.idx.length; j++) gS[sp.idx[j]] += e * sp.val[j];
      if (nD) for (let k = 0; k < nD; k++) gD[k] += e * d[k];
    }
    const c1 = 1 - Math.pow(b1, it), c2 = 1 - Math.pow(b2, it);
    for (let j = 0; j < nS; j++) { const g = gS[j] + l2S * wS[j]; mS[j] = b1 * mS[j] + (1 - b1) * g; vS[j] = b2 * vS[j] + (1 - b2) * g * g; wS[j] -= lr * (mS[j] / c1) / (Math.sqrt(vS[j] / c2) + eps); }
    for (let k = 0; k < nD; k++) { const g = gD[k] + l2D * wD[k]; mD[k] = b1 * mD[k] + (1 - b1) * g; vD[k] = b2 * vD[k] + (1 - b2) * g * g; wD[k] -= lr * (mD[k] / c1) / (Math.sqrt(vD[k] / c2) + eps); }
    mb = b1 * mb + (1 - b1) * gb; vb = b2 * vb + (1 - b2) * gb * gb; b -= lr * (mb / c1) / (Math.sqrt(vb / c2) + eps);
    if (yielder && it % 6 === 0) await yielder();
  }
  return { wS, wD, b };
}
function predictLogit(m, sp, d) {
  let z = m.b;
  for (let j = 0; j < sp.idx.length; j++) z += m.wS[sp.idx[j]] * sp.val[j];
  if (d) for (let k = 0; k < m.wD.length; k++) z += m.wD[k] * d[k];
  return z;
}

// ---------- métriques ----------
function auc(scores, labels) {
  const idx = scores.map((s, i) => i).sort((a, b) => scores[a] - scores[b]);
  let rankSum = 0, nPos = 0, nNeg = 0;
  for (let r = 0; r < idx.length;) {
    let e = r; while (e + 1 < idx.length && scores[idx[e + 1]] === scores[idx[r]]) e++;
    const avg = (r + e) / 2 + 1;
    for (let k = r; k <= e; k++) if (labels[idx[k]]) { rankSum += avg; nPos++; } else nNeg++;
    r = e + 1;
  }
  return nPos && nNeg ? (rankSum - nPos * (nPos + 1) / 2) / (nPos * nNeg) : NaN;
}
function logloss(p, y) { let s = 0; for (let i = 0; i < p.length; i++) { const q = Math.min(1 - 1e-6, Math.max(1e-6, p[i])); s -= y[i] ? Math.log(q) : Math.log(1 - q); } return s / Math.max(1, p.length); }
function brier(p, y) { let s = 0; for (let i = 0; i < p.length; i++) s += (p[i] - y[i]) ** 2; return s / Math.max(1, p.length); }
function topK(scores, k) { return scores.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0]).slice(0, k).map((x) => x[1]); }
function precisionAtK(scores, labels, k) { if (scores.length < k) return NaN; const t = topK(scores, k); return t.reduce((a, i) => a + (labels[i] ? 1 : 0), 0) / k; }
function calibration(p, y, bins = 5) {
  const out = [];
  for (let b = 0; b < bins; b++) {
    const lo = b / bins, hi = (b + 1) / bins; let n = 0, sp = 0, sy = 0;
    for (let i = 0; i < p.length; i++) if (p[i] >= lo && (p[i] < hi || (b === bins - 1 && p[i] <= 1))) { n++; sp += p[i]; sy += y[i]; }
    if (n) out.push({ bin: `${lo.toFixed(1)}–${hi.toFixed(1)}`, n, predicted: +(sp / n).toFixed(3), observed: +(sy / n).toFixed(3) });
  }
  return out;
}

// folds stratifiés déterministes
function kfold(labels, k, seed = 7) {
  const r = mulberry32(seed); const fold = new Int8Array(labels.length);
  for (const cls of [0, 1]) {
    const ids = []; labels.forEach((l, i) => { if ((l ? 1 : 0) === cls) ids.push(i); });
    for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
    ids.forEach((id, i) => { fold[id] = i % k; });
  }
  return fold;
}

// k-means cosinus (vecteurs normalisés), init k-means++ déterministe, échantillons pondérés
function kmeans(vecs, weights, k, seed = 11, iters = 8) {
  const n = vecs.length; if (!n) return [];
  k = Math.max(1, Math.min(k, n));
  const r = mulberry32(seed); const dim = vecs[0].length;
  const cents = [Float32Array.from(vecs[Math.floor(r() * n)])];
  while (cents.length < k) {
    const d = vecs.map((v, vi) => { let best = -1; for (const c of cents) best = Math.max(best, dot(v, c)); return Math.max(1e-6, 1 - best) ** 2 * weights[vi]; });
    let tot = d.reduce((a, b) => a + b, 0), x = r() * tot, pick = 0;
    for (let i = 0; i < n; i++) { x -= d[i]; if (x <= 0) { pick = i; break; } }
    cents.push(Float32Array.from(vecs[pick]));
  }
  for (let it = 0; it < iters; it++) {
    const sums = cents.map(() => new Float32Array(dim));
    for (let i = 0; i < n; i++) { let bi = 0, bs = -2; for (let c = 0; c < cents.length; c++) { const s = dot(vecs[i], cents[c]); if (s > bs) { bs = s; bi = c; } } for (let j = 0; j < dim; j++) sums[bi][j] += vecs[i][j] * weights[i]; }
    sums.forEach((s, c) => { let nn = 0; for (let j = 0; j < dim; j++) nn += s[j] * s[j]; nn = Math.sqrt(nn); if (nn > 1e-9) { for (let j = 0; j < dim; j++) cents[c][j] = s[j] / nn; } });
  }
  return cents;
}

module.exports = { sigmoid, logit, dot, fitLogistic, predictLogit, auc, logloss, brier, precisionAtK, calibration, kfold, kmeans, topK };
