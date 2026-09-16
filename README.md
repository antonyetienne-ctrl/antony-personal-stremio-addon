# 🎯 Antony — Personal Stremio Recommendations v1.1.0

Custom Stremio addon producing **30 films + 30 series** from the user's Stremio 👍/❤️ signals.

## v1.1.0 changes

- TMDB authentication uses the **API Read Access Token** (`Authorization: Bearer ...`), not the legacy API-key query parameter.
- Candidate discovery no longer uses `popular` and does not use popularity as a final ranking signal.
- Candidates are gathered from the user's positive items through TMDB `similar` and `recommendations`, then broadened with profile-derived genre/keyword combinations through TMDB `discover`.
- Discovery samples multiple pages and multiple non-popularity sort orders, including rating, release-date sweeps and low-vote-count sweeps, so old/less-popular qualifying works can enter the candidate pool.
- The final ranking remains **92% taste + 5% TMDB rating + 3% vote-count reliability**. TMDB rating/vote count are hard filters first.
- ❤️ has 3× the positive weight of 👍.
- Watched content is an exclusion only; it is never treated as a positive preference.
- The final 30 are selected first, diversified softly, then shuffled only for display.
- Gemini remains optional. A Gemini 429/timeout/error falls back to the local recommender.
- Background refresh and last-known-good catalogs remain in place. The 20-second cold-start wait is only a response-time guard; it is **not** a cap on the background recommendation computation.

## Configuration

Open `/configure` and provide:

1. **TMDB API Read Access Token** — required.
2. **Stremio AuthKey** — required.
3. **Gemini API key** — optional.

The TMDB Read Access Token is stored encrypted inside the generated manifest token and sent to TMDB only as an HTTP Bearer token.

## Candidate discovery philosophy

The addon cannot download every TMDB title with full metadata on every request. Instead it uses several independent discovery routes so candidate eligibility is not determined by TMDB's popularity ranking:

- recommendations from positive seeds;
- similar titles from positive seeds;
- genre-driven discovery learned from 👍/❤️;
- keyword-driven discovery learned from 👍/❤️;
- genre + keyword combinations;
- sampled pages across several non-popularity sorts.

TMDB's daily ID exports are not used as a runtime dependency: TMDB documents them as ID lists with limited higher-level attributes rather than full metadata exports. This keeps the Render Free deployment small and avoids turning the addon into a data warehouse.

## Resilience

- Stremio state is cached and a last-known-good catalog is retained.
- Expensive recommendation work is performed in the background when possible.
- TMDB calls use retries, timeouts and the Bearer token.
- Gemini is optional and non-blocking for correctness.

## Important limitation

A third-party Stremio addon cannot simply request "all of TMDB with every metadata field" in one operation. This version therefore maximizes candidate coverage within reasonable API traffic rather than pretending to exhaustively crawl the entire TMDB database.
