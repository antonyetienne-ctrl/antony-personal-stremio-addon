'use strict';
// Gemini (Google AI Studio) en REST, sans SDK ni dépendance. Facultatif et NON bloquant : toute erreur => null.
// Budget : ≤ 2 requêtes par synchronisation (1 "ADN + anti-recettes", mise en cache tant que l'historique est identique ;
// 1 "arbitrage" des candidats frontières Films+Séries) et un plafond quotidien dur (GEMINI_MAX_CALLS_PER_DAY, défaut 6).
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
  constructor({ key, maxPerDay = Number(process.env.GEMINI_MAX_CALLS_PER_DAY || 6), model = process.env.GEMINI_MODEL || '', calls = null } = {}) {
    this.key = key; this.maxPerDay = maxPerDay; this.forced = model || ''; this.model = model || null;
    this.cooldownUntil = 0; this.disabledUntil = 0; this.lastError = null; this.modelCheckedAt = 0;
    this.calls = calls && calls.day === zurichDay() ? calls : { day: zurichDay(), count: 0 };
    this.stats = { requests: 0, ok: 0, errors: 0 };
  }
  get available() { return Boolean(this.key) && clock.now() >= this.cooldownUntil && clock.now() >= this.disabledUntil && this._quotaLeft() > 0; }
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
      if (!obj) throw new Error('réponse non JSON');
      this.stats.ok++;
      return obj;
    } catch (e) { this._err(e); return null; }
  }
}

// ---------- prompts (compacts : jamais l'historique complet) ----------
const card = (rec, extra = {}) => ({ titre: rec.t, annee: rec.y, genres: (rec.gn || []).slice(0, 4), mots_cles: (rec.kw || []).slice(0, 7).map((k) => k[1]), ...extra });
function dnaPrompt({ loves, likes, rejects, positiveTraits, negativeTraits, recipes }) {
  const payload = { adorés: loves.map((r) => card(r)), aimés: likes.map((r) => card(r)), rejetés_pourtant_bien_notés: rejects.map((r) => card(r, { note_tmdb: r.va })), traits_appris_positifs: positiveTraits, traits_appris_négatifs: negativeTraits, recettes_négatives_candidates: recipes };
  return `Tu es un analyste de goûts cinématographiques. Voici un profil COMPACT (échantillons) d'un spectateur.\n` +
    `"adorés" = coup de cœur fort ; "aimés" = apprécié ; "rejetés_pourtant_bien_notés" = vus sans apprécier alors que TMDB les note bien (donc rejet probablement lié au goût, pas à la qualité).\n` +
    `Tâches : (1) synthétise l'ADN profond de ses goûts (ambiances, thématiques, ton, sous-genres, structure narrative) au-delà des simples genres ; (2) liste ce qu'il évite ; ` +
    `(3) pour chaque recette négative candidate, décide si c'est une VRAIE combinaison toxique (thème apprécié gâché par un ton/style) ou une coïncidence (films médiocres, note moyenne basse).\n` +
    `Réponds UNIQUEMENT en JSON : {"adn":"<=110 mots, français","themes":["..."],"tons":["..."],"evite":["..."],"recettes":[{"id":"R1","toxique":true,"confiance":0.0,"raison":"<=18 mots"}]}\n` +
    `DONNÉES : ${JSON.stringify(payload)}`;
}
function arbitragePrompt({ adn, evite, candidats }) {
  return `Tu départages des recommandations pour un spectateur dont l'ADN de goût est : ${adn || '(inconnu)'}\nÀ éviter : ${(evite || []).join(', ') || '(rien de précis)'}.\n` +
    `Pour chaque candidat (déjà présélectionné par un modèle statistique, score_local 0-100), donne "adequation" (0-100 : probabilité que ce soit un COUP DE CŒUR (❤️) pour lui, pas seulement un titre correct) et "risque" (0-100 : risque de déception, ` +
    `notamment s'il ressemble à "plus_proche_rejete" plutôt qu'à "plus_proche_aime"). Sois discriminant et fondé sur les nuances sémantiques (ton, thème, structure), pas sur la popularité.\n` +
    `Réponds UNIQUEMENT en JSON : {"evaluations":[{"id":"<id>","adequation":0,"risque":0,"note":"<=14 mots"}]}\nCANDIDATS : ${JSON.stringify(candidats)}`;
}

module.exports = { Gemini, pickModel, extractJson, dnaPrompt, arbitragePrompt };
