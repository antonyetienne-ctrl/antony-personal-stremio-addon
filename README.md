# 🎯 Antony — Personal Stremio Recommendations v6.2.0

Custom Stremio addon producing **30 films + 30 series** from the user's Stremio ❤️/👍 signals and watched-without-rating negative evidence.

## v6.2.0 — daily sync + cumulative candidate pool + low-Upstash architecture

- Unified Films + Séries taste model, with format-specific heads.
- **70% type-specific taste + 30% global Films+Séries taste** for both movie and series ranking.
- ❤️ = loved; 👍 = liked; watched without 👍/❤️ = negative evidence.
- The existing positive/negative learning model is retained; negative families, interactions and semantic negative prototypes remain separate from positive taste.
- **TMDB rating < 5/10 is a hard exclusion. There is no minimum vote-count filter.** Vote count is only a weak confidence/ranking signal.
- Candidate discovery is cumulative: the persistent pool grows across rebuilds and is not capped at a fixed total number of candidates.
- Previously enriched candidate details remain available and are ranked together with newly enriched candidates. Each daily rebuild only limits the number of *new detail API calls* so TMDB work remains bounded; this is not a cap on the cumulative candidate pool.
- Last complete Top 30 Films and Top 30 Séries remain published while a replacement build runs. A partial catalog is never published.
- TMDB display metadata uses **fr-FR** wherever TMDB provides it; French posters and trailers are preferred with neutral/English fallback.

## Synchronisation

- Stremio catalog navigation is read-only and **does not trigger a rebuild**.
- At most **one synchronization per calendar day** (Europe/Zurich) is performed.
- The daily sync refreshes the Stremio library and rating snapshot, then compares the resulting library/feedback fingerprints.
- If nothing changed, **no recommendation rebuild occurs**.
- A single relevant change — one Like, one Love, one newly watched item, etc. — causes a complete Films + Séries rebuild.
- Configuration changes can intentionally trigger a rebuild immediately.
- There is no periodic 15-minute rebuild loop.

## Upstash / Free-tier strategy

Upstash is used only for compact, high-value persistent state. High-volume TMDB/embedding data is not written item-by-item to Upstash.

The architecture specifically reduces commands by:

- keeping build diagnostics and partial checkpoints in RAM only;
- avoiding rebuilds caused by catalog navigation;
- persisting the cumulative candidate pool as one compressed bulk value per type;
- persisting the rating snapshot as one compact value;
- serving existing catalogs directly from RAM or persistent cache;
- using a longer Upstash timeout to avoid unnecessary fallback churn.

The goal is for Upstash command volume to depend mainly on **real synchronisation/build events**, not on the number of candidates considered by the recommender.

## Configuration

Open `/configure` and provide:

1. TMDB API Read Access Token
2. Stremio AuthKey
3. Gemini API key (optional)

Existing keys are preserved when corresponding fields are left unchanged.

Default filters:

- TMDB rating ≥ 5.0
- no minimum TMDB vote count
- Horror / Romance / Music / Comedy excluded
- Kids excluded
- Western animation series excluded; anime remains allowed
- Cancelled series excluded
- Ongoing series allowed
- No maximum movie duration

## Diagnostics

`/u/<TOKEN>/debug/build.json` exposes the latest in-process build status and timings without exposing API keys.

## Render / persistence

Render Free can spin down after inactivity. The addon therefore relies on persistent catalogs, state and candidate pools in Upstash rather than assuming that RAM survives a restart.

Persistent keys are compressed with gzip. The namespace remains versioned under `v6` so older generations are isolated from the current algorithm where appropriate.
