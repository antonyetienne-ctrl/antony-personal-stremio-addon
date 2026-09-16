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
  geminiApiKey: "",
  tmdbMinRating: 7,
  tmdbMaxRating: 10,
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
  maxResults: 50
};

const MANIFEST = {
  id: "com.antony.personalrecommendations",
  version: "0.7.0",
  name: "🎯 Antony — Personal Recommendations",
  description: "Recommendations learned from Stremio 👍 and ❤️ only; watched items are used only for exclusion.",
  resources: ["catalog", "meta"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [
    { type: "movie", id: "antony_movies", name: "🎯 Antony — Films" },
    { type: "series", id: "antony_series", name: "🎯 Antony — Séries" }
  ],
  behaviorHints: { configurable: true, configurationRequired: false }
};

const cache = new Map();
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const PROFILE_CACHE_TTL_MS = 5 * 60 * 1000;
const TMDB_DETAIL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const EMBEDDING_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LIBRARY_CACHE_TTL_MS = 30 * 1000;
const RATING_CACHE_TTL_MS = 60 * 1000;
const REFRESH_LOCK = new Map();
const ACTIVE_CONFIGS = new Map();
const CACHE_MAX_ENTRIES = 80;
const MAX_POSITIVE_ITEMS = 100;
const MAX_PROFILE_ITEMS = 60;
const CANDIDATE_PAGES_PER_STRATEGY = 3;
const CANDIDATE_DETAILS_LIMIT = 160;
const EMBEDDING_BATCH = 80;

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}
function b64url(buf) { return Buffer.from(buf).toString("base64url"); }
function packConfig(config) {
  const iv = crypto.randomBytes(12);
  const key = crypto.createHash("sha256").update(CONFIG_SECRET).digest();
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(config), "utf8"), cipher.final()]);
  return b64url(Buffer.concat([iv, cipher.getAuthTag(), body]));
}
function unpackConfig(token) {
  try {
    const raw = Buffer.from(token, "base64url");
    if (raw.length < 29) return null;
    const key = crypto.createHash("sha256").update(CONFIG_SECRET).digest();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return { ...DEFAULTS, ...JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8")) };
  } catch { return null; }
}

function cacheSet(key, value, ttlMs = CACHE_TTL_MS) {
  cache.set(key, { time: Date.now(), expires: Date.now() + ttlMs, value });
  while (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
}
function cacheGet(key) {
  const x = cache.get(key);
  if (!x) return null;
  if (x.expires && Date.now() > x.expires) { cache.delete(key); return null; }
  return x.value;
}

async function jsonFetch(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return data;
  } finally { clearTimeout(timer); }
}

async function stremioApi(method, body) {
  return jsonFetch(`https://api.strem.io/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}
function resultOf(x) { return x && typeof x === "object" ? (x.result ?? x) : x; }
function arrayFrom(x) {
  const y = resultOf(x);
  if (Array.isArray(y)) return y;
  if (Array.isArray(y?.items)) return y.items;
  if (Array.isArray(y?.data)) return y.data;
  return [];
}

function extractImdb(item) {
  const candidates = [item?._id, item?.id, item?.metaItemId, item?.meta?.id, item?.state?.metaItemId, item?.state?._id];
  for (const value of candidates) {
    if (typeof value !== "string") continue;
    const m = value.match(/(?:^|:)(tt\d{5,12})(?:$|:)/);
    if (m) return m[1];
  }
  return null;
}
function itemType(item) {
  const t = item?.type || item?.meta?.type || item?.state?.type;
  if (t === "movie" || t === "series") return t;
  const id = extractImdb(item);
  return id ? (item?.meta?.seriesInfo || item?.seriesInfo ? "series" : "movie") : null;
}
function isWatched(item) {
  const s = item?.state || {};
  // Current Stremio LibraryItem has explicit counters/flags.
  if (Number(s.timesWatched) > 0) return true;
  if (Number(s.flaggedWatched) > 0) return true;
  if (s.watched === true || s.isWatched === true) return true;
  // Series use a serialized watched bitfield when individual episodes are watched.
  if (typeof s.watched === "string" && s.watched.trim()) return true;
  if (typeof s.timeWatched === "number" && typeof s.duration === "number" && s.duration > 0 && s.timeWatched / s.duration >= 0.7) return true;
  return false;
}

async function getLibrary(authKey) {
  if (!authKey) return [];
  const key = `library:${crypto.createHash("sha256").update(authKey).digest("hex").slice(0, 24)}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.time < PROFILE_CACHE_TTL_MS) return cached.value;
  const meta = resultOf(await stremioApi("datastoreMeta", { authKey, collection: "libraryItem" }));
  const ids = arrayFrom(meta).map(x => typeof x === "string" ? x : x?._id || x?.id).filter(Boolean);
  let items;
  if (!ids.length) items = arrayFrom(await stremioApi("datastoreGet", { authKey, collection: "libraryItem", ids: [], all: true }));
  else {
    const out = [];
    for (let i = 0; i < ids.length; i += 100) out.push(...arrayFrom(await stremioApi("datastoreGet", { authKey, collection: "libraryItem", ids: ids.slice(i, i + 100), all: false })));
    items = out;
  }
  const deduped = [...new Map(items.map(x => [x?._id || x?.id, x])).values()].filter(Boolean);
  cacheSet(key, deduped, LIBRARY_CACHE_TTL_MS);
  return deduped;
}

function normalizeRating(x) {
  if (x == null) return null;
  if (typeof x === "object") {
    for (const v of [x.status, x.rating, x.value, x.type, x.state, x.result]) {
      const r = normalizeRating(v);
      if (r) return r;
    }
    return null;
  }
  if (typeof x !== "string") return null;
  const s = x.toLowerCase().replace(/[ _-]/g, "");
  if (["loved","love","heart","hearted"].includes(s)) return "heart";
  if (["liked","like","thumbsup","thumbup"].includes(s)) return "like";
  if (s === "watched") return "watched";
  return null;
}
async function getStremioRating(authKey, imdbId, type) {
  const key = `rating:${crypto.createHash("sha256").update(`${authKey}:${type}:${imdbId}`).digest("hex").slice(0, 28)}`;
  const cached = cacheGet(key);
  if (cached !== null) return cached;
  const u = new URL("https://likes.stremio.com/api/get_status");
  u.searchParams.set("authToken", authKey);
  u.searchParams.set("mediaId", imdbId);
  u.searchParams.set("mediaType", type);
  try {
    const r = normalizeRating(await jsonFetch(u, {}, 10000));
    cacheSet(key, r || "none", RATING_CACHE_TTL_MS);
    return r;
  } catch {
    cacheSet(key, "none", 10 * 60 * 1000);
    return null;
  }
}
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try { out[i] = await fn(items[i], i); } catch { out[i] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function tmdb(endpoint, params, apiKey) {
  const u = new URL(`https://api.themoviedb.org/3/${endpoint}`);
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
  u.searchParams.set("api_key", apiKey);
  const key = `tmdb:${crypto.createHash("sha256").update(u.toString()).digest("hex").slice(0, 28)}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const data = await jsonFetch(u);
  cacheSet(key, data, endpoint.startsWith("discover/") ? PROFILE_CACHE_TTL_MS : TMDB_DETAIL_CACHE_TTL_MS);
  return data;
}

function cleanText(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}
const STOP = new Set("the and with from that this into their they them have has for are was were his her its our your about after before through while where when will would there than then film movie series show story life man woman people one two three very just over under between against who what which how also more most some such only other first last new old this that these those".split(" "));
function tokens(s) { return cleanText(s).split(/\s+/).filter(x => x.length >= 4 && !STOP.has(x)); }
function addWeighted(map, key, value) { if (!key) return; map.set(key, (map.get(key) || 0) + value); }

function textOf(d) {
  const genres = (d.genres || []).map(x => x.name).join(" ");
  const keywords = (d.keywords?.keywords || []).map(x => x.name).join(" ");
  const collection = d.belongs_to_collection?.name || "";
  const countries = (d.production_countries || []).map(x => x.name).join(" ");
  const creators = [
    ...(d.credits?.crew || []).filter(x => ["Director", "Creator", "Executive Producer", "Screenplay", "Writer"].includes(x.job)).slice(0, 6).map(x => x.name),
    ...(d.credits?.cast || []).slice(0, 8).map(x => x.name)
  ].join(" ");
  return [d.title || d.name || "", d.overview || "", genres, keywords, collection, countries, creators].join(" ");
}

function featureMap(d) {
  const m = new Map();
  for (const g of d.genres || []) addWeighted(m, `genre:${cleanText(g.name)}`, 1.0);
  for (const k of d.keywords?.keywords || []) addWeighted(m, `kw:${cleanText(k.name)}`, 1.0);
  if (d.belongs_to_collection?.id) addWeighted(m, `collection:${d.belongs_to_collection.id}`, 0.9);
  for (const c of d.production_countries || []) addWeighted(m, `country:${cleanText(c.name)}`, 0.12);
  if (d.original_language) addWeighted(m, `language:${cleanText(d.original_language)}`, 0.08);
  const runtime = Number(d.runtime || d.episode_run_time?.[0] || 0);
  if (runtime) addWeighted(m, `runtime:${Math.round(runtime / 20) * 20}`, 0.06);
  for (const x of (d.credits?.crew || [])) {
    if (x.job === "Director" || x.job === "Creator") addWeighted(m, `director:${cleanText(x.name)}`, 0.08);
  }
  for (const x of (d.credits?.cast || []).slice(0, 8)) addWeighted(m, `actor:${cleanText(x.name)}`, 0.04);
  for (const t of tokens(d.overview || "")) addWeighted(m, `word:${t}`, 0.20);
  return m;
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

async function geminiEmbeddings(apiKey, texts) {
  if (!apiKey || !texts.length) return null;
  const out = [];
  for (let start = 0; start < texts.length; start += EMBEDDING_BATCH) {
    const chunk = texts.slice(start, start + EMBEDDING_BATCH);
    const body = { requests: chunk.map(text => ({ model: "models/gemini-embedding-001", content: { parts: [{ text: String(text).slice(0, 12000) }] }, taskType: "SEMANTIC_SIMILARITY" })) };
    const data = await jsonFetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents", {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body)
    }, 30000);
    out.push(...(data?.embeddings || []).map(x => x.values || []));
  }
  return out.length === texts.length ? out : null;
}

async function cachedEmbeddings(apiKey, texts, namespace) {
  if (!apiKey || !texts.length) return null;
  const result = new Array(texts.length);
  const missing = [];
  const missingIndexes = [];
  for (let i = 0; i < texts.length; i++) {
    const hash = crypto.createHash("sha256").update(`${namespace}:${texts[i]}`).digest("hex");
    const cached = cacheGet(`embedding:${hash}`);
    if (cached) result[i] = cached;
    else { missing.push(texts[i]); missingIndexes.push(i); }
  }
  if (missing.length) {
    const fresh = await geminiEmbeddings(apiKey, missing);
    if (!fresh) return result.every(Boolean) ? result : null;
    fresh.forEach((v, j) => {
      result[missingIndexes[j]] = v;
      const hash = crypto.createHash("sha256").update(`${namespace}:${missing[j]}`).digest("hex");
      cacheSet(`embedding:${hash}`, v, EMBEDDING_CACHE_TTL_MS);
    });
  }
  return result.every(Boolean) ? result : null;
}

function learnedFeatureProfile(details) {
  const weights = new Map();
  let total = 0;
  for (const item of details) {
    const w = item.rating === "heart" ? 3 : 1;
    total += w;
    for (const [f, v] of featureMap(item.details)) addWeighted(weights, f, w * Math.min(v, 1));
  }
  if (!total) return weights;
  for (const [f, v] of weights) weights.set(f, v / total);
  return weights;
}

function featureSimilarity(candidate, profile) {
  if (!profile.size) return 0;
  let matched = 0, possible = 0;
  for (const [f, v] of featureMap(candidate)) {
    possible += Math.min(v, 1);
    matched += Math.min(v, 1) * (profile.get(f) || 0);
  }
  return possible ? matched / Math.max(0.0001, possible) : 0;
}

function lexicalSimilarity(candidate, positives) {
  const a = new Set(tokens(candidate.overview || ""));
  if (!a.size || !positives.length) return 0;
  let best = 0;
  for (const p of positives) {
    const b = new Set(tokens(p.details.overview || ""));
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    const union = a.size + b.size - inter;
    best = Math.max(best, union ? inter / union : 0);
  }
  return best;
}

function semanticScore(candidateVector, positiveVectors, positives) {
  if (!candidateVector || !positiveVectors?.length) return 0;
  const sims = [];
  for (let i = 0; i < Math.min(positiveVectors.length, positives.length); i++) {
    const s = Math.max(0, cosine(candidateVector, positiveVectors[i]));
    const w = positives[i].rating === "heart" ? 3 : 1;
    sims.push({ s, w });
  }
  sims.sort((a, b) => b.s - a.s);
  const top = sims.slice(0, 12);
  let num = 0, den = 0;
  for (const x of top) { num += x.s * x.w; den += x.w; }
  return den ? num / den : 0;
}

function hardFilter(d, type, config, watched, excludedGenres) {
  const imdb = d.external_ids?.imdb_id || d.imdb_id;
  if (!imdb) return null;
  if (config.useWatchedExclusion && (watched.has(imdb) || watched.has(String(imdb).toLowerCase()))) return null;
  const rating = Number(d.vote_average);
  const votes = Number(d.vote_count);
  // TMDB rating and vote count are filters only. They never enter the recommendation score.
  if (Number.isFinite(rating) && rating < config.tmdbMinRating) return null;
  if (Number.isFinite(rating) && rating > config.tmdbMaxRating) return null;
  if (votes < config.tmdbMinVotes) return null;
  if ((d.genres || []).some(g => excludedGenres.has(cleanText(g.name)))) return null;
  if (type === "series" && config.excludeCancelledSeries && String(d.status || "").toLowerCase() === "canceled") return null;
  if (type === "series" && !config.allowOngoingSeries && ["Returning Series", "In Production", "Planned", "Pilot"].includes(d.status)) return null;
  const date = d.release_date || d.first_air_date || "";
  const year = Number(String(date).slice(0, 4));
  if (year && (year < config.yearMin || year > config.yearMax)) return null;
  const runtime = type === "movie" ? Number(d.runtime || 0) : Number(d.episode_run_time?.[0] || 0);
  if (config.runtimeMin && runtime && runtime < config.runtimeMin) return null;
  if (config.runtimeMax && runtime && runtime > config.runtimeMax) return null;
  return imdb;
}

function diversityPick(scored, target) {
  if (scored.length <= target) return scored.slice();
  const pool = scored.slice();
  const selected = [];
  while (selected.length < target && pool.length) {
    let bestIndex = 0, bestValue = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i];
      let redundancy = 0;
      for (const s of selected) {
        const sem = c.semantic && s.semantic ? cosine(c.semantic, s.semantic) : 0;
        const feat = featureSimilarity(c.details, featureMap(s.details));
        redundancy = Math.max(redundancy, 0.65 * Math.max(0, sem) + 0.35 * Math.max(0, feat));
      }
      // Soft diversification only. It cannot overturn a very strong personal match indefinitely.
      const value = c.personalScore - 0.18 * redundancy;
      if (value > bestValue) { bestValue = value; bestIndex = i; }
    }
    selected.push(pool.splice(bestIndex, 1)[0]);
  }
  return selected;
}

async function buildProfile(config, libraryItems, type) {
  const libraryFingerprint = crypto.createHash("sha256").update(libraryItems.map(x => JSON.stringify({ id:x?._id||x?.id, m:x?._mtime||x?._mtime, s:x?.state })).sort().join("|")).digest("hex").slice(0, 24);
  const profileKey = `profile:${type}:${libraryFingerprint}:${config.useLikes}:${config.useHearts}:${config.geminiApiKey ? crypto.createHash("sha256").update(config.geminiApiKey).digest("hex").slice(0, 8) : "nogemini"}`;
  const cachedProfile = cacheGet(profileKey);
  if (cachedProfile) return cachedProfile;
  const watched = new Set();
  const positives = [];
  const relevant = libraryItems.filter(x => itemType(x) === type);
  // IMPORTANT: watched is built from Stremio's LibraryItem state, not from ratings.
  // Stremio's current model exposes timesWatched/flaggedWatched and a watched bitfield for series.
  for (const item of relevant) {
    const id = extractImdb(item);
    if (!id) continue;
    if (config.useWatchedExclusion && isWatched(item)) {
      watched.add(id);
      watched.add(id.toLowerCase());
    }
  }
  const rated = await mapLimit(relevant, 24, async item => {
    const id = extractImdb(item);
    if (!id) return null;
    const rating = await getStremioRating(config.stremioAuthKey, id, type);
    if ((rating === "heart" && config.useHearts) || (rating === "like" && config.useLikes)) return { id, rating, type };
    return null;
  });
  for (const x of rated) if (x) positives.push(x);

  const details = (await mapLimit(positives.slice(0, MAX_PROFILE_ITEMS), 16, async p => {
    const found = await tmdb(`find/${encodeURIComponent(p.id)}`, { external_source: "imdb_id", language: "en-US" }, config.tmdbApiKey);
    const d = type === "movie" ? found.movie_results?.[0] : found.tv_results?.[0];
    if (!d) return null;
    const full = await tmdb(`${type === "series" ? "tv" : "movie"}/${d.id}`, { language: "en-US", append_to_response: "keywords,external_ids,credits" }, config.tmdbApiKey);
    return { details: full, rating: p.rating, id: p.id };
  })).filter(Boolean);

  const featureProfile = learnedFeatureProfile(details);
  let positiveVectors = null;
  if (config.geminiApiKey && details.length) {
    positiveVectors = await cachedEmbeddings(config.geminiApiKey, details.map(x => textOf(x.details)), "positive");
  }
  const profile = { watched, positives: details, featureProfile, positiveVectors, positiveCount: positives.length };
  cacheSet(profileKey, profile, PROFILE_CACHE_TTL_MS);
  return profile;
}

async function discoverCandidates(type, config, profile) {
  const excludedGenres = new Set((config.excludeGenres || []).map(x => cleanText(x)));
  const genreCounts = new Map();
  for (const x of profile.positives) for (const g of (x.details.genres || [])) genreCounts.set(g.id, (genreCounts.get(g.id) || 0) + (x.rating === "heart" ? 3 : 1));
  const learnedGenreIds = [...genreCounts.entries()].filter(([id]) => id).sort((a,b) => b[1]-a[1]).slice(0, 4).map(([id]) => id);
  const keywordCounts = new Map();
  for (const x of profile.positives) for (const k of (x.details.keywords?.keywords || [])) if (k.id) keywordCounts.set(k.id, (keywordCounts.get(k.id) || 0) + (x.rating === "heart" ? 3 : 1));
  const topKeywordIds = [...keywordCounts.entries()].sort((a,b) => b[1]-a[1]).slice(0, 8).map(x => x[0]);

  const strategies = [
    { sort_by: "vote_average.desc" },
    { sort_by: "vote_count.desc" },
    { sort_by: "popularity.desc" }
  ];
  if (learnedGenreIds.length) strategies.push({ sort_by: "vote_count.desc", with_genres: learnedGenreIds.slice(0, 2).join(",") });
  if (topKeywordIds.length) strategies.push({ sort_by: "vote_count.desc", with_keywords: topKeywordIds.slice(0, 4).join(",") });

  const candidates = [];
  for (const strategy of strategies) {
    const pages = await Promise.all(Array.from({ length: CANDIDATE_PAGES_PER_STRATEGY }, (_, i) => {
      const params = { language: "en-US", include_adult: false, page: i + 1, ...strategy };
      if (type === "movie") { params.primary_release_date_gte = `${config.yearMin}-01-01`; params.primary_release_date_lte = `${config.yearMax}-12-31`; }
      else { params.first_air_date_gte = `${config.yearMin}-01-01`; params.first_air_date_lte = `${config.yearMax}-12-31`; }
      return tmdb(type === "movie" ? "discover/movie" : "discover/tv", params, config.tmdbApiKey).catch(() => null);
    }));
    for (const data of pages) candidates.push(...(data?.results || []));
  }
  const unique = [...new Map(candidates.map(x => [x.id, x])).values()];
  // Apply cheap filters before expensive detail calls. This removes most candidates immediately.
  const cheap = unique.filter(d => {
    const rating = Number(d.vote_average);
    const votes = Number(d.vote_count);
    if (Number.isFinite(rating) && (rating < config.tmdbMinRating || rating > config.tmdbMaxRating)) return false;
    if (votes < config.tmdbMinVotes) return false;
    const date = d.release_date || d.first_air_date || "";
    const year = Number(String(date).slice(0,4));
    if (year && (year < config.yearMin || year > config.yearMax)) return false;
    if (type === "series" && config.excludeCancelledSeries && String(d.status || "").toLowerCase() === "canceled") return false;
    return true;
  }).slice(0, CANDIDATE_DETAILS_LIMIT);
  const detailed = (await mapLimit(cheap, 24, async c => tmdb(`${type === "series" ? "tv" : "movie"}/${c.id}`, { language: "en-US", append_to_response: "keywords,external_ids,credits" }, config.tmdbApiKey))).filter(Boolean);
  return detailed.filter(d => hardFilter(d, type, config, profile.watched, excludedGenres));
}

async function buildTop50(type, config, profile) {
  if (!profile.positiveCount) return [];
  const filtered = await discoverCandidates(type, config, profile);
  if (!filtered.length) return [];

  let candidateVectors = null;
  if (config.geminiApiKey && profile.positiveVectors?.length) {
    candidateVectors = await geminiEmbeddings(config.geminiApiKey, filtered.map(textOf)).catch(() => null);
  }

  const scored = filtered.map((d, i) => {
    const sem = candidateVectors?.[i] ? semanticScore(candidateVectors[i], profile.positiveVectors, profile.positives) : 0;
    const feat = featureSimilarity(d, profile.featureProfile);
    const lex = lexicalSimilarity(d, profile.positives);
    // Personal taste is deliberately dominant. TMDB quality/popularity are weak
    // secondary signals only: they can break close calls, but cannot dominate a
    // strong taste match. Release date remains neutral.
    const tasteScore = config.geminiApiKey && profile.positiveVectors?.length
      ? 0.72 * sem + 0.23 * feat + 0.05 * lex
      : 0.80 * feat + 0.20 * lex;
    const rating = Math.max(0, Math.min(10, Number(d.vote_average) || 0)) / 10;
    const votes = Math.max(0, Number(d.vote_count) || 0);
    // Reliability rises with vote count but saturates quickly; it is not a
    // popularity ranking. 100k votes is already close to the ceiling.
    const voteReliability = Math.min(1, Math.log10(1 + votes) / 5);
    const tmdbWeak = 0.05 * rating + 0.03 * voteReliability;
    const personalScore = 0.92 * tasteScore + tmdbWeak;
    return { details: d, imdbId: d.external_ids?.imdb_id || d.imdb_id, personalScore, tasteScore, tmdbWeak, semantic: candidateVectors?.[i] || null };
  });
  scored.sort((a,b) => b.personalScore - a.personalScore);
  // Diversity is applied before the final top-50 cut. The result is then shuffled only for display.
  const diversified = diversityPick(scored, Math.min(50, config.maxResults));
  return diversified;
}

function serializeAndShuffle(top50, type) {
  const shuffled = top50.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return { metas: shuffled.map(({ details, imdbId }) => ({
    id: imdbId, type, name: details.title || details.name,
    poster: details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : undefined,
    background: details.backdrop_path ? `https://image.tmdb.org/t/p/w1280${details.backdrop_path}` : undefined,
    description: details.overview || "",
    releaseInfo: String(details.release_date || details.first_air_date || "").slice(0,4),
    imdbRating: details.vote_average != null ? Number(details.vote_average).toFixed(1) : undefined,
    genres: (details.genres || []).map(g => g.name), posterShape: "poster"
  })) };
}

function profileFingerprint(profile) {
  const positives = profile.positives.map(x => `${x.id}:${x.rating}`).sort().join("|");
  const watched = [...profile.watched].sort().join("|");
  return crypto.createHash("sha256").update(`${positives}##${watched}`).digest("hex").slice(0, 20);
}

async function computeRecommendations(type, config, token, library) {
  const profile = await buildProfile(config, library, type);
  const fingerprint = profileFingerprint(profile);
  const key = `result:${token}:${type}:${fingerprint}`;
  const cached = cacheGet(key);
  if (cached) return { top50: cached, fingerprint, profile };
  const top50 = await buildTop50(type, config, profile);
  cacheSet(key, top50, CACHE_TTL_MS);
  return { top50, fingerprint, profile };
}

async function discover(type, config, token) {
  ACTIVE_CONFIGS.set(token, config);
  const library = await getLibrary(config.stremioAuthKey);
  // Build a fingerprint from Stremio library state + current ratings before doing any heavy work.
  const profile = await buildProfile(config, library, type);
  const fingerprint = profileFingerprint(profile);
  const key = `result:${token}:${type}:${fingerprint}`;
  const cached = cacheGet(key);
  if (cached) {
    // Refresh the other catalog in the background without delaying this response.
    warmOtherType(type, config, token, library).catch(() => {});
    return serializeAndShuffle(cached, type);
  }
  const lockKey = `lock:${token}:${type}:${fingerprint}`;
  if (REFRESH_LOCK.has(lockKey)) {
    const result = await REFRESH_LOCK.get(lockKey);
    return serializeAndShuffle(result.top50, type);
  }
  const job = (async () => {
    const top50 = await buildTop50(type, config, profile);
    cacheSet(key, top50, CACHE_TTL_MS);
    return { top50 };
  })();
  REFRESH_LOCK.set(lockKey, job);
  try {
    const result = await job;
    return serializeAndShuffle(result.top50, type);
  } finally {
    REFRESH_LOCK.delete(lockKey);
  }
}

async function warmOtherType(currentType, config, token, library) {
  const other = currentType === "movie" ? "series" : "movie";
  const profile = await buildProfile(config, library, other);
  const fingerprint = profileFingerprint(profile);
  const key = `result:${token}:${other}:${fingerprint}`;
  if (cacheGet(key)) return;
  const lockKey = `lock:${token}:${other}:${fingerprint}`;
  if (REFRESH_LOCK.has(lockKey)) return;
  const job = (async () => {
    const top50 = await buildTop50(other, config, profile);
    cacheSet(key, top50, CACHE_TTL_MS);
  })();
  REFRESH_LOCK.set(lockKey, job);
  try { await job; } finally { REFRESH_LOCK.delete(lockKey); }
}


async function prewarmBoth(token, config) {
  ACTIVE_CONFIGS.set(token, config);
  const library = await getLibrary(config.stremioAuthKey);
  await Promise.all([
    (async () => {
      const profile = await buildProfile(config, library, "movie");
      const fingerprint = profileFingerprint(profile);
      const key = `result:${token}:movie:${fingerprint}`;
      if (!cacheGet(key)) cacheSet(key, await buildTop50("movie", config, profile), CACHE_TTL_MS);
    })(),
    (async () => {
      const profile = await buildProfile(config, library, "series");
      const fingerprint = profileFingerprint(profile);
      const key = `result:${token}:series:${fingerprint}`;
      if (!cacheGet(key)) cacheSet(key, await buildTop50("series", config, profile), CACHE_TTL_MS);
    })()
  ]);
}

function configFromForm(p) {
  const genres = (p.get("excludeGenres") || "").split(",").map(x => x.trim()).filter(Boolean);
  return {
    ...DEFAULTS,
    tmdbApiKey: p.get("tmdbApiKey") || "",
    stremioAuthKey: p.get("stremioAuthKey") || "",
    geminiApiKey: p.get("geminiApiKey") || "",
    tmdbMinRating: Math.max(0, Math.min(10, Number(p.get("tmdbMinRating")) || 7)),
    tmdbMaxRating: Math.max(0, Math.min(10, Number(p.get("tmdbMaxRating")) || 10)),
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
function configurePage() {
  const y = new Date().getFullYear();
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>🎯 Antony</title><style>body{font-family:system-ui;background:#111;color:#eee;max-width:760px;margin:24px auto;padding:0 18px;line-height:1.45}section{background:#1b1b1b;padding:18px;border-radius:14px;margin:14px 0}label{display:block;margin:12px 0 5px}input{width:100%;box-sizing:border-box;padding:11px;border-radius:8px;border:1px solid #444;background:#242424;color:#fff}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.check{display:flex;align-items:center;gap:9px}.check input{width:auto}.btn{display:block;width:100%;padding:14px;border:0;border-radius:9px;font-weight:700;background:#fff;color:#111}.muted{opacity:.72;font-size:.9em}.ok{background:#172b1d;padding:12px;border-radius:10px}</style></head><body><h1>🎯 Antony — Personal Recommendations</h1><p>50 films + 50 séries, appris uniquement de tes 👍 et ❤️.</p><form method="post" action="/config/save"><section><h2>Connexions</h2><label>TMDB API key *</label><input name="tmdbApiKey" type="password" required autocomplete="off"><label>Stremio AuthKey *</label><input name="stremioAuthKey" type="password" required autocomplete="off"><label>Gemini API key (recommandée)</label><input name="geminiApiKey" type="password" autocomplete="off"><p class="muted">Gemini sert uniquement à mesurer la similarité sémantique des histoires et thèmes. La recommandation reste pilotée par tes 👍/❤️.</p></section><section><h2>Filtres TMDB — filtres uniquement</h2><div class="grid"><div><label>Note minimale</label><input name="tmdbMinRating" type="number" min="0" max="10" step="0.1" value="7"></div><div><label>Note maximale</label><input name="tmdbMaxRating" type="number" min="0" max="10" step="0.1" value="10"></div><div><label>Votes minimum</label><input name="tmdbMinVotes" type="number" min="0" step="100" value="1000"></div><div><label>Année min.</label><input name="yearMin" type="number" value="1900"></div><div><label>Année max.</label><input name="yearMax" type="number" value="${y}"></div><div><label>Durée min.</label><input name="runtimeMin" type="number" min="0" value="0"></div><div><label>Durée max.</label><input name="runtimeMax" type="number" min="0" value="0"></div></div><label>Genres à exclure</label><input name="excludeGenres" value="Horror"><p class="muted">La note et le nombre de votes servent d'abord de filtres, puis ont seulement un faible poids (8 % au total) dans le classement final. L'année reste un filtre neutre.</p></section><section><h2>Apprentissage</h2><label class="check"><input name="useWatchedExclusion" type="checkbox" checked> Exclure ce que j'ai déjà vu</label><label class="check"><input name="useLikes" type="checkbox" checked> Utiliser les 👍</label><label class="check"><input name="useHearts" type="checkbox" checked> Utiliser les ❤️</label><label class="check"><input name="excludeCancelledSeries" type="checkbox" checked> Exclure les séries annulées</label><label class="check"><input name="allowOngoingSeries" type="checkbox" checked> Autoriser les séries en cours</label></section><div class="ok">❤️ pèse 3× 👍. Le visionnage n'est jamais interprété comme un goût. Les 50 meilleurs candidats sont sélectionnés, puis seulement mélangés pour l'affichage. Un nouveau 👍/❤️ invalide automatiquement le cache.</div><br><button class="btn">Enregistrer et installer</button></form></body></html>`;
}
async function saveConfig(req, res) {
  try {
    const config = configFromForm(new URLSearchParams(await readBody(req)));
    if (!config.tmdbApiKey) throw new Error("TMDB API key manquante");
    if (!config.stremioAuthKey) throw new Error("Stremio AuthKey manquante");
    if (config.tmdbMaxRating < config.tmdbMinRating) throw new Error("La note maximale doit être ≥ à la note minimale");
    const token = packConfig(config);
    const origin = `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host}`;
    const manifestUrl = `${origin}/u/${token}/manifest.json`;
    ACTIVE_CONFIGS.set(token, config);
    res.writeHead(200, { "content-type":"text/html; charset=utf-8", "cache-control":"no-store" });
    res.end(`<!doctype html><meta name="viewport" content="width=device-width"><style>body{font-family:system-ui;background:#111;color:#eee;max-width:650px;margin:40px auto;padding:20px}a{display:block;background:#fff;color:#111;text-align:center;padding:16px;border-radius:10px;font-weight:700;text-decoration:none;margin:20px 0}.small{word-break:break-all;opacity:.7}</style><h1>Configuration terminée</h1><p>Le moteur prépare déjà tes deux catalogues en arrière-plan.</p><a href="stremio://${manifestUrl.replace(/^https?:\/\//, "")}">Installer dans Stremio</a><p class="small">URL du manifeste : ${esc(manifestUrl)}</p>`);
    setImmediate(() => prewarmBoth(token, config).catch(e => console.error("Prewarm failed:", e.message)));
  } catch (e) { res.writeHead(400, { "content-type":"text/plain; charset=utf-8" }); res.end(`Erreur de configuration: ${e.message}`); }
}
function readBody(req) { return new Promise((resolve, reject) => { let data = "", size = 0; req.on("data", c => { size += c.length; if (size > 200000) { reject(new Error("Formulaire trop volumineux")); req.destroy(); } else data += c; }); req.on("end", () => resolve(data)); req.on("error", reject); }); }
function tokenFromPath(pathname) { const m = pathname.match(/^\/u\/([^/]+)(?:\/|$)/); return m ? unpackConfig(m[1]) : null; }

async function handle(req, res) {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  if (u.pathname === "/health") { res.writeHead(200, { "content-type":"text/plain", "cache-control":"no-store" }); return res.end("ok"); }
  if (u.pathname === "/configure" && req.method === "GET") { res.writeHead(200, { "content-type":"text/html; charset=utf-8", "cache-control":"no-store" }); return res.end(configurePage()); }
  if (u.pathname === "/config/save" && req.method === "POST") return saveConfig(req, res);
  const tokenConfig = tokenFromPath(u.pathname);
  if (tokenConfig && u.pathname.endsWith("/manifest.json")) { res.writeHead(200, { "content-type":"application/json", "cache-control":"no-store" }); return res.end(JSON.stringify(MANIFEST)); }
  if (tokenConfig) {
    const m = u.pathname.match(/^\/u\/[^/]+\/(catalog|meta)\/(movie|series)\/([^/]+?)(?:\/[^/]+)?(?:\.json)?$/);
    if (m) {
      const [, resource, type, id] = m;
      try {
        if (resource === "catalog") {
          const result = await discover(type, tokenConfig, u.pathname.split("/")[2]);
          res.writeHead(200, { "content-type":"application/json; charset=utf-8", "cache-control":"private, max-age=300, stale-while-revalidate=3600" });
          return res.end(JSON.stringify(result));
        }
        const find = await tmdb(`find/${encodeURIComponent(id)}`, { external_source:"imdb_id", language:"en-US" }, tokenConfig.tmdbApiKey);
        const hit = type === "movie" ? find.movie_results?.[0] : find.tv_results?.[0];
        if (!hit) { res.writeHead(404); return res.end(JSON.stringify({ meta:null })); }
        const d = await tmdb(`${type === "series" ? "tv" : "movie"}/${hit.id}`, { language:"en-US" }, tokenConfig.tmdbApiKey);
        res.writeHead(200, { "content-type":"application/json", "cache-control":"public, max-age=3600" });
        return res.end(JSON.stringify({ meta:{ id, type, name:d.title||d.name, poster:d.poster_path?`https://image.tmdb.org/t/p/w500${d.poster_path}`:undefined, background:d.backdrop_path?`https://image.tmdb.org/t/p/w1280${d.backdrop_path}`:undefined, description:d.overview||"", releaseInfo:String(d.release_date||d.first_air_date||"").slice(0,4), imdbRating:d.vote_average!=null?Number(d.vote_average).toFixed(1):undefined, genres:(d.genres||[]).map(g=>g.name), posterShape:"poster" } }));
      } catch (e) { console.error(e); res.writeHead(502, { "content-type":"application/json" }); return res.end(JSON.stringify({ error:"upstream_error" })); }
    }
  }
  if (u.pathname === "/manifest.json") { res.writeHead(200, { "content-type":"application/json" }); return res.end(JSON.stringify(MANIFEST)); }
  res.writeHead(200, { "content-type":"text/plain; charset=utf-8" }); res.end("Antony Personal Recommendations — open /configure");
}

setInterval(async () => {
  for (const [token, config] of ACTIVE_CONFIGS) {
    try {
      const library = await getLibrary(config.stremioAuthKey);
      await Promise.all(["movie", "series"].map(type => warmOtherType(type === "movie" ? "series" : "movie", config, token, library)));
    } catch (e) { console.error("Background refresh failed:", e.message); }
  }
}, 6 * 60 * 60 * 1000).unref();

http.createServer((req,res) => handle(req,res).catch(e => { console.error(e); if (!res.headersSent) res.writeHead(500); res.end("Internal server error"); })).listen(PORT, HOST, () => console.log(`Antony addon v0.7.0 listening on ${HOST}:${PORT}`));
