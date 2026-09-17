"use strict";

const http = require("http");
const crypto = require("crypto");
const zlib = require("zlib");
const { URL, URLSearchParams } = require("url");

const ALGO_VERSION = "5.2.0";
const PORT = Number(process.env.PORT || 10000);
const HOST = process.env.HOST || "0.0.0.0";
const CONFIG_SECRET = process.env.CONFIG_SECRET || crypto.createHash("sha256").update(`antony:${process.env.RENDER_SERVICE_ID || process.env.RENDER_INSTANCE_ID || "local"}`).digest("hex");

const DEFAULTS = {
  tmdbAccessToken: "",
  stremioAuthKey: "",
  geminiApiKey: "",
  tmdbMinRating: 7.2,
  tmdbMaxRating: 10,
  tmdbMinVotes: 2000,
  yearMin: 1900,
  yearMax: new Date().getFullYear(),
  runtimeMinMovie: 0,
  excludeGenres: ["Horror", "Romance", "Music", "Comedy"],
  useWatchedExclusion: true,
  useLikes: true,
  useHearts: true,
  excludeCancelledSeries: true,
  allowOngoingSeries: true,
  maxResults: 30,
  displayOrder: "random",
  excludeKids: true,
  excludeWesternAnimation: true,
  movieCatalogEnabled: true,
  seriesCatalogEnabled: true
};

function buildManifest(config = DEFAULTS) {
  const catalogs = [];
  if (config.movieCatalogEnabled !== false) catalogs.push({ type: "movie", id: "antony_movies", name: "🎯 Recommandations selon vos Goûts" });
  if (config.seriesCatalogEnabled !== false) catalogs.push({ type: "series", id: "antony_series", name: "🎯 Recommandations selon vos Goûts" });
  return {
    id: "com.antony.personalrecommendations",
    version: ALGO_VERSION,
    name: "🎯 Antony — Personal Recommendations",
    description: "Recommendations learned primarily from Stremio 👍 and ❤️, with watched-without-rating used as cautious negative evidence with repetition confidence; watched items remain excluded from results.",
    resources: ["catalog", "meta"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs,
    behaviorHints: { configurable: true, configurationRequired: false }
  };
}

let LAST_CONFIG_TOKEN = "";
const CONFIG_ALIASES = new Map();
const cache = new Map();
const UPSTASH_URL = String(process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const UPSTASH_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || "");
const UPSTASH_ENABLED = Boolean(UPSTASH_URL && UPSTASH_TOKEN);
const PERSIST_PREFIX = "antony:v5:p:";
const PERSIST_CATALOG_TTL_SEC = 30 * 24 * 60 * 60;
const PERSIST_STATE_TTL_SEC = 7 * 24 * 60 * 60;
const PERSIST_TMDB_TTL_SEC = 90 * 24 * 60 * 60;
const UPSTASH_TIMEOUT_MS = 7000;
let upstashWarned = false;
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const PROFILE_CACHE_TTL_MS = 5 * 60 * 1000;
const TMDB_DETAIL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const EMBEDDING_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LIBRARY_CACHE_TTL_MS = 60 * 1000;
const RATING_CACHE_TTL_MS = 60 * 1000;
const REFRESH_LOCK = new Map();
const ACTIVE_CONFIGS = new Map();
const CACHE_MAX_ENTRIES = 220;
const CATALOG_FRESH_MS = 12 * 60 * 60 * 1000;
const CATALOG_STALE_MS = 30 * 24 * 60 * 60 * 1000;
const STATE_REFRESH_MS = 15 * 60 * 1000;
const STATE_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const stateStore = new Map();
const catalogStore = new Map();
const refreshJobs = new Map();
const typeBuildLocks = new Map();
const MAX_POSITIVE_ITEMS = Infinity;
const MAX_PROFILE_ITEMS = Infinity;
const CANDIDATE_PAGES_PER_STRATEGY = 2;
const CANDIDATE_DISCOVERY_STRATEGIES = 44;
const CANDIDATE_DETAILS_LIMIT = 480;
const CANDIDATE_DETAIL_BATCH = 60;
const CANDIDATE_DETAIL_CONCURRENCY = 10;
const MIN_RECOMMENDATIONS_TARGET = 30;
const POSITIVE_SEED_LIMIT = 80;
const SEED_NEIGHBOR_PAGES = 1;
const WATCHED_NEGATIVE_LIMIT = 180;
const WATCHED_NEGATIVE_MAX_PENALTY = 0.24;
const EMBEDDING_BATCH = 50;
const COLD_START_WAIT_MS = 12000;
const GEMINI_COOLDOWN_MS = 15 * 60 * 1000;
let geminiCooldownUntil = 0;
let geminiTail = Promise.resolve();
function geminiAvailable(apiKey) { return Boolean(apiKey) && Date.now() >= geminiCooldownUntil; }
function markGeminiFailure(err) {
  const msg = String(err?.message || err || "Gemini error");
  if (/HTTP 429|HTTP 403|quota|rate.?limit/i.test(msg)) geminiCooldownUntil = Date.now() + GEMINI_COOLDOWN_MS;
}

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


function persistKey(scope, token = "", extra = "") {
  const user = token ? crypto.createHash("sha256").update(token).digest("hex").slice(0, 24) : "global";
  const suffix = extra ? `:${extra}` : "";
  return `${PERSIST_PREFIX}${user}:${scope}${suffix}`;
}
function packPersistent(value) {
  return zlib.gzipSync(Buffer.from(JSON.stringify(value), "utf8"), { level: 6 }).toString("base64");
}
function unpackPersistent(value) {
  try {
    return JSON.parse(zlib.gunzipSync(Buffer.from(String(value), "base64")).toString("utf8"));
  } catch { return null; }
}
async function upstashCommand(command, args = []) {
  if (!UPSTASH_ENABLED) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTASH_TIMEOUT_MS);
  try {
    const response = await fetch(`${UPSTASH_URL}`, {
      method: "POST",
      headers: { "authorization": `Bearer ${UPSTASH_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify([command, ...args]),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Upstash HTTP ${response.status}`);
    const data = await response.json();
    if (data?.error) throw new Error(`Upstash ${data.error}`);
    return data?.result ?? null;
  } catch (e) {
    if (!upstashWarned) { console.warn(`Upstash cache unavailable; continuing with local cache: ${e.message}`); upstashWarned = true; }
    return null;
  } finally { clearTimeout(timer); }
}
async function persistentGet(key) {
  if (!UPSTASH_ENABLED) return null;
  const raw = await upstashCommand("GET", [key]);
  return raw == null ? null : unpackPersistent(raw);
}
async function persistentSet(key, value, ttlSec) {
  if (!UPSTASH_ENABLED) return false;
  const raw = packPersistent(value);
  const result = await upstashCommand("SET", [key, raw, "EX", ttlSec]);
  return result === "OK";
}
async function persistentDeleteByPrefix(prefix) {
  // Deliberately unused: avoid KEYS/SCAN traffic on the free tier. TTL + eviction handle housekeeping.
  return false;
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

async function jsonFetch(url, options = {}, timeoutMs = 12000, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      if (response.ok) return data;
      const retryable = response.status === 429 || response.status >= 500;
      lastError = new Error(`HTTP ${response.status}`);
      if (!retryable || attempt === attempts) throw lastError;
    } catch (e) {
      lastError = e;
      const retryable = e?.name === "AbortError" || /fetch failed|ECONN|ETIMEDOUT|HTTP 429|HTTP 5\d\d/i.test(String(e?.message || e));
      if (!retryable || attempt === attempts) throw e;
    } finally {
      clearTimeout(timer);
    }
    await new Promise(r => setTimeout(r, 350 * (2 ** (attempt - 1)) + crypto.randomInt(250)));
  }
  throw lastError || new Error("HTTP request failed");
}

async function stremioApi(method, body) {
  return jsonFetch(`https://api.strem.io/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }, 8000, 2);
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

async function getLibrary(authKey, { force = false } = {}) {
  if (!authKey) return [];
  const key = `library:${crypto.createHash("sha256").update(authKey).digest("hex").slice(0, 24)}`;
  const cached = cache.get(key);
  if (!force && cached && Date.now() - cached.time < STATE_REFRESH_MS) return cached.value;

  // Prefer one complete datastoreGet. This is the same basic strategy used by
  // Watchly: fetch the whole library state once, then process it locally.
  try {
    const all = arrayFrom(await stremioApi("datastoreGet", {
      authKey, collection: "libraryItem", ids: [], all: true
    }));
    const deduped = [...new Map(all.map(x => [x?._id || x?.id, x])).values()].filter(Boolean);
    cacheSet(key, deduped, STATE_STALE_MS);
    return deduped;
  } catch (firstError) {
    // Compatibility fallback for accounts/servers that reject all=true.
    const meta = resultOf(await stremioApi("datastoreMeta", { authKey, collection: "libraryItem" }));
    const ids = arrayFrom(meta).map(x => typeof x === "string" ? x : x?._id || x?.id).filter(Boolean);
    const out = [];
    for (let i = 0; i < ids.length; i += 100) {
      out.push(...arrayFrom(await stremioApi("datastoreGet", {
        authKey, collection: "libraryItem", ids: ids.slice(i, i + 100), all: false
      })));
    }
    const deduped = [...new Map(out.map(x => [x?._id || x?.id, x])).values()].filter(Boolean);
    cacheSet(key, deduped, STATE_STALE_MS);
    return deduped;
  }
}
function libraryFingerprint(items) {
  return crypto.createHash("sha256").update((items || []).map(x => JSON.stringify({
    id: x?._id || x?.id,
    state: x?.state,
    mtime: x?._mtime
  })).sort().join("|")).digest("hex").slice(0, 24);
}

function watchedSetFromLibrary(library) {
  const watched = new Set();
  for (const item of library || []) {
    const id = extractImdb(item);
    if (id && isWatched(item)) {
      watched.add(id);
      watched.add(id.toLowerCase());
    }
  }
  return watched;
}

function stateKey(token) { return `state:${token}`; }
function catalogKey(token, type) { return `${token}:${type}`; }

function getCatalogCached(token, type) {
  const x = catalogStore.get(catalogKey(token, type));
  if (!x) return null;
  if (Date.now() > x.staleUntil) {
    catalogStore.delete(catalogKey(token, type));
    return null;
  }
  return { ...x, stale: Date.now() > x.freshUntil };
}

function putCatalog(token, type, payload, fingerprint, usedGemini) {
  const now = Date.now();
  const record = { payload, fingerprint, usedGemini, createdAt: now, freshUntil: now + CATALOG_FRESH_MS, staleUntil: now + CATALOG_STALE_MS };
  catalogStore.set(catalogKey(token, type), record);
  void persistentSet(persistKey(`catalog:${type}`, token), record, PERSIST_CATALOG_TTL_SEC);
}
async function hydrateCatalogFromPersistent(token, type) {
  const local = getCatalogCached(token, type);
  if (local) return local;
  const record = await persistentGet(persistKey(`catalog:${type}`, token));
  if (!record?.payload?.metas?.length) return null;
  catalogStore.set(catalogKey(token, type), record);
  return getCatalogCached(token, type);
}

function scheduleRefresh(token, config, reason = "request") {
  const key = `refresh:${token}`;
  if (refreshJobs.has(key)) return refreshJobs.get(key);
  const job = (async () => {
    try {
      await refreshUserStateAndCatalogs(token, config, reason);
    } catch (e) {
      console.warn(`Background refresh failed (${reason}): ${e.message}`);
    } finally {
      refreshJobs.delete(key);
    }
  })();
  refreshJobs.set(key, job);
  return job;
}

async function refreshUserStateAndCatalogs(token, config, reason = "scheduled") {
  const previous = stateStore.get(stateKey(token));
  let library;
  try {
    library = await getLibrary(config.stremioAuthKey, { force: true });
  } catch (e) {
    if (previous?.library) {
      console.warn(`Stremio unavailable; keeping last known library (${reason}): ${e.message}`);
      return false;
    }
    throw e;
  }

  const fp = libraryFingerprint(library);
  const changed = !previous || previous.libraryFingerprint !== fp;
  const state = {
    library,
    libraryFingerprint: fp,
    updatedAt: Date.now(),
    generation: (previous?.generation || 0) + 1
  };
  stateStore.set(stateKey(token), state);
  void persistentSet(persistKey("state", token), { libraryFingerprint: fp, updatedAt: state.updatedAt, generation: state.generation }, PERSIST_STATE_TTL_SEC);

  if (changed || !previous || Date.now() - (previous.rebuiltAt || 0) >= STATE_REFRESH_MS) {
    invalidateTokenResults(token);
    // One heavy recommendation build at a time. This prevents movie and series
    // from competing for the same small Render instance and makes latency more
    // predictable.
    await buildAndStoreCatalog("movie", config, token, library);
    await buildAndStoreCatalog("series", config, token, library);
    const current = stateStore.get(stateKey(token));
    if (current) current.rebuiltAt = Date.now();
  }
  return true;
}

function invalidateTokenResults(token) {
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`result:${token}:`) || key.startsWith(`resultmeta:${token}:`) || key.startsWith(`profile:`)) {
      cache.delete(key);
    }
  }
  // Deliberately keep catalogStore: if the next rebuild fails, Stremio still
  // receives the last known-good catalog instead of an error/empty response.
}

async function buildAndStoreCatalog(type, config, token, library) {
  const lockKey = `build:${token}:${type}`;
  if (typeBuildLocks.has(lockKey)) return typeBuildLocks.get(lockKey);
  const job = (async () => {
    const profile = await buildProfile(config, library, type);
    const fingerprint = profileFingerprint(profile);
    const existing = await hydrateCatalogFromPersistent(token, type);
    // If an identical fresh catalog already exists, do not redo the expensive TMDB/Gemini pipeline.
    if (existing && existing.fingerprint === fingerprint && !existing.stale) return existing.payload;
    const top30 = await buildTop50(type, config, profile);
    if (top30.length < Math.min(MIN_RECOMMENDATIONS_TARGET, config.maxResults)) {
      console.warn(`Only ${top30.length} recommendations produced for ${type}; preserving previous catalog instead of storing a partial catalog.`);
      return existing?.payload || null;
    }
    const payload = serializeAndShuffle(top30, type, config);
    putCatalog(token, type, payload, fingerprint, Boolean(profile.positiveVectors?.length));
    cacheSet(`result:${token}:${type}:${fingerprint}`, top30, CACHE_TTL_MS);
    cacheSet(resultMetaKey(token, type, fingerprint), { geminiUsed: Boolean(profile.positiveVectors?.length) }, CACHE_TTL_MS);
    return payload;
  })();
  typeBuildLocks.set(lockKey, job);
  try { return await job; } finally { typeBuildLocks.delete(lockKey); }
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

async function tmdb(endpoint, params, accessToken) {
  const u = new URL(`https://api.themoviedb.org/3/${endpoint}`);
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
  const hash = crypto.createHash("sha256").update(`${endpoint}?${u.searchParams.toString()}`).digest("hex").slice(0, 40);
  const key = `tmdb:${hash}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const persisted = await persistentGet(persistKey("tmdb", "", hash));
  if (persisted) { cacheSet(key, persisted, endpoint.startsWith("discover/") ? CATALOG_FRESH_MS : TMDB_DETAIL_CACHE_TTL_MS); return persisted; }
  const data = await jsonFetch(u, { headers: { Authorization: `Bearer ${accessToken}` } }, 10000, 3);
  cacheSet(key, data, endpoint.startsWith("discover/") ? CATALOG_FRESH_MS : TMDB_DETAIL_CACHE_TTL_MS);
  void persistentSet(persistKey("tmdb", "", hash), data, PERSIST_TMDB_TTL_SEC);
  return data;
}

function cleanText(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}
const STOP = new Set("the and with from that this into their they them have has for are was were his her its our your about after before through while where when will would there than then film movie series show story life man woman people one two three very just over under between against who what which how also more most some such only other first last new old this that these those".split(" "));
function tokens(s) { return cleanText(s).split(/\s+/).filter(x => x.length >= 4 && !STOP.has(x)); }
function addWeighted(map, key, value) { if (!key) return; map.set(key, (map.get(key) || 0) + value); }

function textOf(d) {
  // The embedding should represent the kind of story the user likes, not
  // accidentally learn actor/country/director identity as a shortcut. Those
  // attributes remain available elsewhere with deliberately tiny weights.
  const genres = (d.genres || []).map(x => x.name).join(" ");
  const keywords = (d.keywords?.keywords || []).map(x => x.name).join(" ");
  const collection = d.belongs_to_collection?.name || "";
  return [d.overview || "", genres, keywords, collection].join(" ");
}

function deepFeatureMap(d) {
  const m = new Map();
  const add = (k,w=1) => addWeighted(m, k, w);
  const genres = (d.genres || []).map(x => cleanText(x.name)).filter(Boolean);
  const keywords = (d.keywords?.keywords || []).map(x => cleanText(x.name)).filter(Boolean);
  for (const g of genres) add(`genre:${g}`, 1.0);
  for (const k of keywords) add(`kw:${k}`, 0.95);
  if (d.belongs_to_collection?.id) add(`collection:${d.belongs_to_collection.id}`, 0.55);
  for (const c of d.production_countries || []) add(`country:${cleanText(c.name)}`, 0.035);
  if (d.original_language) add(`language:${cleanText(d.original_language)}`, 0.025);
  const runtime = Number(d.runtime || d.episode_run_time?.[0] || 0);
  if (runtime) add(`runtime:${Math.round(runtime / 20) * 20}`, 0.04);
  for (const x of (d.credits?.crew || [])) if (x.job === 'Director' || x.job === 'Creator') add(`director:${cleanText(x.name)}`, 0.035);
  for (const x of (d.credits?.cast || []).slice(0,8)) add(`actor:${cleanText(x.name)}`, 0.012);

  const text = cleanText([d.title || d.name || '', d.overview || '', ...keywords].join(' '));
  const toks = tokens(text);
  for (const t of toks) add(`word:${t}`, 0.10);
  for (let i=0;i<toks.length-1;i++) add(`bigram:${toks[i]}_${toks[i+1]}`, 0.055);

  // Generic narrative/theme dimensions. These are not user preferences: they
  // are a vocabulary used to discover latent patterns in the user's feedback.
  const dimensions = {
    exploration: ['explore','exploration','discover','discovery','journey','expedition','unknown','world'],
    survival: ['survival','survive','stranded','escape','wilderness','disaster','apocalypse','post-apocalyptic'],
    mystery: ['mystery','mysterious','investigation','detective','secret','conspiracy','puzzle','enigma'],
    revenge: ['revenge','vengeance','aveng','retaliation'],
    rise: ['rise','ambition','power','king','queen','emperor','empire','reign','ascend'],
    transformation: ['transform','identity','redemption','coming-of-age','awakening','origin'],
    war: ['war','battle','army','soldier','military','invasion','conflict','revolt','rebellion'],
    quest: ['quest','mission','hunt','search','journey','pursuit','objective'],
    investigation: ['investigation','detective','case','crime','murder','police','lawyer','trial'],
    power_struggle: ['power','political','politics','throne','rival','rivalry','succession','regime'],
    worldbuilding: ['world','kingdom','empire','civilization','planet','galaxy','universe','colony','society'],
    psychological: ['psychological','mind','memory','trauma','obsession','paranoia','dream','reality'],
    friendship: ['friendship','friend','companions','brotherhood','family'],
    romance: ['romance','romantic','love','relationship','marriage','couple'],
    humor: ['comedy','comedic','funny','humor','humour','hilarious'],
    dark_tone: ['dark','grim','brutal','violent','bleak','tragic','disturbing'],
    heroic: ['hero','heroic','superhero','superpower','vigilante'],
    science: ['science','scientist','technology','future','space','time travel','artificial intelligence','robot'],
    fantasy: ['magic','fantasy','wizard','dragon','myth','mythology','supernatural'],
    historical: ['historical','history','medieval','ancient','century','kingdom','dynasty'],
    family_friendly: ['family','children','kid','kids','school','teen','teenager']
  };
  for (const [dim, words] of Object.entries(dimensions)) {
    let hits=0;
    for (const w of words) {
      if (text.includes(w)) hits++;
    }
    if (hits) add(`dim:${dim}`, Math.min(1.5, 0.30 + 0.12 * hits));
  }
  return m;
}
function featureMap(d) { return deepFeatureMap(d); }

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

async function geminiEmbeddings(apiKey, texts) {
  if (!geminiAvailable(apiKey) || !texts.length) return null;

  // Serialize Gemini calls so movie/series prewarming cannot hit the same
  // rate-limit bucket simultaneously.
  const run = geminiTail.catch(() => null).then(async () => {
    if (!geminiAvailable(apiKey)) return null;
    try {
      const out = [];
      for (let start = 0; start < texts.length; start += EMBEDDING_BATCH) {
        const chunk = texts.slice(start, start + EMBEDDING_BATCH);
        const body = { requests: chunk.map(text => ({
          model: "models/gemini-embedding-001",
          content: { parts: [{ text: String(text).slice(0, 12000) }] },
          taskType: "SEMANTIC_SIMILARITY"
        })) };
        const data = await jsonFetch(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents",
          { method: "POST", headers: {"content-type":"application/json","x-goog-api-key":apiKey}, body: JSON.stringify(body) },
          30000
        );
        out.push(...(data?.embeddings || []).map(x => x.values || []));
      }
      return out.length === texts.length ? out : null;
    } catch (e) {
      markGeminiFailure(e);
      console.warn(`Gemini unavailable; using local recommender fallback: ${e.message}`);
      return null;
    }
  });
  geminiTail = run.catch(() => null);
  return run;
}

async function cachedEmbeddings(apiKey, texts, namespace) {
  if (!geminiAvailable(apiKey) || !texts.length) return null;
  const result = new Array(texts.length);
  const missing = [], missingIndexes = [];

  // L1 first, then L2. Embeddings are public-derived TMDB text representations,
  // so they can safely be shared across configs and survive Render restarts.
  const persisted = await mapLimit(texts, 20, async (text, i) => {
    const hash = crypto.createHash("sha256").update(`${namespace}:${text}`).digest("hex");
    const local = cacheGet(`embedding:${hash}`);
    if (local) return { i, value: local };
    const remote = await persistentGet(persistKey("embedding", "", hash));
    if (remote) {
      cacheSet(`embedding:${hash}`, remote, EMBEDDING_CACHE_TTL_MS);
      return { i, value: remote };
    }
    return { i, value: null };
  });
  for (const row of persisted) {
    if (row.value) result[row.i] = row.value;
    else { missing.push(texts[row.i]); missingIndexes.push(row.i); }
  }

  if (missing.length) {
    const fresh = await geminiEmbeddings(apiKey, missing);
    if (!fresh) return null;
    const writes = [];
    fresh.forEach((v, j) => {
      const idx = missingIndexes[j];
      result[idx] = v;
      const hash = crypto.createHash("sha256").update(`${namespace}:${missing[j]}`).digest("hex");
      cacheSet(`embedding:${hash}`, v, EMBEDDING_CACHE_TTL_MS);
      writes.push(persistentSet(persistKey("embedding", "", hash), v, PERSIST_TMDB_TTL_SEC));
    });
    await Promise.allSettled(writes);
  }
  return result.every(Boolean) ? result : null;
}
function buildPreferenceModel(positives, negatives) {
  const posDf=new Map(),negDf=new Map(),posIntensity=new Map();
  const posTotal=Math.max(1,positives.length),negTotal=Math.max(1,negatives.length);
  for(const item of positives){const w=item.rating==="heart"?3:1;for(const f of new Set(featureMap(item.details).keys())){posDf.set(f,(posDf.get(f)||0)+1);posIntensity.set(f,(posIntensity.get(f)||0)+w);}}
  for(const item of negatives)for(const f of new Set(featureMap(item.details).keys()))negDf.set(f,(negDf.get(f)||0)+1);
  const weights=new Map(),all=new Set([...posDf.keys(),...negDf.keys()]);
  for(const f of all){const pc=posDf.get(f)||0,nc=negDf.get(f)||0;const p=(pc+.75)/(posTotal+1.5),n=(nc+.75)/(negTotal+1.5);const lift=Math.log(p/n);const support=Math.min(1,Math.log1p(pc)/Math.log1p(7));const intensity=Math.min(1,(posIntensity.get(f)||0)/Math.max(3,posTotal));const credibility=.25+.45*support+.30*intensity;const scale=Math.max(-3,Math.min(3,lift))*credibility;if(Math.abs(scale)>=.045)weights.set(f,scale);}
  const positiveFeatures=[...weights.entries()].filter(([,w])=>w>.08).sort((a,b)=>b[1]-a[1]).slice(0,42).map(([f])=>f);
  const pairPos=new Map(),pairNeg=new Map(),triplePos=new Map(),tripleNeg=new Map();
  const collect=(items,pm,tm)=>{for(const item of items){const fs=new Set(featureMap(item.details).keys());const present=positiveFeatures.filter(f=>fs.has(f)).slice(0,14);for(let i=0;i<present.length;i++)for(let j=i+1;j<present.length;j++){const k=[present[i],present[j]].sort().join('||');pm.set(k,(pm.get(k)||0)+1);for(let z=j+1;z<present.length;z++){const t=[present[i],present[j],present[z]].sort().join('||');tm.set(t,(tm.get(t)||0)+1);}}}};
  collect(positives,pairPos,triplePos);collect(negatives,pairNeg,tripleNeg);
  const pairWeights=new Map(),tripleWeights=new Map();
  for(const [key,c] of pairPos){if(c<2)continue;const n=pairNeg.get(key)||0;const lift=Math.log(((c+.7)/(posTotal+1))/((n+.7)/(negTotal+1)));if(lift>.10)pairWeights.set(key,Math.min(2.4,lift)*Math.min(1,Math.log1p(c)/Math.log1p(6)));}
  for(const [key,c] of triplePos){if(c<2)continue;const n=tripleNeg.get(key)||0;const lift=Math.log(((c+.5)/(posTotal+1))/((n+.5)/(negTotal+1)));if(lift>.18)tripleWeights.set(key,Math.min(3,lift)*Math.min(1,Math.log1p(c)/Math.log1p(5)));}
  return {weights,pairWeights,tripleWeights,positiveCount:positives.length,negativeCount:negatives.length};
}
function preferenceFeatureScore(candidate,model){if(!model?.weights?.size)return 0;const fs=new Set(featureMap(candidate).keys());let signed=0,abs=0;for(const [f,w] of model.weights)if(fs.has(f)){signed+=w;abs+=Math.abs(w);}let pair=0;for(const [key,w] of model.pairWeights||[]){const [a,b]=key.split('||');if(fs.has(a)&&fs.has(b))pair+=w;}let triple=0;for(const [key,w] of model.tripleWeights||[]){const [a,b,c]=key.split('||');if(fs.has(a)&&fs.has(b)&&fs.has(c))triple+=w;}const base=abs?signed/abs:0;return Math.max(-1,Math.min(1,.56*base+.26*Math.tanh(pair)+.18*Math.tanh(triple)));}

function featureSimilarity(candidate, profile) {
  if (!profile) return 0;
  const x=preferenceFeatureScore(candidate, profile);
  return (x+1)/2;
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

function weightedBestSimilarity(candidateVector, positiveVectors, positives, desiredRating) {
  if (!candidateVector || !positiveVectors?.length) return 0;
  const sims = [];
  for (let i = 0; i < Math.min(positiveVectors.length, positives.length); i++) {
    if (desiredRating && positives[i].rating !== desiredRating) continue;
    const s = Math.max(0, cosine(candidateVector, positiveVectors[i]));
    const w = positives[i].rating === "heart" ? 3 : 1;
    sims.push({ s, w });
  }
  if (!sims.length) return 0;
  sims.sort((a,b) => b.s - a.s);
  const top = sims.slice(0, Math.min(8, sims.length));
  let num=0, den=0;
  for (const x of top) { num += x.s * x.w; den += x.w; }
  const consensus = den ? num / den : 0;
  // Prevent one accidental near-match from dominating: a candidate should
  // resemble a small group of positives, not just one title.
  return 0.35 * top[0].s + 0.65 * consensus;
}

function semanticScore(candidateVector, positiveVectors, positives, clusters) {
  if (!candidateVector || !positiveVectors?.length) return 0;
  const heart = weightedBestSimilarity(candidateVector, positiveVectors, positives, "heart");
  const like = weightedBestSimilarity(candidateVector, positiveVectors, positives, "like");
  let cluster = 0;
  if (clusters?.length) {
    const sims = clusters.map(c => Math.max(0, cosine(candidateVector, c.vector)) * (0.7 + 0.3 * c.weight)).sort((a,b)=>b-a);
    const top = sims.slice(0, Math.min(3, sims.length));
    cluster = top.length ? 0.6 * top[0] + 0.4 * (top.reduce((a,b)=>a+b,0) / top.length) : 0;
  }
  // Explicit loves are strongest, likes broaden the profile, and multiple
  // independent taste clusters prevent the model from collapsing into one genre.
  return 0.50 * heart + 0.18 * like + 0.32 * Math.max(0, cluster);
}

function cosineProfileSimilarity(candidateVector, vectors) {
  if (!candidateVector || !vectors?.length) return 0;
  return vectors.reduce((best, v) => Math.max(best, Math.max(0, cosine(candidateVector, v))), 0);
}
function isAnimeSeries(d) {
  if (!d) return false;
  const lang = String(d.original_language || "").toLowerCase();
  const countries = Array.isArray(d.origin_country) ? d.origin_country.map(x => String(x).toUpperCase()) : [];
  const kws = (d.keywords?.keywords || []).map(k => cleanText(k.name));
  return lang === "ja" || countries.includes("JP") || kws.some(k => ["anime", "manga", "japanese animation"].includes(k));
}
function isKidsContent(d) {
  if (!d) return false;
  const genres = new Set((d.genres || []).map(g => cleanText(g.name)));
  const kws = (d.keywords?.keywords || []).map(k => cleanText(k.name));
  const kidsWords = new Set(["kids", "kid", "children", "child", "children's", "preschool", "preschoolers", "toddler", "educational", "nursery", "elementary school", "for children"]);
  const explicitKidsKeyword = kws.some(k => kidsWords.has(k));
  const family = genres.has("family");
  const animation = genres.has("animation");
  return explicitKidsKeyword || (family && animation);
}
function isWesternAnimationSeries(d) {
  if (!d || !(d.genres || []).some(g => cleanText(g.name) === "animation")) return false;
  if (isAnimeSeries(d)) return false;
  const countries = Array.isArray(d.origin_country) ? d.origin_country.map(x => String(x).toUpperCase()) : [];
  const western = new Set(["US", "CA", "GB", "AU", "NZ", "IE", "FR", "DE", "ES", "IT", "BE", "NL"]);
  return countries.length === 0 || countries.some(c => western.has(c));
}
function hardFilter(d, type, config, watched, excludedGenres) {
  const imdb = d.external_ids?.imdb_id || d.imdb_id;
  if (!imdb) return null;
  if (config.useWatchedExclusion && (watched.has(imdb) || watched.has(String(imdb).toLowerCase()))) return null;
  if (config.excludeKids && isKidsContent(d)) return null;
  // Hard safety/taste filter: TMDB include_adult=false is not sufficient for
  // every TV/anime title, so explicitly remove adult/erotic/hentai material.
  const contentText = cleanText([d.title || d.name || "", d.overview || "", ...(d.keywords?.keywords || []).map(k => k.name)].join(" "));
  const adultWords = /\b(hentai|porn|pornographic|sexploitation|adult anime|adult animation|explicit sex|sexual content)\b/i;
  if (d.adult === true || adultWords.test(contentText)) return null;
  if (type === "series" && config.excludeWesternAnimation && isWesternAnimationSeries(d)) return null;
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
  const runtime = type === "movie" ? Number(d.runtime || 0) : 0;
  if (type === "movie" && config.runtimeMinMovie && runtime && runtime < config.runtimeMinMovie) return null;
  return imdb;
}

function chooseDiversePositiveSeeds(positives, count) {
  if (positives.length <= count) return positives;
  const hearts = positives.filter(x => x.rating === "heart");
  const likes = positives.filter(x => x.rating === "like");
  const ordered = [...hearts, ...likes];
  const selected = [];
  const usedGenres = new Set();
  for (const item of ordered) {
    if (selected.length >= count) break;
    const genres = new Set((item.details.genres || []).map(g => g.id));
    const novelty = [...genres].filter(g => !usedGenres.has(g)).length;
    if (selected.length < Math.ceil(count * 0.65) || novelty > 0) {
      selected.push(item);
      for (const g of genres) usedGenres.add(g);
    }
  }
  for (const item of ordered) if (selected.length < count && !selected.includes(item)) selected.push(item);
  return selected;
}

function buildTasteClusters(positiveVectors, positives) {
  if (!positiveVectors?.length) return [];
  // Discover several independent taste poles. A positive can contribute to
  // more than one pole when it sits between them; this avoids forcing a title
  // into one genre-shaped bucket.
  const maxClusters = Math.min(10, Math.max(3, Math.round(Math.sqrt(positiveVectors.length / 4))));
  const orderedIndexes = positives.map((p, i) => ({ i, w: p.rating === "heart" ? 3 : 1 }))
    .sort((a, b) => b.w - a.w);
  const anchors = [];
  for (const { i } of orderedIndexes) {
    if (anchors.length >= maxClusters) break;
    const v = positiveVectors[i];
    if (!v) continue;
    if (anchors.every(a => cosine(v, a.vector) < 0.70)) anchors.push({ vector: v });
  }
  if (!anchors.length) return [];
  const sums = anchors.map(() => ({ v: new Array(positiveVectors[0].length).fill(0), w: 0 }));
  for (let i = 0; i < positiveVectors.length; i++) {
    const v = positiveVectors[i]; if (!v) continue;
    const sims = anchors.map(a => Math.max(0, cosine(v, a.vector)));
    const eligible = sims.map((sim, j) => ({ sim, j })).filter(x => x.sim >= 0.55).sort((a,b) => b.sim - a.sim).slice(0, 3);
    const chosen = eligible.length ? eligible : [{ sim: Math.max(...sims), j: sims.indexOf(Math.max(...sims)) }];
    const baseW = positives[i]?.rating === "heart" ? 3 : 1;
    const norm = chosen.reduce((a, x) => a + Math.max(0.05, x.sim), 0);
    for (const x of chosen) {
      const w = baseW * Math.max(0.05, x.sim) / norm;
      sums[x.j].w += w;
      for (let k = 0; k < v.length; k++) sums[x.j].v[k] += v[k] * w;
    }
  }
  return sums.map(x => {
    const n = Math.sqrt(x.v.reduce((a, b) => a + b * b, 0)) || 1;
    return { vector: x.v.map(v => v / n), weight: Math.min(1, x.w / Math.max(1, positiveVectors.length * 0.22)) };
  }).filter(x => x.vector.length);
}
function watchedNegativeSimilarity(candidateVector, negativeVectors) {
  if (!candidateVector || !negativeVectors?.length) return 0;
  const sims = negativeVectors.map(v => Math.max(0, cosine(candidateVector, v))).sort((a, b) => b - a);
  if (!sims.length) return 0;
  const top = sims.slice(0, Math.min(12, sims.length));
  const avg = top.reduce((a, b) => a + b, 0) / top.length;
  const repetitionConfidence = Math.min(1, Math.log1p(negativeVectors.length) / Math.log1p(30));
  return repetitionConfidence * (0.30 * top[0] + 0.70 * avg);
}
function watchedNegativeFeatureProfile(details) {
  if (!details?.length) return new Map();
  const weights = new Map();
  const df = new Map();
  for (const item of details) {
    for (const f of new Set(featureMap(item.details).keys())) df.set(f, (df.get(f) || 0) + 1);
  }
  let total = 0;
  for (const item of details) {
    for (const [f, v] of featureMap(item.details)) {
      const count = df.get(f) || 1;
      // One forgotten rating should barely matter. Repetition across watched
      // unrated titles makes the negative evidence progressively credible.
      const confidence = Math.min(1, Math.log1p(count) / Math.log1p(15));
      const idf = 1 + Math.log((details.length + 1) / (count + 1));
      const contribution = confidence * Math.min(v, 1) * idf;
      addWeighted(weights, f, contribution);
      total += contribution;
    }
  }
  if (total) for (const [f, v] of weights) weights.set(f, v / total);
  return weights;
}
function chooseDiverseWatchedSeeds(items, count) {
  if (items.length <= count) return items;
  const ordered = items.slice().sort((a, b) => stableSeed(a.id || a.details?.id) - stableSeed(b.id || b.details?.id));
  const selected = [];
  const usedGenres = new Set();
  for (const item of ordered) {
    if (selected.length >= count) break;
    const genres = new Set((item.details?.genres || []).map(g => g.id));
    const novelty = [...genres].filter(g => !usedGenres.has(g)).length;
    if (selected.length < Math.ceil(count * 0.65) || novelty > 0) {
      selected.push(item);
      for (const g of genres) usedGenres.add(g);
    }
  }
  for (const item of ordered) if (selected.length < count && !selected.includes(item)) selected.push(item);
  return selected;
}

async function buildUnifiedProfile(config, libraryItems) {
  const libraryFingerprint = crypto.createHash("sha256").update(libraryItems.map(x => JSON.stringify({ id:x?._id||x?.id, m:x?._mtime, s:x?.state })).sort().join("|")).digest("hex").slice(0, 24);
  const key = `unified-profile:${ALGO_VERSION}:${libraryFingerprint}:${config.useLikes}:${config.useHearts}:${config.geminiApiKey ? crypto.createHash("sha256").update(config.geminiApiKey).digest("hex").slice(0, 8) : "nogemini"}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const relevant = libraryItems.filter(x => itemType(x) === "movie" || itemType(x) === "series");
  const watchedByType = { movie:new Set(), series:new Set() };
  const positives = [], watchedUnrated = [];
  for (const item of relevant) {
    const type = itemType(item), id = extractImdb(item);
    if (!type || !id) continue;
    if (config.useWatchedExclusion && isWatched(item)) {
      watchedByType[type].add(id); watchedByType[type].add(id.toLowerCase());
    }
  }

  // One complete rating scan feeds both movie and series profiles. This removes
  // the duplicate per-item status requests that existed when the two models
  // were built independently.
  const rated = await mapLimit(relevant, 20, async item => {
    const type = itemType(item), id = extractImdb(item); if (!type || !id) return null;
    const rating = await getStremioRating(config.stremioAuthKey, id, type);
    if ((rating === "heart" && config.useHearts) || (rating === "like" && config.useLikes)) return { id, rating, type };
    if (rating === "none" && isWatched(item)) return { id, rating:"watched_unrated", type };
    return null;
  });
  for (const x of rated) {
    if (!x) continue;
    (x.rating === "watched_unrated" ? watchedUnrated : positives).push(x);
  }

  async function enrich(rows) {
    return (await mapLimit(rows, 20, async p => {
      const found = await tmdb(`find/${encodeURIComponent(p.id)}`, { external_source:"imdb_id", language:"en-US" }, config.tmdbAccessToken);
      const d = p.type === "movie" ? found.movie_results?.[0] : found.tv_results?.[0];
      if (!d) return null;
      const full = await tmdb(`${p.type === "series" ? "tv" : "movie"}/${d.id}`, { language:"en-US", append_to_response:"keywords,external_ids,credits" }, config.tmdbAccessToken);
      return { details:full, rating:p.rating, id:p.id, type:p.type };
    })).filter(Boolean);
  }

  const details = await enrich(positives);
  const negativeSeeds = chooseDiverseWatchedSeeds(watchedUnrated, Math.min(WATCHED_NEGATIVE_LIMIT, watchedUnrated.length));
  const negativeDetails = await enrich(negativeSeeds);

  const globalModel = buildPreferenceModel(details, negativeDetails);
  const globalGenreAffinity = buildGenreAffinity(details, negativeDetails);
  let globalVectors = null, negativeVectors = null;
  if (geminiAvailable(config.geminiApiKey) && details.length) globalVectors = await cachedEmbeddings(config.geminiApiKey, details.map(x=>textOf(x.details)), "positive");
  if (geminiAvailable(config.geminiApiKey) && negativeDetails.length) negativeVectors = await cachedEmbeddings(config.geminiApiKey, negativeDetails.map(x=>textOf(x.details)), "negative");
  const globalClusters = buildTasteClusters(globalVectors, details);

  const byType = {};
  for (const type of ["movie","series"]) {
    const pos = details.filter(x=>x.type===type), neg = negativeDetails.filter(x=>x.type===type);
    const posIndexes = details.map((x,i)=>x.type===type?i:-1).filter(i=>i>=0);
    const negIndexes = negativeDetails.map((x,i)=>x.type===type?i:-1).filter(i=>i>=0);
    const pv = globalVectors ? posIndexes.map(i=>globalVectors[i]).filter(Boolean) : null;
    const nv = negativeVectors ? negIndexes.map(i=>negativeVectors[i]).filter(Boolean) : null;
    const localModel = buildPreferenceModel(pos, neg);
    const localGenre = buildGenreAffinity(pos, neg);
    const featureProfile = mergePreferenceModels(globalModel, localModel, 0.62, 0.38);
    const genreAffinity = mergeAffinityMaps(globalGenreAffinity, localGenre, 0.62, 0.38);
    const localClusters = buildTasteClusters(pv, pos);
    const watched = watchedByType[type];
    const profile = {
      watched,
      positives: pos,
      watchedUnrated: neg,
      featureProfile,
      negativeFeatureProfile: buildNegativeFeatureProfile(neg),
      preferenceModel: featureProfile,
      positiveVectors: pv,
      negativeVectors: nv,
      clusters: localClusters,
      seeds: chooseDiversePositiveSeeds(pos, Math.min(40, pos.length)),
      genreAffinity,
      positiveCount: pos.length,
      global: {
        positives: details,
        watchedUnrated: negativeDetails,
        preferenceModel: globalModel,
        featureProfile: globalModel,
        positiveVectors: globalVectors,
        negativeVectors,
        clusters: globalClusters,
        genreAffinity: globalGenreAffinity,
        negativeFeatureProfile: buildNegativeFeatureProfile(negativeDetails),
        positiveCount: details.length
      }
    };
    byType[type] = profile;
  }
  console.log(`Unified profile: library=${relevant.length} positive=${details.length} watchedUnrated=${negativeDetails.length} movie=${byType.movie.positiveCount} series=${byType.series.positiveCount} gemini=${Boolean(globalVectors?.length)}`);
  const out = { libraryFingerprint, byType };
  cacheSet(key, out, PROFILE_CACHE_TTL_MS);
  return out;
}

function buildGenreAffinity(positiveDetails, negativeDetails) {
  const pos = new Map(), neg = new Map();
  for (const x of positiveDetails) for (const g of x.details.genres || []) pos.set(g.id, (pos.get(g.id)||0) + (x.rating === "heart" ? 3 : 1));
  for (const x of negativeDetails) for (const g of x.details.genres || []) neg.set(g.id, (neg.get(g.id)||0) + 1);
  const out = new Map();
  for (const id of new Set([...pos.keys(), ...neg.keys()])) {
    const lift = Math.log(((pos.get(id)||0)+0.7)/(Math.max(1,positiveDetails.length)+1.4) / (((neg.get(id)||0)+0.7)/(Math.max(1,negativeDetails.length)+1.4)));
    out.set(id, Math.max(-1, Math.min(1, lift)));
  }
  return out;
}
function mergeAffinityMaps(a,b,wa,wb) {
  const out=new Map();
  for(const k of new Set([...a.keys(),...b.keys()])) out.set(k,Math.max(-1,Math.min(1,wa*(a.get(k)||0)+wb*(b.get(k)||0))));
  return out;
}
function buildNegativeFeatureProfile(negativeDetails) {
  const out = new Map();
  if (!negativeDetails?.length) return out;
  const df = new Map();
  for (const item of negativeDetails) {
    for (const f of new Set(featureMap(item.details).keys())) df.set(f, (df.get(f) || 0) + 1);
  }
  const total = negativeDetails.length;
  for (const item of negativeDetails) {
    for (const [f, v] of featureMap(item.details)) {
      const support = Math.min(1, Math.log1p(df.get(f) || 0) / Math.log1p(10));
      const idf = 1 + Math.log((total + 1) / ((df.get(f) || 0) + 1));
      out.set(f, (out.get(f) || 0) + Math.min(1, v) * support * idf);
    }
  }
  const sum = [...out.values()].reduce((a,b)=>a+b,0) || 1;
  for (const [f,v] of out) out.set(f, v / sum);
  return out;
}
function mergePreferenceModels(globalModel, localModel, wg, wl) {
  const weights=new Map(), pairWeights=new Map(), tripleWeights=new Map();
  for(const f of new Set([...globalModel.weights.keys(),...localModel.weights.keys()])) {
    const v=wg*(globalModel.weights.get(f)||0)+wl*(localModel.weights.get(f)||0); if(Math.abs(v)>=.035) weights.set(f,v);
  }
  for(const f of new Set([...globalModel.pairWeights.keys(),...localModel.pairWeights.keys()])) {
    const v=wg*(globalModel.pairWeights.get(f)||0)+wl*(localModel.pairWeights.get(f)||0); if(Math.abs(v)>=.03) pairWeights.set(f,v);
  }
  for(const f of new Set([...globalModel.tripleWeights.keys(),...localModel.tripleWeights.keys()])) {
    const v=wg*(globalModel.tripleWeights.get(f)||0)+wl*(localModel.tripleWeights.get(f)||0); if(Math.abs(v)>=.03) tripleWeights.set(f,v);
  }
  return {weights,pairWeights,tripleWeights,positiveCount:localModel.positiveCount,negativeCount:localModel.negativeCount};
}

async function buildProfile(config, libraryItems, type) {
  const unified = await buildUnifiedProfile(config, libraryItems);
  return unified.byType[type];
}

function stableSeed(text) {
  return parseInt(crypto.createHash("sha256").update(String(text)).digest("hex").slice(0, 8), 16) >>> 0;
}
function samplePages(seedText, count = CANDIDATE_PAGES_PER_STRATEGY) {
  const pages = new Set();
  let x = stableSeed(seedText) || 1;
  while (pages.size < count) {
    x = (1664525 * x + 1013904223) >>> 0;
    pages.add(1 + (x % 500));
  }
  return [...pages];
}

async function discoverCandidates(type,config,profile){
  const excludedGenres=new Set((config.excludeGenres||[]).map(cleanText));const candidates=new Map();const addResults=arr=>{for(const x of arr||[])if(x?.id)candidates.set(`${type}:${x.id}`,x);};const media=type==='movie'?'movie':'tv';
  const seeds=chooseDiversePositiveSeeds(profile.positives,Math.min(POSITIVE_SEED_LIMIT,profile.positives.length));
  const seedJobs=seeds.flatMap(seed=>{const id=seed.details?.id;if(!id)return[];const base=`${media}/${id}`,jobs=[];for(let page=1;page<=SEED_NEIGHBOR_PAGES;page++){jobs.push({endpoint:`${base}/recommendations`,params:{language:'en-US',page}},{endpoint:`${base}/similar`,params:{language:'en-US',page}});}return jobs;});
  const seedResults=await mapLimit(seedJobs,10,async q=>tmdb(q.endpoint,q.params,config.tmdbAccessToken).catch(()=>null));for(const data of seedResults)addResults(data?.results);
  const genreScore=new Map(),keywordScore=new Map(),negGenre=new Map(),negKeyword=new Map();
  const addDiscovery=(items,mG,mK,scale=1)=>{for(const x of items||[]){const w=(x.rating==='heart'?3:1)*scale;for(const g of x.details.genres||[])mG.set(g.id,(mG.get(g.id)||0)+w);for(const k of x.details.keywords?.keywords||[])mK.set(k.id,(mK.get(k.id)||0)+w);}};
  addDiscovery(profile.global?.positives,genreScore,keywordScore,0.62);
  addDiscovery(profile.positives,genreScore,keywordScore,0.38);
  for(const x of profile.global?.watchedUnrated||[]){for(const g of x.details.genres||[])negGenre.set(g.id,(negGenre.get(g.id)||0)+1);for(const k of x.details.keywords?.keywords||[])negKeyword.set(k.id,(negKeyword.get(k.id)||0)+1);}
  const rank=(pos,neg,tp,tn)=>[...pos.entries()].map(([id,v])=>({id,score:Math.log(((v+.6)/(tp+1.2))/(((neg.get(id)||0)+.6)/(tn+1.2)))})).sort((a,b)=>b.score-a.score);
  const discoveryPositiveCount=Math.max(1,profile.global?.positiveCount||profile.positiveCount||0);
  const discoveryNegativeCount=Math.max(1,profile.global?.watchedUnrated?.length||profile.watchedUnrated?.length||0);
  const genres=rank(genreScore,negGenre,discoveryPositiveCount,discoveryNegativeCount).filter(x=>x.score>0).slice(0,14).map(x=>x.id);
  const keywords=rank(keywordScore,negKeyword,discoveryPositiveCount,discoveryNegativeCount).filter(x=>x.score>0).slice(0,32).map(x=>x.id);
  const strategies=[];for(const g of genres)strategies.push({with_genres:String(g),label:`g:${g}`});for(const k of keywords)strategies.push({with_keywords:String(k),label:`k:${k}`});
  for(let i=0;i<genres.length;i++)for(let j=i+1;j<genres.length&&j<i+4;j++)strategies.push({with_genres:`${genres[i]},${genres[j]}`,label:`gg:${genres[i]}:${genres[j]}`});
  for(let i=0;i<keywords.length;i++)for(let j=i+1;j<keywords.length&&j<i+5;j++)strategies.push({with_keywords:`${keywords[i]},${keywords[j]}`,label:`kk:${keywords[i]}:${keywords[j]}`});
  for(const g of genres.slice(0,10))for(const k of keywords.slice(0,12))strategies.push({with_genres:String(g),with_keywords:String(k),label:`gk:${g}:${k}`});
  for(const item of seeds.slice(0,24)){const gs=(item.details.genres||[]).map(x=>x.id).slice(0,2),ks=(item.details.keywords?.keywords||[]).map(x=>x.id).slice(0,3);for(const g of gs)for(const k of ks)strategies.push({with_genres:String(g),with_keywords:String(k),label:`seedgk:${g}:${k}`});}
  const dedup=new Map();for(const x of strategies)dedup.set(x.label,x);const strategyList=[...dedup.values()].slice(0,CANDIDATE_DISCOVERY_STRATEGIES);
  const sortModes=['vote_average.desc','vote_count.desc'];
  const pageJobs=[];
  for(const strategy of strategyList) for(const sort_by of sortModes) for(const page of [1,2]) {
    const params={language:'en-US',include_adult:false,page,sort_by,...strategy}; delete params.label;
    params.vote_count_gte=config.tmdbMinVotes; params.vote_average_gte=config.tmdbMinRating; params.vote_average_lte=config.tmdbMaxRating;
    if(type==='movie'){params.primary_release_date_gte=`${config.yearMin}-01-01`;params.primary_release_date_lte=`${Math.min(config.yearMax,new Date().getFullYear())}-12-31`;}
    else {params.first_air_date_gte=`${config.yearMin}-01-01`;params.first_air_date_lte=`${Math.min(config.yearMax,new Date().getFullYear())}-12-31`;}
    pageJobs.push({endpoint:type==='movie'?'discover/movie':'discover/tv',params});
  }
  const discovered=await mapLimit(pageJobs,8,async q=>tmdb(q.endpoint,q.params,config.tmdbAccessToken).catch(()=>null));
  for(const data of discovered)addResults(data?.results);

  // A broad fallback is intentional: the personalized model decides what is
  // good later. This prevents a narrow TMDB strategy from starving the movie
  // pool and producing only a couple of usable titles.
  const fallbackJobs=[1,2,3].flatMap(page=>sortModes.map(sort_by=>{
    const params={language:'en-US',include_adult:false,page,sort_by,vote_count_gte:config.tmdbMinVotes,vote_average_gte:config.tmdbMinRating,vote_average_lte:config.tmdbMaxRating};
    if(type==='movie'){params.primary_release_date_gte=`${config.yearMin}-01-01`;params.primary_release_date_lte=`${Math.min(config.yearMax,new Date().getFullYear())}-12-31`;}
    else {params.first_air_date_gte=`${config.yearMin}-01-01`;params.first_air_date_lte=`${Math.min(config.yearMax,new Date().getFullYear())}-12-31`;}
    return {endpoint:type==='movie'?'discover/movie':'discover/tv',params};
  }));
  const fallback=await mapLimit(fallbackJobs,4,async q=>tmdb(q.endpoint,q.params,config.tmdbAccessToken).catch(()=>null));
  for(const data of fallback)addResults(data?.results);

  const cheap=[...candidates.values()].filter(d=>{
    const rating=Number(d.vote_average),votes=Number(d.vote_count);
    if(!Number.isFinite(rating)||rating<config.tmdbMinRating||rating>config.tmdbMaxRating)return false;
    if(!Number.isFinite(votes)||votes<config.tmdbMinVotes)return false;
    const date=d.release_date||d.first_air_date||'',year=Number(String(date).slice(0,4));
    return year&&year>=config.yearMin&&year<=config.yearMax;
  });

  const rankedCheap = cheap.map(d => {
    const gs = new Set((d.genre_ids || []).map(Number));
    let affinity = 0;
    for (const [gid, w] of profile.genreAffinity || []) if (gs.has(Number(gid))) affinity += w;
    const lexical = lexicalSimilarity(d, profile.positives);
    const exploration = stableSeed(`${ALGO_VERSION}:${type}:${d.id}:${profile.positiveCount}`) / 0xffffffff;
    return { d, cheapScore: 0.62 * affinity + 0.20 * lexical + 0.18 * exploration, exploration };
  }).sort((a,b)=>b.cheapScore-a.cheapScore);

  // Candidate discovery must not collapse onto the easiest genre signal.
  // Reserve an explicit exploration tranche in addition to the learned-affinity
  // tranche. The final ranking still decides the actual Top 30.
  const primaryCount = Math.min(Math.floor(CANDIDATE_DETAILS_LIMIT * 0.70), rankedCheap.length);
  const explorationPool = rankedCheap.slice(primaryCount).sort((a,b)=>b.exploration-a.exploration);
  const explorationCount = Math.min(CANDIDATE_DETAILS_LIMIT - primaryCount, explorationPool.length);
  const limitedRows = rankedCheap.slice(0, primaryCount).concat(explorationPool.slice(0, explorationCount));
  const limited=limitedRows.map(x=>x.d);
  const detailed=[];
  const eligible=[];
  for(let start=0; start<limited.length && start< CANDIDATE_DETAILS_LIMIT; start+=CANDIDATE_DETAIL_BATCH){
    const batch=limited.slice(start,start+CANDIDATE_DETAIL_BATCH);
    const rows=await mapLimit(batch,CANDIDATE_DETAIL_CONCURRENCY,async c=>tmdb(`${media}/${c.id}`,{language:'en-US',append_to_response:'keywords,external_ids,credits'},config.tmdbAccessToken).catch(()=>null));
    for(const d of rows){
      if(!d) continue;
      detailed.push(d);
      if(hardFilter(d,type,config,profile.watched,excludedGenres)) eligible.push(d);
    }
    // Once we have a healthy pool, stop making expensive detail requests.
    if(eligible.length>=Math.max(MIN_RECOMMENDATIONS_TARGET*6,180)) break;
  }
  console.log(`Candidate pipeline ${type}: seeds=${seeds.length} seedRequests=${seedJobs.length} discoveryRequests=${pageJobs.length+fallbackJobs.length} raw=${candidates.size} cheap=${cheap.length} detailed=${detailed.length} eligible=${eligible.length}`);
  return eligible;
}

async function buildTop50(type,config,profile){
  if(!profile.positiveCount && !profile.global?.positiveCount)return[];
  const filtered=await discoverCandidates(type,config,profile);
  if(!filtered.length)return[];
  const global=profile.global || profile;
  let candidateVectors=null;
  if(geminiAvailable(config.geminiApiKey) && global.positiveVectors?.length)
    candidateVectors=await cachedEmbeddings(config.geminiApiKey,filtered.map(textOf),`candidate:${ALGO_VERSION}`).catch(()=>null);

  const scored=filtered.map((d,i)=>{
    const vec=candidateVectors?.[i]||null;
    const localSem=vec&&profile.positiveVectors?.length?semanticScore(vec,profile.positiveVectors,profile.positives,profile.clusters):0;
    const globalSem=vec&&global.positiveVectors?.length?semanticScore(vec,global.positiveVectors,global.positives,global.clusters):0;
    const sem=0.38*globalSem+0.62*localSem;
    const localDisc=preferenceFeatureScore(d,profile.preferenceModel);
    const globalDisc=preferenceFeatureScore(d,global.preferenceModel);
    const discriminative=Math.max(-1,Math.min(1,0.42*globalDisc+0.58*localDisc));
    const feat=(discriminative+1)/2;
    const lex=lexicalSimilarity(d,profile.positives);
    const globalLex=lexicalSimilarity(d,global.positives);
    const lexical=0.45*globalLex+0.55*lex;
    const clusterFit=vec&&global.clusters?.length?Math.max(...global.clusters.map(c=>Math.max(0,cosine(vec,c.vector))*c.weight)):0;
    const negativeLocal=vec&&profile.negativeVectors?.length?watchedNegativeSimilarity(vec,profile.negativeVectors):0;
    const negativeGlobal=vec&&global.negativeVectors?.length?watchedNegativeSimilarity(vec,global.negativeVectors):0;
    const negativeSemantic=0.40*negativeGlobal+0.60*negativeLocal;
    const candidateFeatures = new Set(featureMap(d).keys());
    let explicitNegativeFeature = 0;
    let negativeFeatureMass = 0;
    for (const [f,w] of profile.negativeFeatureProfile || []) {
      negativeFeatureMass += w;
      if (candidateFeatures.has(f)) explicitNegativeFeature += w;
    }
    const globalNegativeProfile = global.negativeFeatureProfile || new Map();
    for (const [f,w] of globalNegativeProfile) {
      negativeFeatureMass += 0.62 * w;
      if (candidateFeatures.has(f)) explicitNegativeFeature += 0.62 * w;
    }
    const negativeFeature = negativeFeatureMass ? Math.min(1, explicitNegativeFeature / negativeFeatureMass) : 0;
    const negCount=(profile.watchedUnrated?.length||0)+(global.watchedUnrated?.length||0);
    const negativeStrength=Math.min(1,Math.log1p(negCount)/Math.log1p(36));
    const watchedPenalty=WATCHED_NEGATIVE_MAX_PENALTY*negativeStrength*(0.45*negativeSemantic+0.55*negativeFeature);
    const positiveTaste=0.43*sem+0.23*feat+0.18*Math.max(0,discriminative)+0.10*clusterFit+0.06*lexical;
    const convergence=Math.min(1,[sem,feat,Math.max(0,discriminative),clusterFit,lexical].filter(x=>x>=0.25).length/5);
    const tasteScore=Math.max(0,Math.min(1,positiveTaste+0.08*convergence-watchedPenalty));
    const rating=Math.max(0,Math.min(10,Number(d.vote_average)||0))/10;
    const votes=Math.max(0,Number(d.vote_count)||0);
    const voteReliability=Math.min(1,Math.log10(1+votes)/5);
    const personalScore=0.92*tasteScore+0.05*rating+0.03*voteReliability;
    return{details:d,imdbId:d.external_ids?.imdb_id||d.imdb_id,personalScore,tasteScore,semantic:vec};
  }).filter(x=>x.imdbId);
  scored.sort((a,b)=>b.personalScore-a.personalScore);
  const top=scored.slice(0,Math.min(30,config.maxResults));
  console.log(`Ranking ${type}: scored=${scored.length} selected=${top.length} globalTaste=true`);
  return top;
}

function serializeAndShuffle(top50, type, config = DEFAULTS) {
  const ordered = top50.slice();
  if (config.displayOrder === "random") {
    for (let i = ordered.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
    }
  }
  return { metas: ordered.map(({ details, imdbId }) => ({
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
  const negatives = (profile.watchedUnrated || []).map(x => x.id || x.details?.id || "").sort().join("|");
  return crypto.createHash("sha256").update(`${positives}##${watched}##${negatives}##${ALGO_VERSION}`).digest("hex").slice(0, 20);
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

function resultMetaKey(token,type,fingerprint){return `resultmeta:${token}:${type}:${fingerprint}`;}
function scheduleGeminiUpgrade(type,config,token,library,fingerprint){
  if(!config.geminiApiKey || !geminiAvailable(config.geminiApiKey)) return;
  const k=`gemini-upgrade:${token}:${type}:${fingerprint}`;
  if(cacheGet(k)) return;
  cacheSet(k,true,10*60*1000);
  setImmediate(async()=>{
    try{
      const profile=await buildProfile(config,library,type);
      if(profileFingerprint(profile)!==fingerprint || !profile.positiveVectors?.length) return;
      const rk=`result:${token}:${type}:${fingerprint}`, meta=cacheGet(resultMetaKey(token,type,fingerprint));
      if(!cacheGet(rk) || meta?.geminiUsed) return;
      const top30=await buildTop50(type,config,profile);
      cacheSet(rk,top30,CACHE_TTL_MS);
      cacheSet(resultMetaKey(token,type,fingerprint),{geminiUsed:true},CACHE_TTL_MS);
      console.log(`Gemini upgrade completed for ${type}`);
    }catch(e){console.warn(`Gemini upgrade failed for ${type}: ${e.message}`);}
  });
}
async function buildBootstrapCatalog(type, config, token) {
  const media = type === "movie" ? "movie" : "tv";
  const endpoint = type === "movie" ? "discover/movie" : "discover/tv";
  const pages=[1,2,3];
  const raw=[];
  for(const page of pages){
    const params={language:"en-US",include_adult:false,page,sort_by:"vote_count.desc",vote_count_gte:config.tmdbMinVotes,vote_average_gte:config.tmdbMinRating,vote_average_lte:config.tmdbMaxRating};
    if(type==="movie"){params.primary_release_date_gte=`${config.yearMin}-01-01`;params.primary_release_date_lte=`${Math.min(config.yearMax,new Date().getFullYear())}-12-31`;}
    else {params.first_air_date_gte=`${config.yearMin}-01-01`;params.first_air_date_lte=`${Math.min(config.yearMax,new Date().getFullYear())}-12-31`;}
    const data=await tmdb(endpoint,params,config.tmdbAccessToken).catch(()=>null);
    raw.push(...(data?.results||[]));
  }
  const state=stateStore.get(stateKey(token));
  const watched=state?.library?watchedSetFromLibrary(state.library):new Set();
  const excludedGenres=new Set((config.excludeGenres||[]).map(cleanText));
  const details=await mapLimit([...new Map(raw.map(x=>[x.id,x])).values()].slice(0,90),6,async c=>tmdb(`${media}/${c.id}`,{language:"en-US",append_to_response:"keywords,external_ids,credits"},config.tmdbAccessToken).catch(()=>null));
  const eligible=details.filter(Boolean).filter(d=>hardFilter(d,type,config,watched,excludedGenres));
  const usable=eligible.filter(d=>d.external_ids?.imdb_id||d.imdb_id).slice(0,Math.min(30,config.maxResults));
  return serializeAndShuffle(usable.map(d=>({details:d,imdbId:d.external_ids?.imdb_id||d.imdb_id,personalScore:0,semantic:null})),type,{...config,displayOrder:"score"});
}

async function discover(type, config, token) {
  ACTIVE_CONFIGS.set(token, config);
  const cached = await hydrateCatalogFromPersistent(token, type);
  if (cached) {
    if (cached.stale) scheduleRefresh(token, config, "stale-catalog");
    else {
      const state = stateStore.get(stateKey(token));
      if (!state || Date.now() - state.updatedAt > STATE_REFRESH_MS) scheduleRefresh(token, config, "state-refresh");
    }
    return cached.payload;
  }

  let state = stateStore.get(stateKey(token));
  if (!state || !state.library) {
    try {
      const library = await getLibrary(config.stremioAuthKey, { force: true });
      state = { library, libraryFingerprint: libraryFingerprint(library), updatedAt: Date.now(), generation: 1 };
      stateStore.set(stateKey(token), state);
    } catch (e) {
      console.warn(`Cold-start Stremio sync failed for ${type}: ${e.message}`);
      // No personalized state yet: return a small valid TMDB bootstrap instead
      // of ever returning { metas: [] }. The full personalized build continues
      // only when the account state becomes available.
      try { return await buildBootstrapCatalog(type, config, token); }
      catch (bootError) {
        console.warn(`Bootstrap catalog failed for ${type}: ${bootError.message}`);
        return { metas: [] };
      }
    }
  }

  const lockKey = `cold:${token}:${type}`;
  if (!REFRESH_LOCK.has(lockKey)) {
    const job = buildAndStoreCatalog(type, config, token, state.library).catch(e => {
      console.warn(`Cold-start catalog build failed for ${type}: ${e.message}`);
      return null;
    });
    REFRESH_LOCK.set(lockKey, job);
    job.finally(() => REFRESH_LOCK.delete(lockKey));
  }
  const job = REFRESH_LOCK.get(lockKey);
  if (job) await Promise.race([job.catch(() => null), new Promise(r => setTimeout(r, COLD_START_WAIT_MS))]);

  const ready = getCatalogCached(token, type);
  if (ready?.payload?.metas?.length) {
    const other = type === "movie" ? "series" : "movie";
    if (!getCatalogCached(token, other)) {
      setImmediate(() => buildAndStoreCatalog(other, config, token, state.library).catch(e => console.warn(`Background ${other} build failed: ${e.message}`)));
    }
    return ready.payload;
  }

  // The personalized build may legitimately still be running. Give Stremio a
  // valid temporary catalog rather than an empty response; it is never cached
  // by HTTP and therefore cannot poison the client for five minutes.
  try {
    const bootstrap = await buildBootstrapCatalog(type, config, token);
    console.warn(`Catalog ${type} still warming; serving temporary bootstrap (${bootstrap.metas?.length || 0} items).`);
    return bootstrap;
  } catch (e) {
    console.warn(`Temporary bootstrap failed for ${type}: ${e.message}`);
    return { metas: [] };
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
    cacheSet(resultMetaKey(token,other,fingerprint), {geminiUsed:Boolean(profile.positiveVectors?.length)}, CACHE_TTL_MS);
  })();
  REFRESH_LOCK.set(lockKey, job);
  try { await job; } finally { REFRESH_LOCK.delete(lockKey); }
}


async function prewarmBoth(token, config) {
  ACTIVE_CONFIGS.set(token, config);
  scheduleRefresh(token, config, "configuration");
}

function configFromForm(p, base = DEFAULTS) {
  const genres = (p.get("excludeGenres") || "").split(",").map(x => x.trim()).filter(Boolean);
  const keep = (name, fallback) => {
    const v = p.get(name);
    return v === null || v === "" ? fallback : v;
  };
  return {
    ...DEFAULTS,
    ...base,
    tmdbAccessToken: keep("tmdbAccessToken", base.tmdbAccessToken || ""),
    stremioAuthKey: keep("stremioAuthKey", base.stremioAuthKey || ""),
    geminiApiKey: keep("geminiApiKey", base.geminiApiKey || ""),
    tmdbMinRating: Math.max(0, Math.min(10, Number(keep("tmdbMinRating", base.tmdbMinRating)) || 7)),
    tmdbMaxRating: Math.max(0, Math.min(10, Number(keep("tmdbMaxRating", base.tmdbMaxRating)) || 10)),
    tmdbMinVotes: Math.max(0, Number(keep("tmdbMinVotes", base.tmdbMinVotes)) || 1000),
    yearMin: Math.max(1900, Number(keep("yearMin", base.yearMin)) || 1900),
    yearMax: Math.min(2100, Number(keep("yearMax", base.yearMax)) || new Date().getFullYear()),
    runtimeMinMovie: Math.max(0, Number(keep("runtimeMinMovie", base.runtimeMinMovie)) || 0),
    excludeGenres: p.has("excludeGenres") ? genres : (base.excludeGenres || []),
    useWatchedExclusion: p.has("useWatchedExclusion"),
    useLikes: p.has("useLikes"),
    useHearts: p.has("useHearts"),
    excludeCancelledSeries: p.has("excludeCancelledSeries"),
    allowOngoingSeries: p.has("allowOngoingSeries"),
    displayOrder: p.get("displayOrder") === "score" ? "score" : (p.get("displayOrder") === "random" ? "random" : (base.displayOrder || DEFAULTS.displayOrder)),
    excludeKids: p.has("excludeKids"),
    excludeWesternAnimation: p.has("excludeWesternAnimation"),
    movieCatalogEnabled: p.has("movieCatalogEnabled"),
    seriesCatalogEnabled: p.has("seriesCatalogEnabled")
  };
}

function masked(v) {
  if (!v) return "";
  const s = String(v);
  return s.length <= 8 ? "••••••••" : `${"•".repeat(Math.min(12, s.length - 4))}${s.slice(-4)}`;
}
function configurePage(config = DEFAULTS, action = "/config/save") {
  const y = new Date().getFullYear();
  const escAttr = v => esc(v).replace(/`/g, "&#96;");
  const checked = k => config[k] ? "checked" : "";
  const selected = k => config.displayOrder === k ? "selected" : "";
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>🎯 Antony</title><style>body{font-family:system-ui;background:#111;color:#eee;max-width:760px;margin:24px auto;padding:0 18px;line-height:1.45}section{background:#1b1b1b;padding:18px;border-radius:14px;margin:14px 0}label{display:block;margin:12px 0 5px}input,select{width:100%;box-sizing:border-box;padding:11px;border-radius:8px;border:1px solid #444;background:#242424;color:#fff}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.check{display:flex;align-items:center;gap:9px}.check input{width:auto}.btn{display:block;width:100%;padding:14px;border:0;border-radius:9px;font-weight:700;background:#fff;color:#111}.muted{opacity:.72;font-size:.9em}.ok{background:#172b1d;padding:12px;border-radius:10px}</style></head><body><h1>🎯 Antony — Personal Recommendations</h1><p>30 films + 30 séries, appris uniquement de tes 👍 et ❤️.</p><form method="post" action="${action}"><section><h2>Connexions</h2><label>TMDB API Read Access Token *</label><input name="tmdbAccessToken" type="password" required autocomplete="off" value="${escAttr(config.tmdbAccessToken || "")}" placeholder="${escAttr(masked(config.tmdbAccessToken))}"><label>Stremio AuthKey *</label><input name="stremioAuthKey" type="password" required autocomplete="off" value="${escAttr(config.stremioAuthKey || "")}" placeholder="${escAttr(masked(config.stremioAuthKey))}"><label>Gemini API key (recommandée)</label><input name="geminiApiKey" type="password" autocomplete="off" value="${escAttr(config.geminiApiKey || "")}" placeholder="${escAttr(masked(config.geminiApiKey))}"><p class="muted">Les clés déjà enregistrées sont conservées. Tu peux les laisser telles quelles et modifier seulement les autres paramètres.</p></section><section><h2>Affichage</h2><label>Ordre des résultats</label><select name="displayOrder"><option value="score" ${selected("score")}>Meilleur score en premier</option><option value="random" ${selected("random")}>Aléatoire</option></select><p class="muted">Dans les deux cas, ce sont les 30 meilleurs candidats qui sont sélectionnés. « Aléatoire » ne fait que mélanger leur ordre.</p></section><section><h2>Filtres TMDB</h2><div class="grid"><div><label>Note minimale</label><input name="tmdbMinRating" type="number" min="0" max="10" step="0.1" value="${config.tmdbMinRating}"></div><div><label>Note maximale</label><input name="tmdbMaxRating" type="number" min="0" max="10" step="0.1" value="${config.tmdbMaxRating}"></div><div><label>Votes minimum</label><input name="tmdbMinVotes" type="number" min="0" step="100" value="${config.tmdbMinVotes}"></div><div><label>Année min.</label><input name="yearMin" type="number" value="${config.yearMin}"></div><div><label>Année max.</label><input name="yearMax" type="number" value="${config.yearMax || y}"></div><div><label>Films : durée minimale (minutes)</label><input name="runtimeMinMovie" type="number" min="0" value="${config.runtimeMinMovie}"></div></div><label>Genres à exclure</label><input name="excludeGenres" value="${escAttr((config.excludeGenres || []).join(", "))}"><p class="muted">La note et les votes restent des filtres, puis ont seulement un faible poids dans le classement. La durée minimale ci-dessus concerne uniquement les films.</p></section><section><h2>Affichage des catalogues</h2><p class="muted">Stremio ne permet pas à un addon de séparer indépendamment Board (catalogue) et Discover (découverte) pour un même catalogue : un catalogue standard apparaît dans les deux. Ces cases activent ou désactivent donc chaque catalogue.</p><label class="check"><input name="movieCatalogEnabled" type="checkbox" ${checked("movieCatalogEnabled")}> Films — afficher le catalogue</label><label class="check"><input name="seriesCatalogEnabled" type="checkbox" ${checked("seriesCatalogEnabled")}> Séries — afficher le catalogue</label></section><section><h2>Exclusions</h2><label class="check"><input name="excludeKids" type="checkbox" ${checked("excludeKids")}> Exclure le contenu clairement destiné aux enfants</label><label class="check"><input name="excludeWesternAnimation" type="checkbox" ${checked("excludeWesternAnimation")}> Séries : exclure l'animation occidentale</label><p class="muted">Les anime restent autorisés : l'animation japonaise est conservée.</p></section><section><h2>Apprentissage</h2><label class="check"><input name="useWatchedExclusion" type="checkbox" ${checked("useWatchedExclusion")}> Exclure ce que j'ai déjà vu</label><label class="check"><input name="useLikes" type="checkbox" ${checked("useLikes")}> Utiliser les 👍</label><label class="check"><input name="useHearts" type="checkbox" ${checked("useHearts")}> Utiliser les ❤️</label><label class="check"><input name="excludeCancelledSeries" type="checkbox" ${checked("excludeCancelledSeries")}> Exclure les séries annulées</label><label class="check"><input name="allowOngoingSeries" type="checkbox" ${checked("allowOngoingSeries")}> Autoriser les séries en cours</label></section><div class="ok">❤️ pèse 3× 👍. Un contenu vu sans 👍/❤️ produit un signal négatif prudent : un seul oubli pèse presque rien, mais un motif répété sur plusieurs contenus similaires pèse davantage. Cela ne devient jamais une exclusion.</div><br><button class="btn">Enregistrer</button></form></body></html>`;
}

async function saveConfig(req, res, previousToken = "") {
  try {
    const previous = previousToken ? unpackConfig(previousToken) : null;
    const config = configFromForm(new URLSearchParams(await readBody(req)), previous || DEFAULTS);
    if (!config.tmdbAccessToken) throw new Error("TMDB Read Access Token manquant");
    if (!config.stremioAuthKey) throw new Error("Stremio AuthKey manquante");
    if (config.tmdbMaxRating < config.tmdbMinRating) throw new Error("La note maximale doit être ≥ à la note minimale");
    const token = packConfig(config);
    if (previousToken && previousToken !== token) CONFIG_ALIASES.set(previousToken, token);
    LAST_CONFIG_TOKEN = token;
    const origin = `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host}`;
    const manifestUrl = `${origin}/u/${token}/manifest.json`;
    ACTIVE_CONFIGS.set(token, config);
    res.writeHead(200, { "content-type":"text/html; charset=utf-8", "cache-control":"no-store" });
    res.end(`<!doctype html><meta name="viewport" content="width=device-width"><style>body{font-family:system-ui;background:#111;color:#eee;max-width:650px;margin:40px auto;padding:20px}a{display:block;background:#fff;color:#111;text-align:center;padding:16px;border-radius:10px;font-weight:700;text-decoration:none;margin:20px 0}.small{word-break:break-all;opacity:.7}</style><h1>Configuration enregistrée</h1><p>Le moteur prépare tes deux catalogues en arrière-plan.</p><a href="stremio://${manifestUrl.replace(/^https?:\/\//, "")}">Mettre à jour dans Stremio</a><p class="small">URL du manifeste : ${esc(manifestUrl)}</p>`);
    setImmediate(() => prewarmBoth(token, config).catch(e => console.error("Prewarm failed:", e.message)));
  } catch (e) { res.writeHead(400, { "content-type":"text/plain; charset=utf-8" }); res.end(`Erreur de configuration: ${e.message}`); }
}
function readBody(req) { return new Promise((resolve, reject) => { let data = "", size = 0; req.on("data", c => { size += c.length; if (size > 200000) { reject(new Error("Formulaire trop volumineux")); req.destroy(); } else data += c; }); req.on("end", () => resolve(data)); req.on("error", reject); }); }
function tokenFromPath(pathname) {
  const m = pathname.match(/^\/u\/([^/]+)(?:\/|$)/);
  if (!m) return null;
  const raw = m[1];
  const resolved = CONFIG_ALIASES.get(raw) || raw;
  return unpackConfig(resolved);
}
function resolvedPathToken(pathname) {
  const m = pathname.match(/^\/u\/([^/]+)(?:\/|$)/);
  return m ? (CONFIG_ALIASES.get(m[1]) || m[1]) : "";
}

async function handle(req, res) {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  if (u.pathname === "/health") {
    res.writeHead(200, { "content-type":"application/json", "cache-control":"no-store" });
    return res.end(JSON.stringify({ ok:true, version:ALGO_VERSION, persistentCache:UPSTASH_ENABLED, catalogMemory:catalogStore.size }));
  }
  if (u.pathname === "/configure" && req.method === "GET") {
    if (LAST_CONFIG_TOKEN && unpackConfig(LAST_CONFIG_TOKEN)) { res.writeHead(302, { "location": `/u/${LAST_CONFIG_TOKEN}/configure`, "cache-control":"no-store" }); return res.end(); }
    res.writeHead(200, { "content-type":"text/html; charset=utf-8", "cache-control":"no-store" }); return res.end(configurePage());
  }
  if (u.pathname === "/config/save" && req.method === "POST") return saveConfig(req, res);
  const tokenConfig = tokenFromPath(u.pathname);
  const pathTokenMatch = u.pathname.match(/^\/u\/([^/]+)/);
  const pathToken = pathTokenMatch?.[1] || "";
  const effectiveToken = resolvedPathToken(u.pathname);
  if (tokenConfig && u.pathname.endsWith("/manifest.json")) { LAST_CONFIG_TOKEN = effectiveToken; ACTIVE_CONFIGS.set(effectiveToken, tokenConfig); res.writeHead(200, { "content-type":"application/json", "cache-control":"no-store" }); return res.end(JSON.stringify(buildManifest(tokenConfig))); }
  if (tokenConfig && u.pathname === `/u/${pathToken}/configure` && req.method === "GET") { LAST_CONFIG_TOKEN = effectiveToken; res.writeHead(200, { "content-type":"text/html; charset=utf-8", "cache-control":"no-store" }); return res.end(configurePage(tokenConfig, `/u/${effectiveToken}/config/save`)); }
  if (tokenConfig && u.pathname === `/u/${pathToken}/config/save` && req.method === "POST") {
    const result = await saveConfig(req, res, effectiveToken);
    return result;
  }
  if (tokenConfig) {
    const m = u.pathname.match(/^\/u\/[^/]+\/(catalog|meta)\/(movie|series)\/([^/]+?)(?:\/[^/]+)?(?:\.json)?$/);
    if (m) {
      const [, resource, type, id] = m;
      try {
        if (resource === "catalog") {
          const result = await discover(type, tokenConfig, u.pathname.split("/")[2]);
          res.writeHead(200, { "content-type":"application/json; charset=utf-8", "cache-control":"no-store, no-cache, must-revalidate" });
          return res.end(JSON.stringify(result));
        }
        const find = await tmdb(`find/${encodeURIComponent(id)}`, { external_source:"imdb_id", language:"en-US" }, tokenConfig.tmdbAccessToken);
        const hit = type === "movie" ? find.movie_results?.[0] : find.tv_results?.[0];
        if (!hit) { res.writeHead(404); return res.end(JSON.stringify({ meta:null })); }
        const d = await tmdb(`${type === "series" ? "tv" : "movie"}/${hit.id}`, { language:"en-US" }, tokenConfig.tmdbAccessToken);
        res.writeHead(200, { "content-type":"application/json", "cache-control":"public, max-age=3600" });
        return res.end(JSON.stringify({ meta:{ id, type, name:d.title||d.name, poster:d.poster_path?`https://image.tmdb.org/t/p/w500${d.poster_path}`:undefined, background:d.backdrop_path?`https://image.tmdb.org/t/p/w1280${d.backdrop_path}`:undefined, description:d.overview||"", releaseInfo:String(d.release_date||d.first_air_date||"").slice(0,4), imdbRating:d.vote_average!=null?Number(d.vote_average).toFixed(1):undefined, genres:(d.genres||[]).map(g=>g.name), posterShape:"poster" } }));
      } catch (e) { console.error(e); res.writeHead(502, { "content-type":"application/json" }); return res.end(JSON.stringify({ error:"upstream_error" })); }
    }
  }
  if (u.pathname === "/manifest.json") { res.writeHead(200, { "content-type":"application/json" }); return res.end(JSON.stringify(buildManifest(DEFAULTS))); }
  res.writeHead(200, { "content-type":"text/plain; charset=utf-8" }); res.end("Antony Personal Recommendations — open /configure");
}

setInterval(() => {
  for (const [token, config] of ACTIVE_CONFIGS) scheduleRefresh(token, config, "scheduled");
}, STATE_REFRESH_MS).unref();

http.createServer((req,res) => handle(req,res).catch(e => {
  console.error(e);
  if (!res.headersSent) res.writeHead(500, { "content-type":"application/json" });
  res.end(JSON.stringify({ error:"internal_error" }));
})).listen(PORT, HOST, () => console.log(`Antony addon v${ALGO_VERSION} listening on ${HOST}:${PORT}`));
