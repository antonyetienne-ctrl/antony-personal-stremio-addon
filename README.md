# 🎯 Antony — Personal Stremio Recommendations v6.2.0

Evolution of v6.0.0 without replacing its recommendation engine.

## Priority: recommendation precision

- ❤️ Love = very strong positive anchor.
- 👍 Like = moderate positive signal.
- Watched without 👍/❤️ = negative evidence, separate from positives.
- Positive/negative feature models include individual features, pair interactions, triple interactions, semantic prototypes and taste clusters.
- Films and Séries use separate local heads plus a unified cross-format profile.
- **Exact 70% local format profile + 30% global profile** at recommendation scoring/discovery layers.
- No genre quota and no popularity ranking. TMDB rating/vote thresholds remain hard filters; popularity is not a ranking objective.
- Final Top 30 is selected by personalized score; random display only shuffles those 30.
- A conservative optional Gemini reranker judges the top local candidates for narrative fit and disappointment risk. It can only provide a limited 15% final adjustment; if Gemini fails, local ranking remains fully functional.

## Daily synchronization

- At most one complete user-state synchronization per **calendar day in Europe/Zurich**.
- A day change triggers one check of the Stremio library plus the Love/Like status snapshot.
- If neither library nor rating fingerprint changed, the existing catalogs are reused and no rebuild occurs.
- If something changed, Films and Séries are rebuilt once from the same synchronized snapshot.
- Navigation requests do not trigger repeated 15-minute rebuild checks.
- The previous valid catalog remains untouched until a complete replacement is ready.

## Upstash architecture

Upstash is deliberately restricted to durable state that is actually useful after a Render restart:

- latest complete Top 30 Films;
- latest complete Top 30 Séries;
- compact daily synchronization state;
- last build timing/diagnostic record.

High-volume TMDB metadata and Gemini embeddings are kept in Render RAM instead of issuing one Upstash GET + SET per item. This removes a major source of command amplification without reducing the candidate pool or recommendation model.

## Timing / diagnostics

The addon measures:

- Stremio library sync time;
- Love/Like status scan time;
- Film build time;
- Series build time;
- profile/ranking/store sub-times for each catalog;
- total build duration;
- Upstash commands consumed by the build.

Diagnostic endpoint:

`/debug/build`

It exposes only timing/operational counters, never API keys or the Stremio AuthKey.

## French metadata

TMDB display metadata is requested in `fr-FR`.

- French titles/descriptions/genres when TMDB provides them;
- French-first poster selection, then universal/English fallback when no French poster exists;
- French-first YouTube trailers when available, then English fallback;
- Stremio meta responses include trailers in the standard addon format.

## Gemini

Gemini is optional. The engine continues normally if Gemini is unavailable, rate-limited or times out.

Two complementary uses are retained:

1. Gemini embeddings for semantic similarity and taste clusters.
2. A conservative Gemini 2.5 Flash-Lite narrative reranker on the strongest local candidates, using Hearts, Likes and watched-unrated negatives as explicit evidence.

## Installation

1. Deploy the ZIP to the existing GitHub/Render service.
2. Keep the existing Render environment variables:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
   - the TMDB/Stremio/Gemini keys are entered through `/configure` and embedded encrypted in the manifest token.
3. Open `/configure` and save the existing configuration.
4. Reinstall/update the manifest in Stremio.
5. Wait for the first complete personalized build if no previous v6.2 catalog exists.

The addon never substitutes a partial/bootstrap recommendation list for the personalized Top 30.
