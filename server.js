"use strict";

const http = require("http");
const crypto = require("crypto");
const { URL, URLSearchParams } = require("url");

const PORT = Number(process.env.PORT || 10000);
const HOST = process.env.HOST || "0.0.0.0";
const CONFIG_SECRET = process.env.CONFIG_SECRET || crypto.createHash("sha256").update(`antony:${process.env.RENDER_SERVICE_ID || process.env.RENDER_INSTANCE_ID || "local"}`).digest("hex");

const DEFAULTS = {
  tmdbApiKey: "",
  stremioAuthKey: "",
  tmdbMinRating: 7,
  tmdbMinVotes: 1000,
  yearMin: 1900,
  yearMax: new Date().getFullYear(),
  runtimeMin: 0,
  runtimeMax: 0,
  excludeGenres: ["Horror"],
  useWatchedExclusion: true,
  useLikes: true,
  useHearts: true,
  excludeCancelledSeries: true,
  allowOngoingSeries: true,
  maxResults: 24
};

const MANIFEST = {
  id: "com.antony.personalrecommendations",
  version: "0.3.0",
  name: "🎯 Antony — Personal Recommendations",
  description: "Personalized movie and series catalogs using Stremio watch state, Stremio likes/hearts and TMDB.",
  resources: ["catalog", "meta"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [
    { type: "movie", id: "antony_movies", name: "🎯 Antony — Films" },
    { type: "series", id: "antony_series", name: "🎯 Antony — Séries" }
  ],
  behaviorHints: {
    configurable: true,
    configurationRequired: false
  }
};

const INITIAL_GENRES = {
  Adventure: 1.25, Fantasy: 1.25, "Science Fiction": 1.20, Action: 1.05,
  Drama: 1.00, Thriller: 0.95, History: 1.15, War: 1.15,
  Crime: 0.95, Mystery: 0.95
};
const INITIAL_THEMES = {
  epic: 1.20, "political intrigue": 1.20, "power struggle": 1.20,
  revenge: 1.15, ambition: 1.10, transformation: 1.05,
  survival: 1.00, dystopia: 1.00, space: 0.95, historical: 1.10
};

const memCache = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000;

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function packConfig(config) {
  const iv = crypto.randomBytes(12);
  const key = crypto.createHash("sha256").update(CONFIG_SECRET).digest();
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(config), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return b64url(Buffer.concat([iv, tag, body]));
}

function unpackConfig(token) {
  try {
    const raw = Buffer.from(token, "base64url");
    if (raw.length < 29) return null;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const body = raw.subarray(28);
    const key = crypto.createHash("sha256").update(CONFIG_SECRET).digest();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return { ...DEFAULTS, ...JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8")) };
  } catch {
    return null;
  }
}

async function jsonFetch(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function stremioApi(method, body) {
  return jsonFetch(`https://api.strem.io/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

function resultOf(x) {
  if (!x || typeof x !== "object") return x;
  return x.result ?? x;
}

function arrayFrom(x) {
  const y = resultOf(x);
  if (Array.isArray(y)) return y;
  if (Array.isArray(y?.items)) return y.items;
  if (Array.isArray(y?.data)) return y.data;
  return [];
}

function extractImdb(item) {
  const candidates = [
    item?._id, item?.id, item?.metaItemId, item?.meta?.id,
    item?.state?.metaItemId, item?.state?._id
  ];
  for (const value of candidates) {
    if (typeof value === "string") {
      const m = value.match(/(?:^|:)(tt\d{5,12})(?:$|:)/);
      if (m) return m[1];
    }
  }
  return null;
}

function isWatched(item) {
  const s = item?.state || {};
  if (s.watched === true || s.flaggedWatched === 1 || s.isWatched === true) return true;
  if (typeof s.watched === "number") return s.watched > 0;
  if (typeof s.timeWatched === "number" && typeof s.duration === "number" && s.duration > 0) {
    return s.timeWatched / s.duration >= 0.7;
  }
  // For series, Stremio uses a serialized watched bitfield. Any non-empty/non-zero
  // bitfield means at least one episode has been watched, so the show is excluded.
  if (typeof s.watched === "string" && s.watched.length > 0) return /[^0:]+/.test(s.watched);
  return false;
}

async function getLibrary(authKey) {
  if (!authKey) return [];
  const meta = resultOf(await stremioApi("datastoreMeta", {
    authKey,
    collection: "libraryItem"
  }));
  const ids = arrayFrom(meta).map(x => typeof x === "string" ? x : x?._id || x?.id).filter(Boolean);
  if (ids.length === 0) {
    return arrayFrom(await stremioApi("datastoreGet", {
      authKey, collection: "libraryItem", ids: [], all: true
    }));
  }
  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    out.push(...arrayFrom(await stremioApi("datastoreGet", {
      authKey, collection: "libraryItem", ids: ids.slice(i, i + 100), all: false
    })));
  }
  return out;
}

function normalizeRating(x) {
  if (x == null) return null;
  const v = typeof x === "object" ? (x.status ?? x.rating ?? x.value ?? x.type) : x;
  if (typeof v !== "string") return null;
  const s = v.toLowerCase();
  if (s === "loved" || s === "love" || s === "heart" || s === "hearted") return "heart";
  if (s === "liked" || s === "like" || s === "thumbsup" || s === "thumbs-up") return "like";
  if (s === "watched") return "watched";
  return null;
}

async function getStremioRating(authKey, imdbId, type) {
  if (!authKey || !imdbId || !["movie", "series"].includes(type)) return null;
  const u = new URL("https://likes.stremio.com/api/get_status");
  u.searchParams.set("authToken", authKey);
  u.searchParams.set("mediaId", imdbId);
  u.searchParams.set("mediaType", type);
  try {
    const data = await jsonFetch(u);
    return normalizeRating(data?.status ?? data?.rating ?? data?.result ?? data);
  } catch {
    return null;
  }
}

async function tmdb(endpoint, params, apiKey) {
  if (!apiKey) throw new Error("TMDB API key manquante");
  const u = new URL(`https://api.themoviedb.org/3/${endpoint}`);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
  }
  u.searchParams.set("api_key", apiKey);
  return jsonFetch(u);
}

function qualityScore(rating, votes, minimumVotes) {
  const R = Number(rating) || 0;
  const V = Number(votes) || 0;
  const m = Math.max(1, Number(minimumVotes) || 1);
  const C = 7;
  return (V / (V + m)) * R + (m / (V + m)) * C;
}

function tokenize(text) {
  return String(text || "").toLowerCase().split(/[^a-z0-9]+/).filter(x => x.length >= 4);
}

function featuresFromDetails(d) {
  const features = [];
  for (const g of d.genres || []) features.push(`genre:${g.name}`);
  for (const k of d.keywords?.keywords || []) features.push(`kw:${String(k.name || "").toLowerCase()}`);
  return features;
}

function learnedProfile(positiveDetails) {
  const counts = new Map();
  let totalWeight = 0;
  for (const item of positiveDetails) {
    const w = item.rating === "heart" ? 1.5 : 1.0;
    totalWeight += w;
    const unique = new Set(featuresFromDetails(item.details));
    for (const f of unique) counts.set(f, (counts.get(f) || 0) + w);
  }
  const weights = {};
  const denominator = totalWeight || 1;
  for (const [f, n] of counts.entries()) {
    const p = n / denominator;
    // Adaptive lift. It uses the user's actual positive signals rather than
    // a fixed genre list, while keeping any single feature bounded.
    weights[f] = Math.max(-1.5, Math.min(2.5, 3.0 * (p - 0.20)));
  }
  return weights;
}

function initialScore(d) {
  let z = 0;
  for (const g of d.genres || []) z += INITIAL_GENRES[g.name] || 0;
  for (const k of d.keywords?.keywords || []) {
    const n = String(k.name || "").toLowerCase();
    for (const [theme, w] of Object.entries(INITIAL_THEMES)) {
      if (n.includes(theme) || theme.includes(n)) z += w;
    }
    // Soft semantic prior for terms that match the user's known profile.
    const words = tokenize(n);
    if (words.includes("political")) z += 0.8;
    if (words.includes("revenge")) z += 0.8;
    if (words.includes("empire") || words.includes("kingdom")) z += 0.5;
  }
  if ((d.genres || []).some(g => g.name === "Horror")) z -= 2.5;
  return z;
}

function finalScore(d, learned, feedback) {
  let z = qualityScore(d.vote_average, d.vote_count, feedback.minimumVotes) * 0.9;
  z += Math.log10(1 + (Number(d.vote_count) || 0)) * 0.35;
  z += initialScore(d);
  for (const f of featuresFromDetails(d)) z += learned[f] || 0;
  if (feedback.rating === "heart") z += 6;
  else if (feedback.rating === "like") z += 3;
  return z;
}

async function buildProfile(config, libraryItems) {
  const positive = [];
  const watched = new Set();
  const feedback = new Map();
  for (const item of libraryItems) {
    const id = extractImdb(item);
    if (!id) continue;
    if (config.useWatchedExclusion && isWatched(item)) watched.add(id);
    const type = item.type === "series" || item.type === "movie" ? item.type : null;
    if (!type) continue;
    const rating = await getStremioRating(config.stremioAuthKey, id, type);
    if ((rating === "like" && config.useLikes) || (rating === "heart" && config.useHearts)) {
      feedback.set(id, { rating, type });
      positive.push({ id, type, rating });
    }
  }

  // Learn from a bounded number of positive items. The profile is rebuilt on cache
  // refresh, so it does not rely on a non-persistent Render disk.
  const details = [];
  for (const p of positive.slice(0, 60)) {
    try {
      const found = await tmdb("find/" + encodeURIComponent(p.id), { external_source: "imdb_id", language: "en-US" }, config.tmdbApiKey);
      const d = p.type === "movie" ? found.movie_results?.[0] : found.tv_results?.[0];
      if (d) {
        const full = await tmdb(`${p.type === "series" ? "tv" : "movie"}/${d.id}`, {
          language: "en-US", append_to_response: "keywords,external_ids"
        }, config.tmdbApiKey);
        details.push({ details: full, rating: p.rating });
      }
    } catch {}
  }
  const learned = learnedProfile(details);
  return { watched, feedback, learned, positiveCount: positive.length };
}

function configFromForm(p) {
  const genres = (p.get("excludeGenres") || "").split(",").map(x => x.trim()).filter(Boolean);
  return {
    ...DEFAULTS,
    tmdbApiKey: p.get("tmdbApiKey") || "",
    stremioAuthKey: p.get("stremioAuthKey") || "",
    tmdbMinRating: clamp(Number(p.get("tmdbMinRating")) || 7, 0, 10),
    tmdbMinVotes: Math.max(0, Number(p.get("tmdbMinVotes")) || 1000),
    yearMin: Math.max(1900, Number(p.get("yearMin")) || 1900),
    yearMax: Math.min(2100, Number(p.get("yearMax")) || new Date().getFullYear()),
    runtimeMin: Math.max(0, Number(p.get("runtimeMin")) || 0),
    runtimeMax: Math.max(0, Number(p.get("runtimeMax")) || 0),
    excludeGenres: genres,
    useWatchedExclusion: p.has("useWatchedExclusion"),
    useLikes: p.has("useLikes"),
    useHearts: p.has("useHearts"),
    excludeCancelledSeries: p.has("excludeCancelledSeries"),
    allowOngoingSeries: p.has("allowOngoingSeries")
  };
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

function configurePage(req) {
  const currentYear = new Date().getFullYear();
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>🎯 Antony</title><style>
body{font-family:system-ui,-apple-system,sans-serif;background:#111;color:#eee;max-width:760px;margin:24px auto;padding:0 18px;line-height:1.45}section{background:#1b1b1b;padding:18px;border-radius:14px;margin:14px 0}label{display:block;margin:12px 0 5px}input{width:100%;box-sizing:border-box;padding:11px;border-radius:8px;border:1px solid #444;background:#242424;color:#fff}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.check{display:flex;align-items:center;gap:9px}.check input{width:auto}.btn{display:block;width:100%;padding:14px;border:0;border-radius:9px;font-weight:700;background:#fff;color:#111}.muted{opacity:.72;font-size:.9em}.warn{background:#332515;padding:12px;border-radius:10px}</style></head><body>
<h1>🎯 Antony — Personal Recommendations</h1><p>Configuration du catalogue personnel Films + Séries.</p>
<form method="post" action="/config/save">
<section><h2>Connexions</h2><label>TMDB API key *</label><input name="tmdbApiKey" type="password" required autocomplete="off"><p class="muted">Cette clé sert uniquement à interroger TMDB.</p><label>Stremio AuthKey *</label><input name="stremioAuthKey" type="password" required autocomplete="off"><p class="muted">Utilise une AuthKey Stremio, pas ton mot de passe. Ne colle jamais cette clé dans le chat.</p></section>
<section><h2>Filtres TMDB</h2><div class="grid"><div><label>Note minimale</label><input name="tmdbMinRating" type="number" min="0" max="10" step="0.1" value="7"></div><div><label>Votes minimum</label><input name="tmdbMinVotes" type="number" min="0" step="100" value="1000"></div><div><label>Année min.</label><input name="yearMin" type="number" value="1990"></div><div><label>Année max.</label><input name="yearMax" type="number" value="${currentYear}"></div><div><label>Durée min. (minutes)</label><input name="runtimeMin" type="number" min="0" value="0"></div><div><label>Durée max. (minutes)</label><input name="runtimeMax" type="number" min="0" value="0"></div></div><label>Genres à exclure</label><input name="excludeGenres" value="Horror"><p class="muted">Sépare les genres par des virgules.</p></section>
<section><h2>Apprentissage</h2><label class="check"><input name="useWatchedExclusion" type="checkbox" checked> Exclure ce que j'ai déjà vu</label><label class="check"><input name="useLikes" type="checkbox" checked> Utiliser les 👍 Stremio</label><label class="check"><input name="useHearts" type="checkbox" checked> Utiliser les ❤️ Stremio</label><label class="check"><input name="excludeCancelledSeries" type="checkbox" checked> Exclure les séries annulées</label><label class="check"><input name="allowOngoingSeries" type="checkbox" checked> Autoriser les séries encore en cours</label></section>
<div class="warn">Le moteur utilise ton profil initial comme point de départ, puis renforce progressivement les caractéristiques présentes dans tes 👍/❤️ Stremio. Le visionnage sert à exclure, pas à conclure que tu as aimé.</div><br><button class="btn">Enregistrer et installer dans Stremio</button></form></body></html>`;
}

async function saveConfig(req, res) {
  try {
    const body = await readBody(req);
    const p = new URLSearchParams(body);
    const config = configFromForm(p);
    if (!config.tmdbApiKey) throw new Error("TMDB API key manquante");
    if (!config.stremioAuthKey) throw new Error("Stremio AuthKey manquante");
    const token = packConfig(config);
    const origin = `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host}`;
    const manifestUrl = `${origin}/u/${token}/manifest.json`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(`<!doctype html><meta name="viewport" content="width=device-width"><style>body{font-family:system-ui;background:#111;color:#eee;max-width:650px;margin:40px auto;padding:20px}a{display:block;background:#fff;color:#111;text-align:center;padding:16px;border-radius:10px;font-weight:700;text-decoration:none;margin:20px 0}.small{word-break:break-all;opacity:.7}</style><h1>Configuration terminée</h1><p>Le bouton ci-dessous ouvre Stremio avec ton catalogue personnel.</p><a href="stremio://${manifestUrl.replace(/^https?:\/\//, "")}">Installer dans Stremio</a><p class="small">URL du manifeste : ${esc(manifestUrl)}</p>`);
  } catch (e) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end(`Erreur de configuration: ${e.message}`);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > 200000) { reject(new Error("Formulaire trop volumineux")); req.destroy(); return; }
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function tokenFromPath(pathname) {
  const m = pathname.match(/^\/u\/([^/]+)(?:\/|$)/);
  return m ? unpackConfig(m[1]) : null;
}

async function discover(type, config, token) {
  if (!config.tmdbApiKey) throw new Error("TMDB API key manquante");
  const cacheKey = token || "anonymous";
  const cached = memCache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL_MS) return cached.data;

  const libraryItems = await getLibrary(config.stremioAuthKey);
  const profile = await buildProfile(config, libraryItems);
  const watched = profile.watched;
  const feedback = profile.feedback;
  const excludedGenres = new Set((config.excludeGenres || []).map(x => x.toLowerCase()));
  const candidates = [];

  for (let page = 1; page <= 4; page++) {
    const params = {
      language: "en-US",
      sort_by: "popularity.desc",
      page,
      vote_average_gte: config.tmdbMinRating,
      vote_count_gte: config.tmdbMinVotes
    };
    if (type === "movie") {
      params.primary_release_date_gte = `${config.yearMin}-01-01`;
      params.primary_release_date_lte = `${config.yearMax}-12-31`;
    } else {
      params.first_air_date_gte = `${config.yearMin}-01-01`;
      params.first_air_date_lte = `${config.yearMax}-12-31`;
    }
    const data = await tmdb(type === "movie" ? "discover/movie" : "discover/tv", params, config.tmdbApiKey);
    candidates.push(...(data.results || []));
  }

  const seen = new Set();
  const scored = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    try {
      const details = await tmdb(`${type === "series" ? "tv" : "movie"}/${candidate.id}`, {
        language: "en-US", append_to_response: "keywords,external_ids"
      }, config.tmdbApiKey);
      const imdbId = details.external_ids?.imdb_id || details.imdb_id;
      if (!imdbId || (config.useWatchedExclusion && watched.has(imdbId))) continue;
      if ((details.genres || []).some(g => excludedGenres.has(String(g.name).toLowerCase()))) continue;
      if (type === "series" && config.excludeCancelledSeries && details.status === "Canceled") continue;
      if (!config.allowOngoingSeries && type === "series" && details.status === "Returning Series") continue;
      const runtime = type === "movie" ? details.runtime : details.episode_run_time?.[0];
      if (config.runtimeMin && runtime && runtime < config.runtimeMin) continue;
      if (config.runtimeMax && runtime && runtime > config.runtimeMax) continue;
      const fb = feedback.get(imdbId) || { rating: null };
      const score = finalScore(details, profile.learned, { minimumVotes: config.tmdbMinVotes, rating: fb.rating });
      scored.push({ details, imdbId, score });
    } catch {}
  }

  scored.sort((a, b) => b.score - a.score);
  const metas = scored.slice(0, config.maxResults).map(({ details, imdbId }) => ({
    id: imdbId,
    type,
    name: details.title || details.name,
    poster: details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : undefined,
    background: details.backdrop_path ? `https://image.tmdb.org/t/p/w1280${details.backdrop_path}` : undefined,
    description: details.overview || "",
    releaseInfo: String(details.release_date || details.first_air_date || "").slice(0, 4),
    imdbRating: details.vote_average != null ? Number(details.vote_average).toFixed(1) : undefined,
    genres: (details.genres || []).map(g => g.name),
    posterShape: "poster"
  }));
  const result = { metas };
  memCache.set(cacheKey, { time: Date.now(), data: result });
  return result;
}

async function handle(req, res) {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  if (u.pathname === "/health") {
    res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
    return res.end("ok");
  }
  if (u.pathname === "/configure" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(configurePage(req));
  }
  if (u.pathname === "/config/save" && req.method === "POST") return saveConfig(req, res);

  const tokenConfig = tokenFromPath(u.pathname);
  if (tokenConfig && u.pathname.endsWith("/manifest.json")) {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    return res.end(JSON.stringify(MANIFEST));
  }

  if (tokenConfig) {
    const m = u.pathname.match(/^\/u\/[^/]+\/(catalog|meta)\/(movie|series)\/([^/]+?)(?:\/[^/]+)?(?:\.json)?$/);
    if (m) {
      const [, resource, type, id] = m;
      try {
        if (resource === "catalog") {
          const catalog = await discover(type, tokenConfig, u.pathname.split("/")[2]);
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=900, stale-while-revalidate=1800" });
          return res.end(JSON.stringify(catalog));
        }
        const find = await tmdb(`find/${encodeURIComponent(id)}`, { external_source: "imdb_id", language: "en-US" }, tokenConfig.tmdbApiKey);
        const hit = type === "movie" ? find.movie_results?.[0] : find.tv_results?.[0];
        if (!hit) { res.writeHead(404); return res.end(JSON.stringify({ meta: null })); }
        const details = await tmdb(`${type === "series" ? "tv" : "movie"}/${hit.id}`, { language: "en-US" }, tokenConfig.tmdbApiKey);
        const meta = {
          id,
          type,
          name: details.title || details.name,
          poster: details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : undefined,
          background: details.backdrop_path ? `https://image.tmdb.org/t/p/w1280${details.backdrop_path}` : undefined,
          description: details.overview || "",
          releaseInfo: String(details.release_date || details.first_air_date || "").slice(0, 4),
          imdbRating: details.vote_average != null ? Number(details.vote_average).toFixed(1) : undefined,
          genres: (details.genres || []).map(g => g.name),
          posterShape: "poster"
        };
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=3600" });
        return res.end(JSON.stringify({ meta }));
      } catch (e) {
        console.error(e);
        res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ error: "upstream_error" }));
      }
    }
  }

  if (u.pathname === "/manifest.json") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify(MANIFEST));
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("Antony Personal Recommendations — open /configure");
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    console.error(err);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Internal server error");
  });
});

server.listen(PORT, HOST, () => console.log(`Antony addon listening on ${HOST}:${PORT}`));
