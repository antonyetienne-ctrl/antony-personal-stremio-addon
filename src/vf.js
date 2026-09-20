'use strict';
// Détection VF (piste audio française) via l'API Streaming Availability (RapidAPI). MODE INFORMATION : n'exclut RIEN, ne change pas le Top 30.
// Module isolé : le retirer = supprimer ce fichier et ses 3 points d'appel (sync.js, server.js, ui.js).
// Règles validées :
//  - "VF" : gardé pour toujours, jamais revérifié (même si l'API disparaît) ;
//  - VOSTFR / VO seule / absent des plateformes FR : revérifié au plus une fois par semaine ;
//  - si la vérification est impossible : on garde l'ancien statut, SAUF si l'API est muette depuis plus de 6 mois ET que la série est
//    récente (dernier épisode < 6 mois, ou série en cours) : statut "inconnu" (un doublage peut encore arriver) ;
//  - séries françaises/américaines : non concernées ; animes : exemptés ; aucun appel pour eux.
const { fetchJson, clock, log, zurichDay, HttpError, redact } = require('./util');
const { key } = require('./config');
const { isAnime } = require('./filters');

const HOST = process.env.VF_API_HOST || 'streaming-availability.p.rapidapi.com';
const BASE = process.env.VF_API_BASE || `https://${HOST}`;
const WEEK = 7 * 864e5, SIX_MONTHS = 183 * 864e5;
const MAX_PER_BUILD = () => Number(process.env.VF_MAX_PER_BUILD || 40);
const DAILY_CAP = () => Number(process.env.VF_DAILY_CAP || 800);      // marge sous les 1 000 requêtes/jour du plan gratuit
const DIRECT_BASE = process.env.VF_API_BASE_DIRECT || 'https://api.movieofthenight.com/v4';
const isDirectKey = (k) => /^motn-key-/i.test(String(k || ''));      // clé obtenue sur developers.movieofthenight.com (API directe v4)
const TEST_IMDB = 'tt0903747';                                       // série connue, pour le bouton "Tester maintenant"
const FR = new Set(['fr', 'fra', 'fre', 'french', 'français', 'francais']);
const LABEL = { vf: 'VF', vostfr: 'VOSTFR', vo: 'VO seule', absent: 'absente des plateformes FR', inconnu: 'inconnu' };

const langOf = (x) => { if (!x) return null; if (typeof x === 'string') return x.toLowerCase(); const l = x.language || (x.locale && x.locale.language) || x.code || x.iso639_2 || x.iso639_1; return l ? String(l).toLowerCase() : null; };
const langs = (a) => (Array.isArray(a) ? a : []).map(langOf).filter(Boolean);
const serviceName = (o) => (o && o.service && (o.service.name || o.service.id)) || '?';

// Lecture tolérante d'une réponse "show" (structure exacte à confirmer sur les vraies réponses : voir la trace du diagnostic).
function analyse(show) {
  const so = show && show.streamingOptions;
  const opts = so && (so.fr || so.FR);
  if (!Array.isArray(opts) || !opts.length) return { statut: 'absent', audios: [], sousTitresFr: false, plateformes: [], vfSur: [] };
  const audios = new Set(), vfSur = new Set(); let subFr = false, anyAudio = false;
  for (const o of opts) {
    const a = langs(o.audios); if (a.length) anyAudio = true;
    a.forEach((l) => audios.add(l));
    if (a.some((l) => FR.has(l))) vfSur.add(serviceName(o));
    if (langs(o.subtitles).some((l) => FR.has(l))) subFr = true;
  }
  const plateformes = [...new Set(opts.map(serviceName))];
  const base = { audios: [...audios], sousTitresFr: subFr, plateformes, vfSur: [...vfSur] };
  if (vfSur.size) return { statut: 'vf', ...base };
  if (!anyAudio) return { statut: 'inconnu', note: 'aucune langue audio renseignée par l\'API', ...base };
  return { statut: subFr ? 'vostfr' : 'vo', ...base };
}
const isJapaneseAnimation = (rec) => (rec.g || []).includes(16) && isAnime(rec);
const isFrUs = (rec) => (rec.ct || []).some((c) => c === 'FR' || c === 'US') || rec.ol === 'fr';
const dotOf = (health, hasKey) => (!hasKey || !health || (!health.lastOkAt && !health.lastFailAt) ? 'grey' : health.lastOkAt && (!health.lastFailAt || health.lastOkAt >= health.lastFailAt) ? 'green' : 'red');

class VF {
  constructor({ store }) { this.store = store; this.items = new Map(); this.health = {}; this.loaded = false; this.dirty = false; this.trace = []; }
  async load() {
    if (this.loaded) return;
    const s = await this.store.getJson(key.vf, 'vf-load');
    if (s === undefined) return;                                     // Upstash indisponible : on réessaiera
    this.loaded = true;
    if (s && s.items) { for (const [k, v] of Object.entries(s.items)) this.items.set(k, v); this.health = s.health || {}; }
  }
  async save() {
    if (!this.dirty) return true;
    const ok = await this.store.setJson(key.vf, { v: 1, items: Object.fromEntries(this.items), health: this.health }, 'vf-save');
    if (ok) this.dirty = false; return ok;
  }
  _day() { const d = zurichDay(); if (this.health.day !== d) { this.health.day = d; this.health.callsToday = 0; } }
  _ok(now) { this.health.lastOkAt = now; this.health.lastError = null; this.health.lastBody = null; this.health.lastCode = 200; this.dirty = true; }
  _fail(err, now) {
    this.health.lastFailAt = now; this.health.lastCode = err instanceof HttpError ? err.status : null; this.dirty = true;
    this.health.lastBody = err instanceof HttpError && err.body ? redact(String(err.body)).slice(0, 200) : null;     // message renvoyé par l'API (sans clé)
    this.health.lastError = err instanceof HttpError ? (err.status === 401 || err.status === 403 ? 'clé refusée par l\'API' : err.status === 429 ? 'quota de requêtes épuisé' : `erreur HTTP ${err.status}`) : 'API injoignable (réseau ou délai dépassé)';
  }
  async _fetch(imdb, apiKey) {
    const direct = isDirectKey(apiKey); this.health.mode = direct ? 'API directe (developers.movieofthenight.com)' : 'RapidAPI';
    const u = new URL(`${direct ? DIRECT_BASE : BASE}/shows/${imdb}`); u.searchParams.set('country', 'fr');
    const headers = direct ? { 'X-API-Key': apiKey, accept: 'application/json' } : { 'X-RapidAPI-Key': apiKey, 'X-RapidAPI-Host': HOST, accept: 'application/json' };
    const res = await fetchJson(u, { headers, timeoutMs: 9000, retries: 0, label: 'vf-api' });
    const so = res && res.streamingOptions; const fr = so && (so.fr || so.FR);
    this.trace.push({ imdb, at: new Date(clock.now()).toISOString(), cles: res && typeof res === 'object' ? Object.keys(res).slice(0, 10) : typeof res, pays: so ? Object.keys(so).slice(0, 8) : null, optionsFr: Array.isArray(fr) ? fr.length : null, exempleOption: Array.isArray(fr) && fr[0] ? Object.keys(fr[0]).slice(0, 10) : null, exempleAudios: Array.isArray(fr) && fr[0] && Array.isArray(fr[0].audios) ? fr[0].audios.slice(0, 2) : null });
    if (this.trace.length > 4) this.trace.shift();
    return res;
  }
  async _lastAir(tmdb, rec) {
    if (rec.la) return Date.parse(rec.la) || null;
    if (!tmdb) return null;
    try { const d = await tmdb.get(`/tv/${rec.i}`, {}, { label: 'last-air', timeoutMs: 8000 }); return Date.parse(d && d.last_air_date) || null; } catch { return null; }
  }
  _recent(e, rec, now) { return rec.st === 'Returning Series' || e.st === 'Returning Series' || !e.la || now - e.la < SIX_MONTHS; }

  // recs : séries du Top 30 (fiches compactes). Renvoie le rapport. N'exclut rien.
  async annotate(recs, { apiKey, tmdb, gate }) {
    await this.load(); this._day();
    const now = clock.now(); let calls = 0, stop = false, consecutiveFails = 0; const rows = [];
    const silent = this.health.lastOkAt ? now - this.health.lastOkAt : Infinity;
    for (const [i, rec] of recs.entries()) {
      const row = { rang: i + 1, titre: rec.t, annee: rec.y, imdb: rec.im, pays: (rec.ct || []).join(',') || null, langueOriginale: rec.ol || null };
      if (isFrUs(rec)) { row.statut = 'non concerné (série française ou américaine)'; rows.push(row); continue; }
      if (isJapaneseAnimation(rec)) { row.statut = 'exempté (anime)'; rows.push(row); continue; }
      let e = this.items.get(rec.im), verified = false;
      const due = !e || (e.s !== 'vf' && now - (e.t || 0) >= WEEK);
      if (due && apiKey && !stop && calls < MAX_PER_BUILD() && (this.health.callsToday || 0) < DAILY_CAP()) {
        try {
          calls++; this.health.callsToday = (this.health.callsToday || 0) + 1;
          const show = await this._fetch(rec.im, apiKey); const a = analyse(show);
          const la = await this._lastAir(tmdb, rec);
          e = { s: a.statut, t: now, a: a.audios, sf: a.sousTitresFr, p: a.plateformes, vs: a.vfSur, la, st: rec.st || null };
          this.items.set(rec.im, e); this._ok(now); verified = true; consecutiveFails = 0;
        } catch (err) {
          this._fail(err, now); consecutiveFails++;
          if (err instanceof HttpError && [401, 403, 429].includes(err.status)) stop = true;
          if (consecutiveFails >= 2) stop = true;
        }
      }
      if (gate) await gate();
      if (!e) { row.statut = 'inconnu (jamais vérifié)'; row.source = apiKey ? (stop ? 'API indisponible' : 'budget de requêtes atteint') : 'aucune clé'; rows.push(row); continue; }
      let statut = e.s;
      if (e.s !== 'vf' && !verified && due) {                               // vérification due mais impossible
        if (silent > SIX_MONTHS && this._recent(e, rec, now)) statut = 'inconnu';
      }
      row.statut = statut === 'inconnu' && e.s !== 'inconnu' ? 'inconnu (expiré : série récente, API muette depuis plus de 6 mois)' : (LABEL[statut] || statut);
      row.audios = e.a; row.sousTitresFr = e.sf; row.plateformes = e.p; row.verifieLe = new Date(e.t).toISOString().slice(0, 10);
      row.source = verified ? 'API (vérifié maintenant)' : due ? 'cache (non revérifié : API indisponible)' : e.s === 'vf' ? 'cache (VF conservé)' : 'cache (vérifié il y a moins d\'une semaine)';
      rows.push(row);
    }
    const tally = {}; for (const r of rows) { const k = r.statut.split(' (')[0]; tally[k] = (tally[k] || 0) + 1; }
    return { active: true, mode: 'information : rien n\'est exclu', requetesCeCalcul: calls, requetesAujourdhui: this.health.callsToday || 0, sante: { ...this.health, pastille: dotOf(this.health, true) }, cache: this.items.size, bilan: tally, series: rows, trace: this.trace.slice(-2) };
  }

  // Bouton "Tester maintenant" : UNE requête.
  async testNow(apiKey) {
    await this.load(); this._day(); const now = clock.now(); const t0 = Date.now();
    if (!apiKey) return { ok: false, pastille: 'grey', message: 'aucune clé enregistrée' };
    try {
      this.health.callsToday = (this.health.callsToday || 0) + 1;
      const a = analyse(await this._fetch(TEST_IMDB, apiKey)); this._ok(now); await this.save();
      return { ok: true, pastille: 'green', message: `L'API répond (${Date.now() - t0} ms).`, exemple: { statut: LABEL[a.statut] || a.statut } };
    } catch (err) { this._fail(err, now); await this.save(); return { ok: false, pastille: 'red', message: this.health.lastError }; }
  }
  view(hasKey) { const h = this.health || {}; return { pastille: dotOf(h, hasKey), lastOkAt: h.lastOkAt || null, lastFailAt: h.lastFailAt || null, lastError: h.lastError || null, callsToday: h.callsToday || 0, cache: this.items.size }; }
}

module.exports = { VF, analyse, dotOf, isFrUs, LABEL, WEEK, SIX_MONTHS };
