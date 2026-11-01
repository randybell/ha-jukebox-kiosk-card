// Mock `hass` for the jukebox-card dev harness. No network, no Home Assistant.
// Shapes follow the real exports in /workspace/ha-exports (HA 2026.10.4, MA 2.10.9, mass_queue 0.10.4):
//  - music_assistant.search -> {context, response:{artists, albums, tracks, playlists, radio, audiobooks, podcasts}} (always 7 lists)
//    items: {media_type, uri, name, version, image, favorite, explicit} (+artists[]/album{} on tracks, artists[] on albums).
//    No provider / duration / year / owner / metadata. Provider is the uri scheme (library://, apple_music://, apple_music--XXXXXXXX://).
//  - music_assistant.get_library -> {response:{items, limit, offset, order_by, media_type}}
//  - music_assistant.get_queue (entity) -> {response:{<entity_id>: {current_index, current_item{queue_item_id,...}, items:<count>, shuffle_enabled, repeat_mode}}}
//  - mass_queue.get_queue_items -> {response:{<entity_id>: [{queue_item_id, media_title, media_album_name, media_artist, media_content_id, media_image, favorite}]}}
//  - mass_queue.get_{album,artist,playlist}_tracks {config_entry_id, uri, page?} -> {response:{tracks:[{media_title, media_content_id,
//    duration, media_image (https or ""), favorite, media_album_name, media_artist, position (playlists only, null)}]}}
//  - radio items: {media_type:'radio', uri:'radiobrowser://radio/<uuid>', name (often with leading tabs/spaces), image (https or null)}
//  - media_player.everywhere: entity_picture is an absolute LAN URL (not loadable from the kiosk); entity_picture_local is
//    /api/media_player_proxy/... (served by dev/api/ in the harness).
// URL params: latency, jitter, mode=fixed|inverse, real=1 (search returns the real "eagles" sample),
// radio=1 (Radio Browser stations in search only; the library has none, as on the real server), radio=lib (stations in the library too),
// default: no radio provider at all; mqpage=all|paged (mass_queue `page`: all = falsy page returns every track, page n = 50-track
// page n, like mass_queue 0.10; paged = 0-based 50-track pages, page 0 included; ignore = page ignored, always everything),
// idle=1 (nothing playing), empty=1 (empty library), noart=1 (player without entity_picture_local),
// pods=1 (a podcast + an audiobook in the catalog), mqslow=<text> (mass_queue calls whose uri or name contains <text> take 900 ms),
// mqfail=<service> (that one mass_queue service throws, e.g. get_artist_tracks), mqlat=<ms> (mass_queue latency, default 30-60),
// playlat=<ms> (play_media round trip, default 20).
// Lyrics (mass_queue.send_command, response {context, response:{response:X}} like the real REST/websocket shape):
// lyrlat=<ms> (send_command latency, default 40), lyrfail=perm|err (every send_command throws), lyrics=none (nothing has lyrics).
// The mock lyrics are INVENTED placeholder text (see dev/fixtures/ma-lyrics-sample.json), never real song lyrics.
// 'So What' = synced via metadata/get_track_lyrics, 'Teardrop' = synced in item metadata, 'Dreams' = plain, the rest = none.
// music_assistant.search with `artist` / `album`: MA prefixes the query ("artist - name"); the mock keeps only items by that artist.
// Speakers (0.5.0): dev/mock-ma.js adds media_player.indoor / media_player.outdoor (dynamic MA groups, each with its own queue)
// and the players/*, player_queues/* and config/players/* send_command calls (logged in __maLog; writes also in __calls). See mock-ma.js for params.
// admin=1 (the user is an admin), user=<name>, uid=<user id>.
// HA media_player.join / unjoin throw (their ids don't match MA's speakers; the card must use MA set_members).

import { createMa } from './mock-ma.js';

const params = new URLSearchParams(location.search);
export const mock = (window.__mock = {
  latency: Number(params.get('latency') ?? 120),
  jitter: Number(params.get('jitter') ?? 0),
  mode: params.get('mode') ?? 'fixed',
  fail: false,
  failQueue: params.get('qfail') === '1',
});
window.__calls = [];
window.__lyricsLog = [];
const REAL = params.get('real') === '1';
const RADIO = params.get('radio') === '1' || params.get('radio') === 'lib';
const RADIO_LIB = params.get('radio') === 'lib';
const MQPAGE = params.get('mqpage') ?? 'all';
const NOART = params.get('noart') === '1';
const MQ_PAGE_SIZE = 50;
const EMPTY = params.get('empty') === '1';
const PODS = params.get('pods') === '1';
const MQSLOW = (params.get('mqslow') ?? '').toLowerCase();
const MQFAIL = params.get('mqfail') ?? '';
const MQLAT = params.get('mqlat');
const LYRLAT = Number(params.get('lyrlat') ?? 40);
const LYRFAIL = params.get('lyrfail') ?? '';
const LYRNONE = params.get('lyrics') === 'none';
const fixture = async (f) => (await fetch(new URL(`./fixtures/${f}`, import.meta.url))).json();
// real mass_queue tracks (scrubbed): library://album/1448 (Hotel California, 9 tracks), library://playlist/158 (2 tracks)
const realTracks = await fixture('mass-queue-tracks-sample.json').then((d) => Object.fromEntries(Object.values(d).map((v) => [v.uri, v.raw.result.response.tracks]))).catch(() => ({}));
const realRadio = await fixture('ma-search-sample-radio.json').then((d) => d.result.response.radio).catch(() => []);
const realSample = REAL ? (await (await fetch(new URL('./fixtures/ma-search-sample.json', import.meta.url))).json()).result.response : null;

const PALETTE = [['#ff2e7e', '#ff9a3d'], ['#3b2cff', '#00d4c4'], ['#ffd23f', '#ff4f8b'], ['#00b37e', '#1e3cff'], ['#c42fd8', '#ffd23f'], ['#ff7a3d', '#7a2cff'], ['#0fd1ff', '#ff2e7e'], ['#7a2cff', '#00d4c4']];
const h = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7) >>> 0;
function art(name) {
  const [a, b] = PALETTE[h(name) % PALETTE.length];
  const init = name.replace(/^the /i, '').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="200" height="200" fill="url(#g)"/><circle cx="${40 + (h(name) % 120)}" cy="${50 + (h(name + 'y') % 90)}" r="46" fill="#ffffff" opacity=".22"/><text x="18" y="182" font-family="Helvetica,Arial" font-weight="800" font-size="54" fill="#fff" opacity=".9">${init}</text></svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seqId = 1000;
const nid = () => String(seqId++);
// provider scheme per item: 'library' | 'apple_music'. Nested artists of apple_music items use the instance id (as in the real sample).
const nestedScheme = (p) => (p === 'apple_music' ? 'apple_music--XXXXXXXX' : p);
const short = (media_type, uri, name, image = null) => ({ media_type, uri, name, version: '', image });

// ---- catalog (internal fields start with _ and are stripped from responses) ----
const A = {}; // artist name -> item
function artist(name, prov = 'library', fav = false) {
  const it = { media_type: 'artist', uri: `${prov}://artist/${prov === 'library' ? nid() : encodeURIComponent(name)}`, name, version: '', image: art(name), favorite: fav, explicit: null, fanart_image: null, _added: h(name) % 1000 };
  A[name] = it; return it;
}
const nestedArtist = (by, prov) => short('artist', prov === 'library' ? (A[by]?.uri ?? `library://artist/${h(by) % 9000}`) : `${nestedScheme(prov)}://artist/${encodeURIComponent(by)}`, by);
function album(name, by, prov = 'library', fav = false) {
  return { media_type: 'album', uri: `${prov}://album/${nid()}`, name, version: '', image: art(name), favorite: fav, explicit: null, discart_image: null, artists: [nestedArtist(by, prov)], _added: h(name) % 1000 };
}
function track(name, by, alb, dur, prov = 'library', version = '', fav = false) {
  return { media_type: 'track', uri: `${prov}://track/${nid()}`, name, version, image: art(alb), favorite: fav, explicit: null,
    artists: [nestedArtist(by, prov)], album: short('album', `${prov}://album/${h(alb) % 90000}`, alb, art(alb)), _duration: dur, _added: h(name + by) % 1000, _played: h(by + name) % 1000 };
}
const playlist = (name, prov = 'library', fav = false) => ({ media_type: 'playlist', uri: `${prov}://playlist/${nid()}`, name, version: '', image: art(name), favorite: fav, explicit: null, _added: h(name) % 1000 });
const uuid = (s) => { const x = [0, 1, 2, 3].map((i) => h(s + i).toString(16).padStart(8, '0')).join(''); return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`; };
// Radio Browser station as MA returns it: tab/space-padded name, https logo or null
const radio = (name, logo, played = 0) => ({ media_type: 'radio', uri: `radiobrowser://radio/${uuid(name)}`, name, version: '',
  image: logo === undefined ? `https://logos.radio.example/${h(name).toString(36)}.png` : logo, favorite: false, explicit: null, _added: h(name) % 1000, _played: played, _plays: played });
const STATIONS = () => [
  ...realRadio.map((x, i) => ({ ...x, _added: 900 - i, _played: 50 - i, _plays: 50 - i })),
  radio('\tRadio Paradise - Main Mix', undefined, 80), radio(' \tJazz FM', undefined, 30), radio('Magic Radio\t', null, 12),
  radio('\t\tKEXP 90.3 FM', undefined, 64), radio('BBC Radio 6 Music', undefined, 71), radio('\tSomaFM Groove Salad', undefined, 44),
  radio('FIP Radio', null, 9), radio('\tAbsolute Classic Rock', undefined, 22), radio('NTS Radio 1 ', undefined, 5),
];

const CATALOG = {
  artists: [
    artist('The Mock Ups', 'library', true), artist('Mockingbird Trio', 'apple_music'), artist('Mocktail Lounge'), artist('DJ Mockery'),
    artist('Miles Davis', 'library', true), artist('Moby', 'apple_music'), artist('Muse'), artist('Massive Attack', 'library', true), artist('Mumford & Sons', 'apple_music'),
    artist('Madonna'), artist('Metallica'), artist('Eagles', 'library', true), artist('Fleetwood Mac'), artist('Abba', 'apple_music'), artist('Adele'),
    artist('Bob Marley & The Wailers'), artist('Coldplay', 'apple_music'), artist('Daft Punk', 'library', true), artist('Norah Jones'), artist('Air'), artist('The Beatles', 'library', true),
    // "chicago": the band (library + the same artist on Apple Music), plus look-alikes that must not show up as its albums
    artist('Chicago', 'library', true), artist('Chicago Symphony Orchestra', 'apple_music'),
    // the same band from Apple Music, without artwork (not registered in A: nested artists of library items keep the library uri)
    { media_type: 'artist', uri: 'apple_music://artist/Chicago', name: 'Chicago', version: '', image: null, favorite: false, explicit: null, fanart_image: null, _added: 11 },
  ],
  albums: [
    album('Mock Turtle Soup', 'The Mock Ups', 'library', true), album('Mocking the Blues', 'Mockingbird Trio', 'apple_music'),
    album('Mockumentary OST', 'Various Artists', 'apple_music'), album('Mock Sessions Vol. 2', 'Lorem Funk'),
    album('Kind of Blue', 'Miles Davis', 'library', true), album('Mezzanine', 'Massive Attack'), album('Moon Safari', 'Air', 'library', true),
    album('Hotel California', 'Eagles', 'library', true), album('Rumours', 'Fleetwood Mac'), album('Abbey Road', 'The Beatles', 'apple_music'),
    album('Come Away with Me', 'Norah Jones'), album('Random Access Memories', 'Daft Punk', 'library', true), album('Their Greatest Hits 1971-1975', 'Eagles', 'apple_music'),
    album('Discovery', 'Daft Punk'), album('Play', 'Moby'), album('The 2nd Law', 'Muse'), album('21', 'Adele'), album('Arrival', 'Abba', 'apple_music'),
    album('Exodus', 'Bob Marley & The Wailers'), album('Parachutes', 'Coldplay', 'apple_music'), album('Master of Puppets', 'Metallica'), album('Like a Prayer', 'Madonna'),
    album('Sigh No More', 'Mumford & Sons'), album('Tusk', 'Fleetwood Mac'),
    album('Chicago Transit Authority', 'Chicago', 'library', true), album('Chicago X', 'Chicago'), album('Chicago 17', 'Chicago', 'apple_music'),
    album('Chicago X', 'Chicago', 'apple_music'), // same album on another provider: shown once
    album('Chicago (Original Broadway Cast)', 'Original Broadway Cast', 'apple_music'), album('Mahler: Symphony No. 5', 'Chicago Symphony Orchestra', 'apple_music'),
  ],
  tracks: [
    track('Mockingbird Lane', 'The Mock Ups', 'Mock Turtle Soup', 221), track('Mock Sunrise', 'Placeholder Band', 'Ipsum', 242, 'apple_music'),
    track("Don't Mock the Groove", 'Lorem Funk', 'Mock Sessions Vol. 2', 195), track('Mockingjay Blues', 'Mockingbird Trio', 'Mocking the Blues', 288, 'apple_music'),
    track('Mocktail Hour', 'Mocktail Lounge', 'Happy Hour', 204), track('Mock Turtle', 'The Mock Ups', 'Mock Turtle Soup', 176, 'library', 'Remastered 2024'),
    track('Mockery', 'DJ Mockery', 'Mockery EP', 312), track('So What', 'Miles Davis', 'Kind of Blue', 562, 'library', '', true), track('Freddie Freeloader', 'Miles Davis', 'Kind of Blue', 589),
    track('Blue in Green', 'Miles Davis', 'Kind of Blue', 337), track('All Blues', 'Miles Davis', 'Kind of Blue', 693), track('Teardrop', 'Massive Attack', 'Mezzanine', 330, 'library', '', true),
    track('Angel', 'Massive Attack', 'Mezzanine', 379), track('Porcelain', 'Moby', 'Play', 241, 'apple_music'), track('Madness', 'Muse', 'The 2nd Law', 281),
    track('Hotel California', 'Eagles', 'Hotel California', 391, 'library', '', true), track('New Kid in Town', 'Eagles', 'Hotel California', 304), track('Life in the Fast Lane', 'Eagles', 'Hotel California', 286),
    track('The Last Resort', 'Eagles', 'Hotel California', 445), track('Take It Easy', 'Eagles', 'Their Greatest Hits 1971-1975', 211, 'apple_music'),
    track('Dreams', 'Fleetwood Mac', 'Rumours', 257, 'library', '', true), track('Go Your Own Way', 'Fleetwood Mac', 'Rumours', 218), track('The Chain', 'Fleetwood Mac', 'Rumours', 270),
    track('Come Together', 'The Beatles', 'Abbey Road', 259, 'apple_music'), track('Here Comes the Sun', 'The Beatles', 'Abbey Road', 185, 'apple_music'),
    track("Don't Know Why", 'Norah Jones', 'Come Away with Me', 186), track('Get Lucky', 'Daft Punk', 'Random Access Memories', 369, 'library', '', true),
    track('Instant Crush', 'Daft Punk', 'Random Access Memories', 337), track('One More Time', 'Daft Punk', 'Discovery', 320), track('La Femme d\'Argent', 'Air', 'Moon Safari', 429),
    track('Sexy Boy', 'Air', 'Moon Safari', 298), track('Mo Money Mo Problems', 'The Notorious B.I.G.', 'Life After Death', 257, 'apple_music'), track('Moondance', 'Van Morrison', 'Moondance', 274, 'apple_music'),
    track('Rolling in the Deep', 'Adele', '21', 228), track('Dancing Queen', 'Abba', 'Arrival', 231, 'apple_music'), track('Three Little Birds', 'Bob Marley & The Wailers', 'Exodus', 180),
    track('Yellow', 'Coldplay', 'Parachutes', 269, 'apple_music'), track('Like a Prayer', 'Madonna', 'Like a Prayer', 340), track('Little Lion Man', 'Mumford & Sons', 'Sigh No More', 245),
    track('25 or 6 to 4', 'Chicago', 'Chicago Transit Authority', 290), track('Beginnings', 'Chicago', 'Chicago Transit Authority', 474), track('Questions 67 and 68', 'Chicago', 'Chicago Transit Authority', 303),
    track('If You Leave Me Now', 'Chicago', 'Chicago X', 236, 'library', '', true), track('Another Rainy Day in New York City', 'Chicago', 'Chicago X', 180),
    track("Hard to Say I'm Sorry", 'Chicago', 'Chicago 17', 302, 'apple_music'), track("You're the Inspiration", 'Chicago', 'Chicago 17', 228, 'apple_music'),
    track('All That Jazz', 'Original Broadway Cast', 'Chicago (Original Broadway Cast)', 362, 'apple_music'), track('Chicago', 'Frank Sinatra', 'Sinatra Sings', 133, 'apple_music'),
  ],
  playlists: [
    playlist('Mock Rock Essentials', 'library', true), playlist('Mockingbird Jazz Club', 'apple_music'), playlist('Monday Morning Mix'),
    playlist('Motown Classics', 'apple_music'), playlist('Eagles'), playlist('Long Drive'), playlist('Mellow Moods', 'library', true), playlist('Dinner Party'), playlist('Garage Workout', 'apple_music'),
    playlist('Chicago Blues Classics', 'apple_music'),
  ],
  radio: RADIO ? [...STATIONS(), radio('\tWXRT Chicago 93.1 FM', undefined, 3)] : [],
  podcasts: PODS ? [{ media_type: 'podcast', uri: 'library://podcast/31', name: 'The Mockcast', version: '', image: art('The Mockcast'), favorite: false, explicit: null, _added: 5 },
    { media_type: 'podcast', uri: 'library://podcast/32', name: 'Chicago Stories', version: '', image: null, favorite: false, explicit: null, _added: 6 }] : [],
  audiobooks: PODS ? [{ media_type: 'audiobook', uri: 'library://audiobook/7', name: 'The Mock Chronicles', version: '', image: art('Mock Chronicles'), favorite: false, explicit: null,
    authors: ['A. N. Author'], _added: 4 }] : [],
};
// the real export's ids, so drill-down into "Hotel California" serves the real mass_queue response (9 tracks with durations)
CATALOG.albums.find((x) => x.name === 'Hotel California').uri = 'library://album/1448';
const KEYS = ['artists', 'albums', 'tracks', 'playlists', 'radio', 'audiobooks', 'podcasts'];
const TYPE2KEY = { artist: 'artists', album: 'albums', track: 'tracks', playlist: 'playlists', radio: 'radio', audiobook: 'audiobooks', podcast: 'podcasts' };
const pub = (it) => JSON.parse(JSON.stringify(it, (k, v) => (k.startsWith('_') ? undefined : v)));
const allItems = () => KEYS.flatMap((k) => CATALOG[k]);
const libUri = (it) => (it.uri.startsWith('library://') ? it.uri : (it._lib ??= `library://${it.media_type}/${nid()}`));
const libView = (it) => (it.uri.startsWith('library://') ? it : { ...it, uri: libUri(it), favorite: it.favorite,
  artists: it.artists?.map((a) => ({ ...a, uri: A[a.name] ? libUri(A[a.name]) : a.uri })) });
const byUri = (uri) => allItems().find((i) => i.uri === uri || i._lib === uri);

function search(name, limit, types, by = '') {
  const q = name.trim().toLowerCase();
  const byOk = (it) => !by || (it.artists ?? []).some((a) => a.name.toLowerCase() === by.toLowerCase()) || it.name.toLowerCase() === by.toLowerCase();
  // MA's Radio Browser search also matches tags/genre, so "radio" or "rock" finds stations without it in the name
  const hay = (it) => [it.name, ...(it.artists ?? []).map((a) => a.name), it.album?.name ?? '', it.media_type === 'radio' ? 'radio rock fm' : ''].join(' ').toLowerCase();
  const score = (it) => (it.name.trim().toLowerCase().startsWith(q) ? 0 : it.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) ? 1 : 2);
  const want = new Set((types ?? Object.keys(TYPE2KEY)).map((t) => TYPE2KEY[t]));
  const out = {};
  for (const key of KEYS) out[key] = want.has(key) ? CATALOG[key].filter((it) => hay(it).includes(q) && byOk(it)).sort((a, b) => score(a) - score(b)).slice(0, limit).map(pub) : [];
  return out;
}
function library({ media_type, favorite, search: s, limit = 25, offset = 0, order_by = 'name' }) {
  const key = TYPE2KEY[media_type];
  if (!key) throw new Error(`invalid media_type ${media_type}`);
  // Everything in the mock catalog is "in the library"; MA reports library items with library:// uris.
  let items = EMPTY || (key === 'radio' && !RADIO_LIB) ? [] : CATALOG[key].map(libView);
  if (favorite) items = items.filter((i) => i.favorite);
  if (s) items = items.filter((i) => i.name.toLowerCase().includes(String(s).toLowerCase()));
  const cmp = {
    name: (a, b) => a.name.localeCompare(b.name), name_desc: (a, b) => b.name.localeCompare(a.name),
    sort_name: (a, b) => a.name.replace(/^the /i, '').localeCompare(b.name.replace(/^the /i, '')),
    timestamp_added_desc: (a, b) => b._added - a._added, timestamp_added: (a, b) => a._added - b._added,
    last_played_desc: (a, b) => (b._played ?? b._added) - (a._played ?? a._added),
    play_count_desc: (a, b) => (b._plays ?? 0) - (a._plays ?? 0) || a.name.localeCompare(b.name),
    play_count: (a, b) => (a._plays ?? 0) - (b._plays ?? 0) || a.name.localeCompare(b.name),
  }[order_by] ?? ((a, b) => a.name.localeCompare(b.name));
  items = [...items].sort(cmp);
  return { items: items.slice(offset, offset + Math.min(500, limit)).map(pub), limit, offset, order_by, media_type };
}

// ---- player state ----
const EVERY = 'media_player.everywhere';
const ROOMS = { 'media_player.living_room': ['Living Room Speaker', 0.45], 'media_player.kitchen': ['Kitchen Speaker', 0.62], 'media_player.garage': ['Garage Speaker', 0.3] };
let qn = 0;
const qItem = (t) => ({ queue_item_id: `${(++qn).toString(16).padStart(4, '0')}a7c1e0b84d2f9e${qn}`, _t: t });
const libTracks = CATALOG.tracks;
const startList = ['So What', 'Teardrop', 'Dreams', 'Get Lucky', 'Hotel California', 'La Femme d\'Argent', 'Come Together', 'Instant Crush', 'The Chain', 'Angel', 'Porcelain', 'Rolling in the Deep', 'Yellow', 'Three Little Birds'];
export const Q = (window.__queue = {
  items: params.get('idle') === '1' ? [] : [libTracks.find((t) => t.name === 'Mockingbird Lane'), ...startList.map((n) => libTracks.find((t) => t.name === n))].map(qItem),
  index: params.get('idle') === '1' ? -1 : 1,
});
/** one queue per MA group entity (Everywhere's is Q / window.__queue; mock-ma adds Indoor and Outdoor) */
const QS = (window.__queues = { 'media_player.everywhere': Q });
const qOf = (id) => QS[id];
const qPub = (q) => ({ queue_item_id: q.queue_item_id, media_title: q._t.name, media_album_name: q._t.album?.name ?? '', media_artist: (q._t.artists ?? []).map((a) => a.name).join(', '),
  media_content_id: q._t.uri, media_image: q._t.image, favorite: !!q._t.favorite });

const states = {};
const st = (id) => states[id];
let afterGroupState = null; // set once the MA mock exists: re-derives a group entity's attributes (live active_queue) after a state change
function setState(id, state, attrs) {
  const old = states[id];
  states[id] = { entity_id: id, state: state ?? old.state, attributes: { ...(old?.attributes ?? {}), ...(attrs ?? {}) }, last_changed: new Date().toISOString(), last_updated: new Date().toISOString(), context: { id: 'mock' } };
  if (state && old && state !== old.state && afterGroupState) afterGroupState(id);
}
function syncNowPlaying(resetPos = true, EVERY = 'media_player.everywhere') {
  const Q = qOf(EVERY);
  const cur = Q.items[Q.index];
  const e = st(EVERY);
  if (!cur) { setState(EVERY, 'idle', { media_title: undefined, media_artist: undefined, media_album_name: undefined, media_content_id: undefined, entity_picture: undefined, entity_picture_local: undefined, media_duration: undefined, media_position: undefined }); return; }
  const t = cur._t;
  // Like HA + MA: entity_picture is the MA server's absolute image URL (LAN http, blocked/unreachable on the kiosk),
  // entity_picture_local goes through HA's media_player_proxy (here: dev/api/media_player_proxy/ fetch interception).
  const tag = h(t.uri).toString(16);
  setState(EVERY, e?.state === 'idle' || !e ? 'playing' : e.state, {
    media_title: t.name, media_artist: (t.artists ?? []).map((a) => a.name).join(', '), media_album_name: t.album?.name, media_content_id: t.uri, media_content_type: 'music',
    entity_picture: `http://192.168.0.10:8095/imageproxy?path=${tag}&size=512`,
    entity_picture_local: NOART ? undefined : `/api/media_player_proxy/${EVERY}?token=mock&cache=${tag}`,
    media_content_type: t.media_type === 'radio' ? 'radio' : 'music', media_duration: t._duration ?? null,
    ...(resetPos ? { media_position: 0, media_position_updated_at: new Date().toISOString() } : {}),
  });
}
setState(EVERY, params.get('idle') === '1' ? 'idle' : params.get('paused') === '1' ? 'paused' : 'playing', {
  friendly_name: 'Everywhere', group_members: Object.keys(ROOMS), app_id: 'music_assistant', active_queue: 'syncgroup_everywhere',
  volume_level: 0.55, is_volume_muted: false, shuffle: false, repeat: 'off', supported_features: 4127295, mass_player_type: 'group', mass_player_id: null,
});
syncNowPlaying();
if (st(EVERY).state !== 'idle') setState(EVERY, null, { media_position: 128, media_position_updated_at: new Date(Date.now() - 2000).toISOString() });
for (const [id, [name, v]] of Object.entries(ROOMS))
  setState(id, st(EVERY).state === 'idle' ? 'idle' : 'playing', { friendly_name: name, volume_level: v, is_volume_muted: false, source: 'Music Assistant', supported_features: 152463, mass_player_id: null });
setState('button.everywhere_favorite_current_song', 'unknown', { friendly_name: 'Everywhere Favorite current song' });
const ma = createMa({ params, st, setState, commit: () => commit(), sleep, QS, syncNowPlaying, EVERY, libTracks, qItem });
afterGroupState = (id) => ma.groupStateChanged(id);

const listeners = new Set();
export const onHass = (fn) => listeners.add(fn);
function commit() { hass = makeHass(); window.__hass = hass; listeners.forEach((f) => f(hass)); }

function delayFor(name) {
  let ms = mock.latency;
  if (mock.mode === 'inverse') ms = mock.latency * Math.max(1, 6 - name.trim().length);
  return ms + (mock.jitter ? Math.random() * mock.jitter : 0);
}
const ids = (target) => [target?.entity_id].flat().filter(Boolean);
const posNow = (a, s) => (a.media_position ?? 0) + (s === 'playing' && a.media_position_updated_at ? (Date.now() - Date.parse(a.media_position_updated_at)) / 1000 : 0);
// 120 unique tracks, for playlist paging
const LONG_DRIVE = Array.from({ length: 120 }, (_, i) => track(`Highway Song ${String(i + 1).padStart(3, '0')}`, ['Eagles', 'Fleetwood Mac', 'Daft Punk', 'Air'][i % 4], 'Long Drive Sessions', 150 + ((i * 37) % 200)));
const tracksFor = (it) => {
  if (!it) return [];
  if (it.media_type === 'track') return [it];
  if (it.media_type === 'album') return libTracks.filter((t) => t.album?.name === it.name);
  if (it.media_type === 'artist') return libTracks.filter((t) => t.artists.some((a) => a.name === it.name));
  if (it.media_type === 'playlist' && it.name === 'Long Drive') return LONG_DRIVE;
  if (it.media_type === 'playlist') return libTracks.filter((_, i) => (h(it.name) + i) % 4 === 0).slice(0, 12);
  if (it.media_type === 'radio') return [it];
  return [];
};

async function callService(domain, service, data = {}, target, notifyOnError, returnResponse) {
  const call = { t: Math.round(performance.now()), domain, service, data: structuredClone(data), target: target ? structuredClone(target) : undefined, returnResponse: !!returnResponse };
  // read-only lyrics fetches go to their own log so the user-action log (__calls) stays exactly as before 0.4.0
  const lyr = domain === 'mass_queue' && service === 'send_command';
  const maCmd = lyr && /^(players|player_queues|config\/players)\//.test(String(data.command ?? ''));
  if (!maCmd) (lyr ? window.__lyricsLog : window.__calls).push(call);
  const ctx = { id: 'mock-' + (window.__calls.length + window.__lyricsLog.length) };
  const needResp = () => { if (!returnResponse) throw new Error(`${domain}.${service} needs return_response`); };
  if (domain === 'music_assistant' && service === 'search') {
    needResp();
    if (!data.config_entry_id) throw new Error('config_entry_id missing');
    const ms = delayFor(data.name ?? '');
    await sleep(ms);
    if (mock.fail) throw new Error('mock failure');
    const response = realSample ? structuredClone(realSample) : search(data.name ?? '', data.limit ?? 5, data.media_type, data.artist ?? '');
    call.ms = Math.round(ms); call.replyAt = Math.round(performance.now());
    return { context: ctx, response };
  }
  if (domain === 'mass_queue' && service === 'send_command') {
    needResp();
    await sleep(LYRLAT);
    if (LYRFAIL === 'perm') throw Object.assign(new Error('Unauthorized'), { code: 'unauthorized' });
    if (LYRFAIL === 'err') throw new Error('mass_queue.send_command: provider unavailable');
    if (data.config_entry_id !== MQ_ENTRY) throw new Error(`Config entry ${data.config_entry_id} not found`);
    if (maCmd) return { context: ctx, response: { response: await ma.command(data.command, data.data ?? {}) } };
    return { context: ctx, response: { response: sendCommand(data.command, data.data ?? {}) } };
  }
  const slow = domain === 'mass_queue' && MQSLOW && String(data.uri ?? '').toLowerCase().includes(MQSLOW) || (domain === 'mass_queue' && MQSLOW && (byUri(data.uri)?.name ?? '').toLowerCase().includes(MQSLOW));
  await sleep(slow ? 900 : domain === 'mass_queue' && MQLAT ? Number(MQLAT) : 30 + Math.random() * 30);
  if (domain === 'music_assistant' && service === 'get_library') {
    needResp();
    if (!data.config_entry_id) throw new Error('config_entry_id missing');
    return { context: ctx, response: library(data) };
  }
  if (domain === 'music_assistant' && service === 'get_queue') {
    needResp();
    if (mock.failQueue) throw new Error('queue unavailable');
    const id = ids(target)[0];
    if (!qOf(id)) throw new Error(`${id} is not a Music Assistant player`);
    const Q = qOf(id), E = st(id);
    const cur = Q.items[Q.index];
    return { context: ctx, response: { [id]: { queue_id: E.attributes.active_queue, active: true, name: E.attributes.friendly_name, items: Q.items.length, shuffle_enabled: !!E.attributes.shuffle,
      repeat_mode: E.attributes.repeat, current_index: Q.index < 0 ? null : Q.index, elapsed_time: Math.round(posNow(E.attributes, E.state)),
      current_item: cur ? { queue_item_id: cur.queue_item_id, name: cur._t.name, duration: cur._t._duration, media_item: pub(cur._t) } : null,
      next_item: Q.items[Q.index + 1] ? { queue_item_id: Q.items[Q.index + 1].queue_item_id, name: Q.items[Q.index + 1]._t.name } : null } } };
  }
  if (domain === 'music_assistant' && service === 'play_media') {
    const id = ids(target);
    if (id.length !== 1 || !qOf(id[0])) throw new Error(`play_media: ${id.join(',')} is not a Music Assistant player (only ${Object.keys(QS).join(', ')})`);
    const EVERY = id[0], Q = qOf(EVERY);
    if (!['play', 'replace', 'next', 'replace_next', 'add', undefined].includes(data.enqueue)) throw new Error('invalid enqueue');
    // HA's MA schema: media_type is optional, one of these (MA infers the type from a full uri when it is omitted)
    if (!['artist', 'album', 'audiobook', 'folder', 'playlist', 'podcast', 'track', 'radio', undefined].includes(data.media_type)) throw new Error(`invalid media_type ${data.media_type}`);
    if (data.radio_mode !== undefined && typeof data.radio_mode !== 'boolean') throw new Error('radio_mode must be a boolean');
    await sleep(Number(params.get('playlat') ?? 20)); // a real MA takes a moment to answer play_media
    const uris = [data.media_id].flat();
    let add = uris.flatMap((u) => tracksFor(byUri(u) ?? (realSample ? null : null)));
    if (!add.length) add = [libTracks[h(uris[0]) % libTracks.length]];
    if (data.radio_mode && (data.media_type === 'radio' || uris.some((u) => /:\/\/radio\//.test(u)))) throw new Error('radio_mode is not supported for radio stations');
    if (data.radio_mode) add = [...add, ...libTracks.filter((t) => !add.includes(t)).slice(0, 8)];
    const items = add.map(qItem);
    const at = Q.index + 1;
    if (['play', 'replace', undefined].includes(data.enqueue) && ma.willPlay(EVERY)) ma.afterHa();
    switch (data.enqueue ?? 'play') {
      case 'play': Q.items.splice(at, 0, ...items); Q.index = at; syncNowPlaying(true, EVERY); setState(EVERY, 'playing'); break;
      case 'replace': Q.items = items; Q.index = 0; syncNowPlaying(true, EVERY); setState(EVERY, 'playing'); break;
      case 'next': Q.items.splice(at, 0, ...items); break;
      case 'replace_next': Q.items.splice(at, Q.items.length, ...items); break;
      case 'add': Q.items.push(...items); break;
    }
    commit();
    return { context: ctx };
  }
  if (domain === 'media_player' && (service === 'join' || service === 'unjoin'))
    throw new Error(`media_player.${service}: HA group member ids don't match Music Assistant's speakers; use players/cmd/set_members`);
  if (domain === 'media_player') {
    const tg = ids(target);
    if (!tg.length) throw new Error('no target');
    for (const id of tg) {
      const e = st(id); if (!e) throw new Error(`unknown entity ${id}`);
      const a = e.attributes;
      switch (service) {
        case 'volume_set': setState(id, null, { volume_level: Math.max(0, Math.min(1, +data.volume_level)) }); break;
        case 'volume_mute': setState(id, null, { is_volume_muted: !!data.is_volume_muted }); break;
        case 'media_play': if (ma.willPlay(id)) ma.afterHa(); setState(id, 'playing', { media_position: posNow(a, e.state), media_position_updated_at: new Date().toISOString() }); break;
        case 'media_pause': setState(id, 'paused', { media_position: posNow(a, e.state), media_position_updated_at: new Date().toISOString() }); break;
        case 'media_play_pause': setState(id, e.state === 'playing' ? 'paused' : 'playing'); break;
        case 'media_next_track': { const Q = qOf(id); if (Q && Q.index < Q.items.length - 1) { Q.index++; syncNowPlaying(true, id); } break; }
        case 'media_previous_track': { const Q = qOf(id); if (Q) { if (posNow(a, e.state) < 3 && Q.index > 0) Q.index--; syncNowPlaying(true, id); } break; }
        case 'media_seek': setState(id, null, { media_position: +data.seek_position, media_position_updated_at: new Date().toISOString() }); break;
        case 'shuffle_set': setState(id, null, { shuffle: !!data.shuffle }); break;
        case 'repeat_set': if (!['off', 'all', 'one'].includes(data.repeat)) throw new Error('bad repeat'); setState(id, null, { repeat: data.repeat }); break;
        default: throw new Error(`mock-hass: unhandled media_player.${service}`);
      }
    }
    commit();
    return { context: ctx };
  }
  if (domain === 'button' && service === 'press') {
    const id = ids(target)[0];
    if (!st(id)) throw new Error(`unknown entity ${id}`);
    const cur = Q.items[Q.index]; if (cur) cur._t.favorite = true;
    setState(id, new Date().toISOString());
    commit();
    return { context: ctx };
  }
  if (domain === 'mass_queue') {
    if (mock.failQueue) throw new Error('queue unavailable');
    if (MQFAIL && service === MQFAIL) throw new Error(`mass_queue.${service}: provider unavailable`);
    if (service === 'get_podcast_episodes') {
      needResp();
      if (!data.config_entry_id || !data.uri) throw new Error('config_entry_id and uri required');
      const pod = byUri(data.uri);
      if (!pod || pod.media_type !== 'podcast') throw new Error(`URI ${data.uri} returned no results!`);
      const n = pod.name === 'The Mockcast' ? 6 : 3;
      return { context: ctx, response: { episodes: Array.from({ length: n }, (_, i) => ({ media_title: `${pod.name} #${n - i}`, media_content_id: `library://podcast_episode/${h(pod.uri) % 900 + i}`,
        duration: 1800 + i * 60, media_image: '', favorite: false, release_date: new Date(Date.UTC(2026, 9, 28 - i * 7)).toISOString() })) } };
    }
    if (service.startsWith('get_') && service.endsWith('_tracks')) {
      needResp();
      if (!data.config_entry_id || !data.uri) throw new Error('config_entry_id and uri required');
      // mass_queue looks the item up first (get_*_details): an unknown uri is an error, not an empty list
      if (!byUri(data.uri) && !realTracks[data.uri]) throw new Error(`URI ${data.uri} returned no results!`);
      if (data.page !== undefined && (!Number.isInteger(data.page) || data.page < 0 || data.page > 1000)) throw new Error('page must be 0..1000');
      const it = byUri(data.uri);
      const pl = service === 'get_playlist_tracks';
      let all = realTracks[data.uri] ? structuredClone(realTracks[data.uri])
        : tracksFor(it).map((t) => ({ media_title: t.name, media_content_id: t.uri, duration: t._duration ?? 0,
          media_image: t.image ?? '', favorite: !!t.favorite, media_album_name: t.album?.name ?? '', media_artist: (t.artists ?? []).map((a) => a.name).join(', '),
          ...(pl ? { position: null } : {}) }));
      // mass_queue: `if not page` -> every track; otherwise MA's page
      if (pl && data.page !== undefined && MQPAGE !== 'ignore' && (data.page || MQPAGE === 'paged')) all = all.slice(data.page * MQ_PAGE_SIZE, (data.page + 1) * MQ_PAGE_SIZE);
      return { context: ctx, response: { tracks: all } };
    }
    const ent = data.entity;
    if (!qOf(ent)) throw new Error(`mass_queue: ${ent} is not a Music Assistant player`);
    const Q = qOf(ent);
    if (service === 'get_queue_items') {
      needResp();
      const lb = data.limit_before ?? 5, la = data.limit_after ?? 100;
      const from = Math.max(0, Q.index - lb);
      return { context: ctx, response: { [ent]: Q.items.slice(from, Math.max(0, Q.index) + la + 1).map(qPub) } };
    }
    if (service === 'unfavorite_current_item') { const cur = Q.items[Q.index]; if (cur) cur._t.favorite = false; commit(); return { context: ctx }; }
    const i = Q.items.findIndex((q) => q.queue_item_id === data.queue_item_id);
    if (i < 0) throw new Error(`queue item ${data.queue_item_id} not found`);
    const move = (to) => { const [x] = Q.items.splice(i, 1); Q.items.splice(to, 0, x); };
    // these mass_queue services call MA's move_item / delete_item: an item MA already buffered (after the playing one,
    // up to index_in_buffer) can't move (500 "<n> is already played/buffered") and isn't deleted (200, ignored)
    const bufEnd = Math.max(Q.index, typeof Q.buf === 'number' ? Q.buf : Q.index + (params.get('qbuf') === '1' ? 1 : 0));
    const buffered = i > Q.index && i <= bufEnd;
    if (buffered && /^move_queue_item_/.test(service)) throw new Error(`${i} is already played/buffered`);
    if (buffered && service === 'remove_queue_item') { commit(); return { context: ctx }; }
    switch (service) {
      case 'play_queue_item': Q.index = i; syncNowPlaying(true, ent); setState(ent, 'playing'); break;
      case 'move_queue_item_up': if (i > Q.index + 1) move(i - 1); break;
      case 'move_queue_item_down': if (i < Q.items.length - 1 && i > Q.index) move(i + 1); break;
      case 'move_queue_item_next': if (i !== Q.index) { const [x] = Q.items.splice(i, 1); if (i < Q.index) Q.index--; Q.items.splice(Q.index + 1, 0, x); } break;
      case 'remove_queue_item': if (i === Q.index) throw new Error('cannot remove the playing item'); Q.items.splice(i, 1); if (i < Q.index) Q.index--; break;
      default: throw new Error(`mock-hass: unhandled mass_queue.${service}`);
    }
    commit();
    return { context: ctx };
  }
  throw new Error(`mock-hass: unhandled ${domain}.${service}`);
}

// ---------------- lyrics (invented text only) ----------------
const MQ_ENTRY = '01MASSQUEUE0000000000000000';
const LYR = await fixture('ma-lyrics-sample.json').catch(() => ({ lines: ['La la la'] }));
const stamp = (t) => `[${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(2).padStart(5, '0')}]`;
/** invented synced lyrics spanning `dur` seconds: a line every `step` s from `start`, a blank break every 8th line */
function fakeLrc(dur, start = 6, step = 9) {
  const out = ['[ar:Placeholder]', '[ti:Placeholder]'];
  for (let t = start, i = 0; t < dur - 4; t += step, i++) out.push(`${stamp(t)}${i % 8 === 7 ? '' : LYR.lines[i % LYR.lines.length]}`);
  return out.join('\n');
}
const fakePlain = () => LYR.lines.slice(0, 12).join('\n') + '\n\n' + LYR.lines.slice(12).join('\n');
const LYRICS_TABLE = {
  'So What': { via: 'gtl', lrc: () => fakeLrc(562) },
  'Teardrop': { via: 'meta', lrc: () => fakeLrc(330, 4, 7) },
  'Dreams': { via: 'meta', plain: fakePlain },
};
window.__lyricsCalls = () => window.__lyricsLog;
/** sanitized MA item_by_uri shape: placeholder ids, provider apple_music--XXXXXXXX */
function maItem(t) {
  const lyr = LYRNONE ? undefined : LYRICS_TABLE[t.name];
  return { item_id: String(h(t.uri) % 100000), provider: 'library', name: t.name, version: t.version ?? '', duration: t._duration ?? 0, media_type: 'track', uri: t.uri,
    artists: (t.artists ?? []).map((a) => ({ ...a, item_id: String(h(a.name) % 9000), provider: 'library' })), album: t.album ?? null, favorite: !!t.favorite,
    provider_mappings: [{ item_id: 'XXXXXXXX', provider_domain: 'apple_music', provider_instance: 'apple_music--XXXXXXXX', available: true }],
    metadata: { lyrics: lyr?.via === 'meta' && lyr.plain ? lyr.plain() : null, lrc_lyrics: lyr?.via === 'meta' && lyr.lrc ? lyr.lrc() : null, images: null } };
}
function sendCommand(command, d) {
  switch (command) {
    case 'music/item_by_uri': {
      const t = byUri(d.uri) ?? [...libTracks, ...LONG_DRIVE].find((x) => x.uri === d.uri);
      if (!t) throw new Error(`MediaNotFoundError: ${d.uri}`);
      return maItem(t);
    }
    case 'metadata/get_track_lyrics': {
      if (!d.track || typeof d.track !== 'object') throw new Error('track required');
      const lyr = LYRNONE ? undefined : LYRICS_TABLE[d.track.name];
      if (!lyr) return [null, null];
      return [lyr.plain ? lyr.plain() : null, lyr.lrc ? lyr.lrc() : null];
    }
    case 'music/search': {
      const q = String(d.search_query ?? '').toLowerCase();
      const words = q.split(/\s+-\s+|\s+/).filter(Boolean);
      const tracks = libTracks.filter((t) => { const hay = `${t.name} ${(t.artists ?? []).map((a) => a.name).join(' ')}`.toLowerCase(); return words.every((w) => hay.includes(w)); })
        .slice(0, d.limit ?? 8).map(maItem);
      return { artists: [], albums: [], tracks, playlists: [], radio: [], audiobooks: [], podcasts: [] };
    }
    default: throw new Error(`mock-hass: unhandled send_command ${command}`);
  }
}
/** test hook: pretend a radio station (or anything else) is now playing artist/title */
window.__setNowPlaying = ({ artist = '', title = '', radio = true, uri, duration = null, position = 0 } = {}) => {
  setState(EVERY, 'playing', { media_title: title, media_artist: artist, media_album_name: radio ? 'Mock Radio FM' : '', media_content_id: uri ?? (radio ? 'library://radio/7' : undefined),
    media_content_type: radio ? 'radio' : 'music', media_duration: duration, media_position: position, media_position_updated_at: new Date().toISOString() });
  commit();
};

/** test hook: play a catalog track by name (non-radio, real uri/duration) */
window.__playTrack = (name, position = 60) => {
  const t = libTracks.find((x) => x.name === name);
  if (!t) throw new Error('no track ' + name);
  window.__setNowPlaying({ artist: (t.artists ?? []).map((a) => a.name).join(', '), title: t.name, radio: false, uri: t.uri, duration: t._duration ?? 0, position });
};

const USER = { ...(params.get('uid') ? { id: params.get('uid') } : {}), name: params.get('user') ?? 'Kiosk', is_admin: params.get('admin') === '1' };
function makeHass() {
  return { states: { ...states }, user: USER, locale: { language: 'en-US' }, language: 'en-US', callService };
}
export let hass = makeHass();
window.__hass = hass;
