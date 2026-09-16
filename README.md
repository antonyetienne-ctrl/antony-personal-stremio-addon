# 🎯 Antony Personal Stremio Recommendations v0.6.0

Personal Stremio add-on with separate movie and series catalogs.

## Recommendation model
- ❤️ is weighted 3× 👍.
- Only Stremio 👍/❤️ teach the preference model.
- Watched items are exclusion-only; watching never means liking.
- TMDB rating and vote count are hard filters first, then weak ranking signals (8% combined).
- TMDB popularity/release date do not drive the ranking.
- Gemini embeddings provide semantic story/theme similarity when configured.
- Structured signals include genres, keywords, collections, narrative text, with actors/directors kept low-weight.
- Soft diversification is applied before selecting the final 50.
- Exactly the selected top 50 are then shuffled for display.
- A profile fingerprint invalidates the cache when likes/hearts or watched exclusions change.

## Deployment
Deploy the five files to Render as a Docker service. Open `/configure`, enter TMDB and Stremio credentials, optionally Gemini, then install the generated Stremio manifest.
