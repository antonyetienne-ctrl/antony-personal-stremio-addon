'use strict';
// FICHES « POURQUOI » : un court texte ajouté EN TÊTE de la fiche Stremio d'un titre recommandé (ou d'un titre non vu de la liste de lecture 📌) :
// chances de coup de cœur, titres adorés dont il est proche, ce qui devrait plaire, ce qui est à surveiller. Rien n'est retiré de la fiche existante (note IMDb, synopsis…).
// Le texte est construit par des gabarits à partir de DONNÉES DÉJÀ CALCULÉES (aucune requête Gemini de plus) : voisins les plus proches (embeddings si disponibles), traits du modèle, probabilités.
// Un titre « non concluant » (liste de lecture) n'a pas de texte.
const { clock, log } = require('./util');
const { key } = require('./config');
const embed = require('./embed');

// ---- niveaux (sur la probabilité de coup de cœur estimée ; le modèle est un peu trop confiant : seuils calés plus bas que 0,5 / 0,7)
const TIERS = [
  { id: 'top', min: 0.66, head: 'COUP DE CŒUR TRÈS PROBABLE', icon: '🎯', dots: 5 },
  { id: 'probable', min: 0.56, head: 'COUP DE CŒUR PROBABLE', icon: '🎯', dots: 4 },
  { id: 'possible', min: 0.46, head: 'BONNES CHANCES DE TE PLAIRE', icon: '👍', dots: 3 },
  { id: 'incertain', min: 0.30, head: 'À TENTER, MAIS INCERTAIN', icon: '🤔', dots: 2 },
  { id: 'peu', min: -1, head: 'PEU DE CHANCES DE TE PLAIRE', icon: '⚠️', dots: 1 }
];
const tierOf = (pLove, pPos) => { if (pPos !== undefined && pPos < 0.5 && pLove < 0.3) return TIERS[4]; return TIERS.find((t) => pLove >= t.min) || TIERS[4]; };
const dots = (n) => '●'.repeat(n) + '○'.repeat(5 - n);
const NUM = ['', "l'un", 'deux', 'trois'];

// traductions des mots-clés TMDB (anglais) les plus fréquents dans les traits d'un profil ; un mot-clé absent d'ici n'est jamais affiché (pas d'anglais dans les fiches)
const KW_FR = {
  'based on novel or book': 'adaptation littéraire', 'based on true story': 'inspiré de faits réels', 'biography': 'biographie', 'based on young adult novel': 'adaptation de roman pour jeunes adultes',
  'inspirational': 'récit inspirant', 'sports': 'sport', 'space opera': 'space opera', 'miniseries': 'mini-série', 'superhero': 'super-héros', 'based on comic': 'adapté d\'une bande dessinée',
  'alien': 'extraterrestres', 'live action remake': 'remake en prises de vues réelles', 'war': 'guerre', 'revenge': 'vengeance', 'survival': 'survie', 'dystopia': 'dystopie',
  'post-apocalyptic future': 'futur post-apocalyptique', 'medieval': 'époque médiévale', 'politics': 'intrigues politiques', 'heist': 'braquage', 'time travel': 'voyage dans le temps',
  'magic': 'magie', 'wizard': 'sorcellerie', 'friendship': 'amitié', 'coming of age': 'passage à l\'âge adulte', 'love triangle': 'triangle amoureux', 'murder': 'meurtre', 'investigation': 'enquête',
  'court': 'procès', 'espionage': 'espionnage', 'world war ii': 'Seconde Guerre mondiale', 'vikings': 'Vikings', 'gladiator': 'gladiateurs', 'kingdom': 'royaume', 'battle': 'batailles',
  'anime': 'anime', 'manga': 'manga', 'martial arts': 'arts martiaux', 'zombie': 'zombies', 'horror': 'horreur', 'slasher': 'slasher', 'sequel': 'suite', 'remake': 'remake', 'parody': 'parodie',
  'drug cartel': 'narcotrafic', 'prison': 'prison', 'crime boss': 'chefs du crime', 'organized crime': 'crime organisé', 'historical fiction': 'fiction historique', 'epic': 'récit épique'
};
const GENRE_OK = (n) => typeof n === 'string' && n.length > 0;

// traits du modèle : [{ k: 'g'|'k', name, w }] triés par poids ; `label` = texte affichable ou null
function traitList(raw) {
  const out = [];
  for (const t of raw || []) {
    const m = /^(genre|mot-clé) « (.+) »$/.exec(t.name || ''); if (!m) continue;
    const kind = m[1] === 'genre' ? 'g' : 'k'; const name = m[2];
    const label = kind === 'g' ? (GENRE_OK(name) ? name.toLowerCase() : null) : (KW_FR[name.toLowerCase()] || null);
    if (label) out.push({ kind, name, label, w: t.weight });
  }
  return out;
}
// traits présents sur la fiche du titre
function matchTraits(rec, traits, sign, max = 3) {
  const gn = new Set((rec.gn || []).map((x) => String(x).toLowerCase())), kw = new Set((rec.kw || []).map((k) => String(k[1] || '').toLowerCase()));
  const hit = traits.filter((t) => (sign > 0 ? t.w > 0 : t.w < 0) && (t.kind === 'g' ? gn.has(t.name.toLowerCase()) : kw.has(t.name.toLowerCase()))).sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
  const seen = new Set(), out = [];
  for (const t of hit) { if (!seen.has(t.label)) { seen.add(t.label); out.push(t.label); } if (out.length >= max) break; }
  return out;
}
const titleOf = (r) => String(r.t || r.titre || '').trim();
const joinFr = (a) => (a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' et ' + a[a.length - 1]);
const pick = (arr, seed) => arr[Math.abs(seed) % arr.length];

// neighbours : { loved: [{ rec, sim }], disliked: [{ rec, sim }], minSim }  (déjà triés par similarité décroissante)
// mode : 'top' (titre du Top 30 : toujours un texte) | 'lib' (liste de lecture : seulement si concluant)
function buildWhy({ rec, pLove, pPos, neighbors, posTraits, negTraits, mode = 'top', seed = 0 }) {
  const tier = tierOf(pLove, pPos);
  if (mode === 'lib' && tier.id === 'incertain') return null;                                  // non concluant : aucun texte
  const nb = neighbors || { loved: [], disliked: [], minSim: 0 };
  const loved = (nb.loved || []).filter((n) => n.sim >= nb.minSim).slice(0, 2);
  const disliked = (nb.disliked || []).filter((n) => n.sim >= nb.minSim);
  const lines = [`${tier.icon} ${tier.head}  ${dots(tier.dots)}`];
  if (tier.id === 'peu') {
    const names = disliked.slice(0, 2).map((n) => titleOf(n.rec)).filter(Boolean);
    if (names.length) lines.push(`Il ressemble surtout à ${joinFr(names)}, ${names.length > 1 ? 'deux titres' : 'un titre'} que tu n'as pas aimé${names.length > 1 ? 's' : ''}.`);
    const neg = matchTraits(rec, negTraits, -1, 3); if (neg.length) lines.push(`⚠️ À surveiller : ${joinFr(neg)}, plutôt rare dans tes coups de cœur`);
    if (lines.length === 1 && mode === 'top') lines.push('Peu de points communs avec ton historique.');
    return lines.length > 1 ? { tier: tier.id, text: lines.join('\n') } : null;
  }
  if (loved.length) {
    const list = joinFr(loved.map((n) => titleOf(n.rec)).filter(Boolean));
    lines.push(pick([`Dans la lignée de ${list}, ${NUM[loved.length]} de tes coups de cœur.`, `Proche de ${list} : ${NUM[loved.length]} de tes coups de cœur.`, `Ça devrait te rappeler ${list}, ${NUM[loved.length]} de tes coups de cœur.`], seed));
  }
  const pos = matchTraits(rec, posTraits, +1, 3); if (pos.length) lines.push(`✅ Ce qui devrait te plaire : ${joinFr(pos)}`);
  const closest = disliked[0], bestLoved = loved[0];
  if (closest && (!bestLoved || closest.sim >= bestLoved.sim - 0.04)) lines.push(`⚠️ À surveiller : il ressemble aussi à ${titleOf(closest.rec)}, un titre que tu n'as pas aimé`);
  else { const neg = matchTraits(rec, negTraits, -1, 2); if (neg.length) lines.push(`⚠️ À surveiller : ${joinFr(neg)}, plutôt rare dans tes coups de cœur`); }
  if (lines.length === 1) lines.push(mode === 'top' ? 'Sélectionné d\'après l\'ensemble de tes goûts.' : '');
  return { tier: tier.id, text: lines.filter(Boolean).join('\n') };
}

// voisins d'un titre : vecteur sémantique si disponible (les deux côtés), sinon vecteur « genres + mots-clés »
function neighborsOf({ rec, vecOf, hashVec, poolsEmb, poolsHash }) {
  const v = vecOf && vecOf(rec);
  if (v && poolsEmb && poolsEmb.loved.length && poolsEmb.disliked.length) return { loved: embed.topK(v, poolsEmb.loved, 2).map((n) => ({ rec: n.item.rec, sim: n.sim })), disliked: embed.topK(v, poolsEmb.disliked, 2).map((n) => ({ rec: n.item.rec, sim: n.sim })), minSim: 0.62, space: 'embeddings' };
  const h = hashVec && hashVec(rec);
  if (h && poolsHash) return { loved: embed.topK(h, poolsHash.loved, 2).map((n) => ({ rec: n.item.rec, sim: n.sim })), disliked: embed.topK(h, poolsHash.disliked, 2).map((n) => ({ rec: n.item.rec, sim: n.sim })), minSim: 0.45, space: 'hash' };
  return { loved: [], disliked: [], minSim: 1, space: null };
}

// Stockage : un seul document par utilisateur { items: { movie: {imdb: texte}, series: {…}, libMovie: {…}, libSeries: {…} } } ; RAM d'abord (lecture Upstash bornée à 2,5 s)
class WhyStore {
  constructor(store) { this.store = store; this.ram = new Map(); }
  async getFast(uid, timeoutMs = 2500) {
    if (this.ram.has(uid)) return this.ram.get(uid);
    if (!this.store.available) return null;
    const p = this.store.getJson(key.why(uid), 'why-load');
    const r = await Promise.race([p, new Promise((res) => setTimeout(() => res('timeout'), timeoutMs))]);
    if (r === 'timeout') { p.then((v) => { if (v && !this.ram.has(uid)) this.ram.set(uid, v); }).catch(() => {}); return null; }
    if (r && r.items) this.ram.set(uid, r);
    return this.ram.get(uid) || null;
  }
  // parts : { movie?, series?, libMovie?, libSeries? } : ne remplace que les parties fournies
  async publish(uid, parts, { buildId } = {}) {
    const prev = this.ram.get(uid) || (await this.getFast(uid)) || { items: {} };
    const next = { v: 1, buildId: buildId || prev.buildId, builtAt: clock.now(), items: { movie: {}, series: {}, libMovie: {}, libSeries: {}, ...prev.items } };
    for (const k of ['movie', 'series', 'libMovie', 'libSeries']) if (parts[k]) next.items[k] = parts[k];
    this.ram.set(uid, next);
    const ok = await this.store.setJson(key.why(uid), next, 'why-publish');
    if (!ok) log('warn', 'Fiches « pourquoi » publiées en RAM seulement (Upstash indisponible)');
    return { persisted: ok };
  }
  text(uid, imdb) { const d = this.ram.get(uid); if (!d) return null; const it = d.items; return (it.movie && it.movie[imdb]) || (it.series && it.series[imdb]) || (it.libMovie && it.libMovie[imdb]) || (it.libSeries && it.libSeries[imdb]) || null; }
}
const SEPARATOR = '──────────────────';
// description finale : le texte « pourquoi » puis la fiche d'origine, inchangée
const withWhy = (why, description) => (why ? `${why}\n${SEPARATOR}\n${description || ''}` : description || '');

module.exports = { TIERS, tierOf, dots, KW_FR, traitList, matchTraits, buildWhy, neighborsOf, WhyStore, withWhy, SEPARATOR };
