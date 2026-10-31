import { LitElement, html, css, nothing, type PropertyValues } from 'lit';
import { tokens, base } from './styles';
import { icon } from './icons';
import { providerLabel } from './providers';
import {
  mediaStyles, noFocus, artTpl, provTpl, artistNames, fmtDur, unwrap, fire, PressController, menuPos, menuTpl,
  playMedia, playInOrder, shufflePlay, playMessage, normItem, safeImage, canRadio, rowActsTpl, foldedActions, confirmTpl,
  type MenuAction, type MenuPos, type RowAct, type ConfirmState,
} from './shared';
import type { Enqueue, HomeAssistant, JukeboxCardConfig, MaItem } from './types';

/** mass_queue `page` is 0..1000. A first page shorter than this is taken as the whole list (no "load more" call). */
export const QUEUE_PAGE_MIN = 25;
export const QUEUE_PAGE_MAX = 1000;
const ONE: Record<string, string> = { artist: 'artist', album: 'album', playlist: 'playlist', podcast: 'podcast' };

/**
 * mass_queue get_{album,artist,playlist}_tracks / get_podcast_episodes item -> MA-like item.
 * Real shape (mass_queue 0.10.x): {media_title, media_content_id, duration (s, 0 = unknown), media_image ("" or https URL),
 * favorite, media_album_name, media_artist, position (playlists only, may be null)}; optional local_image_encoded.
 */
export function fromQueueTrack(t: any, mediaType = 'track'): MaItem {
  const dur = Number(t?.duration);
  const img = safeImage(t?.media_image) || safeImage(t?.image) || (t?.local_image_encoded ? `data:image/jpeg;base64,${t.local_image_encoded}` : '');
  return normItem({
    media_type: mediaType, uri: t?.media_content_id ?? t?.uri ?? '', name: t?.media_title ?? t?.name ?? '',
    artists: t?.media_artist ? [{ name: t.media_artist }] : t?.artists, album: t?.media_album_name ? { name: t.media_album_name } : t?.album,
    image: img || null, duration: Number.isFinite(dur) && dur > 0 ? dur : undefined, favorite: !!t?.favorite,
    ...(typeof t?.position === 'number' ? { position: t.position } : {}),
  });
}
/** Unwrap {response:{tracks|episodes}} / {result:{response:{..}}} / {tracks} / [..] into card items. */
export function queueTracks(r: any, mediaType = 'track'): MaItem[] {
  const d = unwrap(r?.result ?? r);
  const raw = Array.isArray(d) ? d : Array.isArray(d?.tracks) ? d.tracks : Array.isArray(d?.episodes) ? d.episodes : [];
  return raw.map((t: any) => fromQueueTrack(t, mediaType)).filter((t: MaItem) => t.uri && t.name);
}
/**
 * Merge one more playlist page. mass_queue does not report a page size or a total, and older builds ignore `page`
 * (or return everything for page 0), so stop when a page is empty, shorter than the first one, or a run of tracks we
 * already have (the server repeated itself). Playlists may legitimately contain the same track twice, so no per-uri dedupe.
 */
export function mergePage(have: MaItem[], page: MaItem[], firstLen: number): { tracks: MaItem[]; more: boolean } {
  if (!page.length) return { tracks: have, more: false };
  const sig = (l: MaItem[]) => l.map((t) => t.uri).join('\n');
  if (page.length <= have.length && ('\n' + sig(have) + '\n').includes('\n' + sig(page) + '\n')) return { tracks: have, more: false };
  return { tracks: [...have, ...page], more: page.length >= firstLen };
}
/** mass_queue config entry id: `mass_queue_entry_id`, or the 0.3.0 name `queue_config_entry_id`. Never the MA entry. */
export const queueEntryId = (c: JukeboxCardConfig) => c.mass_queue_entry_id || c.queue_config_entry_id || '';

const same = (a?: string, b?: string) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
const byArtist = (it: MaItem) => (x: MaItem) => (x.artists ?? []).some((a: any) => (a?.uri && a.uri === it.uri) || same(typeof a === 'string' ? a : a?.name, it.name));
/** One album per name+version; a library:// copy wins over a provider copy of the same album. */
export function dedupeAlbums(list: MaItem[]): MaItem[] {
  const out = new Map<string, MaItem>();
  for (const a of list) {
    const k = `${a.name.trim().toLowerCase()}|${(a.version ?? '').toLowerCase()}`;
    const had = out.get(k);
    if (!had || (!had.uri.startsWith('library://') && a.uri.startsWith('library://'))) out.set(k, a);
  }
  return [...out.values()];
}
const dedupeUri = (l: MaItem[]) => { const s = new Set<string>(); return l.filter((t) => !s.has(t.uri) && !!s.add(t.uri)); };

/** Where the track list came from. 'search' = approximate (labelled "matched by search"). */
export type TrackSrc = 'mass_queue' | 'search' | 'none';
export interface DetailData {
  tracks: MaItem[]; albums: MaItem[]; loading: boolean; error: string; src: TrackSrc; note: string;
  /** playlist paging (mass_queue get_playlist_tracks `page`) */
  page: number; more: boolean; loadingMore: boolean; firstLen: number;
}
export interface DetailEntry { item: MaItem; type: string; scroll?: number; data?: DetailData }
export const emptyDetail = (): DetailData => ({ tracks: [], albums: [], loading: true, error: '', src: 'none', note: '', page: 0, more: false, loadingMore: false, firstLen: 0 });

/**
 * Load a detail view. Nothing here plays anything.
 *  artist   -> mass_queue get_artist_tracks (top tracks) + music_assistant.search {name, media_type:[album,track]} for the
 *              albums (filtered by artist; mass_queue has no artist-albums call). Without mass_queue, or if it fails,
 *              the search tracks are used and labelled.
 *  album    -> mass_queue get_album_tracks; fallback search {name: album, artist, media_type:[track]} filtered by album name.
 *  playlist -> mass_queue get_playlist_tracks page 0 (more pages on scroll). No search can list a playlist: labelled note.
 *  podcast  -> mass_queue get_podcast_episodes.
 */
export async function loadDetail(hass: HomeAssistant, config: JukeboxCardConfig, it: MaItem, type: string): Promise<DetailData> {
  const qid = queueEntryId(config);
  const d = emptyDetail();
  const mq = (svc: string, page?: number) => hass.callService('mass_queue', svc,
    { config_entry_id: qid, uri: it.uri, ...(page !== undefined ? { page } : {}) }, undefined, false, true);
  const search = async (data: Record<string, any>) =>
    unwrap(await hass.callService('music_assistant', 'search', { config_entry_id: config.config_entry_id, ...data }, undefined, false, true)) ?? {};
  const svc = ({ artist: 'get_artist_tracks', album: 'get_album_tracks', playlist: 'get_playlist_tracks', podcast: 'get_podcast_episodes' } as Record<string, string>)[type];
  let mqErr: unknown = null;
  const viaMq = qid && svc
    ? mq(svc, type === 'playlist' ? 0 : undefined).then((r) => queueTracks(r, type === 'podcast' ? 'podcast_episode' : 'track'))
      .catch((e) => { mqErr = e; console.warn(`[jukebox-card] mass_queue.${svc} failed`, e); return null; })
    : Promise.resolve(null);
  if (type === 'artist') {
    const [t, s] = await Promise.all([viaMq, search({ name: it.name, media_type: ['album', 'track'], limit: 25 }).catch((e) => { console.warn('[jukebox-card] artist search failed', e); return null; })]);
    d.albums = dedupeAlbums((s?.albums ?? []).filter((x: any) => x?.uri && x?.name).map(normItem).filter(byArtist(it)));
    if (t && t.length) { d.tracks = dedupeUri(t); d.src = 'mass_queue'; }
    else if (s) { d.tracks = dedupeUri((s.tracks ?? []).filter((x: any) => x?.uri && x?.name).map(normItem).filter(byArtist(it))); d.src = 'search'; }
    if (!t && !s) d.error = "Couldn't load this artist. Check Music Assistant.";
  } else if (type === 'album') {
    const t = await viaMq;
    if (t && t.length) { d.tracks = t; d.src = 'mass_queue'; }
    else {
      const by = artistNames(it).split(',')[0].trim();
      try {
        const s = await search({ name: it.name, media_type: ['track'], limit: 50, ...(by ? { artist: by } : {}) });
        d.tracks = dedupeUri((s.tracks ?? []).filter((x: any) => x?.uri && x?.name).map(normItem)
          .filter((x: MaItem) => same(x.album?.name, it.name) && (!by || (x.artists ?? []).some((a: any) => same(a?.name, by)))));
        d.src = 'search';
      } catch (e) { console.warn('[jukebox-card] album search failed', e); d.error = "Couldn't load the track list. Check Music Assistant."; }
    }
  } else if (type === 'playlist' || type === 'podcast') {
    const t = await viaMq;
    if (t) {
      d.tracks = t; d.src = 'mass_queue'; d.firstLen = t.length;
      d.more = type === 'playlist' && t.length >= QUEUE_PAGE_MIN;
    } else if (mqErr) d.error = `Couldn't load the ${type === 'podcast' ? 'episodes' : 'track list'}. You can still play the whole ${type}.`;
    else d.note = `${type === 'podcast' ? 'Episode lists' : 'Playlist tracks'} need mass_queue (set mass_queue_entry_id). Play, Shuffle or Add the whole ${type} above.`;
  }
  if (d.src === 'search') d.note = qid
    ? `mass_queue couldn't list these tracks, so they were found by searching for “${it.name}”. Some may be missing.`
    : `mass_queue is not set up, so these tracks were found by searching for “${it.name}”. Some may be missing.`;
  d.loading = false;
  return d;
}

/**
 * Detail page for an artist / album / playlist / podcast. Owns its scroller (scroll position is kept per stack entry),
 * its menus and its toast. Emits `jb-nav` {op:'push', item, type} | {op:'back'} for the host's back stack.
 */
export class JbDetail extends LitElement {
  static properties = {
    hass: { attribute: false }, config: { attribute: false }, entry: { attribute: false }, trail: { attribute: false },
    _menu: { state: true }, _toast: { state: true }, _confirm: { state: true }, _sel: { state: true },
  };
  hass?: HomeAssistant;
  config!: JukeboxCardConfig;
  entry?: DetailEntry;
  /** names of the views below this one, for the "Search › Chicago" breadcrumb */
  trail: string[] = [];
  private _menu: { item: MaItem; type: string; pos: MenuPos; actions: MenuAction[] } | null = null;
  private _toast = '';
  private _toastTimer?: number;
  private _confirm: ConfirmState | null = null;
  private _sel = '';
  private press = new PressController<{ it: MaItem; type: string; key: string }>(this, (p) => this.tap(p.it, p.type, p.key), (p) => this.tap(p.it, p.type, p.key));

  get data(): DetailData | undefined { return this.entry?.data; }
  private get scroller() { return this.renderRoot?.querySelector('.scroll') as HTMLElement | null; }
  protected shouldUpdate(ch: PropertyValues) { return !(ch.size === 1 && ch.has('hass')); }
  protected willUpdate(ch: PropertyValues) {
    if (ch.has('entry')) {
      const old = ch.get('entry') as DetailEntry | undefined;
      if (old && this.scroller) old.scroll = this.scroller.scrollTop;
      this._menu = null; this._confirm = null; this._sel = ''; this.press.release();
      if (this.entry && !this.entry.data) this.load(this.entry);
    }
  }
  protected updated(ch: PropertyValues) {
    if (ch.has('entry') && this.scroller) this.scroller.scrollTop = this.entry?.scroll ?? 0;
  }
  private set(e: DetailEntry, patch: Partial<DetailData>) {
    e.data = { ...(e.data ?? emptyDetail()), ...patch };
    if (this.entry === e) { this.requestUpdate(); if (e.data.more && !e.data.loadingMore) this.updateComplete.then(() => this.fillScreen()); }
  }
  async load(e: DetailEntry) {
    if (!this.hass) return;
    e.data = emptyDetail();
    const d = await loadDetail(this.hass, this.config, e.item, e.type).catch((err) => {
      console.warn('[jukebox-card] detail failed', err);
      return { ...emptyDetail(), loading: false, error: "Couldn't load this. Check Music Assistant." };
    });
    this.set(e, d);
  }
  /** If the first page does not fill the scroller there is no scroll event, so pull the next page now. */
  private fillScreen() {
    const el = this.scroller;
    if (el && this.data?.more && el.scrollHeight <= el.clientHeight + 400) this.loadMoreTracks();
  }
  async loadMoreTracks() {
    const e = this.entry, d = e?.data;
    if (!e || !d || !d.more || d.loadingMore || e.type !== 'playlist' || !this.hass) return;
    const page = d.page + 1;
    if (page > QUEUE_PAGE_MAX) { this.set(e, { more: false }); return; }
    this.set(e, { loadingMore: true });
    try {
      const got = queueTracks(await this.hass.callService('mass_queue', 'get_playlist_tracks',
        { config_entry_id: queueEntryId(this.config), uri: e.item.uri, page }, undefined, false, true));
      const m = mergePage(e.data!.tracks, got, d.firstLen);
      this.set(e, { tracks: m.tracks, more: m.more, page, loadingMore: false });
    } catch (err) {
      console.warn('[jukebox-card] playlist page failed', err);
      this.set(e, { more: false, loadingMore: false, error: "Couldn't load more tracks." });
    }
  }
  private onScroll() {
    this.press.scrolled();
    const el = this.scroller;
    if (el && el.scrollTop + el.clientHeight > el.scrollHeight - 400) this.loadMoreTracks();
  }

  private toast(t: string) { this._toast = t; window.clearTimeout(this._toastTimer); this._toastTimer = window.setTimeout(() => (this._toast = ''), 2400); }
  private closeMenu() { this._menu = null; this.press.release(); }
  /** play_media type for a row: podcast episodes omit media_type (not in HA's list; MA infers it from the URI). */
  private mt(it: MaItem, type: string) { return it.media_type === 'podcast_episode' ? '' : type; }
  async play(it: MaItem, type: string, enqueue: Enqueue = 'play', radio = false) {
    if (!this.hass) return;
    this.closeMenu();
    try {
      const r = await playMedia(this.hass, this.config, it, this.mt(it, type), enqueue, radio);
      if (!r) return;
      this.toast(playMessage(this.hass, this.config, it, enqueue, radio));
      fire(this, 'jukebox-played', { item: it, ...r });
    } catch (err) { this.toast(`Couldn't play ${it.name}`); console.warn('[jukebox-card] play_media failed', err); }
  }
  /** Header buttons, the whole list. Play (in order) and Shuffle replace the queue, so they ask first; Add does not. */
  private headerAct(mode: 'play' | 'shuffle' | 'add' | 'radio') {
    const e = this.entry; if (!e || !this.hass) return;
    if (mode === 'add') { this.play(e.item, e.type, 'add'); return; }
    if (mode === 'radio') { this._confirm = { kind: 'radio', item: e.item, run: () => this.play(e.item, e.type, 'replace', true) }; return; }
    this._confirm = { kind: mode, item: e.item, run: () => this.playAll(mode) };
  }
  private async playAll(mode: 'play' | 'shuffle') {
    const e = this.entry; if (!e || !this.hass) return;
    try {
      const r = mode === 'shuffle' ? await shufflePlay(this.hass, this.config, e.item, e.type, 'replace') : await playInOrder(this.hass, this.config, e.item, e.type, 'replace');
      if (!r) return;
      this.toast(playMessage(this.hass, this.config, e.item, 'play', false, mode === 'shuffle'));
      fire(this, 'jukebox-played', { item: e.item, ...r });
    } catch (err) { this.toast(`Couldn't play ${e.item.name}`); console.warn('[jukebox-card] play failed', err); }
  }
  private root() { return this.renderRoot.querySelector('.dx') as HTMLElement; }
  /** Row tap: an album row opens its detail; a track / episode row is only highlighted (its icons do the playing). */
  private tap(it: MaItem, type: string, key: string) {
    if (type === 'album') { this.press.release(); fire(this, 'jb-nav', { op: 'push', item: it, type }); return; }
    this._sel = this._sel === key ? '' : key;
  }
  /** Row icons: Add / Play next at once; Replace queue / Start radio (enqueue replace) behind the confirmation. */
  private rowAct(it: MaItem, type: string, a: RowAct | 'more', el: HTMLElement) {
    const ask = (k: RowAct) => {
      this.closeMenu();
      if (k === 'add' || k === 'next') { this.play(it, type, k); return; }
      this._confirm = { kind: k, item: it, run: () => this.play(it, type, 'replace', k === 'radio') };
    };
    if (a !== 'more') { ask(a); return; }
    const actions = foldedActions(canRadio(type, it), ask);
    this._menu = { item: it, type, pos: menuPos(this.root(), el.closest('.row') as HTMLElement, actions.length), actions };
  }

  private sub(it: MaItem, type: string) {
    if (type === 'track' || type === 'album') return [artistNames(it), type === 'track' ? it.album?.name : ''].filter(Boolean).join(' · ');
    if (type === 'playlist') return it.owner ?? '';
    return artistNames(it);
  }
  /** Album row inside an artist: tap opens the album; icons queue / replace / radio the whole album. */
  private albumRow(it: MaItem) {
    const key = 'al|' + it.uri;
    const p = this.press.handlers(key, { it, type: 'album', key });
    return html`<div class="row drill ${this.press.held === key ? 'held' : ''}" data-uri=${it.uri} data-type="album" aria-label="Open ${it.name}"
        @pointerdown=${p.down} @pointermove=${p.move} @pointerup=${p.up} @pointercancel=${p.cancel} @pointerleave=${p.cancel}
        @contextmenu=${(e: Event) => e.preventDefault()}>
      ${artTpl(it, 'th')}
      <div class="rt"><b>${it.name}${it.version ? html` <i class="ver">${it.version}</i>` : nothing}</b>
        <small>${provTpl(it.uri, it.provider, 'album')}<span class="st">${['Album', (it as any).year].filter(Boolean).join(' · ')}</span></small></div>
      <span class="du"></span>
      ${rowActsTpl(it, canRadio('album', it), (a, el) => this.rowAct(it, 'album', a, el))}
    </div>`;
  }
  private row(it: MaItem, n?: number, i = 0) {
    const type = it.media_type === 'podcast_episode' ? 'podcast_episode' : 'track';
    const key = `${i}|${it.uri}`;
    const p = this.press.handlers(key, { it, type, key });
    return html`<div class="row ${this.press.held === key ? 'held' : ''} ${this._sel === key ? 'sel' : ''}" data-uri=${it.uri} data-type=${type}
        @pointerdown=${p.down} @pointermove=${p.move} @pointerup=${p.up} @pointercancel=${p.cancel} @pointerleave=${p.cancel}
        @contextmenu=${(e: Event) => e.preventDefault()}>
      ${n !== undefined ? html`<span class="n">${n}</span>` : artTpl(it, 'th')}
      <div class="rt"><b>${it.name}${it.version ? html` <i class="ver">${it.version}</i>` : nothing}</b>
        <small>${provTpl(it.uri, it.provider)}${it.duration ? html`<span class="du2">${fmtDur(it.duration)}</span>` : nothing}<span class="st">${this.sub(it, 'track')}</span></small></div>
      <span class="du">${fmtDur(it.duration)}</span>
      ${rowActsTpl(it, canRadio(type, it), (a, el) => this.rowAct(it, type, a, el))}
    </div>`;
  }
  /** "9 tracks · 43 min" (a "+" while more playlist pages are pending). */
  private meta(d: DetailData, type: string) {
    const secs = d.tracks.reduce((a, t) => a + (t.duration ?? 0), 0);
    const word = type === 'podcast' ? 'episode' : 'track';
    const n = `${d.tracks.length}${d.more ? '+' : ''} ${word}${d.tracks.length === 1 && !d.more ? '' : 's'}`;
    if (!secs || type === 'artist') return n;
    const m = Math.round(secs / 60);
    return `${n} · ${m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`}`;
  }

  render() {
    const e = this.entry;
    if (!e) return nothing;
    const it = e.item, d = e.data ?? emptyDetail(), type = e.type;
    const prov = providerLabel(it.uri);
    const btn = (id: string, ic: string, label: string, cls = 'sbtn') => html`<button class=${cls} data-action=${id} tabindex="-1"
      aria-label=${label} @pointerdown=${noFocus} @click=${() => this.headerAct(id as any)}>${icon(ic)}${label}</button>`;
    const tracksTitle = type === 'artist' ? 'Top tracks' : type === 'podcast' ? 'Episodes' : 'Tracks';
    const m = this._menu;
    return html`<div class="dx">
      <div class="scroll panel" @scroll=${this.onScroll}>
        <div class="detail" data-type=${type} data-uri=${it.uri} data-src=${d.src} ?data-loading=${d.loading}>
          <div class="nav">
            <button class="back" data-action="back" tabindex="-1" aria-label="Back" @pointerdown=${noFocus}
              @click=${() => { this.closeMenu(); fire(this, 'jb-nav', { op: 'back' }); }}>${icon('back')}<span>Back</span></button>
            ${this.trail.length ? html`<span class="trail">${this.trail.join(' › ')}</span>` : nothing}
          </div>
          <div class="dh">
            ${artTpl(it, type === 'artist' ? 'dart circ' : 'dart')}
            <div class="dt"><span class="eyebrow">${ONE[type] ?? type}${prov ? ` · ${prov}` : ''}</span><h2>${it.name}</h2>
              ${this.sub(it, type) ? html`<small>${this.sub(it, type)}</small>` : nothing}
              ${!d.loading && d.tracks.length ? html`<small class="meta" data-tracks=${d.tracks.length}>${this.meta(d, type)}</small>` : nothing}
              <div class="da">
                ${btn('play', 'play', 'Play', 'pbtn')}${btn('shuffle', 'shuffle', 'Shuffle')}${btn('add', 'qadd', 'Add to queue')}
                ${canRadio(type, it) ? btn('radio', 'tower', 'Start radio') : nothing}
              </div></div>
          </div>
          ${d.loading ? html`<div class="empty"><span>Loading…</span></div>` : nothing}
          ${d.error ? html`<div class="note err" role="alert">${d.error}
            <button class="sbtn retry" data-action="retry" tabindex="-1" @pointerdown=${noFocus} @click=${() => { e.data = undefined; this.load(e); this.requestUpdate(); }}>Retry</button></div>` : nothing}
          ${d.note ? html`<div class="note src" data-src=${d.src}>${d.note}</div>` : nothing}
          ${type === 'artist' && !d.loading ? html`<h3 class="eyebrow">Albums</h3>${d.albums.length
            ? html`<div class="list albums">${d.albums.map((a) => this.albumRow(a))}</div>`
            : html`<div class="empty noalbums"><span>No albums found.</span></div>`}` : nothing}
          ${d.tracks.length ? html`<h3 class="eyebrow">${tracksTitle}${d.src === 'search' ? html` <em>matched by search</em>` : nothing}</h3>
            <div class="list tracks">${d.tracks.map((t, i) => this.row(t, type === 'album' && d.src === 'mass_queue' ? i + 1 : undefined, i))}</div>
            ${d.more || d.loadingMore ? html`<button class="sbtn more-t" data-action="more" tabindex="-1" ?disabled=${d.loadingMore} @pointerdown=${noFocus}
              @click=${() => this.loadMoreTracks()}>${d.loadingMore ? 'Loading more tracks…' : 'Load more tracks'}</button>` : nothing}`
            : !d.loading && !d.error && !d.note ? html`<div class="empty notracks"><span>No ${type === 'podcast' ? 'episodes' : 'tracks'} found.</span></div>` : nothing}
        </div>
      </div>
      ${m ? menuTpl(m.pos, { item: m.item, sub: this.sub(m.item, 'track') || providerLabel(m.item.uri) }, m.actions, () => this.closeMenu()) : nothing}
      ${this._toast ? html`<div class="toast" role="status">${this._toast}</div>` : nothing}
      ${confirmTpl(this._confirm, () => (this._confirm = null))}
    </div>`;
  }

  static styles = [tokens, base, mediaStyles, css`
    :host { display: block; height: 100%; min-height: 0; color: var(--_fg); font-family: var(--_font-body); }
    .dx { position: relative; height: 100%; display: flex; flex-direction: column; min-height: 0; }
    .scroll { flex: 1; min-height: 0; overflow-y: auto; scrollbar-width: none; overscroll-behavior: contain; padding: 16px; touch-action: pan-y;
      padding-bottom: calc(16px + var(--jb-fab-space, 0px)); scroll-padding-bottom: var(--jb-fab-space, 0px); }
    .scroll::-webkit-scrollbar { display: none; }
    .detail { display: flex; flex-direction: column; gap: 14px; }
    .nav { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .back { flex: none; display: inline-flex; align-items: center; gap: 6px; height: 44px; padding: 0 16px 0 12px; border-radius: 999px; background: #ffffff14;
      border: 1px solid #ffffff33; color: #fff; font-weight: 700; font-size: 15px; }
    .back .i { width: 22px; height: 22px; }
    .trail { min-width: 0; font-size: 13px; color: var(--_inactive); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .dh { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 18px; align-items: center; }
    .dart { width: 150px; height: 150px; border-radius: 12px; }
    .dart.circ { border-radius: 50%; }
    .dt { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
    .dt .eyebrow { font-size: 11px; color: var(--_inactive); }
    .dt h2 { font-family: var(--_font-display); font-size: 30px; font-weight: 800; line-height: 1.1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dt small { color: var(--_muted); font-size: 15px; }
    .meta { font-size: 13px !important; font-variant-numeric: tabular-nums; }
    .da { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 8px; }
    .pbtn, .sbtn { display: inline-flex; align-items: center; gap: 8px; height: 46px; padding: 0 18px; border-radius: 999px; font-weight: 700; }
    .pbtn { background: var(--_active); color: var(--_on-accent); }
    .sbtn { border: 1px solid #ffffff40; color: #fff; }
    .pbtn .i, .sbtn .i { width: 22px; height: 22px; }
    .note { font-size: 13px; color: var(--_muted); padding: 10px 12px; border-radius: 10px; border: 1px dashed #ffffff33; }
    .note.err { color: #fff; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .note .retry { height: 38px; }
    h3.eyebrow { font-size: 12px; color: var(--_muted); } h3 em { font-style: normal; font-weight: 600; letter-spacing: 0; text-transform: none; color: var(--_inactive); margin-left: 6px; }
    .more-t { align-self: center; min-width: 220px; justify-content: center; }
    .empty { padding: 14px; }
    @container np (max-width: 520px) {
      .scroll { padding: 10px; }
      .dh { grid-template-columns: 96px minmax(0, 1fr); gap: 12px; } .dart { width: 96px; height: 96px; }
      .dt h2 { font-size: 22px; white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
      .da { grid-column: 1 / -1; }
      .pbtn, .sbtn { height: 42px; padding: 0 14px; font-size: 14px; }
      .row .pv { display: none; }
    }
  `];
}
if (!customElements.get('jb-detail')) customElements.define('jb-detail', JbDetail);
