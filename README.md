# 🎯 Antony — Personal Recommendations

Local Stremio recommendation/catalog add-on.

Catalogs:
- 🎯 Antony — Films
- 🎯 Antony — Séries

It only handles recommendations/cataloguing. It does not handle Torrentio, LUMIO, AllDebrid, torrent quality, resolution, HDR, CAM/TS, or playback.

## Install

Requires Node.js 20+.

```bash
npm install
npm start
```

Open `http://127.0.0.1:7000/configure`, enter your TMDB API key and Stremio credentials/AuthKey, then install:

`stremio://127.0.0.1:7000/manifest.json`

## Important

The standard Stremio add-on API does not expose private user history/ratings directly. This first build uses Stremio's account datastore API for library synchronization. Stremio's internal Like/Love representation is not a stable public third-party contract, so the feedback parser is deliberately tolerant. The recommendation engine remains useful from the initial profile, TMDB quality signals and watched exclusion even if a specific Stremio version stores feedback differently.
