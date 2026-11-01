import { parseLrc, parsePlain, toLyrics, type LyricLine } from './lrc';
import type { HassEntity, HomeAssistant } from '../types';

/**
 * One lyrics store per card, shared by every lyrics surface (art overlay, Stage, Lyrics tab, screensaver).
 * The card calls follow() on every hass update; a lookup starts only when the track key changes.
 *
 * Lookup (mass_queue.send_command, return_response, config_entry_id = mass_queue_entry_id):
 *   track with an MA uri:  music/item_by_uri {uri}           -> item.metadata.lrc_lyrics / .lyrics
 *                          metadata/get_track_lyrics {track} -> [plain, lrc]   ([null, null] = not found)
 *   radio / no MA uri:     music/search {search_query, media_types:['track'], limit}
 *                          -> best track match by artist + title -> its metadata, else get_track_lyrics {track}
 * The service response is {response: X}; HA's callService wraps it again as {context, response: {response: X}}.
 *
 * Caching: in-memory LRU (50, shared by every card on the page) and localStorage (100 entries). Found lyrics live 30 days,
 * "not found" 24 hours, errors are never stored (60 s in-memory back-off). Requests for the same key share one promise.
 */
export type LyricsStatus = 'off' | 'idle' | 'loading' | 'synced' | 'plain' | 'none' | 'error';
export interface TrackRef {
  key: string;
  uri?: string;
  artist: string;
  title: string;
  radio: boolean;
  /** seconds; 0 when unknown (radio) */
  duration: number;
}
export interface LyricsState {
  status: LyricsStatus;
  track?: TrackRef;
  lines: LyricLine[];
  /** error detail: 'permission' | 'error' | 'timeout' | 'config' */
  reason?: string;
  /** where the lyrics came from: 'cache' | 'item' | 'lookup' | 'search' */
  via?: string;
}
interface Entry { kind: 'synced' | 'plain' | 'none'; raw: string; at: number }

export const LYRICS_LS_KEY = 'jukebox-card:lyrics:v1';
const MEM_MAX = 50;
const LS_MAX = 100;
const RAW_MAX = 30_000;
export const POS_TTL = 30 * 86_400_000;
export const NEG_TTL = 86_400_000;
const ERR_BACKOFF = 60_000;
const CALL_TIMEOUT = 60_000; // first lookups take 8-33 s on the live server (LRCLIB rate limit)

/** Normalise artist/title for cache keys and search matching. */
export function normKey(s: string): string {
  return (s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\s*[([][^)\]]*(feat\.?|ft\.?|featuring|remaster(ed)?|live|version|edit|mono|stereo|deluxe)[^)\]]*[)\]]/g, '')
    .replace(/\s+[-–—]\s+.*(remaster(ed)?|live|version|edit|mono|stereo).*$/g, '')
    .replace(/\s+(feat\.?|ft\.?|featuring)\s+.*$/g, '')
    .replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** same as shared.cleanName; kept local so the lyrics core has no DOM/lit dependency (unit-tested in node) */
const cleanName = (s: unknown) => (typeof s === 'string' ? s.replace(/[\s\u00a0]+/g, ' ').trim() : '');

const MA_TRACK = /^[a-z0-9_\-]+:\/\/track\//i;
const MA_RADIO = /^[a-z0-9_\-]+:\/\/radio\//i;

/** What is playing, as a lyrics lookup key. undefined = nothing to look up. */
export function trackRef(ent?: HassEntity): TrackRef | undefined {
  if (!ent || !['playing', 'paused', 'buffering', 'on'].includes(ent.state)) return undefined;
  const a = ent.attributes ?? {};
  let title = cleanName(a.media_title), artist = cleanName(a.media_artist);
  if (!title) return undefined;
  const uri = typeof a.media_content_id === 'string' ? a.media_content_id : '';
  const radio = a.media_content_type === 'radio' || MA_RADIO.test(uri);
  const dur = Number(a.media_duration) || 0;
  if (!radio && MA_TRACK.test(uri)) return { key: 'u:' + uri, uri, artist, title, radio: false, duration: dur };
  // radio streams often put "Artist - Title" in the title
  if (!artist) { const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(title); if (m) { artist = m[1].trim(); title = m[2].trim(); } }
  return { key: 'q:' + normKey(artist) + '|' + normKey(title), artist, title, radio, duration: radio ? 0 : dur };
}

/** Best track in a search result for artist + title, or undefined when nothing is close enough. */
export function bestMatch(tracks: any[], artist: string, title: string): any | undefined {
  const nt = normKey(title), na = normKey(artist);
  let best: any, bestScore = 0;
  for (const t of tracks ?? []) {
    if (!t || typeof t !== 'object') continue;
    const tt = normKey(String(t.name ?? ''));
    // exact normalised title 4 (+1 when the raw title matches too, so 'Song' beats 'Song (Live)'), prefix 2
    const ts = tt === nt ? (cleanName(t.name).toLowerCase() === cleanName(title).toLowerCase() ? 5 : 4) : tt && nt && (tt.startsWith(nt) || nt.startsWith(tt)) ? 2 : 0;
    if (!ts) continue;
    const names = (Array.isArray(t.artists) ? t.artists : []).map((x: any) => normKey(typeof x === 'string' ? x : x?.name ?? ''));
    const as = !na ? 1 : names.some((n: string) => n === na) ? 4 : names.some((n: string) => n && (n.includes(na) || na.includes(n))) ? 2 : 0;
    if (!as) continue;
    const s = ts + as;
    if (s > bestScore) { best = t; bestScore = s; }
  }
  return best;
}

/** mass_queue.send_command result: {context, response: {response: X}} / {response: X} / X */
export function mqResult(r: any): any {
  let d = r && typeof r === 'object' && 'response' in r ? r.response : r;
  if (d && typeof d === 'object' && !Array.isArray(d) && Object.keys(d).length === 1 && 'response' in d) d = d.response;
  return d;
}

// ---------------- shared caches ----------------
const MEM = new Map<string, Entry>();
const INFLIGHT = new Map<string, Promise<Entry>>();
const ERRORS = new Map<string, { at: number; reason: string }>();
export const LYRICS_STATS = { lookups: 0, calls: 0, memHits: 0, lsHits: 0, deduped: 0, errors: 0 };

const fresh = (e: Entry, now = Date.now()) => now - e.at < (e.kind === 'none' ? NEG_TTL : POS_TTL);
function memGet(k: string) { const e = MEM.get(k); if (!e) return; MEM.delete(k); if (!fresh(e)) return; MEM.set(k, e); return e; }
function memSet(k: string, e: Entry) { MEM.delete(k); MEM.set(k, e); while (MEM.size > MEM_MAX) MEM.delete(MEM.keys().next().value as string); }
function lsRead(): Record<string, [Entry['kind'], string, number]> {
  try { const o = JSON.parse(localStorage.getItem(LYRICS_LS_KEY) || '{}'); return o && typeof o === 'object' && o.v === 1 && o.items ? o.items : {}; } catch { return {}; }
}
function lsGet(k: string): Entry | undefined {
  const x = lsRead()[k];
  if (!Array.isArray(x)) return;
  const e: Entry = { kind: x[0], raw: String(x[1] ?? ''), at: Number(x[2]) || 0 };
  return ['synced', 'plain', 'none'].includes(e.kind) && fresh(e) ? e : undefined;
}
function lsSet(k: string, e: Entry) {
  if (e.raw.length > RAW_MAX) return;
  try {
    const items = lsRead();
    delete items[k];
    items[k] = [e.kind, e.raw, e.at];
    const now = Date.now();
    const keep = Object.entries(items).filter(([, v]) => Array.isArray(v) && now - v[2] < (v[0] === 'none' ? NEG_TTL : POS_TTL))
      .sort((a, b) => a[1][2] - b[1][2]).slice(-LS_MAX);
    localStorage.setItem(LYRICS_LS_KEY, JSON.stringify({ v: 1, items: Object.fromEntries(keep) }));
  } catch { /* quota / private mode: memory cache only */ }
}
/** Drop every cached result (tests, and the editor's "clear lyrics cache"). */
export function clearLyricsCache() {
  MEM.clear(); ERRORS.clear();
  try { localStorage.removeItem(LYRICS_LS_KEY); } catch { /* */ }
}
const toLines = (e: Entry) => (e.kind === 'synced' ? parseLrc(e.raw) : e.kind === 'plain' ? parsePlain(e.raw) : []);

class LyricsError extends Error { constructor(public reason: string, msg: string) { super(msg); } }
function classify(err: any): string {
  if (err instanceof LyricsError) return err.reason;
  const s = `${err?.code ?? ''} ${err?.message ?? err ?? ''}`;
  return /unauthori[sz]ed|permission|forbidden|not allowed|admin/i.test(s) ? 'permission' : 'error';
}
function timeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: number | undefined;
  return Promise.race([p, new Promise<T>((_, rej) => { t = window.setTimeout(() => rej(new LyricsError('timeout', 'lyrics lookup timed out')), ms); })])
    .finally(() => window.clearTimeout(t));
}

export class LyricsStore {
  hass?: HomeAssistant;
  /** mass_queue config entry id; without it lookups report 'error' (reason 'config') */
  entryId = '';
  enabled = true;
  state: LyricsState = { status: 'idle', lines: [] };
  private key = '';
  private sig = '';
  private subs = new Set<(s: LyricsState) => void>();
  get stats() { return LYRICS_STATS; }

  subscribe(fn: (s: LyricsState) => void) { this.subs.add(fn); fn(this.state); return () => { this.subs.delete(fn); }; }
  private set(s: LyricsState) { this.state = s; this.subs.forEach((f) => f(s)); }

  /** Called on every hass update. Cheap when the track did not change. */
  follow(hass: HomeAssistant | undefined, ent: HassEntity | undefined) {
    this.hass = hass;
    const sig = `${this.enabled}|${this.entryId}`;
    if (sig !== this.sig) { this.sig = sig; this.key = ''; }
    if (!this.enabled) { if (this.state.status !== 'off') { this.key = ''; this.set({ status: 'off', lines: [] }); } return; }
    const ref = trackRef(ent);
    const key = ref?.key ?? '';
    if (key === this.key && this.state.status !== 'off') {
      // same song: keep the latest attributes (duration can arrive late), no lookup
      if (ref && this.state.track && ref.duration !== this.state.track.duration) this.set({ ...this.state, track: ref });
      return;
    }
    this.key = key;
    if (!ref) { this.set({ status: 'idle', lines: [] }); return; }
    this.load(ref);
  }
  /** Look the current track up again (error state "Try again"). */
  retry() {
    const t = this.state.track; if (!t) return;
    ERRORS.delete(t.key); MEM.delete(t.key);
    this.load(t, true);
  }

  private load(ref: TrackRef, force = false) {
    const hit = force ? undefined : this.cached(ref.key);
    if (hit) { this.apply(ref, hit, 'cache'); return; }
    const err = ERRORS.get(ref.key);
    if (!force && err && Date.now() - err.at < ERR_BACKOFF) { this.set({ status: 'error', track: ref, lines: [], reason: err.reason }); return; }
    if (!this.entryId) { this.set({ status: 'error', track: ref, lines: [], reason: 'config' }); return; }
    if (ref.key.startsWith('q:') && (!ref.artist || !ref.title)) { this.apply(ref, { kind: 'none', raw: '', at: Date.now() }, 'search'); return; }
    this.set({ status: 'loading', track: ref, lines: [] });
    this.get(ref).then((e) => { if (this.key === ref.key) this.apply(ref, e, ref.uri ? 'lookup' : 'search'); })
      .catch((e) => {
        const reason = classify(e);
        ERRORS.set(ref.key, { at: Date.now(), reason });
        LYRICS_STATS.errors++;
        console.warn('[jukebox-card] lyrics lookup failed', reason, e?.message ?? e);
        if (this.key === ref.key) this.set({ status: 'error', track: ref, lines: [], reason });
      });
  }
  private apply(ref: TrackRef, e: Entry, via: string) {
    this.set({ status: e.kind === 'none' ? 'none' : e.kind, track: ref, lines: toLines(e), via });
  }
  private cached(k: string): Entry | undefined {
    const m = memGet(k); if (m) { LYRICS_STATS.memHits++; return m; }
    const l = lsGet(k); if (l) { LYRICS_STATS.lsHits++; memSet(k, l); return l; }
    return undefined;
  }
  /** One request per key at a time, whichever surface or card asks. */
  get(ref: TrackRef): Promise<Entry> {
    const c = this.cached(ref.key); if (c) return Promise.resolve(c);
    const p0 = INFLIGHT.get(ref.key); if (p0) { LYRICS_STATS.deduped++; return p0; }
    LYRICS_STATS.lookups++;
    const p = this.fetch(ref).then((e) => { memSet(ref.key, e); lsSet(ref.key, e); return e; })
      .finally(() => INFLIGHT.delete(ref.key));
    INFLIGHT.set(ref.key, p);
    return p;
  }

  private send(command: string, data: Record<string, any>) {
    const hass = this.hass;
    if (!hass) return Promise.reject(new LyricsError('error', 'no hass'));
    LYRICS_STATS.calls++;
    return timeout(hass.callService('mass_queue', 'send_command', { config_entry_id: this.entryId, command, data }, undefined, false, true), CALL_TIMEOUT)
      .then(mqResult);
  }
  private async fromItem(item: any): Promise<Entry> {
    const md = item?.metadata ?? {};
    let ly = toLyrics(md.lyrics, md.lrc_lyrics);
    if (!ly) {
      const r = await this.send('metadata/get_track_lyrics', { track: item });
      const [plain, lrc] = Array.isArray(r) ? r : [r?.lyrics ?? r?.plain, r?.lrc_lyrics ?? r?.lrc];
      ly = toLyrics(plain, lrc);
    }
    if (!ly) return { kind: 'none', raw: '', at: Date.now() };
    const raw = ly.kind === 'synced'
      ? ly.lines.map((l) => `[${String(Math.floor(l.t / 60)).padStart(2, '0')}:${(l.t % 60).toFixed(2).padStart(5, '0')}]${l.text}`).join('\n')
      : ly.lines.map((l) => l.text).join('\n');
    return { kind: ly.kind, raw, at: Date.now() };
  }
  private async fetch(ref: TrackRef): Promise<Entry> {
    if (ref.uri) {
      const item = await this.send('music/item_by_uri', { uri: ref.uri });
      if (!item || typeof item !== 'object' || Array.isArray(item)) return { kind: 'none', raw: '', at: Date.now() };
      return this.fromItem(item);
    }
    const res = await this.send('music/search', { search_query: `${ref.artist} - ${ref.title}`, media_types: ['track'], limit: 8 });
    const tracks = Array.isArray(res?.tracks) ? res.tracks : Array.isArray(res) ? res : [];
    const best = bestMatch(tracks, ref.artist, ref.title);
    if (!best) return { kind: 'none', raw: '', at: Date.now() };
    return this.fromItem(best);
  }
}
