'use strict';
// Gemini (Google AI Studio) en REST, sans SDK ni dépendance. Facultatif et NON bloquant : toute erreur => null.
// Budget : ≤ 2 requêtes par synchronisation (1 "ADN + anti-recettes", mise en cache tant que l'historique est identique ;
// 1 "arbitrage" des candidats frontières Films+Séries) et un plafond quotidien dur (GEMINI_MAX_CALLS_PER_DAY, défaut 100 ; quota gratuit réel : 1 500 par jour et 15 par heure).
// Le modèle est choisi dynamiquement (models.list) : les IDs codés en dur disparaissent (gemini-1.5-flash est arrêté).
const { fetchJson, clock, zurichDay, log } = require('./util');

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const BAD_NAME = /(image|tts|live|audio|embedding|robotics|omni|preview|exp|thinking|vision|computer|customtools|gemma|learnlm|aqa|imagen|veo)/i;

function pickModel(models, { allowPreview = false } = {}) {
  const cands = [];
  for (const m of models || []) {
    const name = String(m.name || '').replace(/^models\//, '');
    if (!/^gemini-/.test(name) || !/flash/.test(name)) continue;
    if (!(m.supportedGenerationMethods || []).includes('generateContent')) continue;
    if (BAD_NAME.test(name.replace(/preview/i, allowPreview ? '' : 'preview'))) continue;
    const ver = Number((name.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1]) || 0;
    cands.push({ name, lite: /lite/.test(name), ver });
  }
  // les modèles "lite" ont le quota gratuit le plus large ; à égalité de famille, version la plus récente
  cands.sort((a, b) => (b.lite - a.lite) || (b.ver - a.ver) || a.name.localeCompare(b.name));
  return cands[0] ? cands[0].name : null;
}
function extractJson(text) {
  const t = String(text || '').replace(/^```(?:json)?/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(t); } catch { /* essai suivant */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* abandon */ } }
  return null;
}

class Gemini {
  constructor({ key, maxPerDay = Number(process.env.GEMINI_MAX_CALLS_PER_DAY || 100), model = process.env.GEMINI_MODEL || '', calls = null } = {}) {
    this.key = key; this.maxPerDay = maxPerDay; this.forced = model || ''; this.model = model || null;
    this.cooldownUntil = 0; this.disabledUntil = 0; this.lastError = null; this.modelCheckedAt = 0;
    this.calls = calls && calls.day === zurichDay() ? calls : { day: zurichDay(), count: 0 };
    this.stats = { requests: 0, ok: 0, errors: 0 };
    this.trace = [];          // 6 dernières réponses (extrait) : jamais de clé, uniquement du texte de réponse

  }
  get available() { return Boolean(this.key) && clock.now() >= this.cooldownUntil && clock.now() >= this.disabledUntil && this._quotaLeft() > 0; }
  _trace(e) { this.trace.push({ at: new Date(clock.now()).toISOString(), ...e }); if (this.trace.length > 6) this.trace.shift(); }
  _quotaLeft() { if (this.calls.day !== zurichDay()) this.calls = { day: zurichDay(), count: 0 }; return this.maxPerDay - this.calls.count; }
  _err(e) {
    this.stats.errors++; this.lastError = { at: new Date(clock.now()).toISOString(), status: e.status || null, message: String(e.message || e).slice(0, 160) };
    if (e.status === 429) this.cooldownUntil = clock.now() + 30 * 60e3;
    else if (e.status === 400 || e.status === 401 || e.status === 403) this.disabledUntil = clock.now() + 60 * 60e3;
    log('warn', 'Gemini indisponible : repli sur le scoring local', this.lastError);
  }
  async ensureModel() {
    if (this.forced) { this.model = this.forced; return this.model; }
    if (this.model && clock.now() - this.modelCheckedAt < 24 * 3600e3) return this.model;
    const r = await fetchJson(`${BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': this.key }, timeoutMs: 12000, retries: 1, label: 'gemini-models' });
    this.model = pickModel(r && r.models) || pickModel(r && r.models, { allowPreview: true });
    this.modelCheckedAt = clock.now();
    if (!this.model) throw Object.assign(new Error('aucun modèle Flash disponible pour cette clé'), { status: 404 });
    return this.model;
  }
  // Une requête generateContent -> objet JSON (ou null). Compte 1 appel sur le plafond quotidien.
  async json(prompt, { timeoutMs = 60000, maxTokens = 8192 } = {}) {
    if (!this.available) return null;
    try {
      let model = await this.ensureModel();
      this.calls.count++; this.stats.requests++;
      const call = () => fetchJson(`${BASE}/models/${model}:generateContent`, { method: 'POST', headers: { 'x-goog-api-key': this.key, 'content-type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, responseMimeType: 'application/json', maxOutputTokens: maxTokens } }), timeoutMs, retries: 1, label: 'gemini' });
      let res;
      try { res = await call(); }
      catch (e) { if (e.status === 404 && !this.forced) { this.model = null; this.modelCheckedAt = 0; model = await this.ensureModel(); res = await call(); } else throw e; }
      const text = ((res && res.candidates && res.candidates[0] && res.candidates[0].content && res.candidates[0].content.parts) || []).map((p) => p.text || '').join('');
      const obj = extractJson(text);
      this._trace({ ok: Boolean(obj), chars: text.length, head: text.slice(0, 300), shape: obj === null ? 'null' : Array.isArray(obj) ? `array[${obj.length}]` : `objet{${Object.keys(obj).slice(0, 6).join(',')}}` });
      if (!obj) throw new Error('réponse non JSON');
      this.stats.ok++;
      return obj;
    } catch (e) { this._trace({ ok: false, error: String(e.message).slice(0, 160), status: e.status || null }); this._err(e); return null; }
  }
}

// ---------- prompts (compacts : jamais l'historique complet) ----------
const card = (rec, extra = {}) => ({ titre: rec.t, annee: rec.y, genres: (rec.gn || []).slice(0, 4), mots_cles: (rec.kw || []).slice(0, 7).map((k) => k[1]), ...extra });
// ---------- PROMPTS (structures définies par l'utilisateur) ----------
// Échantillon représentatif : réparti par genre principal (tour à tour) pour qu'aucun genre aimé (fantastique, comédie…) ne disparaisse de l'ADN.
// ---- VARIANTE C (validée par l'utilisateur) : comparaison à l'historique par PROXIMITÉ, sans résumé d'ADN, sans filtres, sans jugement de qualité.
function comparePrompt({ candidats }) {
  return `Tu compares des candidats (films ou séries) à des titres de l'historique d'un spectateur. Tu ne juges JAMAIS la qualité ni la réputation d'un titre : seulement la ressemblance de l'expérience de visionnage.

Pour chaque candidat, tu reçois :
- ses caractéristiques (titre, année, genres, mots-clés, synopsis) ;
- "adores" : les 3 titres de l'historique que le spectateur a ADORÉS (❤️, coup de cœur : le signal positif maximal) et qui lui ressemblent le plus ;
- "apprecies" : les 2 titres de l'historique que le spectateur a APPRÉCIÉS (👍, franchement positif mais bien moins fort qu'un adoré) et qui lui ressemblent le plus ;
- "non_aimes" : les 3 titres de l'historique que le spectateur a vus SANS LES AIMER (✗) et qui lui ressemblent le plus.

Pour chaque candidat, réponds :
1. "proche_des_adores" (0-100) : à quel point l'expérience du candidat (univers, ton, rythme, type d'intrigue, humour, enjeux, public visé) ressemble à celle des titres adorés.
2. "proche_des_apprecies" (0-100) : la même question avec les titres appréciés (👍).
3. "proche_des_non_aimes" (0-100) : la même question avec les titres vus sans les aimer.
4. "connaissance" (0-100) : à quel point tu connais réellement ce titre. Titre récent ou peu connu : mets une valeur basse et compare d'après le synopsis, sans rien inventer.
5. "motif" : 14 mots maximum, qui nomme le titre voisin le plus proche.

Règles : compare uniquement l'expérience de visionnage ; un genre n'est ni bon ni mauvais en soi ; les trois notes sont indépendantes (un candidat peut ressembler à plusieurs groupes, ou à aucun) ; utilise toute l'échelle ; si les voisins fournis ne sont pas pertinents, dis-le par une note basse plutôt que de forcer une ressemblance.

Réponds UNIQUEMENT en JSON strict :
{"evaluations": [{"id": ..., "proche_des_adores": 0, "proche_des_apprecies": 0, "proche_des_non_aimes": 0, "connaissance": 0, "motif": "..."}]}

CANDIDATS : ${JSON.stringify(candidats)}`;
}

// Lecture tolérante de la réponse d'arbitrage : tableau direct ou objet, clés variantes, identifiants nus, scores en fraction (0-1) ou en points (0-100).

// ---- VARIANTE C (validée par l'utilisateur) : comparaison à l'historique par PROXIMITÉ, sans résumé d'ADN, sans filtres, sans jugement de qualité.
// Version SANS les titres 👍 (celle de la 7.7.0) : sert au grand test comparatif (src/gemab.js)
function comparePromptSans({ candidats }) {
  return `Tu compares des candidats (films ou séries) à des titres de l'historique d'un spectateur. Tu ne juges JAMAIS la qualité ni la réputation d'un titre : seulement la ressemblance de l'expérience de visionnage.

Pour chaque candidat, tu reçois :
- ses caractéristiques (titre, année, genres, mots-clés, synopsis) ;
- "adores" : les 3 titres de l'historique que le spectateur a ADORÉS (❤️, coup de cœur : le signal positif maximal) et qui lui ressemblent le plus ;
- "non_aimes" : les 3 titres de l'historique que le spectateur a vus SANS LES AIMER (✗) et qui lui ressemblent le plus.

Pour chaque candidat, réponds :
1. "proche_des_adores" (0-100) : à quel point l'expérience du candidat (univers, ton, rythme, type d'intrigue, humour, enjeux, public visé) ressemble à celle des titres adorés.
2. "proche_des_non_aimes" (0-100) : la même question avec les titres vus sans les aimer.
3. "connaissance" (0-100) : à quel point tu connais réellement ce titre. Titre récent ou peu connu : mets une valeur basse et compare d'après le synopsis, sans rien inventer.
4. "motif" : 14 mots maximum, qui nomme le titre voisin le plus proche.

Règles : compare uniquement l'expérience de visionnage ; un genre n'est ni bon ni mauvais en soi ; les notes sont indépendantes (un candidat peut ressembler à plusieurs groupes, ou à aucun) ; utilise toute l'échelle ; si les voisins fournis ne sont pas pertinents, dis-le par une note basse plutôt que de forcer une ressemblance.

Réponds UNIQUEMENT en JSON strict :
{"evaluations": [{"id": ..., "proche_des_adores": 0, "proche_des_non_aimes": 0, "connaissance": 0, "motif": "..."}]}

CANDIDATS : ${JSON.stringify(candidats)}`;
}

// Lecture tolérante de la réponse d'arbitrage : tableau direct ou objet, clés variantes, identifiants nus, scores en fraction (0-1) ou en points (0-100).
function parseEvaluations(r, byId) {
  const shape = r === null || r === undefined ? 'null' : Array.isArray(r) ? `array[${r.length}]` : `objet{${Object.keys(r).slice(0, 6).join(',')}}`;
  let list = null;
  if (Array.isArray(r)) list = r;
  else if (r && typeof r === 'object') {
    for (const k of ['evaluations', 'évaluations', 'evaluation', 'resultats', 'résultats', 'results', 'candidats', 'items']) if (Array.isArray(r[k])) { list = r[k]; break; }
    if (!list) list = Object.values(r).find(Array.isArray) || null;
  }
  const map = new Map();
  if (!list) return { map, shape, listLength: 0 };
  const pick = (...v) => { for (const x of v) { if (x === null || x === undefined || x === '') continue; const n = Number(x); if (Number.isFinite(n)) return n; } return NaN; };
  const rows = list.filter((e) => e && typeof e === 'object').map((e) => {
    const a = pick(e.proche_des_adores, e.proche_des_adorés), nn = pick(e.proche_des_non_aimes), lk = pick(e.proche_des_apprecies, e.proche_des_appréciés);
    const isC = Number.isFinite(a) && Number.isFinite(nn);            // variante C : ressemblance aux titres adorés et aux titres non aimés
    return { e, isC, a, nn, lk, fit: isC ? a : pick(e.adequation, e['adéquation'], e.fit, e.score), risk: isC ? nn : pick(e.risque, e.risk) };
  }).filter((x) => Number.isFinite(x.fit));
  const frac = rows.length > 0 && rows.every((x) => x.fit <= 1 && (Number.isNaN(x.risk) || x.risk <= 1));
  const k = frac ? 100 : 1;
  for (const { e, fit, risk, isC, a, nn, lk } of rows) {
    const raw = String(e.id ?? e.identifiant ?? ''); const digits = raw.replace(/\D/g, '');
    const im = byId.get(raw) || (digits && (byId.get('m' + digits) || byId.get('s' + digits)));
    if (!im) continue;
    const kn = pick(e.connaissance, e.knowledge, e.connu); const inc = e.incompatibilite ?? e['incompatibilité'] ?? e.incompatible;
    if (isC) {                                                                       // fit = (100 + adorés − non aimés) / 2 ; risk = 0 ; les deux ressemblances sont conservées (sim)
      const A = Math.max(0, Math.min(100, a * k)), N = Math.max(0, Math.min(100, nn * k));
      const L = Number.isFinite(lk) ? Math.max(0, Math.min(100, lk * k)) : null;
      const Apos = L === null ? A : (3 * A + L) / 4;                           // côté positif sur l'échelle de l'utilisateur : la ressemblance à un adoré compte 3, à un apprécié 1
      const kn2 = pick(e.connaissance, e.knowledge, e.connu);
      map.set(im, { fit: (100 + Apos - N) / 2, risk: 0, sim: { adores: A, ...(L === null ? {} : { apprecies: L }), nonAimes: N }, know: Number.isFinite(kn2) ? Math.max(0, Math.min(100, kn2 * (kn2 <= 1 && frac ? 100 : 1))) : null, incomp: false, note: String(e.note || e.motif || '').slice(0, 100) });
      continue;
    }
    map.set(im, { fit: Math.max(0, Math.min(100, fit * k)), risk: Math.max(0, Math.min(100, (Number.isFinite(risk) ? risk : 0) * k)), know: Number.isFinite(kn) ? Math.max(0, Math.min(100, kn * (kn <= 1 && frac ? 100 : 1))) : null, incomp: inc === true || inc === 1 || (typeof inc === 'string' && /^(true|vrai|oui|1)$/i.test(inc.trim())), note: String(e.note || e.motif || '').slice(0, 100) });
  }
  return { map, shape, listLength: list.length };
}

module.exports = { comparePromptSans, comparePrompt, parseEvaluations, Gemini, pickModel, extractJson };
