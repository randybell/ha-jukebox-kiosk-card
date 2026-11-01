// Unit checks for the lyrics core (src/lyrics/lrc.ts + store.ts), bundled on the fly with the project's rollup setup.
// Usage: node test/unit/lyrics.unit.mjs     (no browser, no network; all lyric text below is invented)
import { rollup } from 'rollup';
import typescript from '@rollup/plugin-typescript';
import resolve from '@rollup/plugin-node-resolve';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = new URL('../tmp/unit/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const bundle = await rollup({ input: ['src/lyrics/lrc.ts', 'src/lyrics/store.ts'], plugins: [resolve(), typescript({ tsconfig: './tsconfig.json', outDir: OUT, noEmitOnError: true })] });
await bundle.write({ dir: OUT, format: 'es', entryFileNames: '[name].mjs', chunkFileNames: '[name]-[hash].mjs' });
await bundle.close();

// minimal browser shims for store.ts (window.setTimeout, localStorage)
globalThis.window = globalThis;
const LS = new Map();
globalThis.localStorage = { getItem: (k) => (LS.has(k) ? LS.get(k) : null), setItem: (k, v) => LS.set(k, String(v)), removeItem: (k) => LS.delete(k), clear: () => LS.clear() };
const origWarn = console.warn; console.warn = () => {};

const lrc = await import(OUT + 'lrc.mjs');
const S = await import(OUT + 'store.mjs');

const results = [];
let failures = 0;
function check(name, ok, info = '') { results.push({ name, ok, info }); if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); }
const J = JSON.stringify;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// ---------------- LRC parser ----------------
{
  const src = ['[ar:Nobody]', '[ti:Placeholder Song]', '[length:03:00]', '[00:01.50]First made-up line', '[00:05.25][01:10.00]Repeated chorus line',
    '[00:09.123]Millisecond stamp', '[00:12:50]Colon fraction', '[00:15.00]', '[00:16.00]', '[00:20]No fraction <00:20.50>word <00:21.00>stamps', 'unstamped junk', '[00:30.00]'].join('\r\n');
  const L = lrc.parseLrc(src);
  check('L1 parseLrc drops ID tags/unstamped lines, keeps one entry per stamp, sorted', L.length === 8 && L[0].t === 1.5 && L[0].text === 'First made-up line' && L[7].t === 70 && L[7].text === 'Repeated chorus line', J(L));
  check('L2 fractions: .25 → 0.25, .123 → 0.123, :50 → 0.5, [mm:ss] → whole seconds', L[1].t === 5.25 && L[2].t === 9.123 && L[3].t === 12.5 && L[5].t === 20, J(L.map((l) => l.t)));
  check('L3 a blank stamped line is kept once (instrumental break), blank runs collapse, trailing blanks dropped', L[4].text === '' && L[4].t === 15 && L[5].text !== '' && L[L.length - 1].text !== '', J(L.map((l) => l.text)));
  check('L4 enhanced <mm:ss.xx> word stamps are stripped', L[5].text === 'No fraction word stamps', L[5].text);
  const O = lrc.parseLrc('[offset:+500]\n[00:10.00]Later line\n[00:00.20]Early line');
  check('L5 [offset:+500] shows lines 0.5 s sooner, never below 0', O[0].t === 0 && O[1].t === 9.5, J(O));
  const N = lrc.parseLrc('[offset:-1000]\n[00:10.00]x');
  check('L6 negative offset delays lines', N[0].t === 11, J(N));
  check('L7 parseLrc tolerates null/empty/non-LRC', lrc.parseLrc(null).length === 0 && lrc.parseLrc('').length === 0 && lrc.parseLrc('just words\nmore words').length === 0);
}
// ---------------- plain vs synced ----------------
{
  const plain = 'Line one of nothing\n\n\nLine two of nothing\r\n  spaced   out  \n\n';
  const P = lrc.parsePlain(plain);
  check('P1 parsePlain: one blank between stanzas, whitespace squashed, trailing blanks gone', J(P.map((l) => l.text)) === J(['Line one of nothing', '', 'Line two of nothing', 'spaced out']), J(P));
  const syncedInPlain = lrc.toLyrics('[00:01.00]Stamped text in the plain field', null);
  check('P2 toLyrics: LRC wins, even when it arrives in the plain field', syncedInPlain?.kind === 'synced' && syncedInPlain.lines[0].t === 1);
  const both = lrc.toLyrics('Plain words', '[00:02.00]Synced words');
  check('P3 toLyrics(plain, lrc) prefers synced', both?.kind === 'synced' && both.lines[0].text === 'Synced words');
  const onlyPlain = lrc.toLyrics('Plain words only', '');
  check('P4 toLyrics falls back to plain', onlyPlain?.kind === 'plain' && onlyPlain.lines.length === 1);
  check('P5 toLyrics(null, null) / blanks / tags-only LRC → null', lrc.toLyrics(null, null) === null && lrc.toLyrics('  \n ', '') === null && lrc.toLyrics(null, '[ar:x]\n[00:01.00]') === null);
}
// ---------------- current line from the interpolated position ----------------
{
  const lines = [{ t: 5, text: 'a' }, { t: 10, text: 'b' }, { t: 10, text: 'b2' }, { t: 20, text: '' }, { t: 30, text: 'c' }];
  check('C1 indexAt: -1 before the first line, last line with t <= pos, end of song → last', lrc.indexAt(lines, 4.99) === -1 && lrc.indexAt(lines, 5) === 0 && lrc.indexAt(lines, 9.9) === 0 && lrc.indexAt(lines, 10) === 2 && lrc.indexAt(lines, 25) === 3 && lrc.indexAt(lines, 999) === 4 && lrc.indexAt([], 3) === -1);
  const now = Date.parse('2026-01-01T00:00:10Z');
  const attrs = { media_position: 100, media_position_updated_at: '2026-01-01T00:00:00Z', media_duration: 300 };
  check('C2 positionOf interpolates while playing (100 s + 10 s elapsed)', lrc.positionOf(attrs, 'playing', now) === 110);
  check('C3 positionOf does not move while paused', lrc.positionOf(attrs, 'paused', now) === 100);
  check('C4 positionOf clamps to duration and ignores clock skew into the future', lrc.positionOf({ ...attrs, media_position: 295 }, 'playing', now) === 300 && lrc.positionOf(attrs, 'playing', Date.parse('2025-12-31T23:59:50Z')) === 100);
  const L = lrc.parseLrc('[00:05.00]a\n[00:09.00]b\n[00:13.00]c');
  check('C5 current line from position + 0.5 s default offset', lrc.indexAt(L, lrc.positionOf({ media_position: 8, media_position_updated_at: '2026-01-01T00:00:10Z' }, 'playing', now + 600) + 0.5) === 1);
}
// ---------------- keys and matching ----------------
{
  const ent = (attrs, state = 'playing') => ({ entity_id: 'media_player.x', state, attributes: attrs });
  const a = S.trackRef(ent({ media_title: 'Song', media_artist: 'Band', media_content_id: 'library://track/42', media_content_type: 'music', media_duration: 200 }));
  check('K1 trackRef keys a library track by uri', a?.key === 'u:library://track/42' && !a.radio && a.duration === 200, J(a));
  const r = S.trackRef(ent({ media_title: 'Some Band - Some Song (Remastered 2011)', media_content_id: 'library://radio/7', media_content_type: 'radio', media_duration: 0 }));
  check('K2 radio: "Artist - Title" split, keyed by normalised artist|title, never a uri lookup', r?.radio && !r.uri && r.artist === 'Some Band' && r.key === 'q:some band|some song', J(r));
  check('K3 trackRef: nothing when idle/off or no title', !S.trackRef(ent({ media_title: 'x' }, 'idle')) && !S.trackRef(ent({ media_artist: 'y' })));
  check('K4 normKey strips feat./remaster/accents/punctuation', S.normKey('Café Song (feat. Someone) - 2011 Remaster') === 'cafe song' && S.normKey('A & B') === 'a and b');
  const tracks = [{ name: 'Some Song (Live)', artists: [{ name: 'Some Band' }] }, { name: 'Some Song', artists: [{ name: 'Other Band' }] }, { name: 'Some Song', artists: [{ name: 'Some Band' }], uri: 'library://track/1' }];
  check('K5 bestMatch prefers exact title + artist; rejects wrong songs', S.bestMatch(tracks, 'Some Band', 'Some Song')?.uri === 'library://track/1' && S.bestMatch(tracks, 'Some Band', 'Different Song') === undefined && S.bestMatch(null, 'a', 'b') === undefined);
  check('K6 mqResult unwraps {context, response:{response:X}}, {response:X}, X — but not a payload that merely has a response key',
    J(S.mqResult({ context: {}, response: { response: [null, 'x'] } })) === J([null, 'x']) && J(S.mqResult({ response: { a: 1 } })) === J({ a: 1 }) && J(S.mqResult([1, 2])) === J([1, 2])
    && J(S.mqResult({ context: {}, response: { response: 'r', other: 1 } })) === J({ response: 'r', other: 1 }));
}
// ---------------- store: lookup, cache, dedupe, TTLs, errors ----------------
const ENTRY = '01MASSQUEUE0000000000000000';
const LRC = '[00:01.00]Invented line one\n[00:05.00]Invented line two';
function fakeHass(handler, latency = 5) {
  const calls = [];
  return { calls, user: { is_admin: false }, states: {}, callService: async (domain, service, data, target, notify, ret) => {
    calls.push({ domain, service, data, target, ret });
    await tick(latency);
    const res = await handler(data.command, data.data, data);
    return { context: { id: 'ctx' }, response: { response: res } };
  } };
}
const playing = (uri, title = 'Song', artist = 'Band', extra = {}) => ({ entity_id: 'media_player.x', state: 'playing', attributes: { media_title: title, media_artist: artist, media_content_id: uri, media_content_type: 'music', media_duration: 200, ...extra } });
const waitFor = async (fn, ms = 2000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await tick(5); } return true; };
const newStore = (hass) => { const s = new S.LyricsStore(); s.entryId = ENTRY; s.follow(hass, undefined); return s; };

{
  S.clearLyricsCache(); LS.clear();
  const item = (uri, md = {}) => ({ uri, name: 'Song', media_type: 'track', metadata: { lyrics: null, lrc_lyrics: null, ...md } });
  const hass = fakeHass((cmd, d) => {
    if (cmd === 'music/item_by_uri') return d.uri === 'library://track/1' ? item(d.uri) : d.uri === 'library://track/2' ? item(d.uri, { lrc_lyrics: LRC }) : item(d.uri);
    if (cmd === 'metadata/get_track_lyrics') return d.track.uri === 'library://track/1' ? ['plain fallback', LRC] : [null, null];
    throw new Error('unexpected ' + cmd);
  });
  const s = newStore(hass);
  const seen = [];
  s.subscribe((st) => seen.push(st.status));
  s.follow(hass, playing('library://track/1'));
  check('S1 lookup starts in loading', s.state.status === 'loading');
  await waitFor(() => s.state.status !== 'loading');
  const cmds = hass.calls.map((c) => c.data.command);
  check('S2 item_by_uri with empty metadata → get_track_lyrics(track:item) → synced', s.state.status === 'synced' && J(cmds) === J(['music/item_by_uri', 'metadata/get_track_lyrics']) && s.state.lines.length === 2, J(cmds));
  const c0 = hass.calls[0];
  check('S3 calls are mass_queue.send_command with return_response and config_entry_id = mass_queue entry', c0.domain === 'mass_queue' && c0.service === 'send_command' && c0.ret === true && c0.data.config_entry_id === ENTRY && J(c0.data.data) === J({ uri: 'library://track/1' }) && hass.calls[1].data.data.track.uri === 'library://track/1');
  check('S4 one status change per lookup (no spinner storm): idle → loading → synced', J(seen) === J(['idle', 'loading', 'synced']), J(seen));
  for (let i = 0; i < 5; i++) s.follow(hass, playing('library://track/1', 'Song', 'Band', { media_position: i * 10 }));
  check('S5 position-only hass updates do not look up again', hass.calls.length === 2 && seen.length === 3);

  s.follow(hass, playing('library://track/2'));
  await waitFor(() => s.state.status !== 'loading');
  check('S6 lyrics already in item metadata → no get_track_lyrics call', s.state.status === 'synced' && hass.calls.length === 3);

  s.follow(hass, playing('library://track/1'));
  check('S7 back to a cached track: synced immediately from memory, no call', s.state.status === 'synced' && s.state.via === 'cache' && hass.calls.length === 3);

  // localStorage survives a reload (memory cleared)
  const stored = JSON.parse(LS.get(S.LYRICS_LS_KEY));
  check('S8 localStorage entry {v:1, items} keyed by uri', stored.v === 1 && stored.items['u:library://track/1']?.[0] === 'synced', Object.keys(stored.items).join());
  const lsCopy = LS.get(S.LYRICS_LS_KEY);
  S.clearLyricsCache(); LS.set(S.LYRICS_LS_KEY, lsCopy);
  const before = S.LYRICS_STATS.lsHits;
  const s2 = newStore(hass);
  s2.follow(hass, playing('library://track/1'));
  check('S9 after a reload: served from localStorage without a call', s2.state.status === 'synced' && hass.calls.length === 3 && S.LYRICS_STATS.lsHits === before + 1);

  // dedupe: two cards, same new track, one request
  const s3 = newStore(hass), s4 = newStore(hass);
  s3.follow(hass, playing('library://track/9')); s4.follow(hass, playing('library://track/9'));
  await waitFor(() => s3.state.status !== 'loading' && s4.state.status !== 'loading');
  const n9 = hass.calls.filter((c) => c.data.data?.uri === 'library://track/9').length;
  check('S10 in-flight dedupe: two stores, same track → one item_by_uri, both get the result', n9 === 1 && s3.state.status === 'none' && s4.state.status === 'none', `item_by_uri calls=${n9}`);
  check('S11 [null,null] → "none"', s3.state.lines.length === 0);

  // negative TTL shorter than positive
  const items = JSON.parse(LS.get(S.LYRICS_LS_KEY)).items;
  check('S12 negative results cached in localStorage too', items['u:library://track/9']?.[0] === 'none');
  check('S13 NEG_TTL (24 h) < POS_TTL (30 d)', S.NEG_TTL === 86_400_000 && S.POS_TTL === 30 * 86_400_000);
  const stale = JSON.parse(LS.get(S.LYRICS_LS_KEY));
  stale.items['u:library://track/9'][2] = Date.now() - S.NEG_TTL - 1000;   // 'none' older than 24 h
  stale.items['u:library://track/1'][2] = Date.now() - S.NEG_TTL - 1000;   // 'synced' older than 24 h, younger than 30 d
  S.clearLyricsCache(); LS.set(S.LYRICS_LS_KEY, J(stale));
  const s5 = newStore(hass);
  const n14 = hass.calls.length;
  s5.follow(hass, playing('library://track/1'));
  check('S14 a found result 25 h old is still served from cache', s5.state.status === 'synced' && hass.calls.length === n14);
  s5.follow(hass, playing('library://track/9'));
  check('S15 a "not found" result 25 h old has expired → looked up again', s5.state.status === 'loading');
  await waitFor(() => s5.state.status !== 'loading');
}
{
  // radio path: music/search → best match → get_track_lyrics
  S.clearLyricsCache(); LS.clear();
  const hass = fakeHass((cmd, d) => {
    if (cmd === 'music/search') return { tracks: [{ uri: 'library://track/77', name: 'Wrong Song', artists: [{ name: 'Radio Band' }], metadata: {} }, { uri: 'library://track/78', name: 'Radio Song', artists: [{ name: 'Radio Band' }], metadata: {} }], artists: [] };
    if (cmd === 'metadata/get_track_lyrics') return d.track.uri === 'library://track/78' ? [null, LRC] : [null, null];
    throw new Error('unexpected ' + cmd);
  });
  const s = newStore(hass);
  s.follow(hass, { entity_id: 'media_player.x', state: 'playing', attributes: { media_title: 'Radio Band - Radio Song', media_content_id: 'library://radio/3', media_content_type: 'radio' } });
  await waitFor(() => s.state.status !== 'loading');
  const cmds = hass.calls.map((c) => c.data.command);
  check('R1 radio: music/search {search_query "artist - title", media_types [track]} → best match → get_track_lyrics', J(cmds) === J(['music/search', 'metadata/get_track_lyrics']) && hass.calls[0].data.data.search_query === 'Radio Band - Radio Song' && J(hass.calls[0].data.data.media_types) === J(['track']) && hass.calls[1].data.data.track.uri === 'library://track/78', J(cmds));
  check('R2 radio result is synced, flagged radio with duration 0 (so never seekable)', s.state.status === 'synced' && s.state.track.radio === true && s.state.track.duration === 0 && s.state.via === 'search');
  check('R3 radio cache key is artist|title', JSON.parse(LS.get(S.LYRICS_LS_KEY)).items['q:radio band|radio song']?.[0] === 'synced');
  s.follow(hass, { entity_id: 'media_player.x', state: 'playing', attributes: { media_title: 'Unknown Act - Nothing Similar', media_content_type: 'radio', media_content_id: 'library://radio/3' } });
  await waitFor(() => s.state.status !== 'loading');
  check('R4 radio with no close match → "none" without a lyrics call', s.state.status === 'none' && hass.calls.length === 3);
  s.follow(hass, { entity_id: 'media_player.x', state: 'playing', attributes: { media_title: 'Station Jingle', media_content_type: 'radio', media_content_id: 'library://radio/3' } });
  check('R5 radio with only a station title (no artist) → "none" immediately, no call', s.state.status === 'none' && hass.calls.length === 3);
}
{
  // errors: permission / generic / no entry id; back-off and retry
  S.clearLyricsCache(); LS.clear();
  let mode = 'perm';
  const hass = fakeHass((cmd, d) => { if (mode === 'perm') throw Object.assign(new Error('Unauthorized'), { code: 'unauthorized' }); if (mode === 'err') throw new Error('provider unavailable'); return cmd === 'music/item_by_uri' ? { uri: d.uri, name: 'Song', metadata: {} } : [null, LRC]; });
  const s = newStore(hass);
  s.follow(hass, playing('library://track/5'));
  await waitFor(() => s.state.status !== 'loading');
  check('E1 permission error → status error, reason permission', s.state.status === 'error' && s.state.reason === 'permission');
  check('E2 errors are not stored in localStorage', !LS.get(S.LYRICS_LS_KEY) || !JSON.parse(LS.get(S.LYRICS_LS_KEY)).items['u:library://track/5']);
  const n = hass.calls.length;
  const s2 = newStore(hass); s2.follow(hass, playing('library://track/5'));
  check('E3 60 s in-memory back-off: another card does not hammer the server', s2.state.status === 'error' && hass.calls.length === n);
  mode = 'ok';
  s.retry();
  await waitFor(() => s.state.status !== 'loading');
  check('E4 retry() bypasses the back-off and recovers', s.state.status === 'synced', s.state.status);
  mode = 'err';
  s.follow(hass, playing('library://track/6'));
  await waitFor(() => s.state.status !== 'loading');
  check('E5 generic failure → error, reason error', s.state.status === 'error' && s.state.reason === 'error');
  const s3 = new S.LyricsStore(); s3.follow(hass, playing('library://track/7'));
  check('E6 no mass_queue_entry_id → error reason config, no call', s3.state.status === 'error' && s3.state.reason === 'config' && hass.calls.every((c) => c.data.data?.uri !== 'library://track/7'));
  s3.entryId = ENTRY; mode = 'ok'; s3.follow(hass, playing('library://track/7'));
  await waitFor(() => s3.state.status !== 'loading');
  check('E7 setting the entry id later re-runs the lookup', s3.state.status === 'synced', s3.state.status);
  const s4 = newStore(hass); s4.enabled = false; s4.follow(hass, playing('library://track/7'));
  check('E8 show_lyrics:false → status off, no call', s4.state.status === 'off');
}
console.warn = origWarn;
console.log(`\n${results.length - failures}/${results.length} unit checks passed`);
writeFileSync(new URL('../shots/unit-results.json', import.meta.url), J(results, null, 2));
process.exit(failures ? 1 : 0);
