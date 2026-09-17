# 🎯 Antony — Personal Stremio Recommendations v6.0.0

Custom Stremio addon producing **30 films + 30 series** from the user's Stremio 👍/❤️ signals.

## v6.0.0 — quality + persistent cache + robust refresh

- Keeps the learned multi-signal recommendation model: ❤️ = 3× 👍.
- Watched-without-rating is negative evidence by definition: one item is weak evidence, repeated similar rejections become strong rejection families and can quasi-exclude matching candidates.
- Uses several learned taste poles rather than genre quotas.
- Final Top 30 is the actual highest personalized scores; no artificial diversity tax or genre quota can displace a stronger match.
- Semantic embeddings focus on narrative content, genres, keywords and collections; actor/director/country/language are deliberately kept at low influence elsewhere rather than becoming semantic shortcuts.
- Candidate discovery uses both positive-seed neighborhoods and contrastive genre/keyword strategies, then uses learned genre affinity to prioritize which candidates receive expensive detail enrichment.
- TMDB rating/vote thresholds are hard filters; rating and vote reliability remain weak final signals.
- Last valid Top 30 Films and Top 30 Series are stored in Upstash Redis and survive Render restarts.
- TMDB responses and embeddings are cached persistently in Upstash and locally in RAM.
- A rebuild never replaces a valid 30-item catalog with a partial result.
- Movie and series builds are serialized per user to avoid resource contention on Render Free.
- Gemini is optional. If unavailable, the local feature/interaction model continues to work.

## Persistent cache

Set these Render environment variables:

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

The addon stores public-derived TMDB metadata, embeddings and the two last-known-good recommendation catalogs. It does not persist raw Stremio library/rating records in Redis.

## Recommendation model

- ❤️ = loved: something the user would recommend and could rewatch.
- 👍 = liked: genuinely positive, but normally one viewing is enough.
- Watched without 👍/❤️ = negative, ranging from "bof" to strongly disliked.
- The model learns negative families, feature interactions and anti-recipes separately from positive taste.
- Repeated negative families can become quasi-exclusions; already-watched titles remain absolute exclusions.
- Already-watched titles are excluded.
- No artificial genre quotas.
- No popularity ranking: TMDB rating and vote reliability are weak signals after hard filters.
- Top 30 is selected before optional random display ordering.

## Configuration

Open `/configure` and provide:

1. **TMDB API Read Access Token** — required.
2. **Stremio AuthKey** — required.
3. **Gemini API key** — optional.

Secrets are stored encrypted inside the generated manifest token and are not included in the ZIP.

## Cache architecture

```text
Stremio
   ↓
Render addon
   ├── L1: RAM
   └── L2: Upstash Redis
          ├── latest Top 30 Films
          ├── latest Top 30 Series
          ├── reusable TMDB responses
          └── reusable semantic embeddings
```


## v6.0.0 — Unified Taste Model
- One unified preference model learns from films and series together.
- Separate movie/series models remain active for format-specific preferences.
- Global and local semantic embeddings, feature interactions, clusters, and cautious negative evidence are combined at ranking time.
- The library rating scan is shared across both catalogs to avoid duplicate Stremio status requests.
- Public-derived embeddings remain persistently cached in Upstash; private library/rating state is not persisted there.
- Final selection remains the true top 30 by personalized score; no artificial diversity quota or popularity ranking.


### Affichage des catalogues
La v6.0.0 permet d’activer/désactiver séparément les catalogues Films et Séries. L’API Stremio standard expose un catalogue dans Board et Discover ; elle ne fournit pas de drapeau officiel permettant de rendre un même catalogue uniquement Board ou uniquement Discover.


## v6.0.0 — final technical hardening
- Candidate enrichment keeps an explicit exploration tranche so discovery does not collapse onto genre affinity alone.
- The final Top 30 remains a pure personalized ranking: no diversity tax or quota.
- Watched-unrated negative evidence is represented separately from the positive/contrastive model and applied conservatively.
- The expensive candidate pool is allowed to grow to a larger healthy set before final ranking, prioritizing recall over a premature 30-item result.
- Default discovery filters are aligned with the intended setup: TMDB rating ≥ 7.2, ≥ 2000 votes, with Horror/Romance/Music/Comedy excluded by default; existing saved configuration values remain preserved.
- The adult-content hard exclusion remains a safety/content filter in the recommender; no adult catalogue or adult-mode feature exists.


## v6.0.0 — symmetric rejection model
- The same unified taste model feeds Films and Séries, with separate format-specific heads.
- ❤️, 👍 and watched-without-rating have explicitly different semantics.
- All watched-without-rating items contribute to the negative model; a bounded set is enriched deeply for Render/TMDB cost control.
- Negative evidence is modeled separately from positive affinity, so generic positive traits cannot erase a strong rejection pattern.
- Negative feature families, pair/triple anti-recipes and semantic negative prototypes are combined.
- Repeated negative families can quasi-exclude candidates before expensive ranking.
- The normal popularity fallback using `vote_count.desc` has been removed; popularity is not a discovery driver.
- Final ranking uses positive fit minus calibrated rejection risk and uncertainty; the Top 30 is still selected by actual personalized score, with no genre quota or artificial diversity tax.
- Persistent cache namespace is bumped to v6 so old v5 catalogs cannot be mistaken for v6 results.
