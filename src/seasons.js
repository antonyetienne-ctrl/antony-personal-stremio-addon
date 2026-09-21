'use strict';
// 🔔 NOUVELLES SAISONS DISPONIBLES. Règles (validées par l'utilisateur) :
//  - séries MARQUÉES VUES (macaron : au moins un épisode terminé, règle « vu » du moteur) ET notées 👍 ou ❤️ ; les saisons précédentes (vues ou non) n'ont aucune importance ;
//  - une NOUVELLE saison est une saison n° 2 ou plus (la saison 1 d'une série déjà vue n'est jamais « nouvelle ») dont le PREMIER ÉPISODE est déjà sorti depuis moins de 12 mois (365 jours) ;
//    une saison annoncée pour plus tard est ignorée ;
//  - elle disparaît quand la saison a plus de 12 mois OU quand TOUS ses épisodes SORTIS (pas les épisodes seulement annoncés) sont marqués vus.
// Lecture des épisodes vus : la liste `state.watched` de Stremio, « épisodeD'ancrage:longueur:bits compressés » (bits dans l'ordre « lsb »), alignée sur la liste d'épisodes de la série
// (Cinemeta, à défaut TMDB). Deux formes réelles : épisodes regardés un à un (le dernier bit à 1 est l'ancre) ; saison ou série marquée « vue » en une fois (l'ancre est un épisode quelconque
// dont le bit est à 1, les bits vont au-delà) ; une liste incohérente est refusée et la série reste affichée par prudence (jamais cachée à tort) jusqu'à la limite des 12 mois.
// Lecture seule, aucune écriture Upstash ; TMDB et Cinemeta en mémoire (6 h / 12 h).
const zlib = require('zlib');
const { fetchJson, clock, mapLimit, LRU, log } = require('./util');
const { classify } = require('./stremio');

const DAYS = 365, DAY_MS = 86400000, TV_TTL = 6 * 3600e3, CM_TTL = 12 * 3600e3;
const CINEMETA = 'https://v3-cinemeta.strem.io';

// ---------- liste des épisodes vus ----------
function parseWatched(str) {
  if (typeof str !== 'string' || !str) return null;
  const p = str.split(':'); if (p.length < 3) return null;
  const b64 = p.pop(), lenS = p.pop(), anchorId = p.join(':'); const anchorLen = Number(lenS);
  if (!Number.isInteger(anchorLen) || anchorLen < 1 || !anchorId) return null;
  let raw; try { raw = Buffer.from(b64, 'base64'); } catch { return null; }
  let bytes = raw, compressed = false;
  try { bytes = zlib.inflateSync(raw); compressed = true; } catch { try { bytes = zlib.inflateRawSync(raw); compressed = true; } catch { bytes = raw; } }
  return { anchorId, anchorLen, bytes, compressed };
}
const bitAt = (bytes, i, order) => { const b = bytes[i >> 3]; if (b === undefined) return 0; return order === 'msb' ? (b >> (7 - (i & 7))) & 1 : (b >> (i & 7)) & 1; };
// videos : identifiants « imdb:saison:épisode » dans l'ordre de Stremio. Renvoie { ok, order, offset, watched:Set } ou { ok:false, why }.
// Contrôle : l'épisode d'ancrage est dans la liste, son bit est à 1 et TOUS les bits à 1 tombent dans la liste. Deux formes existent :
//  - épisodes regardés un à un : le dernier bit à 1 est celui de l'ancre ;
//  - saison marquée vue après coup (constaté : Outlast, Pluribus) : la liste d'ancrage est courte mais des bits à 1 la dépassent ; ils désignent les épisodes SUIVANTS, alignés sur le début de la liste.
function decodeWatched(parsed, videos) {
  if (!parsed) return { ok: false, why: 'liste d\'épisodes vus illisible' };
  if (!videos || !videos.length) return { ok: false, why: 'aucune liste d\'épisodes de la série' };
  const idx = videos.indexOf(parsed.anchorId); if (idx < 0) return { ok: false, why: 'épisode d\'ancrage absent de la liste d\'épisodes' };
  const offset = idx + 1 - parsed.anchorLen; const nbits = parsed.bytes.length * 8;
  const read = (order) => { let last = -1; const watched = new Set(); let bad = false; for (let i = 0; i < nbits; i++) if (bitAt(parsed.bytes, i, order)) { last = i; const v = videos[i + offset]; if (v === undefined) bad = true; else watched.add(v); } return { last, watched, bad }; };
  // 1) forme stricte (épisodes regardés un à un) : le dernier bit à 1 EST celui de l'ancre ; les deux ordres de bits sont essayés (le format réel de Stremio est « lsb »)
  for (const order of ['lsb', 'msb']) { const r = read(order); if (!r.bad && r.last === parsed.anchorLen - 1) return { ok: true, order, offset, watched: r.watched }; }
  // 2) saison marquée vue après coup (constaté : Outlast, Pluribus) : des bits à 1 dépassent l'ancre ; seul l'ordre réel « lsb » est accepté, l'ancre doit être à 1 et tous les bits doivent tomber dans la liste
  { const r = read('lsb'); if (!r.bad && r.watched.size && bitAt(parsed.bytes, parsed.anchorLen - 1, 'lsb') && r.last >= parsed.anchorLen - 1) return { ok: true, order: 'lsb', offset, watched: r.watched, apres: true }; }
  return { ok: false, why: 'lecture non concordante avec la liste d\'épisodes' };
}
// (tests / outils) fabrique une liste « ancre:longueur:bits » à partir des indices d'épisodes vus dans `videos`
function encodeWatched(videos, watchedIdx, { order = 'lsb', compress = true } = {}) {
  const last = Math.max(...watchedIdx); const bytes = Buffer.alloc(Math.ceil((last + 1) / 8));
  for (const i of watchedIdx) bytes[i >> 3] |= order === 'msb' ? (1 << (7 - (i & 7))) : (1 << (i & 7));
  const body = compress ? zlib.deflateSync(bytes) : bytes;
  return `${videos[last]}:${last + 1}:${body.toString('base64')}`;
}

// ---------- listes d'épisodes ----------
const cmCache = new LRU(400);
async function defaultCinemeta(imdb) {
  const hit = cmCache.get(imdb); if (hit && clock.now() - hit.at < CM_TTL) return hit.videos;
  let videos = null;
  try {
    const r = await fetchJson(`${CINEMETA}/meta/series/${imdb}.json`, { timeoutMs: 8000, retries: 1, label: 'cinemeta' });
    const list = r && r.meta && Array.isArray(r.meta.videos) ? r.meta.videos : null;
    if (list) videos = list.filter((v) => v && typeof v.id === 'string').map((v) => ({ id: v.id, season: Number(v.season), episode: Number(v.episode), released: v.released || null }));
  } catch { videos = null; }
  cmCache.set(imdb, { at: clock.now(), videos }); return videos;
}
// listes candidates dans l'ordre de préférence : Cinemeta tel quel, puis liste reconstruite depuis TMDB (sans puis avec les épisodes spéciaux)
function candidateLists(imdb, cmVideos, seasons) {
  const out = [];
  if (cmVideos && cmVideos.length) out.push({ src: 'Cinemeta', ids: cmVideos.map((v) => v.id) });
  const build = (withSpecials) => { const ids = []; for (const s of seasons.slice().sort((a, b) => a.season_number - b.season_number)) { if (s.season_number === 0 && !withSpecials) continue; for (let e = 1; e <= (s.episode_count || 0); e++) ids.push(`${imdb}:${s.season_number}:${e}`); } return ids; };
  const a = build(false), b = build(true); if (a.length) out.push({ src: 'TMDB (sans spéciaux)', ids: a }); if (b.length && b.length !== a.length) out.push({ src: 'TMDB (avec spéciaux)', ids: b });
  return out;
}

const fmtDate = (iso) => { const d = new Date(iso); return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`; };

class NewSeasons {
  constructor({ days = DAYS, cinemeta = defaultCinemeta, capMs = 9000 } = {}) {
    this.days = days; this.cinemeta = cinemeta; this.capMs = capMs;
    this.tv = new Map();               // imdb -> { at, recent: {tmdbId, season, premiere, epCount, seasons} | null }
    this.refreshing = null;
  }
  invalidate() { this.tv.clear(); }
  eligible(libItems, labels) {
    return (libItems || []).filter((x) => x.type === 'series' && ['L', 'K'].includes(labels.get(x.imdb)) && classify({ _id: x.imdb, type: 'series', state: x.state, _mtime: x.mtime }).seen);
  }
  // saison récente d'une série (TMDB, 6 h en mémoire) ; null si aucune saison sortie depuis moins de `days` jours
  async recentOf(imdb, tmdb, { force = false } = {}) {
    const hit = this.tv.get(imdb); if (hit && !force && clock.now() - hit.at < TV_TTL) return hit.recent;
    const ids = await tmdb.findMany([imdb], 'series'); const id = ids.get(imdb); if (!id) { this.tv.set(imdb, { at: clock.now(), recent: null }); return null; }
    const d = await tmdb.get(`/tv/${id}`, {}, { label: 'tv-seasons' }).catch(() => null);
    if (!d || !Array.isArray(d.seasons)) return hit ? hit.recent : null;         // échec réseau : on garde l'ancien résultat
    const now = clock.now();
    const rec = d.seasons.filter((s) => s.season_number >= 2 && s.air_date && Date.parse(s.air_date) <= now && now - Date.parse(s.air_date) <= this.days * DAY_MS).sort((a, b) => Date.parse(b.air_date) - Date.parse(a.air_date))[0];
    const recent = rec ? { tmdbId: id, season: rec.season_number, premiere: rec.air_date, epCount: rec.episode_count || 0, seasons: d.seasons.map((s) => ({ season_number: s.season_number, episode_count: s.episode_count || 0 })) } : null;
    this.tv.set(imdb, { at: now, recent }); return recent;
  }
  // état d'une série pour sa saison récente : { total, seen, decode, source, why }
  async statusOf(item, recent, tmdb) {
    const cm = await this.cinemeta(item.imdb);
    // total = épisodes SORTIS de la saison (jamais les épisodes seulement annoncés) ; une source datée prime sur une source sans dates
    const now = clock.now(); const dated = [], undated = [];
    const count = (list, dateOf) => { if (list.some((e) => dateOf(e))) dated.push(list.filter((e) => dateOf(e) && Date.parse(dateOf(e)) <= now).length); else undated.push(list.length); };
    if (cm) count(cm.filter((v) => v.season === recent.season), (v) => v.released);
    try { const s = await tmdb.season(recent.tmdbId, recent.season); if (s && Array.isArray(s.episodes)) count(s.episodes, (e) => e.air_date); } catch { /* la source restante suffit */ }
    let total = dated.length ? Math.max(...dated) : (undated.length ? Math.max(...undated) : (recent.epCount || 0));
    if (!dated.length && recent.epCount) total = Math.max(total, recent.epCount);
    const parsed = parseWatched(item.state && item.state.watched); const res = { total, seen: null, decode: 'indéterminé', source: null, why: null, allWatched: false };
    if (!parsed) {
      const w = item.state && item.state.watched;
      if (!w) return { ...res, seen: 0, decode: 'ok', source: 'aucune liste d\'épisodes vus', allWatched: false };        // aucun épisode coché : la saison n'est pas vue
      res.why = w === true ? 'marque globale sans détail par épisode' : 'liste d\'épisodes vus illisible'; return res;
    }
    let lastWhy = null;
    for (const cand of candidateLists(item.imdb, cm, recent.seasons)) {
      const dec = decodeWatched(parsed, cand.ids); if (!dec.ok) { lastWhy = `${cand.src} : ${dec.why}`; continue; }
      const eps = []; for (let e = 1; e <= total; e++) eps.push(`${item.imdb}:${recent.season}:${e}`);
      const seen = eps.filter((id) => dec.watched.has(id)).length;
      return { ...res, seen, decode: 'ok', source: cand.src, order: dec.order, allWatched: total > 0 && seen >= total };
    }
    res.why = lastWhy; return res;
  }
  // métadonnées du catalogue ; `deps` : { libItems, labels: Map imdb -> 'L'|'K'|'N', tmdb }
  async metas(deps, { skip = 0 } = {}) {
    const elig = this.eligible(deps.libItems, deps.labels); const stale = elig.filter((x) => { const h = this.tv.get(x.imdb); return !h || clock.now() - h.at >= TV_TTL; });
    if (stale.length) {
      const work = () => mapLimit(stale, 6, (x) => this.recentOf(x.imdb, deps.tmdb).catch(() => null)).then(() => { this.refreshing = null; }).catch(() => { this.refreshing = null; });
      if (!this.refreshing) this.refreshing = work();
      const firstTime = stale.length === elig.length;
      await Promise.race([this.refreshing, new Promise((res) => { const t = setTimeout(res, firstTime ? this.capMs : 1500); if (t.unref) t.unref(); })]);
    }
    const rows = [];
    for (const x of elig) {
      const h = this.tv.get(x.imdb); if (!h || !h.recent) continue;
      let st; try { st = await this.statusOf(x, h.recent, deps.tmdb); } catch { st = { total: h.recent.epCount, seen: null, decode: 'indéterminé', allWatched: false }; }
      if (st.allWatched) continue;                                     // toute la saison est vue : la série disparaît
      rows.push({ x, recent: h.recent, st });
    }
    rows.sort((a, b) => Date.parse(b.recent.premiere) - Date.parse(a.recent.premiere) || (a.x.imdb < b.x.imdb ? -1 : 1));
    return rows.slice(skip, skip + 100).map(({ x, recent, st }) => ({
      id: x.imdb, type: 'series', name: x.name || x.imdb, poster: x.poster || `https://images.metahub.space/poster/small/${x.imdb}/img`, posterShape: 'poster',
      releaseInfo: `Saison ${recent.season}`, description: `🔔 Saison ${recent.season} sortie le ${fmtDate(recent.premiere)}${st.decode === 'ok' && st.total ? ` — ${st.seen} épisode${st.seen > 1 ? 's' : ''} vu${st.seen > 1 ? 's' : ''} sur ${st.total}` : ''}`
    }));
  }
  // détail pour /diag/check
  async explain(item, label, tmdb) {
    const out = { eligible: false };
    const seen = classify({ _id: item.imdb, type: 'series', state: item.state, _mtime: item.mtime }).seen; out.marqueeVue = seen; out.note = label === 'L' ? '❤️' : label === 'K' ? '👍' : 'aucune';
    out.eligible = seen && ['L', 'K'].includes(label);
    const recent = await this.recentOf(item.imdb, tmdb, { force: true }); if (!recent) { out.saisonRecente = null; out.affichee = false; return out; }
    out.saisonRecente = { saison: recent.season, sortieLe: recent.premiere, joursDepuisLaSortie: Math.floor((clock.now() - Date.parse(recent.premiere)) / DAY_MS) };
    out.etat = await this.statusOf(item, recent, tmdb); out.affichee = out.eligible && !out.etat.allWatched; return out;
  }
}
module.exports = { NewSeasons, parseWatched, decodeWatched, encodeWatched, candidateLists, DAYS };
