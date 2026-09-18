# 🎯 Antony — Personal Stremio Recommendations v6.1.1

Custom Stremio addon producing **30 films + 30 series** from the user's Stremio ❤️/👍 signals and watched-without-rating negative evidence.

## v6.1.1 — T0 rebuild + precision + French metadata + measured/resumable builds

- Unified Films + Séries taste model, with format-specific heads.
- ❤️ = loved; 👍 = liked; watched without 👍/❤️ = negative evidence.
- Negative families, feature interactions, anti-patterns and semantic negative prototypes are learned separately from positive taste.
- No artificial genre quota and no popularity ranking.
- TMDB rating/vote thresholds remain hard filters; they are not the main ranking signal.
- Final Top 30 is the actual highest personalized score, then optionally shuffled for display.
- Last complete Top 30 Films and Top 30 Séries remain the only published catalogs. A partial/temporary popularity catalog is never published.
- Catalog replacement is atomic at the application level: the previous complete result remains available until a new complete result is ready.
- TMDB display metadata uses **fr-FR** wherever TMDB provides it.
- French posters are preferred via TMDB image language selection, with neutral/English fallback when no French poster exists.
- French YouTube trailer is preferred when TMDB has one; otherwise neutral/English trailer fallback is used.
- TMDB metadata, images and embeddings are cached in Upstash + RAM to reduce repeated API calls.
- Expensive rebuilds are delayed until approximately **5 minutes after the last addon activity** when a valid catalog already exists. Initial configuration with no catalog can build immediately.
- Build timing is recorded phase-by-phase and persisted in Upstash.
- Build checkpoints persist the discovered candidate pool so a Render restart/sleep can resume without repeating the entire discovery stage.
- `/u/<TOKEN>/debug/build.json` exposes the latest build status/timing for the configured addon token; it contains no API keys.
- Gemini remains optional. If Gemini is unavailable or rate-limited, the local recommender continues.

## Build timing / diagnostic

After a real rebuild, open:

`https://YOUR-RENDER-URL/u/YOUR_TOKEN/debug/build.json`

The response contains:

- `status`: running / complete / failed
- `startedAt`, `finishedAt`, `durationMs`
- movie and series durations
- phase durations for profile, ranking and French localization
- reason for the rebuild

The same data is written to the Render logs as `BUILD COMPLETE ...` and persisted in Upstash for later retrieval.

## Render Free limitation

Render Free can spin down after 15 minutes without inbound traffic. The addon therefore persists build checkpoints instead of assuming that a long in-process calculation will survive a sleep/restart.

A server-originated self-ping is **not** used as a keep-alive mechanism.

## Persistent cache

Set:

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

The cache namespace is versioned (`v6.1`) so older v5/v6 catalogs cannot be mistaken for v6.1 results.

## Configuration

Open `/configure` and provide:

1. TMDB API Read Access Token
2. Stremio AuthKey
3. Gemini API key (optional)

Existing keys are preserved when the corresponding configuration field is left unchanged.

## Recommended default filters

- TMDB rating ≥ 7.2
- TMDB votes ≥ 2000
- Horror / Romance / Music / Comedy excluded
- Kids excluded
- Western animation series excluded; anime remains allowed
- Cancelled series excluded
- Ongoing series allowed
- No maximum movie duration

## Cache architecture

```text
Stremio
   ↓
Render Web Service
   ├── L1 RAM
   └── L2 Upstash
       ├── latest complete Top 30 Films
       ├── latest complete Top 30 Series
       ├── TMDB metadata/images/videos
       ├── semantic embeddings
       ├── build timing
       └── build checkpoints
```
