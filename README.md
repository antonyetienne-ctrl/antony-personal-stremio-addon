# 🎯 Antony — Personal Stremio Recommendations v0.9.0

## Objective
A personal Stremio movie/series recommender. It learns only from the user's actual 👍 and ❤️ signals available through the configured Stremio account/library; watched content is used only as an exclusion signal.

## Recommendation engine
- Complete scan of the configured Stremio library: no artificial 100/60-item learning cap.
- ❤️ has 3× the positive weight of 👍.
- Positive items are resolved to full TMDB metadata and, when configured, Gemini embeddings.
- Taste is modeled at several levels: genres, keywords, collections, narrative text, creators/cast, countries/language/runtime, semantic similarity and learned taste clusters.
- Loved and liked items contribute separately; loved items define the strongest semantic center while liked items broaden the profile.
- Candidate generation uses multiple independent sources: TMDB recommendations/similar for diverse positive seeds plus learned genre/keyword discovery. Popularity is not a final ranking signal and release date is neutral.
- Hard filters are applied before ranking: TMDB rating/vote thresholds, year, runtime, excluded genres, cancelled/ongoing series settings and watched IDs.
- Final ranking: 92% personal taste + 5% TMDB rating + 3% vote-count reliability.
- Diversity is applied softly before selection to prevent repeated franchises/near-duplicates from consuming the catalog.
- Exactly the best 50 admissible films and 50 admissible series are selected when the candidate universe contains at least 50; only the final display order is shuffled.

## Performance/resilience
- `/catalog` never waits for the full recommendation build.
- Last-known-good catalogs are served immediately while refreshes happen in the background.
- Complete Stremio library is fetched with one `datastoreGet(all=true)` request first; the older metadata+100-ID batching method is only a compatibility fallback.
- External HTTP has bounded timeouts, retries, exponential backoff and jitter.
- Gemini is optional and never a hard dependency. 429/quota/network failures fall back to the structured local model.
- Expensive TMDB metadata and Gemini embeddings are cached in-process.
- Background jobs are deduplicated.

## Important limitation
Stremio's official Liked and Loved features are exposed as dedicated addons/catalogs. This build uses the authenticated Stremio rating-status endpoint for every item in the complete configured library, so it does not arbitrarily truncate the library at 100 items. The public documentation available for the Liked/Loved addons does not expose a documented bulk private-user API that can be called directly by this addon; therefore the build does not pretend to have a guaranteed bulk Likes endpoint that has not been verified.

## Files
- Dockerfile
- package.json
- README.md
- render.yaml
- server.js
