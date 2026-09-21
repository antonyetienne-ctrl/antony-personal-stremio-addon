'use strict';
// /diagnostic : état complet SANS aucun secret (clés, AuthKey, tokens jamais exposés ; logs expurgés).
const { clock, recentLogs, redact } = require('./util');
const cfg = require('./config');

const round = (x) => (typeof x === 'number' ? Math.round(x * 1000) / 1000 : x);
function build({ store, users, engine, results, started }) {
  const out = {
    engine: cfg.ENGINE_VERSION, node: process.version, uptimeSec: Math.round(process.uptime()), startedAt: new Date(started).toISOString(), now: new Date(clock.now()).toISOString(),
    memoryMB: Object.fromEntries(Object.entries(process.memoryUsage()).map(([k, v]) => [k, Math.round(v / 1048576)])),
    env: { CONFIG_SECRET: Boolean(process.env.CONFIG_SECRET && process.env.CONFIG_SECRET.length >= 16), DIAG_TOKEN: Boolean(process.env.DIAG_TOKEN), UPSTASH: store.enabled },
    upstash: store.snapshot(), users: []
  };
  for (const uid of engine.jobs.keys()) {
    const job = engine.jobs.get(uid); const u = users.ram.get(uid); const cl = engine.clients.get(uid);
    const res = results.ram.get(uid) || {};
    const bt = job.backtest || null;
    const entry = {
      id: uid.slice(0, 6) + '…', status: engine.status(uid), job: { imdb: job.imdb || null, precision: job.precision || null, taste: job.taste || null, status: job.status, mode: job.mode, reason: job.reason, stage: job.stage, engine: job.engine, buildId: job.buildId, labelFP: job.labelFP, settingsFP: job.settingsFP, lastSuccessAt: job.lastSuccessAt && new Date(job.lastSuccessAt).toISOString(), lastFullDay: job.lastFullDay, lastCheckDay: job.lastCheckDay, nextEligibleAt: job.nextEligibleAt && new Date(job.nextEligibleAt).toISOString(), checkpoint: job.checkpoint || null, error: job.error },
      embeddings: job.embed ? { status: job.embed.status, model: job.embed.model, dim: job.embed.dim, coverage: job.embed.coverage, useNeighbors: job.embed.useNeighbors, neighborsVerdict: job.embed.neighborsVerdict, loo: job.embed.loo, blend: job.embed.blend, poids: job.embed.wk, candidates: job.embed.candidates, lastRun: job.embed.lastRun, calls: job.embed.calls, stats: job.embed.stats, batch: job.embed.batch, debitTitresParMinute: job.embed.rate, restant: job.embed.todo ? { historique: (job.embed.todo.labeledIds || []).length, candidats: (job.embed.todo.candIds || []).length } : null, reprise: { passes: job.embed.contPasses || 0, sansProgres: job.embed.contFails || 0, prisEnCompte: Boolean(job.embed.appliedFull) }, lastError: job.embed.lastError, pausedUntil: job.embed.pausedUntil ? new Date(job.embed.pausedUntil).toISOString() : null } : null,
      securite: job.cv || null,
      grandTestGemini: job.gemab || null,
      signaux: job.signaux || null,
      memoire: require('./memory').snapshot(),
      lastRun: job.lastRun || null, library: job.libStats || null, traits: job.traits || null,
      gemini: { configured: Boolean(cl && cl.gemini), model: cl && cl.gemini ? cl.gemini.model : null, calls: cl && cl.gemini ? cl.gemini.calls : null, stats: cl && cl.gemini ? cl.gemini.stats : null, lastError: cl && cl.gemini ? cl.gemini.lastError : null, dna: job.dna ? { source: job.dna.source, adn: job.dna.adn, themes: job.dna.themes, evite: job.dna.evite, recipes: (job.dna.recipes || []).length } : null },
      tmdb: cl && cl.tmdb ? { ...cl.tmdb.stats, cachedRecords: cl.tmdb.ram.size, languages: [...cl.tmdb.langUsed], persistCanFlush: cl.tmdb.canFlush } : null,
      backtest: bt ? { at: bt.at, split: bt.split, chosen: bt.chosen, risk: bt.risk, notes: bt.notes, geminiEval: bt.geminiEval || null, variants: (bt.variants || []).map((v) => ({ id: v.id, auc: v.cv.auc, logloss: v.cv.logloss, p10: v.cv.p10 && v.cv.p10.precision, p30: v.cv.p30 && v.cv.p30.precision })), test: bt.test, ms: bt.ms } : null,
      settings: u ? u.settings : null,
      top30: {}
    };
    for (const t of ['movie', 'series']) if (res[t]) entry.top30[t] = { builtAt: new Date(res[t].builtAt).toISOString(), short: res[t].short, items: res[t].items.map((x) => ({ rank: x.score.rank, title: x.meta.name, year: x.meta.releaseInfo, imdb: x.imdb, ...Object.fromEntries(Object.entries(x.score).filter(([k]) => !['rank'].includes(k)).map(([k, v]) => [k, typeof v === 'number' ? round(v) : v])) })) };
    out.users.push(entry);
  }
  out.logs = recentLogs().map((l) => ({ ...l, msg: redact(l.msg) }));
  return out;
}
module.exports = { build };
