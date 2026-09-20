'use strict';
// Orchestrateur. Règles :
//  - /catalog ne calcule JAMAIS : il sert la RAM et signale une activité ; le calcul démarre en fond après un délai d'inactivité ;
//  - au plus UNE synchronisation par jour calendaire Europe/Zurich (jour suivant dès 00:00) ; Force Rebuild contourne ;
//  - changement de réglages de filtre => recalcul immédiat des seuls types concernés, profil réutilisé (RAM) ;
//  - nouvelle version du moteur => nouveau calcul même si une synchro a déjà eu lieu ce jour ;
//  - checkpoints Upstash (étape, empreintes, cache TMDB) ; reprise après redémarrage ; JAMAIS de résultat partiel publié ;
//  - un échec (TMDB, Stremio, Gemini, Upstash) conserve le dernier Top 30 complet.
const { clock, log, redact, sha, Spans, fmtDuration, makeYielder, activity, zurichDay, nextZurichMidnight } = require('./util');
const embed = require('./embed');
const cfg = require('./config');
const stremio = require('./stremio');
const { Tmdb } = require('./tmdb');
const { Gemini, comparePrompt, parseEvaluations } = require('./gemini');
const { Corpus, hashedVec, makeNamer, nameOfKey } = require('./features');
const geval = require('./geval');
const model = require('./model');
const bt = require('./backtest');
const pipe = require('./pipeline');
const { Imdb, attach: imdbAttach } = require('./imdb');
const { VF } = require('./vf');

const DEFAULT_RISK = { kappa: 0.25, rho: 0.1 };
const TYPES = ['movie', 'series'];
const kindOf = (t) => (t === 'series' ? 'tv' : 'movie');
const labelName = { 2: 'love', 1: 'like', 0: 'rejeté' };

class SyncEngine {
  constructor({ store, users, results, idleDelayMs = Number(process.env.IDLE_DELAY_MS || 20000) }) {
    this.store = store; this.users = users; this.results = results; this.idleDelayMs = idleDelayMs;
    this.jobs = new Map(); this.running = new Set(); this.timers = new Map(); this.clients = new Map();
    this.snaps = new Map(); this.profileCache = new Map(); this.lastJobSave = new Map(); this.progress = new Map();
    this.imdb = new Imdb({ store }); this.vf = new VF({ store }); this.embedSpaces = new Map(); this.embedTimers = new Map(); this.embedBusy = new Set();
  }

  // ---------- état du job ----------
  async loadJob(uid) {
    if (this.jobs.has(uid)) return this.jobs.get(uid);
    const j = (await this.store.getJson(cfg.key.job(uid), 'job-load')) || {};
    const job = { v: 1, engine: null, status: 'idle', lastCheckDay: null, lastFullDay: null, labelFP: null, settingsFP: {}, ...j };
    this.jobs.set(uid, job); return job;
  }
  async saveJob(job, uid, force = false) {
    const last = this.lastJobSave.get(uid) || 0;
    if (!force && clock.now() - last < 20000) return;
    this.lastJobSave.set(uid, clock.now());
    await this.store.setJson(cfg.key.job(uid), job, 'job-save');
  }
  setStage(uid, job, stage, label, done, total) {
    job.stage = stage; job.updatedAt = clock.now();
    this.progress.set(uid, { stage, label: label || stage, done: done ?? null, total: total ?? null, at: clock.now() });
    if (label === undefined) this.saveJob(job, uid).catch(() => {});
  }
  clientsFor(user, job) {
    const s = user.secrets; const sig = sha(`${s.tmdb}|${s.gemini || ''}`);
    let c = this.clients.get(user.id);
    if (!c || c.sig !== sig) {
      const prevTmdb = c && c.tmdbToken === s.tmdb ? c.tmdb : null;
      c = { sig, tmdbToken: s.tmdb, tmdb: prevTmdb || (s.tmdb ? new Tmdb({ token: s.tmdb, store: this.store }) : null), gemini: s.gemini ? new Gemini({ key: s.gemini, calls: job && job.geminiCalls }) : null };
      this.clients.set(user.id, c);
    }
    return c;
  }

  // ---------- déclencheurs ----------
  touch(uid) { activity.mark(); this._schedule(uid); }
  _schedule(uid, delay = this.idleDelayMs) {
    clearTimeout(this.timers.get(uid));
    const t = setTimeout(() => this.tick(uid).catch((e) => log('error', 'tick', e.message)), delay); t.unref && t.unref();
    this.timers.set(uid, t);
  }
  async resumeAll() {
    const ids = await this.users.list();
    for (const uid of ids) { const job = await this.loadJob(uid); if (job.status === 'running') { log('warn', 'Job interrompu détecté au démarrage : reprise prévue', { stage: job.stage }); } this._schedule(uid, 3000); if (this._embedTodoCount(job) > 0) this._scheduleEmbed(uid, 120000); }
  }
  async onSettingsSaved(uid, changedTypes) { if (changedTypes.length) this._runBg(uid, { mode: 'rerank', types: changedTypes, reason: 'réglages modifiés' }); }
  force(uid) { return this._runBg(uid, { mode: 'full', force: true, reason: 'Force Rebuild' }); }
  _runBg(uid, opts) { if (this.running.has(uid)) return { started: false, why: 'un calcul est déjà en cours' }; setImmediate(() => this.run(uid, opts).catch((e) => log('error', 'run', e.message))); return { started: true }; }

  // ---------- reprise en arrière-plan de la vectorisation (embeddings) : sans relancer le calcul complet ----------
  _embedTodoCount(job) { const t = job && job.embed && job.embed.todo; return t ? (t.labeledIds || []).length + (t.candIds || []).length : 0; }
  _scheduleEmbed(uid, delayMs) {
    if (process.env.EMBED_BACKGROUND === 'off') return;
    const old = this.embedTimers.get(uid); if (old) clearTimeout(old);
    const t = setTimeout(() => { this.embedTimers.delete(uid); this.embedContinue(uid).catch((e) => log('warn', 'reprise de la vectorisation', String(e && e.message || e).slice(0, 120))); }, Math.max(1000, delayMs === undefined ? Number(process.env.EMBED_CONT_DELAY_MS || 30000) : delayMs));
    if (t.unref) t.unref(); this.embedTimers.set(uid, t);
  }
  async embedContinue(uid, opts = {}) {
    if (this.embedBusy.has(uid)) return { skipped: 'déjà en cours' };
    if (this.running.has(uid)) { this._scheduleEmbed(uid, 60000); return { skipped: 'un calcul est en cours : nouvelle tentative dans 60 s' }; }
    const job = await this.loadJob(uid); const S = job.embed;
    if (this._embedTodoCount(job) === 0) return { skipped: 'rien à reprendre' };
    const user = await this.users.get(uid);
    if (!user || !user.secrets.gemini || user.settings.common.useGemini === false) return { skipped: 'Gemini indisponible ou désactivé' };
    this.embedBusy.add(uid);
    try {
      const cl = this.clientsFor(user, job); await cl.tmdb.loadPersisted();
      const r = await embed.continueTodo({ store: this.store, apiKey: user.secrets.gemini, job, tmdb: cl.tmdb, spaces: this.embedSpaces, ...(opts.embed || {}) });
      await this.saveJob(job, uid, true);
      if (r.error || r.skipped) return r;
      // historique vectorisé à 90 % ou plus : un recalcul léger mesure les voisins sémantiques et le poids (une seule fois)
      if (S.coverage && S.coverage.historique >= embed.MIN_COVERAGE && !S.appliedFull) {
        const enabled = TYPES.filter((t) => user.settings.common[t === 'movie' ? 'movieCatalog' : 'seriesCatalog']);
        const st = this._runBg(uid, { mode: 'rerank', types: enabled, reason: 'vectorisation des embeddings terminée' });
        if (!st.started) this._scheduleEmbed(uid, 60000);
        return { ...r, recalcul: st.started };
      }
      if (r.done) return r;
      S.contFails = r.embedded === 0 && !(S.pausedUntil > clock.now()) ? (S.contFails || 0) + 1 : 0;
      if (S.contFails >= 3) { log('warn', 'Vectorisation en arrière-plan : aucun progrès sur 3 passes, reprise au prochain calcul'); return r; }
      const wait = S.pausedUntil > clock.now() ? S.pausedUntil - clock.now() + 5000 : r.stop && /plafond quotidien/.test(r.stop) ? nextZurichMidnight() - clock.now() + 120000 : undefined;
      this._scheduleEmbed(uid, wait);
      return r;
    } finally { this.embedBusy.delete(uid); }
  }

  async tick(uid) {
    if (this.running.has(uid)) return;
    const user = await this.users.get(uid); if (!user || !user.secrets.tmdb || !user.secrets.stremio) return;
    const job = await this.loadJob(uid);
    await this.results.retryPending(uid); await this.users.retryDirty();
    const res = await this.results.getFast(uid);
    const today = zurichDay();
    const enabled = TYPES.filter((t) => user.settings.common[t === 'movie' ? 'movieCatalog' : 'seriesCatalog']);
    if (job.status === 'running') return void (await this.run(uid, { mode: 'full', reason: 'reprise après interruption', resume: true }));
    if (!res || enabled.some((t) => !res[t])) return void (await this.run(uid, { mode: 'full', reason: 'premier calcul' }));
    if (job.engine !== cfg.ENGINE_VERSION) return void (await this.run(uid, { mode: 'full', reason: `nouvelle version du moteur (${job.engine || '?'} → ${cfg.ENGINE_VERSION})` }));
    const stale = enabled.filter((t) => (res[t].settingsFP || '') !== cfg.settingsFingerprint(user.settings, t));
    if (stale.length) return void (await this.run(uid, { mode: 'rerank', types: stale, reason: 'réglages différents du dernier résultat' }));
    if (job.lastCheckDay !== today) return void (await this.run(uid, { mode: 'check', reason: 'première ouverture de la journée' }));
  }

  // ---------- exécution ----------
  async run(uid, { mode = 'full', force = false, reason = '', types = null, resume = false } = {}) {
    if (this.running.has(uid)) return { skipped: true };
    this.running.add(uid);
    const job = await this.loadJob(uid);
    const user = await this.users.get(uid);
    const spans = new Spans(); const startedAt = clock.now(); const t0 = process.hrtime.bigint();
    Object.assign(job, { status: 'running', mode, reason, startedAt, updatedAt: startedAt, stage: 'démarrage', error: null, buildId: sha(uid + startedAt + Math.random()), forced: force });
    await this.saveJob(job, uid, true);
    let outcome = 'failed', report = {}, error = null;
    try {
      if (!user) throw new Error('profil introuvable');
      if (!user.secrets.tmdb || !user.secrets.stremio) throw new Error('clés TMDB ou Stremio manquantes : renseigne-les dans la page de configuration');
      const r = await this._execute(uid, user, job, { mode, force, types, spans });
      outcome = r.outcome; report = r.report;
    } catch (e) { error = redact(e && e.message || e); log('error', `Calcul échoué (${mode}) : ${error} — le dernier Top 30 valide reste servi`); }
    const durationMs = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
    const sp = spans.snapshot();
    const films = (sp.discover_movie || 0) + (sp.score_movie || 0), series = (sp.discover_series || 0) + (sp.score_series || 0);
    job.lastRun = { ok: !error, outcome, mode, reason, startedAt, endedAt: clock.now(), durationMs, durationHuman: fmtDuration(durationMs), spans: sp, filmsMs: films, seriesMs: series, otherMs: Math.max(0, durationMs - films - series), report, error };
    job.status = error ? 'failed' : 'ok'; job.error = error; job.updatedAt = clock.now(); job.stage = error ? 'échec' : 'terminé';
    job.geminiCalls = this.clients.get(uid) && this.clients.get(uid).gemini ? this.clients.get(uid).gemini.calls : job.geminiCalls;
    this.progress.delete(uid);
    await this.saveJob(job, uid, true);
    this.running.delete(uid);
    if (!error && this._embedTodoCount(job) > 0) this._scheduleEmbed(uid, job.embed.pausedUntil > clock.now() ? job.embed.pausedUntil - clock.now() + 5000 : undefined);
    log('info', `BUILD ${error ? 'FAILED' : 'COMPLETE'} (${outcome})  Total: ${fmtDuration(durationMs)}  Films: ${fmtDuration(films)}  Séries: ${fmtDuration(series)}  Autres: ${fmtDuration(job.lastRun.otherMs)}`);
    return { outcome, error };
  }

  async _libraryStage(uid, user, job, { mode, force, spans, gate }) {
    if (mode === 'rerank') {
      const snap = await this.loadSnap(uid);
      if (snap) return { ...this._fromSnap(snap), fromSnapshot: true };
    }
    this.setStage(uid, job, 'bibliothèque', 'lecture de la bibliothèque Stremio');
    const lib = await spans.wrap('library', () => stremio.fetchLibrary(user.secrets.stremio));
    const seen = new Map(); for (const it of lib) { const c = stremio.classify(it); if (c && !seen.has(c.imdb + c.type)) seen.set(c.imdb + c.type, c); }
    const items = [...seen.values()];
    const prevSnap = await this.loadSnap(uid);
    const prev = new Map(prevSnap ? Object.entries(prevSnap.items).map(([im, v]) => [im, v[1] === 'L' ? 'love' : v[1] === 'K' ? 'like' : v[1] === 'N' ? 'none' : '?']) : []);
    this.setStage(uid, job, 'statuts', `lecture des ❤️/👍 (${items.length} titres)`);
    const scan = await spans.wrap('ratings', () => stremio.scanStatuses(user.secrets.stremio, items, { prev, gate }));
    const loveLike = items.filter((c) => ['love', 'like'].includes(scan.statuses.get(c.imdb))).length;
    if (items.length >= 50 && loveLike === 0) throw new Error('Aucun ❤️/👍 détecté alors que la bibliothèque est grande : le service de statuts Stremio semble illisible. Consulte /diagnostic (échantillon de statuts).');
    if (prevSnap && !force) { const prevLL = Object.values(prevSnap.items).filter((v) => v[1] === 'L' || v[1] === 'K').length; if (prevLL >= 20 && loveLike < 0.6 * prevLL) throw new Error(`Baisse suspecte des ❤️/👍 (${prevLL} → ${loveLike}) : synchronisation abandonnée par prudence. Utilise Force Rebuild si c'est voulu.`); }
    return { classified: items, statuses: scan.statuses, scan: { total: scan.total, unknown: scan.unknown, fromPrev: scan.fromPrev }, fromSnapshot: false };
  }
  _fromSnap(snap) {
    const classified = [], statuses = new Map();
    for (const [imdb, v] of Object.entries(snap.items)) { classified.push({ imdb, type: v[0] === 's' ? 'series' : 'movie', seen: v[2].includes('s'), started: v[2].includes('t'), lw: v[3] || 0, why: v[4] || null }); statuses.set(imdb, v[1] === 'L' ? 'love' : v[1] === 'K' ? 'like' : v[1] === 'N' ? 'none' : '?'); }
    return { classified, statuses };
  }
  async loadSnap(uid) { if (this.snaps.has(uid)) return this.snaps.get(uid); const s = await this.store.getJson(cfg.key.snap(uid), 'snap-load'); if (s) this.snaps.set(uid, s); return s || null; }
  _makeSnap(classified, statuses) {
    const items = {}; for (const c of classified) { const st = statuses.get(c.imdb); items[c.imdb] = [c.type[0], st === 'love' ? 'L' : st === 'like' ? 'K' : st === 'none' ? 'N' : '?', (c.seen ? 's' : '') + (c.started ? 't' : ''), c.lw || 0, c.why || '']; }
    return { v: 1, at: clock.now(), items };
  }

  async _execute(uid, user, job, { mode, force, types, spans }) {
    const gate = makeYielder(40); const today = zurichDay(); const settings = user.settings;
    const cl = this.clientsFor(user, job); const tmdb = cl.tmdb; const gem = cl.gemini && settings.common.useGemini ? cl.gemini : null;
    const enabled = TYPES.filter((t) => settings.common[t === 'movie' ? 'movieCatalog' : 'seriesCatalog']);
    const targets = (mode === 'rerank' && types ? types : enabled).filter((t) => enabled.includes(t));
    if (!targets.length) throw new Error('aucun catalogue activé');
    await spans.wrap('cache_load', () => tmdb.loadPersisted());

    // 1) bibliothèque + statuts
    const lib = await this._libraryStage(uid, user, job, { mode, force, spans, gate });
    const { classified, statuses } = lib;
    const flag = (c) => `${c.imdb}:${c.type[0]}:${statuses.get(c.imdb)}:${c.seen ? 1 : 0}${c.started ? 1 : 0}`;
    const labelFP = sha(classified.map(flag).sort().join('|'), 20);
    const counts = { total: classified.length, love: 0, like: 0, none: 0, unknown: 0, seenUnrated: 0, startedOnly: 0, seenSeries: 0, startedSeries: 0 };
    for (const c of classified) { const s = statuses.get(c.imdb); if (s === 'love') counts.love++; else if (s === 'like') counts.like++; else if (s === '?') counts.unknown++; else counts.none++; if (s === 'none' && c.seen) counts.seenUnrated++; if (c.started) counts.startedOnly++; if (c.type === 'series') { if (c.seen) counts.seenSeries++; if (c.started) counts.startedSeries++; } }
    job.libStats = { ...counts, scan: lib.scan || null, fromSnapshot: Boolean(lib.fromSnapshot) };

    if (mode === 'check') {
      const same = job.labelFP === labelFP && job.engine === cfg.ENGINE_VERSION;
      job.lastCheckDay = today;
      if (same) { await this.store.setJson(cfg.key.snap(uid), this._makeSnap(classified, statuses), 'snap-save'); return { outcome: 'unchanged', report: { message: 'aucun changement pertinent : résultat existant conservé', counts } }; }
      if (job.lastFullDay === today) return { outcome: 'deferred', report: { message: 'changements détectés mais une synchronisation complète a déjà eu lieu aujourd\'hui : report à demain', counts } };
    }

    // 2) étiquettes + fiches TMDB des titres étiquetés
    this.setStage(uid, job, 'profil', 'fiches des titres étiquetés');
    const labeled = [], lookup = {};
    for (const t of TYPES) {
      const cand = classified.filter((c) => c.type === t).map((c) => ({ c, st: statuses.get(c.imdb) })).filter(({ c, st }) => st === 'love' || st === 'like' || (st === 'none' && c.seen));
      const ids = await spans.wrap('tmdb_ids', () => tmdb.findMany(cand.map((x) => x.c.imdb), t, { gate }));
      const recs = await spans.wrap('tmdb_labeled', () => tmdb.ensureDetails(kindOf(t), [...ids.values()], { gate, onProgress: (d, n) => this.setStage(uid, job, 'profil', `fiches ${t === 'movie' ? 'films' : 'séries'} étiquetés`, d, n) }));
      let missing = 0;
      for (const { c, st } of cand) {
        const id = ids.get(c.imdb); const rec = id && recs.get(id);
        if (!rec) { missing++; continue; }
        const label = st === 'love' ? 2 : st === 'like' ? 1 : 0;
        labeled.push({ key: t[0] + c.imdb, rec, label, w: 1, lw: c.lw || 0 });
      }
      // pré-filtre de découverte : SEULS les titres marqués VUS sont exclus (un titre noté ou commencé mais non marqué vu reste recommandable)
      lookup[t] = { known: pipe.exclusions(classified, cand, ids).knownTmdb, missing, total: cand.length };
      if (cand.length && missing / cand.length > 0.08) throw new Error(`Fiches TMDB manquantes pour ${missing}/${cand.length} titres ${t} : calcul abandonné (résultat partiel refusé)`);
    }
    if (labeled.filter((i) => i.label > 0).length < 8) throw new Error('Pas assez de ❤️/👍 exploitables (minimum 8) pour apprendre des goûts');
    if (labeled.filter((i) => i.label === 0).length < 5) throw new Error('Pas assez de titres vus sans appréciation (minimum 5) pour apprendre ce qui est rejeté');
    // seuils TMDB automatiques : repli si IMDb est indisponible, et base d'un pré-filtre TMDB ÉLARGI pour la découverte
    const autoT = require('./auto').autoThresholds({ ...settings, movie: { ...settings.movie, ratingMode: 'auto' }, series: { ...settings.series, ratingMode: 'auto' } }, labeled, { source: 'tmdb' });
    const effTmdb = autoT.eff; job.taste = autoT.info;
    const seenImdb = pipe.exclusions(classified, [], new Map()).seenImdb;   // règle unique : seul un titre marqué VU est exclu

    // 3) découverte des candidats (canaux A/B) avec un pré-filtre TMDB ÉLARGI : le vrai filtre de qualité est appliqué ensuite sur IMDb.
    //    Checkpoint (cache TMDB persistant) après chaque type.
    const relax = (t) => ({ ...effTmdb[t], minRating: Math.max(5, +(effTmdb[t].minRating - 0.7).toFixed(1)), minVotes: Math.max(100, Math.round(effTmdb[t].minVotes / 3)) });
    const effDisc = { ...effTmdb, movie: relax('movie'), series: relax('series') };
    const cands = {}, dstats = {}, disc = {};
    for (const t of targets) {
      const seeds = labeled.filter((i) => i.rec.k === t[0] && i.label > 0).sort((a, b) => b.label - a.label || b.lw - a.lw).map((i) => i.rec.i);
      const d = await spans.wrap(`discover_${t}`, () => pipe.discoverCandidates({ tmdb, type: t, settings: effDisc, seedTmdbIds: seeds, excludeTmdb: lookup[t].known, gate, onProgress: (label, done, total) => this.setStage(uid, job, `découverte ${t}`, `${label}`, done, total) }));
      if (d.stats.discoverErrors > 0 || d.stats.detailErrors > Math.max(3, 0.03 * d.stats.toFetch)) throw new Error(`Découverte ${t} incomplète (${d.stats.discoverErrors} pages et ${d.stats.detailErrors} fiches en erreur) : calcul abandonné, l'ancien Top 30 est conservé`);
      disc[t] = d; dstats[t] = { ...d.stats };
      job.checkpoint = { stage: `découverte ${t} terminée`, at: clock.now(), candidates: d.recs.length };
      await spans.wrap('cache_flush', () => tmdb.flushPersisted());
      await this.saveJob(job, uid, true);
    }
    // 3b) notes et votes IMDb (une seule lecture du jeu de données pour Films + Séries) : filtre de qualité + critères appris.
    //     Indisponible ou couverture insuffisante des ❤️/👍 => repli sur les notes TMDB (seuils automatiques TMDB).
    this.setStage(uid, job, 'imdb', 'notes et votes IMDb');
    const wantIds = new Set();
    for (const i of labeled) if (i.rec.im) wantIds.add(i.rec.im);
    for (const t of targets) for (const r of disc[t].recs) if (r.im) wantIds.add(r.im);
    const imr = await spans.wrap('imdb', () => this.imdb.ensure(wantIds, { gate, force }));
    let imdbActive = imr.active;
    if (imdbActive) {
      const pos = labeled.filter((i) => i.label > 0);
      const cov = pos.filter((i) => this.imdb.get(i.rec.im)).length / Math.max(1, pos.length);
      imr.info.coverageLabeled = +cov.toFixed(3);
      if (cov < 0.8) { imdbActive = false; imr.info.error = imr.info.error || `couverture insuffisante des ❤️/👍 (${Math.round(cov * 100)} %)`; }
    }
    imdbAttach([...labeled.map((i) => i.rec), ...targets.flatMap((t) => disc[t].recs)], imdbActive ? this.imdb : null);
    let effA;
    if (imdbActive) { const ai = require('./auto').autoThresholds(settings, labeled, { source: 'imdb' }); effA = ai.eff; job.taste = ai.info; }
    else effA = effTmdb;
    for (const t of TYPES) effA[t].source = imdbActive ? 'imdb' : 'tmdb';
    job.imdb = { active: imdbActive, qualiteSur: imdbActive ? 'IMDb' : 'TMDB (repli)', ...imr.info, manuelIgnore: !imdbActive && (settings.movie.ratingMode === 'manual' || settings.series.ratingMode === 'manual') ? 'mode manuel ignoré : IMDb indisponible, seuils TMDB automatiques utilisés' : null };
    for (const t of targets) {
      const adm = pipe.admissible(disc[t].recs, { settings: effA, type: t, seenImdb });
      cands[t] = adm.recs; dstats[t] = { ...dstats[t], admissible: adm.recs.length, rejects: adm.rejects };
      if (adm.recs.length < cfg.TOP_N) log('warn', `Seulement ${adm.recs.length} candidats admissibles pour ${t}`);
    }

    // 4) modèle : backtest (mis en cache par empreinte) puis entraînement Global/Films/Séries
    this.setStage(uid, job, 'apprentissage', 'apprentissage des goûts');
    const corpus = new Corpus(labeled.map((i) => i.rec));
    for (const it of labeled) it.vec = hashedVec(it.rec, corpus);
    const canEval = Boolean(gem && gem.available);
    // embeddings sémantiques : vectorisation de l'historique (cadencée, mise en cache), comparaison des deux façons de trouver des voisins ; ne bloque jamais le calcul
    const embCtx = await spans.wrap('embeddings', () => embed.prepare({ store: this.store, apiKey: user.secrets.gemini, allowed: settings.common.useGemini !== false, job, labeled, gate, spaces: this.embedSpaces, force, setStage: (l) => this.setStage(uid, job, 'embeddings', l) }));
    const btKey = sha(`${labelFP}|${cfg.ENGINE_VERSION}|${imdbActive ? 'imdb' : 'tmdb'}|${embCtx.useNeighbors ? 'E' : 'H'}`);
    const retryEval = canEval && job.backtest && job.backtest.key === btKey && job.backtest.geminiEval && job.backtest.geminiEval.skipped && job.backtest.geminiEval.day !== today;      // mesure sautée (Gemini indisponible ou quota) : nouvelle tentative au plus UNE fois par jour
    if (!job.backtest || job.backtest.key !== btKey || force || retryEval) {
      const prev = job.backtest && job.backtest.key === btKey ? job.backtest.geminiEval : null;      // même historique : on réutilise la mesure déjà faite
      const prevOk = prev && !prev.error && !prev.skipped ? prev : null;
      const b = await spans.wrap('backtest', () => bt.runBacktest(labeled, corpus, gate, {
        onStage: (s) => this.setStage(uid, job, 'backtest', s),
        afterTest: async (ctx) => {
          if (prevOk) return prevOk;
          if (!gem || !gem.available) return { skipped: 'Gemini indisponible ou désactivé : aucune mesure', day: today };
          this.setStage(uid, job, 'gemini', 'mesure de l\'apport de Gemini');
          const ev = await spans.wrap('gemini_eval', () => geval.evaluate({ gem, ...ctx, neighborsFor: embCtx.useNeighbors ? embed.makeNeighborsFor(embCtx.vecOf) : null, previousMalus: job.malus ? job.malus.params : null, passes: (rec) => pipe.admissible([rec], { settings: effA, type: rec.k === 'm' ? 'movie' : 'series', seenImdb: new Set() }).recs.length === 1 }));
          if (ev && ev.skipped) ev.day = today;
          return ev;
        }
      }));
      job.backtest = { key: btKey, ...b };
    }
    { const gm = job.backtest.geminiEval && job.backtest.geminiEval.malus; if (gm && gm.params) job.malus = { params: gm.params, source: gm.source, at: gm.at || job.backtest.at }; }
    const embBeta = (job.backtest.rank && job.backtest.rank.beta) || 0.33;
    embCtx.wk = embCtx.enabled ? await spans.wrap('embeddings_poids', () => embed.decideBlend({ ctx: embCtx, job, labeled, testScores: job.backtest.testScores, split: bt.split(labeled.filter((i) => i.label >= 0)), beta: embBeta, gate, force })) : 0;
    const malusParams = (job.malus && job.malus.params) || pipe.DEFAULT_MALUS;
    const chosen = job.backtest.chosen; const risk = job.backtest.risk ? { kappa: job.backtest.risk.kappa, rho: job.backtest.risk.rho } : DEFAULT_RISK;
    const pkey = sha(`${btKey}|${JSON.stringify(chosen.cfg)}`);
    let profiles = this.profileCache.get(uid);
    if (!profiles || profiles.key !== pkey) {
      const g = await spans.wrap('train', () => model.trainProfile(labeled, chosen.cfg, corpus, gate));
      const byT = {};
      for (const t of TYPES) { const sub = labeled.filter((i) => i.rec.k === t[0]); byT[t] = sub.filter((i) => i.label > 0).length >= 10 && sub.filter((i) => i.label === 0).length >= 10 ? await spans.wrap('train', () => model.trainProfile(sub, chosen.cfg, corpus, gate)) : g; }
      profiles = { key: pkey, global: g, movie: byT.movie, series: byT.series, corpus };
      this.profileCache.set(uid, profiles);
    }
    const namer = makeNamer(labeled.map((i) => i.rec));
    job.traits = explainProfile(profiles.global, namer);
    // titres "vus sans note" que le modèle pense aimés : oublis probables de notation (à revérifier dans Stremio)
    const recheck = [];
    try {
      const g = profiles.global;
      if (g.keys && g.task1 && g.task1.oof) { const idx = new Map(labeled.map((i) => [i.key, i])); const arr = []; g.keys.forEach((k, j) => { const it = idx.get(k); if (it && it.label === 0) arr.push({ it, p: g.task1.oof[j] }); }); arr.sort((a, b) => b.p - a.p);
        // 20 films + 20 séries ; "why" = signaux Stremio qui ont fait compter le titre comme VU (pour repérer un faux "vu")
        const whyMap = new Map(classified.map((c) => [c.imdb, c.why || null]));
        for (const kind of ['m', 's']) for (const { it, p } of arr.filter((x) => x.it.rec.k === kind).slice(0, 20)) recheck.push({ title: it.rec.t, year: it.rec.y, imdb: it.rec.im, type: kind === 's' ? 'series' : 'movie', probabilite: +p.toFixed(2), why: whyMap.get(it.rec.im) || null }); }
    } catch { /* facultatif */ }

    // "surprises" : titres ❤️/👍 que le modèle croyait improbables, et "vus sans note" qu'il croyait aimés (estimations hors échantillon)
    const surprises = { movie: { aimesMaisImprobables: [], nonAimesMaisProbables: [] }, series: { aimesMaisImprobables: [], nonAimesMaisProbables: [] } };
    try {
      const g = profiles.global;
      if (g.keys && g.task1 && g.task1.oof) {
        const idx = new Map(labeled.map((i) => [i.key, i])); const all = [];
        g.keys.forEach((k, j) => { const it = idx.get(k); if (it) all.push({ it, p: g.task1.oof[j] }); });
        for (const [kind, t] of [['m', 'movie'], ['s', 'series']]) {
          const mine = all.filter((x) => x.it.rec.k === kind);
          const fmt = ({ it, p }) => ({ titre: it.rec.t, annee: it.rec.y, imdb: it.rec.im, reel: it.label === 2 ? '❤️ Love' : it.label === 1 ? '👍 Like' : 'vu sans note', probabiliteEstimee: +p.toFixed(2) });
          surprises[t].aimesMaisImprobables = mine.filter((x) => x.it.label > 0).sort((a, b) => a.p - b.p).slice(0, 20).map(fmt);
          surprises[t].nonAimesMaisProbables = mine.filter((x) => x.it.label === 0).sort((a, b) => b.p - a.p).slice(0, 20).map(fmt);
        }
      }
    } catch { /* facultatif */ }

    // 5) ADN + anti-recettes (Gemini, ≤ 1 requête, mis en cache par empreinte) — repli local sinon
    const recipes = model.negativeRecipes(labeled, 24);
    let dna = job.dna && job.dna.labelFP === labelFP && job.dna.engine === cfg.ENGINE_VERSION ? job.dna : null;
    if (!dna) {
      dna = { labelFP, engine: cfg.ENGINE_VERSION, at: clock.now(), source: 'local', adn: null, themes: [], evite: [], recipes: [] };
      // 7.2.9 : plus de résumé d'ADN rédigé (source de caricatures) ; l'arbitrage Gemini se fait par proximité avec les titres adorés / non aimés (voir plus bas)
      job.dna = dna;
    }
    const toxic = [];
    for (const rc of recipes) {
      const g = dna.recipes.find((x) => x.id === rc.id);
      if (dna.source === 'gemini' && g) { if (g.toxique && g.confiance >= 0.5) toxic.push({ id: rc.id, parts: rc.parts, conf: g.confiance }); }
      else if (rc.score <= -1 && rc.support >= 5 && rc.meanVa >= 6.8) toxic.push({ id: rc.id, parts: rc.parts, conf: 0.5 });   // règle locale : rejet de bons films => thème/ton
    }

    // 6) scoring de TOUS les candidats + arbitrage frontière
    const pools = {}, sections = {}, utils = {}, scoredAll = {};
    for (const t of targets) {
      this.setStage(uid, job, `scoring ${t}`, `scoring de ${cands[t].length} candidats (${t === 'movie' ? 'films' : 'séries'})`);
      const scored = await spans.wrap(`score_${t}`, () => pipe.scoreCandidates({ recs: cands[t], corpus, profType: profiles[t], profGlobal: profiles.global, risk, rank: job.backtest.rank, toxic, yielder: gate }));
      if (embCtx.enabled && (embCtx.useNeighbors || embCtx.wk > 0)) {                 // vectorisation des mieux classés, puis mélange par voisins sémantiques (seulement si adopté par la mesure)
        const er = await spans.wrap(`embeddings_${t}`, () => embed.ensureRecs(embCtx, scored.slice(0, embed.TOP_CANDIDATES).map((c) => c.rec), { setStage: (l) => this.setStage(uid, job, `embeddings ${t}`, l) }));
        let ab = { applied: false }; if (embCtx.wk > 0) ab = embed.applyBlend(scored, { wk: embCtx.wk, pool: embed.poolOf(labeled, (i) => embCtx.vecOf(i.rec)), beta: embBeta, vecOf: embCtx.vecOf });
        job.embed.candidates = job.embed.candidates || {}; job.embed.candidates[t] = { vectorises: er, melange: ab, poids: embCtx.wk };
      }
      pools[t] = scored.slice(0, 100); utils[t] = scored.map((c) => c.util); scoredAll[t] = scored;
      { job.ranks = job.ranks || {}; job.ranks[t] = scored.slice(0, 400).map((c) => [c.rec.im, Math.round(c.util * 1000) / 1000]); job.ranksAt = clock.now(); }   // classement local (400 premiers) : lu par /diag/check
    }
    if (embCtx.enabled) { try { await embCtx.es.flush(); } catch { /* le cache sera réécrit au prochain calcul */ } }
    // exclusion VF (séries d'origine asiatique/turque sans VF) : AVANT Gemini et la sélection finale ; en cas de doute ou de panne, on GARDE
    let vfCtx = null, vfExcluded = [];
    try {
      const vfKeyF = user.secrets.rapidapi;
      if (settings.series.vfCheck !== false && vfKeyF && pools.series && scoredAll.series) {
        await this.vf.load(); vfCtx = this.vf.begin(vfKeyF, tmdb, gate);
        const r = await spans.wrap('vf_filtre', () => this.vf.filterPool(scoredAll.series, vfCtx, { limit: 100 }));
        pools.series = r.kept; vfExcluded = r.excluded;
        { const ex = new Set(r.excluded.map((x) => x.imdb)); if (job.ranks && job.ranks.series) for (const e of job.ranks.series) if (ex.has(e[0])) e[2] = 1; }      // rang « avant / après exclusion VF » lu par /diag/check
      }
    } catch (e) { log('warn', 'exclusion VF en échec (ignorée : aucune série écartée)', e.message); vfCtx = null; vfExcluded = []; }
    let adj = null; const arb = { used: false, variante: 'C (proximité : 3 adorés et 3 non aimés les plus proches)', fenetre: pipe.WINDOW, malus: { params: malusParams, source: (job.malus && job.malus.source) || 'réglage par défaut (aucune calibration disponible)' } };
    if (gem && gem.available) {
      const loved = labeled.filter((i) => i.label === 2 && i.vec), rejected = labeled.filter((i) => i.label === 0 && i.vec);
      const all = new Map(); arb.candidatesSent = 0; arb.evaluated = 0; arb.calls = 0; arb.trace = [];
      const embNb = embCtx.enabled && embCtx.useNeighbors ? (() => { const L = embed.poolOf(loved, (i) => embCtx.vecOf(i.rec)), R = embed.poolOf(rejected, (i) => embCtx.vecOf(i.rec)); return (c) => { const v = embCtx.vecOf(c.rec); return v ? embed.neighborCards(v, L, R) : null; }; })() : null;
      arb.voisins = embNb ? 'sémantiques (embeddings)' : 'genres + mots-clés'; arb.voisinsSemantiques = 0;
      if (loved.length >= 10 && rejected.length >= 10) for (const t of targets) {
        const win = pools[t].slice(0, pipe.WINDOW);
        for (let off = 0; off < win.length; off += 40) {
          if (!gem.available) break;                                     // quota atteint en cours de route : on garde ce qu'on a
          const cs = []; const byId = new Map();
          win.slice(off, off + 40).forEach((c) => { const id = `${t[0]}${c.rec.i}`; byId.set(id, c.rec.im); cs.push({ id, titre: c.rec.t, annee: c.rec.y, genres: c.rec.gn || [], mots_cles: (c.rec.kw || []).slice(0, 8).map((k) => k[1]), synopsis: (c.rec.ov || '').slice(0, 180), ...(() => { const nb = embNb ? embNb(c) : null; if (nb) arb.voisinsSemantiques++; return { adores: nb ? nb.adores : pipe.nearestK(c, loved, 3), non_aimes: nb ? nb.non_aimes : pipe.nearestK(c, rejected, 3) }; })() }); });
          this.setStage(uid, job, 'gemini', `comparaison ${t === 'movie' ? 'des films' : 'des séries'} à ton historique (Gemini, ${off + cs.length}/${win.length})`);
          const r = await spans.wrap(`gemini_arbitrage_${t}`, () => gem.json(comparePrompt({ candidats: cs })));
          const pe = parseEvaluations(r, byId); arb.calls++;
          arb.candidatesSent += cs.length; arb[`forme_${t}`] = pe.shape; arb.trace = gem.trace.slice(-1);
          for (const [k, v] of pe.map) all.set(k, v);
          if (!pe.map.size) log('warn', `Comparaison Gemini (${t}, lot ${off / 40 + 1}) sans évaluation exploitable (${pe.shape}) : classement local conservé pour ces titres`);
        }
      }
      if (all.size) { adj = all; arb.used = true; arb.evaluated = all.size; }
    }
    // 7) sélection finale + validation, puis publication ATOMIQUE
    const explain = {}, finRecs = {};
    for (const t of targets) {
      const local = pipe.finalizeTop(pools[t], null), fin = pipe.finalizeTop(pools[t], adj, { malus: malusParams });
      if (!fin.length) { log('warn', `Aucun candidat pour ${t} : type non publié (ancien résultat conservé)`); continue; }
      if (pools[t].length >= cfg.TOP_N && fin.length !== cfg.TOP_N) throw new Error(`Top ${cfg.TOP_N} incomplet pour ${t} (${fin.length})`);
      sections[t] = { settingsFP: cfg.settingsFingerprint(settings, t), labelFP, short: fin.length < cfg.TOP_N, builtAt: clock.now(), buildId: job.buildId, items: fin.map((x, i) => ({ imdb: x.c.rec.im, tmdb: x.c.rec.i, meta: pipe.makeMeta(x.c.rec, t), score: { rank: i + 1, localRank: x.localRank, util: +x.u.toFixed(4), mu: +x.c.s.mu.toFixed(4), pPos: +x.c.s.pPos.toFixed(3), pLove: +x.c.s.pLove.toFixed(3), sigma: +x.c.s.sigma.toFixed(3), fp: +x.c.s.fp.toFixed(3), toxic: +x.c.tox.toFixed(3), gemini: x.gem } })) };
      const a = new Set(local.map((x) => x.c.rec.im)), b = new Set(fin.map((x) => x.c.rec.im));
      explain[t] = { poolSize: cands[t].length, replacedByGemini: [...b].filter((x) => !a.has(x)).length };
      const pen = new Map((fin.penalised || []).map((x) => [x.c.rec.im, x.pen]));
      const row = (x, extra = {}) => ({ titre: x.c.rec.t, annee: x.c.rec.y, imdb: x.c.rec.im, rangLocal: x.localRank, adequation: x.gem ? Math.round(x.gem.fit) : null, risque: x.gem ? Math.round(x.gem.risk) : null, connaissance: x.gem && Number.isFinite(x.gem.know) ? Math.round(x.gem.know) : null, procheDesAdores: x.gem && x.gem.sim ? Math.round(x.gem.sim.adores) : undefined, procheDesNonAimes: x.gem && x.gem.sim ? Math.round(x.gem.sim.nonAimes) : undefined, motif: x.gem && x.gem.note ? x.gem.note : undefined, ...extra });
      const ent = fin.filter((x) => !a.has(x.c.rec.im)).map((x) => row(x, { rangFinal: fin.indexOf(x) + 1 }));
      const sor = local.filter((x) => !b.has(x.c.rec.im)).map((x) => { const g = adj && adj.get(x.c.rec.im); const p = pen.get(x.c.rec.im) || 0; return row({ ...x, gem: g ? { fit: g.fit, risk: g.risk, know: g.know, incomp: g.incomp, note: g.note, sim: g.sim } : null }, { raison: p >= 0.2 ? `malus de Gemini (${p.toFixed(2)})` : 'mélange 65/35' }); });
      explain[t].entrants = ent; explain[t].sortants = sor; explain[t].nbPenalises = (fin.penalised || []).length;
      explain[t].penalises = (fin.penalised || []).slice(0, 40).map((x) => row(x, { malus: +x.pen.toFixed(2), dansLeTop: b.has(x.c.rec.im) }));
      finRecs[t] = fin.map((x) => x.c.rec);
    }
    if (!Object.keys(sections).length) throw new Error('aucun résultat valide à publier');
    this.setStage(uid, job, 'publication', 'publication atomique');
    // classement "favoris estimés" : TOUS tes titres (vus, notés ou non), du plus au moins probable coup de cœur d'après des estimations
    // HORS ÉCHANTILLON (chaque titre est noté par un modèle qui ne l'a pas vu pendant son apprentissage) ; mélange 70/30 type/global comme en production.
    const favorites = {};
    try {
      const oofOf = (p) => { const m = new Map(); if (p && p.keys && p.task1 && p.taskLove) p.keys.forEach((k, j) => m.set(k, { pos: p.task1.oof[j], love: p.taskLove.oof[j] })); return m; };
      const gm = oofOf(profiles.global);
      for (const t of TYPES) {
        const tm = profiles[t] && profiles[t] !== profiles.global ? oofOf(profiles[t]) : null;
        const rows = labeled.filter((i) => i.rec.k === t[0]).map((i) => {
          const g = gm.get(i.key), a = tm && tm.get(i.key); if (!g && !a) return null;
          return { i, love: a && g ? 0.7 * a.love + 0.3 * g.love : (a || g).love, pos: a && g ? 0.7 * a.pos + 0.3 * g.pos : (a || g).pos };
        }).filter(Boolean).sort((x, y) => y.love - x.love || y.pos - x.pos);
        const tag = (l) => (l === 2 ? '❤️ Love' : l === 1 ? '👍 Like' : 'vu sans note');
        const share = (n) => { const s = rows.slice(0, n); return { love: s.filter((x) => x.i.label === 2).length, like: s.filter((x) => x.i.label === 1).length, sansNote: s.filter((x) => x.i.label === 0).length }; };
        const loveRanks = rows.map((x, r) => (x.i.label === 2 ? r + 1 : 0)).filter(Boolean);
        favorites[t] = {
          totalTitres: rows.length, partDeLoveDansTonHistorique: +(rows.filter((x) => x.i.label === 2).length / Math.max(1, rows.length)).toFixed(3),
          top10: share(10), top30: share(30),
          rangMedianDeTesLove: loveRanks.length ? loveRanks[Math.floor(loveRanks.length / 2)] : null,
          classement: rows.slice(0, 30).map((x, r) => ({ rang: r + 1, titre: x.i.rec.t, annee: x.i.rec.y, reel: tag(x.i.label), pCoupDeCoeur: +x.love.toFixed(2), pApprecie: +x.pos.toFixed(2) }))
        };
      }
    } catch (e) { log('warn', 'favoris estimés en échec', e.message); }
    // détection VF (séries, MODE INFORMATION : n'exclut rien ; toute erreur est ignorée)
    let vfReport = null;
    try {
      const vfKey = user.secrets.rapidapi;
      if (settings.series.vfCheck === false) vfReport = { active: false, raison: 'désactivée dans la configuration' };
      else if (!vfKey) vfReport = { active: false, raison: 'aucune clé enregistrée' };
      else if (finRecs.series) { vfReport = await spans.wrap('vf', () => this.vf.annotate(finRecs.series, { apiKey: vfKey, tmdb, gate, ctx: vfCtx || undefined })); vfReport.mode = 'exclusion : séries d\'origine asiatique ou turque sans VF (VOSTFR, VO seule, absente des plateformes FR) ; « inconnu » = gardée'; vfReport.exclusions = vfExcluded; await this.vf.save(); }
      else vfReport = { active: true, raison: 'catalogue séries non recalculé dans cette passe' };
    } catch (e) { log('warn', 'détection VF en échec (ignorée)', e.message); vfReport = { active: true, erreur: String(e.message).slice(0, 120) }; }
    // signaux Stremio bruts des titres du Top 30 déjà présents dans la bibliothèque (pour comprendre un cas "déjà vu")
    const libTop = {};
    try {
      const byImdb = new Map(classified.map((c) => [c.imdb, c]));
      for (const t of Object.keys(sections)) libTop[t] = sections[t].items.map((x, i) => ({ x, i })).filter(({ x }) => byImdb.has(x.imdb)).map(({ x, i }) => { const c = byImdb.get(x.imdb); return { rang: i + 1, titre: x.meta && x.meta.name, imdb: x.imdb, signaux: c.why || null, decision: c.seen ? 'vu' : c.started ? 'commencé' : 'rien', statut: statuses.get(x.imdb) }; });
    } catch { /* facultatif */ }
    // suivi de la précision RÉELLE : parmi le Top 30 précédemment publié, qu'as-tu noté depuis ? ("vu sans note" compté à part : oublis possibles)
    try {
      const prevRes = await this.results.getFast(uid); const loveS = new Set(), likeS = new Set(), unratedS = new Set();
      for (const c of classified) { const st = statuses.get(c.imdb); if (st === 'love') loveS.add(c.imdb); else if (st === 'like') likeS.add(c.imdb); else if (st === 'none' && c.seen) unratedS.add(c.imdb); }
      job.precision = job.precision || [];
      for (const t of TYPES) {
        const sec = prevRes && prevRes[t]; if (!sec || !sec.items || !sec.buildId || sec.buildId === job.buildId) continue;
        const ids = sec.items.map((x) => x.imdb);
        const row = { buildId: sec.buildId, type: t, builtAt: sec.builtAt || null, checkedAt: clock.now(), shown: ids.length, love: ids.filter((i) => loveS.has(i)).length, like: ids.filter((i) => likeS.has(i)).length, seenUnrated: ids.filter((i) => unratedS.has(i)).length };
        row.unseen = row.shown - row.love - row.like - row.seenUnrated;
        job.precision = job.precision.filter((x) => !(x.buildId === row.buildId && x.type === t)); job.precision.push(row);
      }
      job.precision = job.precision.slice(-12);
    } catch (e) { log('warn', 'suivi de précision', e.message); }
    const pub = await spans.wrap('publish', () => this.results.publish(uid, sections, { buildId: job.buildId }));
    await spans.wrap('cache_flush', () => tmdb.flushPersisted());
    await this.store.setJson(cfg.key.snap(uid), this._makeSnap(classified, statuses), 'snap-save'); this.snaps.set(uid, this._makeSnap(classified, statuses));
    Object.assign(job, { engine: cfg.ENGINE_VERSION, labelFP, settingsFP: { movie: cfg.settingsFingerprint(settings, 'movie'), series: cfg.settingsFingerprint(settings, 'series') }, lastSuccessAt: clock.now(), nextEligibleAt: nextZurichMidnight() });
    if (mode !== 'rerank') { job.lastFullDay = today; job.lastCheckDay = today; }
    return { outcome: 'published', report: { imdb: job.imdb, favorites, vf: vfReport, bibliotheque: libTop, surprises, counts: { ...counts, stateMatrix: stateMatrixOf(classified, statuses), seriesSamples: seriesSamplesOf(classified, statuses) }, taste: job.taste, recheck, candidates: dstats, arbitrage: { ...arb, ...explain }, dna: { source: dna.source, adn: dna.adn }, toxicRecipes: toxic.map((x) => x.id), persisted: pub.persisted, risk, chosenVariant: chosen.id } };
  }

  // ---------- lecture pour l'UI / le diagnostic ----------
  async vfView(user) {
    try { await this.vf.load(); } catch { /* facultatif */ }
    const hasKey = !!(user && user.secrets && user.secrets.rapidapi);
    return { ...this.vf.view(hasKey), hasKey, enabled: !user || user.settings.series.vfCheck !== false };
  }
  async vfTest(uid) {
    const user = await this.users.get(uid);
    if (!user) return { ok: false, pastille: 'grey', message: 'profil inconnu' };
    try { return await this.vf.testNow(user.secrets.rapidapi); } catch (e) { return { ok: false, pastille: 'red', message: String(e.message).slice(0, 100) }; }
  }
  status(uid) {
    const job = this.jobs.get(uid) || {}; const p = this.progress.get(uid) || null;
    const res = this.results.ram.get(uid) || {};
    return { running: this.running.has(uid), stage: job.stage || null, progress: p, mode: job.mode || null, reason: job.reason || null, lastSuccessAt: job.lastSuccessAt || null, lastRun: job.lastRun ? { ok: job.lastRun.ok, outcome: job.lastRun.outcome, durationHuman: job.lastRun.durationHuman, endedAt: job.lastRun.endedAt, error: job.lastRun.error } : null, engine: cfg.ENGINE_VERSION, ready: { movie: res.movie ? res.movie.items.length : 0, series: res.series ? res.series.items.length : 0 }, nextEligibleAt: job.nextEligibleAt || null, lastCheckDay: job.lastCheckDay || null };
  }
}

function explainProfile(profile, namer, n = 12) {
  const base = profile && profile.task1 && profile.task1.base; if (!base) return { positive: [], negative: [] };
  const arr = [];
  for (const [k, j] of base.A.dict) { if (/^(fmt|w|a):/.test(k)) continue; arr.push([k, base.A.m.wS[j]]); }
  arr.sort((a, b) => b[1] - a[1]);
  return { positive: arr.slice(0, n).filter((x) => x[1] > 0.05).map(([k, w]) => ({ name: nameOfKey(namer, k), weight: +w.toFixed(2) })), negative: arr.slice(-n).reverse().filter((x) => x[1] < -0.05).map(([k, w]) => ({ name: nameOfKey(namer, k), weight: +w.toFixed(2) })) };
}

// Répartition des signaux Stremio (T = fois vu, F = marqué vu, b = bitfield d'épisodes) et de la décision prise ("vu", "commencé", "rien").
// Sert à vérifier, sur les vraies données, que la décision "vu" d'une SÉRIE repose bien sur le marquage global et non sur des épisodes isolés.
function parseWhy(why) { const m = /T(\d+) F(\d+) R([\d.]+)/.exec(why || ''); return m ? { t: Number(m[1]), f: Number(m[2]), r: Number(m[3]), w: /\sW/.test(why), b: /\sb\b/.test(why) } : null; }
function stateMatrixOf(classified, statuses) {
  const out = {};
  for (const c of classified) {
    const p = parseWhy(c.why); if (!p) continue;
    const k = `${c.type === 'series' ? 'série' : 'film'} | T${p.t > 0 ? '+' : '0'} F${p.f > 0 ? '+' : '0'}${p.b ? ' épisodes' : ''}${p.r >= 0.7 ? ' R≥70%' : ''} → ${c.seen ? 'VU' : c.started ? 'commencé' : 'rien'}`;
    out[k] = (out[k] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}
function seriesSamplesOf(classified, statuses) {
  return classified.filter((c) => c.type === 'series' && c.why && (c.seen || c.started)).slice(0, 15).map((c) => ({ imdb: c.imdb, why: c.why, decision: c.seen ? 'vu' : 'commencé', statut: statuses.get(c.imdb) }));
}

module.exports = { SyncEngine, explainProfile, TYPES, stateMatrixOf, seriesSamplesOf, parseWhy };
