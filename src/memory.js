'use strict';
// SURVEILLANCE DE LA MÉMOIRE (serveur gratuit : environ 400 Mo de tas utilisables). Après chaque étape lourde d'un calcul, si le tas dépasse le seuil (70 % de la limite),
// les caches de travail sont vidés (caractéristiques des fiches recalculables à la demande) et le ramasse-miettes est demandé s'il est disponible (node --expose-gc).
// Aucune donnée n'est perdue : ces caches sont reconstruits au besoin.
const v8 = require('v8');
const { log } = require('./util');
const RATIO = Number(process.env.MEM_GUARD_RATIO || 0.7);
let last = null;
function snapshot() { try { const st = v8.getHeapStatistics(); const used = process.memoryUsage().heapUsed; return { usedMB: Math.round(used / 1048576), limitMB: Math.round(st.heap_size_limit / 1048576), ratio: +(used / st.heap_size_limit).toFixed(3) }; } catch { return { usedMB: 0, limitMB: 0, ratio: 0 }; } }
function guard(label, { force = false } = {}) {
  try {
    let s = snapshot();
    if (force || s.ratio > RATIO) {
      require('./features').clearRaw();
      if (typeof global.gc === 'function') global.gc();
      const after = snapshot(); last = { label, before: s.usedMB, after: after.usedMB, limitMB: s.limitMB, at: new Date().toISOString() };
      log('warn', 'mémoire élevée : caches de travail vidés', { label, avant: s.usedMB, apres: after.usedMB, limite: s.limitMB });
      s = after;
    }
    return s;
  } catch { return { usedMB: 0, limitMB: 0, ratio: 0 }; }
}
module.exports = { guard, snapshot, last: () => last, RATIO };
