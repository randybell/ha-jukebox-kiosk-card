# Changelog

All notable changes to Jukebox Card. Versions follow [semver](https://semver.org/).

## 0.4.0 — 2026-10-31

### Added
- **Lyrics** from Music Assistant through mass_queue (`mass_queue.send_command`: `music/item_by_uri`, falling back to `metadata/get_track_lyrics`). Requires `mass_queue_entry_id`.
- Four lyrics surfaces sharing one store:
  - art overlay with a toggle at the top right of the art (remembered per device);
  - **Stage**: full-screen lyrics (Fullscreen API, WebKit fallback, fixed-overlay fallback); tap for controls and ✕, Esc closes;
  - a 5th **Lyrics** tab;
  - screensaver lyrics (previous / current / next line when synced, slow scroll when plain).
- Synced lyrics: current-line highlight and auto-centring from the interpolated position; **long-press** a line to seek (`media_player.media_seek`), with feedback. Taps do nothing.
- Plain lyrics: progress-proportional scroll, manual override, "Unsynced" chip.
- Radio: lyrics via `music/search` best match + `get_track_lyrics`; never seeks.
- States: "Looking for lyrics…", "No lyrics found", "Lyrics unavailable" (with Retry and a permission hint).
- Caching: memory LRU + localStorage keyed by URI (or artist|title for radio), 30-day positive / 1-day negative TTL, in-flight de-duplication, 60 s error back-off.
- Options: `show_lyrics`, `lyrics_tab`, `screensaver_lyrics`, `lyrics_seek`, `lyrics_offset_ms` (default 500); `default_tab: lyrics`.
- Editor: **Display** section with screensaver presets Off / 1 / 5 / 10 / 15 / 30 / 60 min plus Custom (any 0–1440 still loads; default 10), and a **Lyrics** section.
- Tests: lyrics unit tests (`test/unit/lyrics.unit.mjs`), lyrics end-to-end tests (`test/lyrics.e2e.mjs`), screenshots (`test/shots-v040.mjs`).

### Changed
- The editor no longer writes untouched defaults (`rooms: []`, `screensaver_minutes: 10`, lyrics switches) into YAML.
- The dev mock records read-only lyrics lookups in `window.__lyricsLog` instead of `window.__calls`.

### Compatibility
- Existing 0.3.x configs load unchanged; lyrics are on by default but need `mass_queue_entry_id`.

## 0.3.2
- Search results as list rows with Add to queue / Play next / Replace queue / Start radio; confirmations; detail pages with Play / Shuffle; phone layouts.

## 0.3.1
- Live API fixes: mass_queue track lists and paging, proxy-only player art, Radio Browser stations.
