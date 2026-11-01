# Changelog

All notable changes to Jukebox Card. Versions follow [semver](https://semver.org/).

## 0.5.1 — 2026-10-31

Docs and repo housekeeping for HACS: MIT license file, HACS validation workflow, README restructure, developer docs. No card changes.

Docs, license and workflow housekeeping for HACS default-store inclusion. No card change and no version bump.

### Changed
- **LICENSE** is the standard MIT text only, with `Copyright (c) 2026 Randy Bell`. The SIL Open Font License paragraph that used to follow it is removed so GitHub can detect MIT. Bundled fonts (Inter, Plus Jakarta Sans) stay OFL-1.1; that is already recorded in `THIRD_PARTY_NOTICES.md`, and each family's `LICENSE-*.txt` ships next to the font files.
- **README** order is intro, screenshots, requirements, install, configuration, options, troubleshooting and license. Screenshot paths are absolute URLs on `main`. The duplicated changelog list is now a link to `CHANGELOG.md`. Maintainer build, dev harness, tests and release steps moved to `docs/DEVELOPMENT.md`. The "Open questions" section and personal setup notes are removed.
- **Install:** HACS custom repository for now (default-store listing is pending). HACS downloads the release assets into `/config/www/community/ha-jukebox-kiosk-card/` and does not unzip `jukebox-card-fonts.zip`. Custom fonts load only after that archive is unzipped into `fonts/` next to the JavaScript, or `font_base` is set. Otherwise the card uses system fonts.
- **Validate workflow** added at `.github/workflows/validate.yml` (`hacs/action`, category `plugin`, no `ignore`).
- **Release workflow** comment only: HACS installs the release assets, not `dist/jukebox-card.js` from the git tree.

## 0.5.0 — 2026-10-31

### Added
- **Speakers panel**, opened by tapping the header status. Responsive at 390x844, 1280x800 and 1920x1080. It opens in the middle of the card, between the header and the tab bar, so it works inside the 0.4.2 fitted height (including the compact `short` / `tiny` layouts): the tab bar stays visible and a tab tap closes the panel; the panel scrolls when it is taller than the room.
  - `speaker_mode: fixed` (default): a per-room volume mixer only; every call still goes to `entity`, so a 0.4 config makes identical calls.
  - `speaker_mode: dynamic`: "Play on" target chips (remembered per device), join / drop / move with Music Assistant only (`mass_queue.send_command` → `players/cmd/set_members`, `player_queues/transfer`; never HA `media_player.join` / `unjoin`), players read with `players/all`. Static MA sync groups are shown as fixed. Start / move warnings name the groups that would lose speakers.
  - Leader drop: `leader_drop: block` (default) or `allow` (MA hands off / re-forms the group).
  - Optimistic changes with timeouts, a toast on failure and Undo.
  - Per-room now-playing line.
  - `presets` (rooms + volumes + optional target).
  - `quiet_hours` volume cap (guests by default), applied to the panel and Now Playing sliders.
  - `large_buttons`.
- **Permissions** (`grouping`, `grouping_users`, `guest_access`): guests get volume only. This is a UI lock, not security.
- **Queue row icons** for users who may group: Play now (confirmation "Play this now? The current song will stop." → `player_queues/play_index`), Play next (`player_queues/move_item`, `pos_shift = (current + 1) − index`), Move up / Move down, and Remove (`player_queues/delete_item`, no dialog, "Removed <title>. Undo" for 5 s; Undo = `player_queues/play_media` option `add` + `player_queues/items` + `move_item`, and the toast says when the place can't be restored). Never on the playing row. On phones Play next and Remove stay inline and ⋯ opens an action sheet with the rest. Without `mass_queue_entry_id` the 0.4 mass_queue services are used.
- Editor: a **Speakers** section and `large_buttons` under Display.
- **Tab bar redesign (segmented bar).** The bottom tabs are now real buttons on one rounded translucent track: equal segments with hairline dividers, 16 px labels (labels ellipsize instead of wrapping on wide cards, wrap to two lines on phones), and the active tab is a solid white segment with dark text and icon. Hover, pressed (`scale(.97)`) and keyboard focus states use only colour / transform transitions. Short (`data-fit=short`) and tiny (`data-fit=tiny`, icon + label in one row, icons only on phones) layouts are compacted, and `large_buttons` keeps larger tabs there too (60 px short, 52 px tiny, 80 px otherwise).
- **Tab bar keyboard support** (roving tabindex): the active tab is the one tab stop (`tabindex=0`, the others `-1`), and ←/→/Home/End switch tabs and move the focus ring with them. Switching tabs from the keyboard also closes the Speakers panel.
- Dev mock of Music Assistant (`dev/mock-ma.js`, placeholder ids only) with the live MA behaviour: set_members, transfer, play_index, move_item (buffered items raise, out-of-range is a silent no-op), delete_item (buffered items ignored), play_media add, items.
- Tests: `test/unit/speakers.unit.mjs`, `test/speakers.e2e.mjs`, screenshots `test/shots-v050.mjs` (including the segmented tab bar at 1024x666 below the HA toolbar, 1280x800 and 390x844).
- `test/speakers.e2e.mjs` section P: every Play now path (row icon, a played row's icon, the phone ⋯ sheet, the 0.4 long-press menu, a row tap, and the 0.4-service fallback) only jumps playback to that item in place: Music Assistant's queue keeps the same items in the same order, the card's rows match it, and nothing but `play_index` / `play_queue_item` is sent (no `play_media`, replace, clear, move or delete).
- The queue's phone action sheet scrolls inside the card when it is taller than the room (short screens with `large_buttons`).
- `test/fit.e2e.mjs` section F6: the Speakers panel, large-button mode, the queue ⋯ sheet, the Undo bar and the Play-now confirm all stay between the header and the tab bar, with no page scroll and the tab bar fully visible, at 1024x666 / 1024x600 / 1280x720 / 1280x800 / 844x390 / 390x844 / 390x600 below the HA toolbar.

- **Matches live Music Assistant 2.10.9** (checked 31 Oct; mock `&live=1` gives the live timings):
  - Dynamic groups: MA's own default member list (`config/players/get` → `group_members`) is offered as an "<Group> default" preset chip next to the card presets; if the config can't be read, only the card presets show. Current members still come from `players/all`.
  - Static groups never get `set_members` (MA answers 500 "does not support group commands").
  - HA entities carry `mass_player_id: null` and idle groups report another group's `active_queue`, so a target is matched to its MA group by name first and by `active_queue` only while it plays.
  - Dropping a group's leader: MA goes silent ~6 s before the next member leads; the panel says "Regrouping…" until it plays again (the header says "regrouping…" while a group buffers).
  - Queue: rows up to MA's buffered item (`player_queues/get` → `index_in_buffer`) are locked (no Play next / Remove, Move disabled, also in the long-press menu); Play next lands after the buffered row. If MA refuses a move (500 "already played/buffered") or ignores a delete, the toast says "That track is already loading" and the queue reloads.

### Fixed
- **Lyrics scrolled the wrong way when idle.** Lines now always move up, with new lines coming in from the bottom, on every surface. The Stage view no longer jumps down (a stale scroll position plus browser scroll anchoring made 177–185 of its moves go down). The screensaver now slides up instead of jumping (synced) or not moving at all (plain), because lines were replaced instead of kept and their flex sizing collapsed. Only `transform` is animated, with no blur; reduced motion and the `.rm` setting switch the slide off. Covered by direction tests on the overlay, Stage, Lyrics tab and screensaver, synced and plain (3+ line changes each, never down).

### Compatibility
- 0.4 configs load unchanged and make the same calls (fixed mode). Tapping a queue row and the long-press menu keep the 0.4 behaviour, except that the menu no longer offers Play next / Move / Remove on the track MA is already loading.
- Play now never re-sorts, replaces or clears the queue: it only moves playback to the chosen item (`play_index` / `play_queue_item`).

## 0.4.2 — 2026-10-31

Hotfix: the bottom tab bar was cut off on standard monitors.

### Fixed
- **Tab bar pushed below the fold.** The card was sized to the full viewport height (`100dvh`/`100vh`), but in a Home Assistant dashboard it starts below HA's fixed 56 px toolbar, so the tab bar ran 56 px past the bottom of the window (for example tabs at 643–722 px in a 1024x666 window). Viewport units grow with browser zoom-out, so zooming out (Cmd-minus) did not help. In 0.4.0 the page could still be scrolled to reach the tabs, but the wheel over the middle of the card is captured by its scroll areas (`overscroll-behavior: contain`, including the lyrics overlay once real lyrics load), so in practice the tabs could not be reached.
- The card now measures the space it really has: its top edge on the page against the visible viewport (`innerHeight`, `clientHeight` and `visualViewport`), re-measured on window and visual-viewport resize, orientation change, full screen changes, HA navigation, and a `ResizeObserver` on the page and the card's parent. The result is set as an internal CSS variable; there is no hard-coded toolbar height (HA's `--header-height` is only a fallback). Any padding below the card in a masonry or sections view is subtracted. Minimum height 320 px; safe-area insets are still respected. The `height` option still overrides it.
- In full screen and in kiosk mode with the toolbar hidden the card still fills the whole screen.
- Short viewports (under 700 px tall) get a slightly more compact header and tab bar, and under 560 px more compact again, so the header and tabs always stay fully visible while the middle shrinks or scrolls.
- Phones in landscape and other short, wide screens: the search keyboard sits beside the query and results instead of above them, so it is no longer clipped.
- Nothing changes at 1920x1080 (same layout, same large-screen zoom, same frame times).

### Tests
- New `test/fit.e2e.mjs` (`npm run test:fit`): the dev harness can emulate HA's toolbar, sidebar, kiosk mode and a masonry view (`?ha=toolbar|kiosk|masonry&sidebar=open|narrow|closed`). Checks that the header and every tab are fully visible and clickable with no page scroll on every tab (Search with the keyboard open) at 1024x666, 1280x720, 1366x768, 1440x900, 1280x800, 1920x1080, 390x844, 844x390, 820x1180, 1180x820 and 1024x600, with and without the toolbar and in full screen; with the sidebar open and closed; while resizing, rotating and hiding or showing the toolbar; and an emulated Mac Chrome check (1024x666, device scale 2, browser zoom 100 %, 80 % and 67 %). Screenshots go to `test/shots/v042/`.

## 0.4.1 — 2026-10-31

Credits, requirements and third-party notices, plus one small screensaver change.

### Changed
- **Screensaver lyrics status.** When screensaver lyrics are on but there are none to show, the screensaver now shows a small, translucent status line under the track info: "No lyrics", "Lyrics unavailable" or "Looking for lyrics…". It sits inside the drifting clock block, so it moves with the anti-burn-in drift (and the reduced-motion hop). It is hidden while lyrics are showing and when `show_lyrics` or `screensaver_lyrics` is off. Before, the screensaver showed nothing in these states.

### Docs and licensing
- README: new Requirements section (Home Assistant, Music Assistant and its integration, a Music Assistant player, mass_queue from HACS, and what works without mass_queue) and Credits section with a non-affiliation note.
- New `THIRD_PARTY_NOTICES.md`, generated by the build from `node_modules`: the bundled Lit packages (BSD-3-Clause) and the OFL fonts with their authors, each with its full license text. The release attaches it and also puts it in `jukebox-card-fonts.zip`.
- The minified bundle now keeps license comments (Lit's `@license` headers and a Jukebox Card banner).
- LICENSE: `Copyright (c) 2026 Randy Bell`; `package.json` gains `"author": "Randy Bell"`. Still MIT.
- Tests: e2e checks for the screensaver status line in each state; `test/shots-v041.mjs` takes its screenshots.

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
