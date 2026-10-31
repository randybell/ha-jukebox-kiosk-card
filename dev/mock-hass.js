// Mock `hass` for the jukebox-card dev harness. No network, no Home Assistant.
// Shapes follow the real exports in /workspace/ha-exports (HA 2026.10.4, MA 2.10.9, mass_queue 0.10.4):
//  - music_assistant.search -> {context, response:{artists, albums, tracks, playlists, radio, audiobooks, podcasts}} (always 7 lists)
//    items: {media_type, uri, name, version, image, favorite, explicit} (+artists[]/album{} on tracks, artists[] on albums).
//    No provider / duration / year / owner / metadata. Provider is the uri scheme (library://, apple_music://, apple_music--XXXXXXXX://).
//  - music_assistant.get_library -> {response:{items, limit, offset, order_by, media_type}}
//  - music_assistant.get_queue (entity) -> {response:{<entity_id>: {current_index, current_item{queue_item_id,...}, items:<count>, shuffle_enabled, repeat_mode}}}
//  - mass_queue.get_queue_items -> {response:{<entity_id>: [{queue_item_id, media_title, media_album_name, media_artist, media_content_id, media_image, favorite}]}}
// URL params: latency, jitter, mode=fixed|inverse, real=1 (search returns the real "eagles" sample), radio=1 (demo radio stations;
// default is the real situation: no radio provider, radio empty), idle=1 (nothing playing), empty=1 (empty library).

const params = new URLSearchParams(location.search);
export const mock = (window.__mock = {
  latency: Number(params.get('latency') ?? 120),
  jitter: Number(params.get('jitter') ?? 0),
  mode: params.get('mode') ?? 'fixed',
  fail: false,
  failQueue: params.get('qfail') === '1',
});
window.__calls = [];
const REAL = params.get('real') === '1';
const RADIO = params.get('radio') === '1';
const EMPTY = params.get('empty') === '1';
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
const radio = (name, prov = 'radiobrowser') => ({ media_type: 'radio', uri: `${prov}://radio/${nid()}`, name, version: '', image: art(name), favorite: false, explicit: null, _added: h(name) % 1000 });

const CATALOG = {
  artists: [
    artist('The Mock Ups', 'library', true), artist('Mockingbird Trio', 'apple_music'), artist('Mocktail Lounge'), artist('DJ Mockery'),
    artist('Miles Davis', 'library', true), artist('Moby', 'apple_music'), artist('Muse'), artist('Massive Attack', 'library', true), artist('Mumford & Sons', 'apple_music'),
    artist('Madonna'), artist('Metallica'), artist('Eagles', 'library', true), artist('Fleetwood Mac'), artist('Abba', 'apple_music'), artist('Adele'),
    artist('Bob Marley & The Wailers'), artist('Coldplay', 'apple_music'), artist('Daft Punk', 'library', true), artist('Norah Jones'), artist('Air'), artist('The Beatles', 'library', true),
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
  ],
  playlists: [
    playlist('Mock Rock Essentials', 'library', true), playlist('Mockingbird Jazz Club', 'apple_music'), playlist('Monday Morning Mix'),
    playlist('Motown Classics', 'apple_music'), playlist('Eagles'), playlist('Mellow Moods', 'library', true), playlist('Dinner Party'), playlist('Garage Workout', 'apple_music'),
  ],
  radio: RADIO ? [radio('Mock FM 99.9'), radio('Mockingbird Jazz Radio', 'tunein'), radio('Jazz FM', 'tunein'), radio('Magic Radio'), radio('Radio Paradise')] : [],
  podcasts: [],
  audiobooks: [],
};
const KEYS = ['artists', 'albums', 'tracks', 'playlists', 'radio', 'audiobooks', 'podcasts'];
const TYPE2KEY = { artist: 'artists', album: 'albums', track: 'tracks', playlist: 'playlists', radio: 'radio', audiobook: 'audiobooks', podcast: 'podcasts' };
const pub = (it) => JSON.parse(JSON.stringify(it, (k, v) => (k.startsWith('_') ? undefined : v)));
const allItems = () => KEYS.flatMap((k) => CATALOG[k]);
const libUri = (it) => (it.uri.startsWith('library://') ? it.uri : (it._lib ??= `library://${it.media_type}/${nid()}`));
const libView = (it) => (it.uri.startsWith('library://') ? it : { ...it, uri: libUri(it), favorite: it.favorite,
  artists: it.artists?.map((a) => ({ ...a, uri: A[a.name] ? libUri(A[a.name]) : a.uri })) });
const byUri = (uri) => allItems().find((i) => i.uri === uri || i._lib === uri);

function search(name, limit, types) {
  const q = name.trim().toLowerCase();
  const hay = (it) => [it.name, ...(it.artists ?? []).map((a) => a.name), it.album?.name ?? ''].join(' ').toLowerCase();
  const score = (it) => (it.name.toLowerCase().startsWith(q) ? 0 : it.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) ? 1 : 2);
  const want = new Set((types ?? Object.keys(TYPE2KEY)).map((t) => TYPE2KEY[t]));
  const out = {};
  for (const key of KEYS) out[key] = want.has(key) ? CATALOG[key].filter((it) => hay(it).includes(q)).sort((a, b) => score(a) - score(b)).slice(0, limit).map(pub) : [];
  return out;
}
function library({ media_type, favorite, search: s, limit = 25, offset = 0, order_by = 'name' }) {
  const key = TYPE2KEY[media_type];
  if (!key) throw new Error(`invalid media_type ${media_type}`);
  // Everything in the mock catalog is "in the library"; MA reports library items with library:// uris.
  let items = EMPTY ? [] : CATALOG[key].map(libView);
  if (favorite) items = items.filter((i) => i.favorite);
  if (s) items = items.filter((i) => i.name.toLowerCase().includes(String(s).toLowerCase()));
  const cmp = {
    name: (a, b) => a.name.localeCompare(b.name), name_desc: (a, b) => b.name.localeCompare(a.name),
    sort_name: (a, b) => a.name.replace(/^the /i, '').localeCompare(b.name.replace(/^the /i, '')),
    timestamp_added_desc: (a, b) => b._added - a._added, timestamp_added: (a, b) => a._added - b._added,
    last_played_desc: (a, b) => (b._played ?? b._added) - (a._played ?? a._added),
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
const qPub = (q) => ({ queue_item_id: q.queue_item_id, media_title: q._t.name, media_album_name: q._t.album?.name ?? '', media_artist: (q._t.artists ?? []).map((a) => a.name).join(', '),
  media_content_id: q._t.uri, media_image: q._t.image, favorite: !!q._t.favorite });

const states = {};
const st = (id) => states[id];
function setState(id, state, attrs) {
  const old = states[id];
  states[id] = { entity_id: id, state: state ?? old.state, attributes: { ...(old?.attributes ?? {}), ...(attrs ?? {}) }, last_changed: new Date().toISOString(), last_updated: new Date().toISOString(), context: { id: 'mock' } };
}
function syncNowPlaying(resetPos = true) {
  const cur = Q.items[Q.index];
  const e = st(EVERY);
  if (!cur) { setState(EVERY, 'idle', { media_title: undefined, media_artist: undefined, media_album_name: undefined, media_content_id: undefined, entity_picture: undefined, media_duration: undefined, media_position: undefined }); return; }
  const t = cur._t;
  setState(EVERY, e?.state === 'idle' || !e ? 'playing' : e.state, {
    media_title: t.name, media_artist: (t.artists ?? []).map((a) => a.name).join(', '), media_album_name: t.album?.name, media_content_id: t.uri, media_content_type: 'music',
    entity_picture: t.image, media_duration: t._duration ?? null,
    ...(resetPos ? { media_position: 0, media_position_updated_at: new Date().toISOString() } : {}),
  });
}
setState(EVERY, params.get('idle') === '1' ? 'idle' : params.get('paused') === '1' ? 'paused' : 'playing', {
  friendly_name: 'Everywhere', group_members: Object.keys(ROOMS), app_id: 'music_assistant', active_queue: 'syncgroup_everywhere',
  volume_level: 0.55, is_volume_muted: false, shuffle: false, repeat: 'off', supported_features: 4127295, mass_player_type: 'group',
});
syncNowPlaying();
if (st(EVERY).state !== 'idle') setState(EVERY, null, { media_position: 128, media_position_updated_at: new Date(Date.now() - 2000).toISOString() });
for (const [id, [name, v]] of Object.entries(ROOMS))
  setState(id, st(EVERY).state === 'idle' ? 'idle' : 'playing', { friendly_name: name, volume_level: v, is_volume_muted: false, source: 'Music Assistant', supported_features: 152463 });
setState('button.everywhere_favorite_current_song', 'unknown', { friendly_name: 'Everywhere Favorite current song' });

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
const tracksFor = (it) => {
  if (!it) return [];
  if (it.media_type === 'track') return [it];
  if (it.media_type === 'album') return libTracks.filter((t) => t.album?.name === it.name);
  if (it.media_type === 'artist') return libTracks.filter((t) => t.artists.some((a) => a.name === it.name));
  if (it.media_type === 'playlist') return libTracks.filter((_, i) => (h(it.name) + i) % 4 === 0).slice(0, 12);
  return [];
};

async function callService(domain, service, data = {}, target, notifyOnError, returnResponse) {
  const call = { t: Math.round(performance.now()), domain, service, data: structuredClone(data), target: target ? structuredClone(target) : undefined, returnResponse: !!returnResponse };
  window.__calls.push(call);
  const ctx = { id: 'mock-' + window.__calls.length };
  const needResp = () => { if (!returnResponse) throw new Error(`${domain}.${service} needs return_response`); };
  if (domain === 'music_assistant' && service === 'search') {
    needResp();
    if (!data.config_entry_id) throw new Error('config_entry_id missing');
    const ms = delayFor(data.name ?? '');
    await sleep(ms);
    if (mock.fail) throw new Error('mock failure');
    const response = realSample ? structuredClone(realSample) : search(data.name ?? '', data.limit ?? 5, data.media_type);
    call.ms = Math.round(ms); call.replyAt = Math.round(performance.now());
    return { context: ctx, response };
  }
  await sleep(30 + Math.random() * 30);
  if (domain === 'music_assistant' && service === 'get_library') {
    needResp();
    if (!data.config_entry_id) throw new Error('config_entry_id missing');
    return { context: ctx, response: library(data) };
  }
  if (domain === 'music_assistant' && service === 'get_queue') {
    needResp();
    if (mock.failQueue) throw new Error('queue unavailable');
    const id = ids(target)[0];
    if (id !== EVERY) throw new Error(`${id} is not a Music Assistant player`);
    const cur = Q.items[Q.index];
    return { context: ctx, response: { [id]: { queue_id: 'syncgroup_everywhere', active: true, name: 'Everywhere', items: Q.items.length, shuffle_enabled: !!st(EVERY).attributes.shuffle,
      repeat_mode: st(EVERY).attributes.repeat, current_index: Q.index < 0 ? null : Q.index, elapsed_time: Math.round(posNow(st(EVERY).attributes, st(EVERY).state)),
      current_item: cur ? { queue_item_id: cur.queue_item_id, name: cur._t.name, duration: cur._t._duration, media_item: pub(cur._t) } : null,
      next_item: Q.items[Q.index + 1] ? { queue_item_id: Q.items[Q.index + 1].queue_item_id, name: Q.items[Q.index + 1]._t.name } : null } } };
  }
  if (domain === 'music_assistant' && service === 'play_media') {
    const id = ids(target);
    if (id.length !== 1 || id[0] !== EVERY) throw new Error(`play_media: ${id.join(',')} is not a Music Assistant player (only ${EVERY})`);
    if (!['play', 'replace', 'next', 'replace_next', 'add', undefined].includes(data.enqueue)) throw new Error('invalid enqueue');
    const uris = [data.media_id].flat();
    let add = uris.flatMap((u) => tracksFor(byUri(u) ?? (realSample ? null : null)));
    if (!add.length) add = [libTracks[h(uris[0]) % libTracks.length]];
    if (data.radio_mode) add = [...add, ...libTracks.filter((t) => !add.includes(t)).slice(0, 8)];
    const items = add.map(qItem);
    const at = Q.index + 1;
    switch (data.enqueue ?? 'play') {
      case 'play': Q.items.splice(at, 0, ...items); Q.index = at; syncNowPlaying(); setState(EVERY, 'playing'); break;
      case 'replace': Q.items = items; Q.index = 0; syncNowPlaying(); setState(EVERY, 'playing'); break;
      case 'next': Q.items.splice(at, 0, ...items); break;
      case 'replace_next': Q.items.splice(at, Q.items.length, ...items); break;
      case 'add': Q.items.push(...items); break;
    }
    commit();
    return { context: ctx };
  }
  if (domain === 'media_player') {
    const tg = ids(target);
    if (!tg.length) throw new Error('no target');
    for (const id of tg) {
      const e = st(id); if (!e) throw new Error(`unknown entity ${id}`);
      const a = e.attributes;
      switch (service) {
        case 'volume_set': setState(id, null, { volume_level: Math.max(0, Math.min(1, +data.volume_level)) }); break;
        case 'volume_mute': setState(id, null, { is_volume_muted: !!data.is_volume_muted }); break;
        case 'media_play': setState(id, 'playing', { media_position: posNow(a, e.state), media_position_updated_at: new Date().toISOString() }); break;
        case 'media_pause': setState(id, 'paused', { media_position: posNow(a, e.state), media_position_updated_at: new Date().toISOString() }); break;
        case 'media_play_pause': setState(id, e.state === 'playing' ? 'paused' : 'playing'); break;
        case 'media_next_track': if (id === EVERY && Q.index < Q.items.length - 1) { Q.index++; syncNowPlaying(); } break;
        case 'media_previous_track': if (id === EVERY) { if (posNow(a, e.state) < 3 && Q.index > 0) Q.index--; syncNowPlaying(); } break;
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
    if (service.startsWith('get_') && service.endsWith('_tracks')) {
      needResp();
      if (!data.config_entry_id || !data.uri) throw new Error('config_entry_id and uri required');
      const it = byUri(data.uri);
      return { context: ctx, response: { tracks: tracksFor(it).map((t) => ({ ...qPub({ queue_item_id: '', _t: t }), duration: t._duration })).map(({ queue_item_id, ...r }) => r) } };
    }
    const ent = data.entity;
    if (ent !== EVERY) throw new Error(`mass_queue: ${ent} is not a Music Assistant player`);
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
    switch (service) {
      case 'play_queue_item': Q.index = i; syncNowPlaying(); setState(EVERY, 'playing'); break;
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

function makeHass() {
  return { states: { ...states }, user: { name: 'Kiosk', is_admin: false }, locale: { language: 'en-US' }, language: 'en-US', callService };
}
export let hass = makeHass();
window.__hass = hass;
