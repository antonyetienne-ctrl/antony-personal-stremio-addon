'use strict';
// Routes HTTP. Règles : /catalog et /meta ne déclenchent JAMAIS de calcul lourd ; aucun secret dans une URL,
// un manifest, une réponse ou un log ; /diagnostic protégé par DIAG_TOKEN.
const http = require('http');
const crypto = require('crypto');
const { log, redact, fetchJson, clock, activity } = require('./util');
const cfg = require('./config');
const { secretsReady } = require('./users');
const ui = require('./ui');
const diag = require('./diag');
const { buildMeta } = require('./meta');

const json = (res, code, obj, headers = {}) => { const b = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }); res.end(b); };
const html = (res, code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...headers }); res.end(body); };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
const readBody = (req, max = 100000) => new Promise((resolve, reject) => { let d = '', n = 0; req.on('data', (c) => { n += c.length; if (n > max) { reject(new Error('corps trop volumineux')); req.destroy(); } else d += c; }); req.on('end', () => resolve(d)); req.on('error', reject); });
const hostOf = (req) => `${(req.headers['x-forwarded-proto'] || 'https').split(',')[0]}://${req.headers.host}`;
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function manifestFor(user) {
  const c = user.settings.common; const catalogs = [];
  if (c.movieCatalog) catalogs.push({ type: 'movie', id: 'antony_movies', name: '🎯 Recommandations selon vos Goûts', extra: [{ name: 'skip' }] });
  if (c.seriesCatalog) catalogs.push({ type: 'series', id: 'antony_series', name: '🎯 Recommandations selon vos Goûts', extra: [{ name: 'skip' }] });
  return { id: 'com.antony.personalrecommendations', version: cfg.ENGINE_VERSION, name: 'Recommandations personnelles', description: 'Recommandations apprises de vos ❤️, 👍 et des contenus vus sans appréciation. Métadonnées en français.',
    resources: c.frMeta ? ['catalog', { name: 'meta', types: ['movie', 'series'], idPrefixes: ['tt'] }] : ['catalog'], types: ['movie', 'series'], idPrefixes: ['tt'], catalogs, behaviorHints: { configurable: true, configurationRequired: false } };
}

// formulaire -> {secrets, clear, settings}
function parseForm(body) {
  const p = new URLSearchParams(body); const g = (k) => p.get(k);
  const settings = { movie: {}, series: {}, common: {} };
  for (const t of ['movie', 'series']) {
    for (const k of ['minRating', 'minVotes', 'minRuntime', 'minYear', 'order', 'ratingMode']) if (p.has(`${t}.${k}`)) settings[t][k] = g(`${t}.${k}`);
    settings[t].noWesternAnimation = p.has(`${t}.noWesternAnimation`);
    if (p.has(`${t}.exclude__present`)) settings[t].exclude = p.getAll(`${t}.exclude`);
  }
  for (const k of ['excludeCancelled', 'movieCatalog', 'seriesCatalog', 'frMeta', 'useGemini']) settings.common[k] = p.has(`common.${k}`);
  if (p.has('common.watch')) settings.common.watch = String(p.get('common.watch')).split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  return { secrets: { tmdb: g('tmdb') || '', stremio: g('stremio') || '', gemini: g('gemini') || '' }, clear: p.has('clearGemini') ? ['gemini'] : [], settings };
}

function createApp({ store, users, engine, results, started = Date.now() }) {
  const diagToken = () => process.env.DIAG_TOKEN || '';
  async function handle(req, res) {
    const u = new URL(req.url, 'http://x'); const path = u.pathname; const method = req.method;
    if (method === 'OPTIONS') { res.writeHead(204, { ...CORS, 'access-control-allow-methods': 'GET,POST,OPTIONS' }); return res.end(); }
    if (path === '/health') return json(res, 200, { ok: true, version: cfg.ENGINE_VERSION, upstash: store.enabled && store.available });

    if (path === '/diagnostic' || path === '/diag' || path.startsWith('/diag/') || path.startsWith('/diagnostic/')) {
      if (!diagToken()) return json(res, 503, { error: 'DIAG_TOKEN non défini sur le serveur' });
      const t = u.searchParams.get('token') || req.headers['x-diag-token'] || '';
      if (!safeEq(t, diagToken())) return json(res, 401, { error: 'non autorisé' });
      return json(res, 200, diag.build({ store, users, engine, results, started }));
    }
    if (path === '/configure') {
      if (method === 'GET') {
        const n = await users.count();
        if (n >= users.maxUsers) return html(res, 200, ui.page({ mode: 'blocked', view: null, host: hostOf(req), notice: { kind: 'warn', text: 'Un profil existe déjà. Rouvre ta page de configuration depuis la molette ⚙️ de l\'addon dans Stremio (ou avec ton lien personnel).' }, secretsReady: secretsReady() }).replace(/<form[\s\S]*<\/form>/, ''));
        return html(res, 200, ui.page({ mode: 'setup', view: null, host: hostOf(req), secretsReady: secretsReady() }));
      }
      if (method === 'POST') {
        try {
          const f = parseForm(await readBody(req));
          if (!f.secrets.tmdb || !f.secrets.stremio) throw new Error('TMDB (Read Access Token) et AuthKey Stremio sont obligatoires');
          const { user } = await users.create({ secrets: f.secrets, settings: f.settings });
          engine._runBg(user.id, { mode: 'full', force: true, reason: 'premier calcul' });
          res.writeHead(303, { location: `/u/${user.id}/configure?created=1` }); return res.end();
        } catch (e) { return html(res, 400, ui.page({ mode: 'setup', view: null, host: hostOf(req), notice: { kind: 'err', text: redact(e.message) }, secretsReady: secretsReady() })); }
      }
    }
    const m = path.match(/^\/u\/([A-Za-z0-9_-]{16,40})\/(.*)$/);
    if (m) {
      const uid = m[1]; const rest = m[2];
      const user = await users.get(uid);
      if (!user) return json(res, 404, { error: 'introuvable' }, CORS);
      if (rest === 'manifest.json') { engine.touch(uid); return json(res, 200, manifestFor(user), { ...CORS, 'cache-control': 'no-store' }); }
      if (rest === 'configure' && method === 'GET') return html(res, 200, ui.page({ mode: 'edit', view: users.view(user), host: hostOf(req), notice: u.searchParams.has('created') ? { kind: 'ok', text: 'Profil créé. Le premier calcul complet a démarré : garde cette page ouverte jusqu\'à ce que les deux catalogues affichent leurs titres, puis installe l\'addon dans Stremio.' } : u.searchParams.has('saved') ? { kind: 'ok', text: 'Configuration enregistrée.' } : u.searchParams.has('warn') ? { kind: 'warn', text: 'Enregistré en mémoire seulement (Upstash indisponible) : nouvelle tentative automatique.' } : null, secretsReady: secretsReady() }));
      if (rest === 'config' && method === 'POST') {
        try {
          const before = { movie: cfg.settingsFingerprint(user.settings, 'movie'), series: cfg.settingsFingerprint(user.settings, 'series') };
          const f = parseForm(await readBody(req));
          const { user: nu, persisted } = await users.update(uid, { secrets: f.secrets, clear: f.clear, settings: f.settings });
          const changed = ['movie', 'series'].filter((t) => before[t] !== cfg.settingsFingerprint(nu.settings, t));
          engine.clients.delete(uid);               // clés éventuellement changées
          engine.onSettingsSaved(uid, changed).catch(() => {});
          res.writeHead(303, { location: `/u/${uid}/configure?${persisted ? 'saved=1' : 'warn=1'}` }); return res.end();
        } catch (e) { return html(res, 400, ui.page({ mode: 'edit', view: users.view(user), host: hostOf(req), notice: { kind: 'err', text: redact(e.message) }, secretsReady: secretsReady() })); }
      }
      if (rest === 'rebuild' && method === 'POST') return json(res, 200, engine.force(uid));
      if (rest === 'status') return json(res, 200, engine.status(uid));
      const c = rest.match(/^catalog\/(movie|series)\/(antony_movies|antony_series)(?:\/([^/]+?))?(?:\.json)?$/);
      if (c) {
        activity.mark(); engine.touch(uid);
        const type = c[1]; const skip = Number((/skip=(\d+)/.exec(c[3] || '') || [])[1] || 0);
        await results.getFast(uid);
        const metas = skip > 0 ? [] : results.ordered(uid, type, user.settings[type].order);
        return json(res, 200, { metas }, { ...CORS, 'cache-control': 'public, max-age=120' });
      }
      const mm = rest.match(/^meta\/(movie|series)\/(tt\d{5,12})(?:\.json)?$/);
      if (mm) {
        activity.mark();
        if (!user.settings.common.frMeta) return json(res, 404, { meta: null }, CORS);
        const cl = engine.clientsFor(user, engine.jobs.get(uid));
        try {
          const meta = await Promise.race([buildMeta(cl.tmdb, mm[1], mm[2]), new Promise((r) => setTimeout(() => r('timeout'), 7000))]);
          if (!meta || meta === 'timeout') return json(res, 404, { meta: null }, CORS);
          return json(res, 200, { meta }, { ...CORS, 'cache-control': 'public, max-age=3600' });
        } catch (e) { log('warn', 'meta indisponible', e.message); return json(res, 404, { meta: null }, CORS); }
      }
      return json(res, 404, { error: 'introuvable' }, CORS);
    }
    if (path === '/manifest.json') return json(res, 200, { id: 'com.antony.personalrecommendations', version: cfg.ENGINE_VERSION, name: 'Recommandations personnelles', description: 'Ouvre /configure pour créer ton profil.', resources: [], types: ['movie', 'series'], catalogs: [], behaviorHints: { configurable: true, configurationRequired: true } }, CORS);
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Recommandations personnelles — ouvre /configure');
  }
  return http.createServer((req, res) => handle(req, res).catch((e) => { log('error', 'requête', e && e.message); if (!res.headersSent) json(res, 500, { error: 'erreur interne' }); else res.end(); }));
}
module.exports = { createApp, manifestFor, parseForm };
