# 🎯 Antony — Personal Stremio Recommendations v4.0.1

Custom Stremio addon producing **30 films + 30 series** from the user's Stremio 👍/❤️ signals.

## v4.0.1 — reliability + performance

- Keeps the v3 recommendation model and its learned taste logic.
- Discovery remains broad, but expensive TMDB detail enrichment is capped after cheap eligibility filtering.
- Candidate discovery uses positive seeds, TMDB similar/recommendations, and profile-derived genre/keyword combinations.
- The first request never deliberately returns an empty catalog merely because personalization is still calculating.
- If no personalized catalog exists yet, a small temporary TMDB bootstrap catalog is returned while the personalized build continues in the background.
- Empty catalog responses are sent with `Cache-Control: no-store` so a transient failure cannot poison Stremio's cache for minutes.
- Movie and series builds are serialized per user to avoid CPU/network contention on Render Free.
- Duplicate builds for the same user/type are locked and coalesced.
- A previously valid personalized catalog is retained if a rebuild produces no eligible results or fails.
- Gemini remains optional; failures fall back to the local recommender.

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

## Important Render Free limitation

Render Free web services have an ephemeral filesystem and can spin down after inactivity. Therefore this addon does not pretend that a local disk cache is persistent across restarts. The last-known-good catalog is kept in memory while the instance is alive; after a cold restart, the temporary bootstrap prevents an empty catalog while the personalized catalog is rebuilt. Render documents that persistent disks require paid services.
