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
function stratifiedSample(items, n) {
  const groups = new Map();
  for (const it of items.slice().sort((x, y) => (y.lw || 0) - (x.lw || 0) || (x.key < y.key ? -1 : 1))) {
    const g = (it.rec.k || '?') + ':' + ((it.rec.gn && it.rec.gn[0]) || 'autre');
    if (!groups.has(g)) groups.set(g, []); groups.get(g).push(it);
  }
  const order = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1)).map((e) => e[1]);
  const out = []; for (let round = 0; out.length < n; round++) { let any = false; for (const g of order) { if (g[round]) { out.push(g[round].rec); any = true; if (out.length >= n) break; } } if (!any) break; }
  return out;
}
// ---- PROMPT 1 : ADN (structure VALIDÉE par l'utilisateur). Aucun goût écrit en dur : seuls les FILTRES ACTIFS de la page de configuration sont transmis.
function dnaPrompt({ filtres, n, tauxGlobal, tableau, loves, likes, rejects, recipes }) {
  const echantillon = { adorés: (loves || []).map((r) => card(r)), aimés: (likes || []).map((r) => card(r)), rejetés_pourtant_bien_notés: (rejects || []).map((r) => card(r, { note_tmdb: r.va })), recettes_candidates: recipes || [] };
  return `Tu es un analyste de goûts cinématographiques et télévisuels. À partir de PREUVES
chiffrées et d'un échantillon de son historique, tu rédiges l'ADN de visionnage d'un
spectateur.

PRINCIPES
- Une note (❤️ adoré, 👍 aimé, ✗ vu sans être aimé) concerne UN titre, pas un genre.
  Ne conclus qu'un genre, un sous-genre ou un mot-clé est rejeté QUE si le tableau
  le prouve : part d'appréciation nettement sous sa moyenne générale ET fiabilité
  « suffisante ». Un ou deux titres ratés dans un ensemble ne prouvent rien.
- « faible » ou « preuve insuffisante » : n'en tire AUCUNE conclusion.
- Pour chaque ensemble, oppose ce qui est adoré à ce qui est rejeté : c'est cette
  différence (ton, rythme, sous-genre, acteurs, réalisateur, structure narrative)
  qui définit l'ADN, pas l'étiquette de genre.
- Les FILTRES ACTIFS sont des choix de configuration de l'utilisateur, appliqués en
  amont : ne les interprète pas comme un goût et ne les commente pas.

FILTRES ACTIFS (page de configuration) :
${filtres || '(aucun)'}

TABLEAU DE PREUVES (historique de ${n} titres ; moyenne générale d'appréciation :
${tauxGlobal} %) :
${tableau}

ÉCHANTILLON (réparti par genre) :
${JSON.stringify(echantillon)}

Réponds UNIQUEMENT en JSON strict :
{"adn": "<=110 mots", "moteurs_d_adhesion": [...], "facteurs_repulsifs": [...],
 "nuances": [{"ensemble": "...", "lecture": "..."}],
 "recettes_toxiques": [{"id": "R1", "toxique": true, "raison": "..."}]}`;
}
// ---- PROMPT 2 : arbitrage (structure VALIDÉE) : quatre notes par candidat.
function arbitragePrompt({ adn, moteurs, repulsifs, nuances, filtres, candidats }) {
  const l = (a) => ((a && a.length) ? a.join(' ; ') : '(aucun)');
  return `Tu arbitres des candidats (films ou séries) pour un spectateur dont voici l'ADN :
${adn || '(inconnu)'}
Moteurs d'adhésion : ${l(moteurs)}
Facteurs répulsifs : ${l(repulsifs)}
Nuances à respecter : ${l(nuances)}

FILTRES ACTIFS (déjà appliqués : tous les candidats les respectent) :
${filtres || '(aucun)'}

Pour chaque candidat (titre, année, tous ses genres, mots-clés, synopsis, titre aimé
et titre rejeté les plus proches) :
1. "adequation" (0-100) : probabilité que ce soit un vrai COUP DE CŒUR (❤️), d'après
   la dynamique, l'immersion, le ton et le divertissement, pas la réputation critique.
2. "risque" (0-100) : risque de déception : titre lent, austère, niais, redondant ou
   ennuyeux pour CE profil.
3. "connaissance" (0-100) : à quel point tu connais réellement ce titre. Titre récent
   ou obscur : mets une valeur basse et juge d'après le synopsis, sans rien inventer.
4. "incompatibilite" (true/false) : true SEULEMENT pour une incompatibilité MAJEURE
   et précise avec l'ADN, à justifier dans le motif. Jamais pour un simple manque
   d'enthousiasme.
5. "motif" : 14 mots maximum.

Règles : utilise toute l'échelle (un titre moyen vaut environ 50) ; sois sévère
seulement si tu peux le justifier ; ne juge pas un genre entier sur ses mauvais
exemples : compare avec les titres aimés du même sous-genre.

Réponds UNIQUEMENT en JSON strict :
{"evaluations": [{"id": ..., "adequation": 0, "risque": 0, "connaissance": 0,
 "incompatibilite": false, "motif": "..."}]}

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
  const rows = list.filter((e) => e && typeof e === 'object').map((e) => ({ e, fit: pick(e.adequation, e['adéquation'], e.fit, e.score), risk: pick(e.risque, e.risk) })).filter((x) => Number.isFinite(x.fit));
  const frac = rows.length > 0 && rows.every((x) => x.fit <= 1 && (Number.isNaN(x.risk) || x.risk <= 1));
  const k = frac ? 100 : 1;
  for (const { e, fit, risk } of rows) {
    const raw = String(e.id ?? e.identifiant ?? ''); const digits = raw.replace(/\D/g, '');
    const im = byId.get(raw) || (digits && (byId.get('m' + digits) || byId.get('s' + digits)));
    if (!im) continue;
    const kn = pick(e.connaissance, e.knowledge, e.connu); const inc = e.incompatibilite ?? e['incompatibilité'] ?? e.incompatible;
    map.set(im, { fit: Math.max(0, Math.min(100, fit * k)), risk: Math.max(0, Math.min(100, (Number.isFinite(risk) ? risk : 0) * k)), know: Number.isFinite(kn) ? Math.max(0, Math.min(100, kn * (kn <= 1 && frac ? 100 : 1))) : null, incomp: inc === true || inc === 1 || (typeof inc === 'string' && /^(true|vrai|oui|1)$/i.test(inc.trim())), note: String(e.note || e.motif || '').slice(0, 100) });
  }
  return { map, shape, listLength: list.length };
}

module.exports = { stratifiedSample, parseEvaluations, Gemini, pickModel, extractJson, dnaPrompt, arbitragePrompt };
