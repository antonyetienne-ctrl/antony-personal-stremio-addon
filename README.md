# 🎯 Antony — Personal Stremio Recommendations v4.0.3

Custom Stremio addon producing **30 films + 30 series** from the user's Stremio 👍/❤️ signals.

## v4.0.3 — persistent cache + reliable refresh

- Keeps the v3 recommendation model and learned taste logic.
- Stores the **last valid Top 30 Films and last valid Top 30 Series** in Upstash Redis when the two `UPSTASH_REDIS_REST_*` environment variables are configured.
- On Render restart, the previous catalogs can be restored immediately from Upstash while the new personalized calculation runs in the background.
- TMDB responses already obtained by the addon are also cached persistently in Upstash for long-term reuse; eviction is enabled on the database so the cache can use the available capacity without making stale entries fatal.
- The local Render RAM cache remains the fast L1 cache; Upstash is the persistent L2 cache.
- A rebuild never replaces a valid 30-item catalog with a partial result.
- Movie and series builds are serialized per user to avoid CPU/network contention on Render Free.
- Discovery remains broad, while expensive TMDB detail enrichment is applied only after cheap eligibility filters.
- The first request never deliberately returns an empty catalog merely because personalization is still calculating.
- If no personalized catalog exists yet, a temporary TMDB bootstrap can be returned while the full build continues.
- Gemini remains optional; failures fall back to the local recommender.

## Persistent cache

Set these Render environment variables to the Upstash REST credentials:

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

The addon stores public TMDB metadata and the two last-known-good recommendation catalogs. It does **not** persist raw Stremio Likes/Loves/library records in Redis. The current Stremio account data remains sourced from Stremio.

## Recommendation model

- ❤️ has 3× the positive weight of 👍.
- Watched-without-rating is cautious negative evidence, not a hard dislike.
- Already-watched titles are excluded.
- Candidate ranking remains 92% taste + 5% TMDB rating + 3% vote-count reliability.
- No artificial genre quotas are imposed.
- The final Top 30 is selected before optional random display ordering.

## Configuration

Open `/configure` and provide:

1. **TMDB API Read Access Token** — required.
2. **Stremio AuthKey** — required.
3. **Gemini API key** — optional.

The TMDB Read Access Token is stored encrypted inside the generated manifest token and sent to TMDB only as an HTTP Bearer token.

## Cache architecture

```text
Stremio
   ↓
Render addon
   ├── L1: RAM cache (fast)
   └── L2: Upstash Redis (persistent)
          ├── last Top 30 Films
          ├── last Top 30 Series
          └── reusable TMDB responses
```

Render Free's local filesystem is ephemeral; the persistent cache therefore lives in Upstash rather than `/tmp`.
