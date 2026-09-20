'use strict';
// Comptes : identifiant opaque (l'URL du manifest ne contient AUCUN secret), réglages, clés chiffrées AES-256-GCM
// avec CONFIG_SECRET (obligatoire, sinon aucune clé n'est stockée : échec fermé).
const crypto = require('crypto');
const { registerSecret, clock, log } = require('./util');
const { defaultSettings, normalizeSettings, key } = require('./config');

let derived = null, derivedFrom = null;
function encKey() {
  const s = process.env.CONFIG_SECRET || '';
  if (s.length < 16) return null;
  if (derivedFrom !== s) { derived = crypto.scryptSync(s, 'antony-av7', 32); derivedFrom = s; }
  return derived;
}
const secretsReady = () => Boolean(encKey());
function encrypt(obj) {
  const k = encKey(); if (!k) throw new Error('CONFIG_SECRET manquant ou trop court (16 caractères minimum)');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return 'v1.' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}
function decrypt(str) {
  const k = encKey(); if (!k || typeof str !== 'string' || !str.startsWith('v1.')) return null;
  try {
    const raw = Buffer.from(str.slice(3), 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', k, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
  } catch { return null; }
}
const mask = (v) => (!v ? '' : v.length <= 8 ? '••••' : '••••' + v.slice(-4));

class Users {
  constructor(store, { maxUsers = Number(process.env.MAX_USERS || 2) } = {}) {
    this.store = store; this.maxUsers = maxUsers;
    this.ram = new Map();       // id -> {id, createdAt, updatedAt, settings, secrets}
    this.dirty = new Set();     // ids dont la sauvegarde Upstash a échoué
  }
  _reg(u) { for (const v of Object.values(u.secrets || {})) registerSecret(v); }
  async get(id) {
    if (!/^[A-Za-z0-9_-]{16,40}$/.test(String(id || ''))) return null;
    if (this.ram.has(id)) return this.ram.get(id);
    const rec = await this.store.getJson(key.user(id), 'user');
    if (!rec) return null;
    const secrets = decrypt(rec.enc) || {};
    const u = { id, createdAt: rec.createdAt, updatedAt: rec.updatedAt, settings: normalizeSettings(rec.settings || {}), secrets };
    this._reg(u); this.ram.set(id, u);
    return u;
  }
  async count() { const m = await this.store.smembers(key.users, 'user'); return Array.isArray(m) ? m.length : this.ram.size; }
  async list() { const m = await this.store.smembers(key.users, 'user'); return Array.isArray(m) ? m : [...this.ram.keys()]; }
  async create({ secrets = {}, settings = {} } = {}) {
    if (!secretsReady()) throw new Error('CONFIG_SECRET manquant ou trop court : ajoute cette variable dans Render (16 caractères minimum)');
    if ((await this.count()) >= this.maxUsers) throw new Error(`Nombre maximal de profils atteint (${this.maxUsers}). Utilise ton lien personnel de configuration.`);
    const id = crypto.randomBytes(16).toString('base64url');
    const u = { id, createdAt: clock.now(), updatedAt: clock.now(), settings: normalizeSettings(settings, defaultSettings()), secrets: cleanSecrets(secrets, {}) };
    this._reg(u); this.ram.set(id, u);
    const ok = await this._persist(u);
    if (ok) await this.store.sadd(key.users, id, 'user');
    return { user: u, persisted: ok };
  }
  // patch.secrets : un champ vide CONSERVE l'ancienne valeur ; patch.clear = ['gemini'] pour supprimer explicitement
  async update(id, patch = {}) {
    const u = await this.get(id); if (!u) throw new Error('profil inconnu');
    if (patch.secrets) u.secrets = cleanSecrets(patch.secrets, u.secrets);
    for (const c of patch.clear || []) if (c === 'gemini') delete u.secrets.gemini;
    if (patch.settings) u.settings = normalizeSettings(patch.settings, u.settings);
    u.updatedAt = clock.now(); this._reg(u);
    const ok = await this._persist(u);
    return { user: u, persisted: ok };
  }
  async _persist(u) {
    const ok = await this.store.setJson(key.user(u.id), { v: 1, createdAt: u.createdAt, updatedAt: u.updatedAt, settings: u.settings, enc: encrypt(u.secrets) }, 'user');
    if (ok) this.dirty.delete(u.id); else this.dirty.add(u.id);
    return ok;
  }
  async retryDirty() { for (const id of [...this.dirty]) { const u = this.ram.get(id); if (u) await this._persist(u); } }
  // vue publique : jamais de valeur en clair
  view(u) { return { id: u.id, settings: u.settings, keys: { tmdb: mask(u.secrets.tmdb), stremio: mask(u.secrets.stremio), gemini: mask(u.secrets.gemini), rapidapi: mask(u.secrets.rapidapi) }, has: { tmdb: !!u.secrets.tmdb, stremio: !!u.secrets.stremio, gemini: !!u.secrets.gemini, rapidapi: !!u.secrets.rapidapi } }; }
}
function cleanSecrets(input, prev) {
  const out = { ...prev };
  for (const k of ['tmdb', 'stremio', 'gemini', 'rapidapi']) {
    const v = typeof input[k] === 'string' ? input[k].trim() : '';
    if (v && !/^•+/.test(v)) out[k] = v;   // vide (ou valeur masquée renvoyée par le formulaire) => on garde l'ancienne
  }
  return out;
}

module.exports = { Users, encrypt, decrypt, secretsReady, mask };
