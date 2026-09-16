# Antony — Personal Stremio Recommendations v0.3.0

## What this release does
- Two Stremio catalogs: **🎯 Antony — Films** and **🎯 Antony — Séries**.
- Uses TMDB for discovery, metadata, vote-count-aware quality scoring and filters.
- Reads Stremio account `libraryItem` data to exclude watched content.
- Reads Stremio's current Likes service (`https://likes.stremio.com`) for `Liked` / `Loved` status.
- Learns genre/keyword affinity from the user's actual positive signals; ❤️ is weighted more strongly than 👍.
- Watched content is used for exclusion, not as evidence that the user liked it.
- No torrent/source/quality management; Torrentio/LUMIO/etc. remain responsible for sources.

## Configuration
Open `/configure`, enter:
1. a TMDB API key;
2. a Stremio AuthKey.

The page generates a `stremio://.../manifest.json` installation link. Stremio's add-on documentation explicitly supports user data in the add-on URL and configurable `/configure` pages.

Never paste credentials into GitHub or into ChatGPT.

## Render
- Runtime: Docker
- Plan: Free
- Region: Frankfurt recommended for Switzerland
- Health check: `/health`
- Port: Render's `PORT` environment variable, default 10000.

`CONFIG_SECRET` is recommended as a Render environment variable. If omitted, the service derives a per-service fallback secret from Render's service identity; setting `CONFIG_SECRET` explicitly is preferable if you want encrypted installation URLs to remain valid across service identity changes.

## Verified design facts
Stremio's current core defines rating states `Watched`, `Liked`, and `Loved`, and its rating requests use `https://likes.stremio.com/api/get_status`. The same core defines the account datastore collection `libraryItem` for library/watch-state synchronization.

The Stremio add-on protocol requires a manifest and supports `catalog` and `meta`; configurable addons use `/configure` and a `stremio://` install link.
