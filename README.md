# 🎯 Antony — Personal Stremio Recommendations v0.7.1

Personal movie and series catalogs for Stremio.

## Recommendation logic
- ❤️ Loved = 3× 👍 Liked
- Only actual 👍/❤️ feedback teaches taste
- Watched content is exclusion-only
- 92% personal taste, 5% TMDB rating, 3% vote-count reliability
- TMDB rating/vote count, year, runtime and excluded genres remain hard filters
- Exactly the best 50 candidates are selected, then shuffled for display

## v0.7 performance and watch-state fixes
- Long-lived in-memory caches for Stremio library, ratings, TMDB metadata and embeddings
- Background warming of the other catalog after a cached request
- Parallel TMDB discovery pages and detail requests
- Cheap TMDB filters before expensive detail/embedding work
- Robust Stremio watched detection using `timesWatched`, `flaggedWatched` and series watched state
- Final hard exclusion of watched IMDb IDs immediately before recommendation selection

## Files
- `Dockerfile`
- `package.json`
- `README.md`
- `render.yaml`
- `server.js`


## V0.7.1 resilience
Gemini is an optional semantic layer. HTTP 429/403, quota, rate-limit, timeout, or network failures automatically trigger the local recommender fallback; the catalog endpoint does not fail because Gemini is unavailable. Gemini is retried automatically after a cooldown and cached local results can be upgraded in the background when Gemini becomes available again.
