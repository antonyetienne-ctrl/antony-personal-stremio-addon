'use strict';
// /diag/check?token=…&q=tt0111161,Outlander,Off Campus : vérifie une LISTE de titres (identifiants IMDb ou noms), sans lancer de calcul.
// Pour chaque titre : est-il dans la bibliothèque Stremio ? vu / commencé (règle appliquée + signaux bruts) ? ❤️ / 👍 ? passe-t-il les filtres ACTUELS (sinon lequel bloque) ?
// est-il dans le Top 30 publié ? quel rang dans le modèle (400 premiers du dernier calcul) ? Lecture seule, protégé par DIAG_TOKEN, aucun secret dans la réponse.
const pipe = require('./pipeline');
const { attach } = require('./imdb');
const { classify } = require('./stremio');
const { virtualTags } = require('./filters');
const embed = require('./embed');

const MAX_ENTRIES = 30, MAX_MATCHES = 5;
const fold = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const IMDB = /^tt\d{5,12}$/;
const kindOf = (type) => (type === 'series' ? 'tv' : 'movie');
const round = (x, d = 3) => (typeof x === 'number' ? Math.round(x * 10 ** d) / 10 ** d : x);
const LABEL = { L: 'love ❤️', K: 'like 👍', N: 'aucune note', '?': 'inconnu' };

// réglages effectifs du dernier calcul : seuils note/votes automatiques recalculés à partir de job.taste
function effectiveSettings(user, job) {
  const eff = JSON.parse(JSON.stringify(user.settings));
  const imdbOn = Boolean(job && job.imdb && job.imdb.active);
  for (const t of ['movie', 'series']) {
    const ta = job && job.taste && job.taste[t];
    if (eff[t].ratingMode !== 'manual' && ta && Number.isFinite(ta.minRating)) { eff[t].minRating = ta.minRating; eff[t].minVotes = ta.minVotes; }
    eff[t].source = imdbOn ? 'imdb' : 'tmdb';
  }
  return eff;
}

async function run({ q, user, engine, results, library }) {
  const uid = user.id;
  const entries = [...new Set(String(q || '').split(/[\n,;|]+/).map((s) => s.trim()).filter(Boolean))].slice(0, MAX_ENTRIES);
  if (!entries.length) return { usage: 'Ajoute ?q= une liste de titres séparés par des virgules : identifiants IMDb (tt0111161) ou noms (Outlander, Off Campus). Maximum 30.', exemple: '/diag/check?token=…&q=tt0111161,Outlander,Off Campus' };
  const notes = [];
  const job = engine.jobs.get(uid) || (await engine.loadJob(uid)) || {};
  const snap = await engine.loadSnap(uid).catch(() => null);
  let libItems = [];
  if (user.secrets.stremio) { const r = await library.load(uid, user.secrets.stremio, { force: true }); libItems = r.items || []; if (!r.items) notes.push(`bibliothèque Stremio illisible (${r.error || 'délai dépassé'}) : signaux bruts indisponibles`); } else notes.push('aucune clé Stremio enregistrée');
  const byImdb = new Map(libItems.map((x) => [x.imdb, x]));
  const cl = engine.clientsFor(user, job);
  try { await engine.imdb.load(); } catch { /* notes IMDb indisponibles : repli TMDB */ }
  const imdbData = engine.imdb && engine.imdb.map && engine.imdb.map.size ? engine.imdb : null;
  if (!imdbData) notes.push('notes IMDb non chargées : les critères de qualité utilisent la note TMDB');
  const eff = effectiveSettings(user, job);
  const seenSet = new Set(snap ? Object.entries(snap.items).filter(([, v]) => v[2].includes('s')).map(([k]) => k) : []);
  const published = results.ram.get(uid) || {};

  // ---- résolution d'une demande en titres (identifiant IMDb, nom dans la bibliothèque, sinon recherche TMDB)
  async function resolve(entry) {
    if (IMDB.test(entry)) {
      const lib = byImdb.get(entry); const sn = snap && snap.items[entry];
      let type = (lib && lib.type) || (sn && (sn[0] === 's' ? 'series' : 'movie')) || null;
      if (!type) for (const t of ['movie', 'series']) { const m = await cl.tmdb.findMany([entry], t); if (m.has(entry)) { type = t; break; } }
      return type ? [{ imdb: entry, type, name: lib && lib.name, via: lib ? 'bibliothèque' : sn ? 'dernier calcul' : 'TMDB' }] : [];
    }
    const f = fold(entry);
    const exact = libItems.filter((x) => fold(x.name) === f), word = libItems.filter((x) => x.name && (` ${fold(x.name)} `).includes(` ${f} `));   // nom identique, puis mot entier (« RRR » ne correspond plus à « RRRrrrr!!! »)
    const pool = exact.length ? exact : word;
    if (pool.length) return pool.slice(0, MAX_MATCHES).map((x) => ({ imdb: x.imdb, type: x.type, name: x.name, via: 'bibliothèque' }));
    const r = await cl.tmdb.get('/search/multi', { query: entry, language: 'fr-FR', include_adult: false }, { label: 'search' }).catch(() => null);
    const hits = ((r && r.results) || []).filter((x) => x.media_type === 'movie' || x.media_type === 'tv').slice(0, 3);
    const out = [];
    for (const [i, h] of hits.entries()) {
      const kind = h.media_type; const det = await cl.tmdb.ensureDetails(kind, [h.id]); const rec = det.get(h.id);
      if (rec && rec.im) out.push({ imdb: rec.im, type: kind === 'tv' ? 'series' : 'movie', name: rec.t, via: `recherche TMDB (résultat ${i + 1}/${hits.length})` });
      if (out.length) break;                                            // on analyse le meilleur résultat ; les autres sont listés en alternatives
    }
    if (out.length) out[0].alternatives = hits.slice(1).map((h) => h.title || h.name).filter(Boolean);
    if (!out.length) {                                                  // dernier recours : sous-chaîne dans la bibliothèque
      const part = libItems.filter((x) => x.name && fold(x.name).includes(f));
      return part.slice(0, MAX_MATCHES).map((x) => ({ imdb: x.imdb, type: x.type, name: x.name, via: 'bibliothèque (correspondance partielle)' }));
    }
    return out;
  }

  const out = [];
  for (const entry of entries) {
    let targets = [];
    try { targets = await resolve(entry); } catch (e) { out.push({ demande: entry, erreur: `résolution impossible (${String(e && e.message || e).slice(0, 80)})` }); continue; }
    if (!targets.length) { out.push({ demande: entry, erreur: 'introuvable (ni dans la bibliothèque, ni sur TMDB)' }); continue; }
    for (const t of targets) out.push({ demande: entry, ...(await analyse(t)) });
  }

  async function analyse(t) {
    const lib = byImdb.get(t.imdb) || null; const sn = snap && snap.items[t.imdb] || null;
    const r = { imdb: t.imdb, type: t.type, titre: t.name || null, trouveVia: t.via };
    if (t.alternatives && t.alternatives.length) r.autresResultats = t.alternatives;
    // --- bibliothèque
    if (lib) {
      const c = classify({ _id: lib.imdb, type: lib.type, state: lib.state, _mtime: lib.mtime });
      const s = lib.state || {};
      r.bibliotheque = {
        presente: true, retire: lib.removed, temporaire: lib.temp, decision: c.seen ? 'VU' : c.started ? 'commencé' : 'rien', signaux: c.why,
        statut: snap ? LABEL[(sn && sn[1]) || '?'] : 'inconnu (aucun instantané)', dernierVisionnage: c.lw ? new Date(c.lw).toISOString().slice(0, 10) : null,
        etatBrut: { timesWatched: s.timesWatched ?? null, flaggedWatched: s.flaggedWatched ?? null, timeWatched: s.timeWatched ?? null, timeOffset: s.timeOffset ?? null, duration: s.duration ?? null, video_id: s.video_id ?? null,
          watched: typeof s.watched === 'string' ? `liste d'épisodes présente (${s.watched.length} caractères)` : s.watched === true ? 'true' : null, lastWatched: s.lastWatched ?? null, _mtime: lib.mtime }
      };
    } else if (sn) r.bibliotheque = { presente: 'absente de la bibliothèque en direct, présente au dernier calcul', decision: sn[2].includes('s') ? 'VU' : sn[2].includes('t') ? 'commencé' : 'rien', signaux: sn[4] || null, statut: LABEL[sn[1]] || 'inconnu' };
    else r.bibliotheque = { presente: false };
    // --- filtres actuels
    try {
      const m = await cl.tmdb.findMany([t.imdb], t.type); const id = m.get(t.imdb);
      if (!id) r.filtres = { erreur: 'identifiant TMDB introuvable' };
      else {
        const det = await cl.tmdb.ensureDetails(kindOf(t.type), [id]); const rec = det.get(id);
        if (!rec) r.filtres = { erreur: 'fiche TMDB indisponible' };
        else {
          attach([rec], imdbData);
          if (!r.titre) r.titre = rec.t; r.annee = rec.y || null;
          const adm = pipe.admissible([rec], { settings: eff, type: t.type, seenImdb: seenSet });
          const why = Object.keys(adm.rejects)[0] || null;
          r.filtres = { passe: adm.recs.length === 1, bloquePar: why, genres: rec.gn, genresVirtuels: virtualTags(rec), motsCles: (rec.kw || []).slice(0, 15).map((k) => k[1]), noteIMDb: rec.ir ?? null, votesIMDb: rec.iv ?? null, noteTMDB: rec.va, votesTMDB: rec.vc, seuils: { note: eff[t.type].minRating, votes: eff[t.type].minVotes, source: eff[t.type].source }, statutSerie: t.type === 'series' ? rec.st : undefined };
          if (t.type === 'series') { try { await engine.vf.load(); r.vf = engine.vf.peek(rec); } catch { r.vf = { statut: 'illisible' }; } }
          try { const es = job.embed && job.embed.model ? engine.embedSpaces.get(`${job.embed.model}:${job.embed.dim}`) : null; r.embedding = es ? { vectorise: es.has(embed.idOf(rec)) } : { vectorise: false, note: 'embeddings inactifs ou non chargés' }; } catch { /* facultatif */ }
        }
      }
    } catch (e) { r.filtres = { erreur: String(e && e.message || e).slice(0, 100) }; }
    // --- Top 30 publié et rang dans le modèle
    const sec = published[t.type]; const it = sec && sec.items.find((x) => x.imdb === t.imdb);
    r.top30 = it ? { rang: it.score.rank, rangLocal: it.score.localRank ?? null, probaCoupDeCoeur: round(it.score.pLove), gemini: it.score.gemini ? { note: it.score.gemini.fit, connaissance: it.score.gemini.know, motif: it.score.gemini.note } : null } : null;
    const rk = job.ranks && job.ranks[t.type]; const pos = rk ? rk.findIndex((x) => x[0] === t.imdb) : -1;
    r.modele = pos >= 0 ? { rangLocal: pos + 1, rangApresExclusionVF: t.type === 'series' ? pos + 1 - rk.slice(0, pos).filter((x) => x[2]).length : undefined, utilite: rk[pos][1], surCandidats: `${rk.length} premiers conservés`, note: t.type === 'series' ? 'rangLocal = avant exclusion VF ; rangApresExclusionVF = rang réel dans la liste' : undefined } : rk ? { rangLocal: `au-delà de ${rk.length}${r.filtres && r.filtres.passe === false ? ' (ou écarté par les filtres)' : ''}` } : { rangLocal: 'pas encore disponible (relance un calcul)' };
    return r;
  }
  return { profil: uid.slice(0, 6) + '…', demandes: entries.length, resultats: out, notes };
}
module.exports = { run, fold, effectiveSettings };
