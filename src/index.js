'use strict';
const { Store } = require('./store');
const { Users } = require('./users');
const { Results } = require('./results');
const { SyncEngine } = require('./sync');
const { createApp } = require('./server');
const { log } = require('./util');
const { ENGINE_VERSION } = require('./config');

const store = new Store({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
const users = new Users(store);
const results = new Results(store);
const engine = new SyncEngine({ store, users, results });
const server = createApp({ store, users, engine, results, started: Date.now() });
const port = Number(process.env.PORT || 10000);
server.listen(port, '0.0.0.0', () => {
  log('info', `Addon v${ENGINE_VERSION} à l'écoute sur ${port} (Upstash: ${store.enabled ? 'oui' : 'NON'}, CONFIG_SECRET: ${process.env.CONFIG_SECRET ? 'oui' : 'NON'}, DIAG_TOKEN: ${process.env.DIAG_TOKEN ? 'oui' : 'NON'})`);
  setTimeout(() => engine.resumeAll().catch((e) => log('error', 'reprise', e.message)), 2000).unref();
});
process.on('SIGTERM', () => { log('info', 'SIGTERM : arrêt propre (le job en cours sera repris au prochain démarrage)'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
process.on('unhandledRejection', (e) => log('error', 'unhandledRejection', String(e && e.message || e)));
