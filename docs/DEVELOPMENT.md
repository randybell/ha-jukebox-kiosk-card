# Development

Maintainer notes for building, testing and releasing Jukebox Card. Install and configuration for Home Assistant are in the [README](../README.md).

Nothing in this repository talks to a real Home Assistant server. Development and tests run against `dev/mock-hass.js`.

## Build

```bash
# lit 3, rollup 4, typescript 5.9 (TS 7 breaks @rollup/plugin-typescript), fontsource
npm ci                # or npm install
npm run build         # -> dist/jukebox-card.js (single ES module) + dist/fonts/*
npm run watch         # rebuild on change
npm run typecheck     # tsc --noEmit
```

## Dev harness and tests (no Home Assistant needed)

```bash
python3 -m http.server 8765 --bind 127.0.0.1     # from the project root; the harness won't run from file://
# open http://127.0.0.1:8765/dev/index.html?log=1
npm test                                           # run.mjs (156 end-to-end checks) + lyrics unit tests (51) + lyrics end-to-end checks (84) + speakers unit tests (35) + speakers end-to-end checks (137) (puppeteer-core + /usr/bin/google-chrome; CHROME=... to override)
node test/shots-m2.mjs f1                          # every tab at 1920x1080, 1280x800, 820x1180 and 390x844 -> test/shots/m2/
JB_SIZES=1920x1080 node test/shots-m2.mjs x1 '&backdrop=light'   # one size, one mode
node test/shots-v040.mjs                           # lyrics surfaces, states and the editor at 1280x800, 1920x1080, 390x844 -> test/shots/v040/
node test/shots-v050.mjs                           # speakers panel (fixed, dynamic, guest, presets, move, large buttons), queue row icons and the segmented tab bar at 390x844, 1280x800, 1920x1080 and 1024x666 below the HA toolbar -> test/shots/v050/
npm run test:fit                                   # fit-to-height checks: 11 sizes x HA toolbar / kiosk / full screen, every tab, sidebar, resize, emulated Mac Chrome zoom, 0.5.0 Speakers panel / large buttons / queue overlays -> test/shots/v042/
node test/perf.mjs 3                               # frame-time benchmark, see "Backdrop and performance"
```

`dev/mock-hass.js` is a fake `hass`. It uses the shapes from the real exports (`dev/fixtures/`):
- `search` always returns the 7 lists.
- Items carry no provider field; the provider comes from the URI scheme (`library://`, `apple_music://`, `apple_music--XXXXXXXX://`).
- `get_library` returns `{items, limit, offset, order_by, media_type}` with `library://` URIs.
- `mass_queue.get_queue_items` returns a list keyed by entity.
- `mass_queue.get_album_tracks` / `get_playlist_tracks` return the real 0.10.x shape (`{tracks: [{media_title, media_artist, media_album_name, media_content_id, media_image, duration, favorite, position}]}`); `library://album/1448` and `library://playlist/158` answer with the real exports in `dev/fixtures/mass-queue-tracks-sample.json`.
- The player has an absolute `entity_picture` (`http://<ma-host>:8095/imageproxy?…`) and a relative `entity_picture_local`, as on the real system.
- The fixtures are scrubbed: provider instance ids are `--XXXXXXXX`, HA context ids are placeholders and `user_id` is `null`.
- `play_media` is rejected unless the target is `media_player.everywhere`.
- Every service call changes the mock state and pushes a new `hass`, as HA does.

URL parameters:

| Parameter | Effect |
|---|---|
| `latency=ms` / `jitter=ms` | reply latency and its random variation |
| `mode=inverse` | shorter queries reply more slowly, which forces out-of-order replies |
| `fail=1` | the mock search fails |
| `real=1` | search returns the real "eagles" export from `dev/fixtures/ma-search-sample.json` |
| `radio=1` | Radio Browser stations in search only (library radio stays empty, so Browse > Radio uses the search fallback) |
| `radio=lib` | the same stations also in the library (`get_library media_type: radio`) |
| `mqpage=all\|paged\|ignore` | how `get_*_tracks` treats `page`: `all` (default, mass_queue 0.10: page 0 = everything), `paged` (50 per page), `ignore` (every page returns the same list) |
| `noart=1` | the player has no `entity_picture_local`, so art falls back to the queue item's https image |
| `legacyq=1` | configures the old `queue_config_entry_id` key instead of `mass_queue_entry_id` |
| `idle=1` / `paused=1` | nothing playing / paused |
| `empty=1` | empty library and queue |
| `qfail=1` | `mass_queue.get_queue_items` fails |
| `noqueue=1` | no `mass_queue_entry_id`, so drill-down uses the search fallback |
| `saver=min` | `screensaver_minutes`; for example `saver=0.05` is 3 seconds |
| `recents=1` | seeds the recent-search chips |
| `fresh=1` | clears localStorage |
| `log=1` | shows a panel with every `callService` call |
| `tab=now\|browse\|search\|queue\|lyrics` | opens that tab (default `now`) |
| `lyrics=none` | every lyrics lookup finds nothing |
| `lyrfail=perm\|err` | lyrics lookups fail with a permission error / a generic error |
| `lyrlat=ms` | lyrics reply latency (the live first lookup takes 8–33 s) |
| `overlay=1\|0` | preset the art lyrics overlay toggle |
| `keeplyrics=1` | with `fresh=1`, keep the lyrics cache |
| `admin=1`, `user=<name>`, `uid=<id>` | the HA user (default: a non-admin guest) |
| `spk=dyn`, `target=<entity>`, `cfg=<json>` | dynamic speaker mode, the starting target, extra card config (merged last) |
| `ma=split\|busy`, `grp=` / `xfer=fail\|slow\|timeout`, `gap=ms`, `malat=ms` | mock Music Assistant situations and failures (`dev/mock-ma.js`, log in `window.__maLog`) |
| `qbuf=1`, `qadd=fail`, `qitems=fail` | next track already buffered in MA; queue re-add / item lookup fails (Remove → Undo) |
| `cfg=<json>` | merged into the card config |
| `backdrop=auto\|full\|light\|static\|off` | sets the `backdrop` option |
| `ha=toolbar\|kiosk\|masonry` | emulates a Home Assistant view around the card: fixed 56 px toolbar (`--header-height`), toolbar hidden (kiosk mode), or a masonry view with padding and a card above |
| `sidebar=open\|narrow\|closed\|none` | with `ha=`, the HA sidebar width (256 px, 56 px, or none; default `narrow`) |

Every call is recorded in `window.__calls`, except read-only lyrics lookups (`mass_queue.send_command`), which go to `window.__lyricsLog`. `window.__setNowPlaying({artist, title, radio, uri, duration, position})` and `window.__playTrack(name, position)` change what is playing. `test/run.mjs` drives the card with real CDP mouse, touch and keyboard input and writes `test/shots/results.json`. The browser tests are hermetic (`test/intercept.mjs`): `/api/media_player_proxy/…` and https images are answered with a generated SVG, and any request to a plain-http host other than the dev server fails (test 16o checks that the card never asks the MA host directly).

## Repository, releases and HACS

- `hacs.json`: `{"name": "Jukebox Card", "filename": "jukebox-card.js", "render_readme": true}`. `filename` lets HACS find `jukebox-card.js` even though the repo is called `ha-jukebox-kiosk-card`.
- `dist/` is **not committed**. `.github/workflows/release.yml` runs on a `v*` tag: `npm ci`, typecheck, build, then it attaches `dist/jukebox-card.js`, `dist/THIRD_PARTY_NOTICES.md` and `jukebox-card-fonts.zip` to a GitHub release. HACS installs from the latest release's assets.
  - Why: committed build output makes every diff noisy, goes stale when someone forgets to rebuild, and is easy to mismatch with the source. A tag-built release always matches its tag, HACS lets users pick from the last 5 releases, and the repo stays small.
  - To release: bump `version` in `package.json` (and `package-lock.json`) and `VERSION` in `src/jukebox-card.ts`, run `npm run build` so `THIRD_PARTY_NOTICES.md` is current, commit, then `git tag -a v0.4.2 -m 'Jukebox Card 0.4.2' && git push origin v0.4.2` (push only that tag).
- `test/shots/` (generated by the tests and screenshot scripts) is git-ignored; the curated screenshots used in the README are in `docs/`.
- License: MIT (`LICENSE`), Copyright (c) 2026 Randy Bell. The root `LICENSE` file is the standard MIT text only, so GitHub detects it. The bundled fonts are OFL (licence files ship in `dist/fonts/` and the fonts zip). Third-party licenses are in `THIRD_PARTY_NOTICES.md`, which ships with each release.
