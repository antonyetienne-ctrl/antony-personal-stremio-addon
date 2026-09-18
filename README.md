# 🎯 Antony — Personal Stremio Recommendations v6.1.3

Custom Stremio addon producing **30 films + 30 series** from the user's Stremio ❤️/👍 signals and watched-without-rating negative evidence.

## v6.1.3 — T0 rebuild + persistent feedback cache + low-Upstash architecture

- Unified Films + Séries taste model, with format-specific heads.
- ❤️ = loved; 👍 = liked; watched without 👍/❤️ = negative evidence.
- Negative families, feature interactions, anti-patterns and semantic negative prototypes are learned separately from positive taste.
- No artificial genre quota and no popularity ranking.
- TMDB rating/vote thresholds remain hard filters; they are not the main ranking signal.
- Final Top 30 is the actual highest personalized score, then optionally shuffled for display.
- Last complete Top 30 Films and Top 30 Séries remain published while a new build runs. A partial/temporary popularity catalog is never published.
- TMDB display metadata uses **fr-FR** wherever TMDB provides it.
- French posters are preferred via TMDB image language selection, with neutral/English fallback when no French poster exists.
- French YouTube trailer is preferred when TMDB has one; otherwise neutral/English trailer fallback is used.
- Upstash is deliberately used only for high-value persistent state: last catalogs, encrypted configuration, ratings snapshot, compact profile source, candidate pools, build timing and compact checkpoints. High-volume per-item TMDB/embedding writes are not sent to Upstash.
- Every catalog request starts the rebuild at **T0** for the measurement phase. The last complete Top 30 remains served immediately while the new movie + series build runs in the background.
- Build timing is recorded phase-by-phase and persisted in Upstash.
- Candidate discovery and eligible-detail pools are persisted as compact bulk values with short TTLs, so repeated builds avoid dozens of TMDB Discover calls without generating dozens of Upstash commands.
- The latest encrypted configuration token is persisted separately in Upstash so API keys survive Render restarts/deployments; the configuration form preserves existing keys when fields are left blank.
- Stremio ❤️/👍/neutral status is kept in one compact persistent snapshot. New titles are queried immediately; the full rating sweep is refreshed at most every 2 hours, because Stremio exposes rating status per title rather than as a bulk feed. This is the main speed/precision compromise.
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
       ├── ratings snapshot
       ├── compact profile source
       ├── candidate pools (short TTL)
       ├── build timing / compact checkpoints
       └── encrypted latest configuration
```
