import { LitElement, html, css, nothing, type PropertyValues } from 'lit';
import { tokens, base } from './styles';
import { icon } from './icons';
import { providerLabel } from './providers';
import {
  mediaStyles, noFocus, artTpl, provTpl, artistNames, fmtDur, unwrap, fire, PressController, menuPos, menuTpl, mediaActions,
  playMedia, playMessage, normItem, safeImage, type MenuPos,
} from './shared';
import type { Enqueue, HomeAssistant, JukeboxCardConfig, MaItem } from './types';

export interface Cat { type: string; label: string; one: string }
export const CATS: Cat[] = [
  { type: 'playlist', label: 'Playlists', one: 'playlist' },
  { type: 'album', label: 'Albums', one: 'album' },
  { type: 'artist', label: 'Artists', one: 'artist' },
  { type: 'track', label: 'Tracks', one: 'track' },
  { type: 'radio', label: 'Radio', one: 'station' },
  { type: 'podcast', label: 'Podcasts', one: 'podcast' },
  { type: 'audiobook', label: 'Audiobooks', one: 'audiobook' },
];
const SORTS = [
  { id: 'name', label: 'A–Z' },
  { id: 'timestamp_added_desc', label: 'Recently added' },
  { id: 'last_played_desc', label: 'Recently played' },
];
/** Radio gets a "Popular" (most played) sort first; get_library has no popularity order, play_count_desc is the closest. */
const RADIO_SORTS = [{ id: 'play_count_desc', label: 'Popular' }, ...SORTS];
const sortsFor = (type: string) => (type === 'radio' ? RADIO_SORTS : SORTS);
/** Search used to find stations when the library has none (Radio Browser stations are not in the MA library until added). */
const RADIO_FALLBACK_QUERY = 'radio';
/** mass_queue `page` is 0..1000. A first page shorter than this is taken as the whole list (no "load more" call). */
export const QUEUE_PAGE_MIN = 25;
export const QUEUE_PAGE_MAX = 1000;
const DRILL = new Set(['artist', 'album', 'playlist']);

interface Page { items: MaItem[]; offset: number; done: boolean; loading: boolean; error: string; src?: Src }
interface Detail {
  item: MaItem; type: string; tracks: MaItem[]; albums: MaItem[]; loading: boolean; error: string; approx: boolean;
  /** playlist paging (mass_queue get_playlist_tracks `page`) */
  page: number; more: boolean; loadingMore: boolean; firstLen: number;
}
/** Where the radio grid came from: the MA library, or a Radio Browser search because the library had no stations. */
type Src = 'library' | 'search';

/**
 * mass_queue get_{album,artist,playlist}_tracks item -> MA-like item.
 * Real shape (mass_queue 0.10.x): {media_title, media_content_id, duration (s, 0 = unknown), media_image ("" or https URL),
 * favorite, media_album_name, media_artist, position (playlists only, may be null)}; optional local_image_encoded.
 */
export function fromQueueTrack(t: any): MaItem {
  const dur = Number(t?.duration);
  const img = safeImage(t?.media_image) || safeImage(t?.image) || (t?.local_image_encoded ? `data:image/jpeg;base64,${t.local_image_encoded}` : '');
  return normItem({
    media_type: 'track', uri: t?.media_content_id ?? t?.uri ?? '', name: t?.media_title ?? t?.name ?? '',
    artists: t?.media_artist ? [{ name: t.media_artist }] : t?.artists, album: t?.media_album_name ? { name: t.media_album_name } : t?.album,
    image: img || null, duration: Number.isFinite(dur) && dur > 0 ? dur : undefined, favorite: !!t?.favorite,
    ...(typeof t?.position === 'number' ? { position: t.position } : {}),
  });
}
/** Unwrap {response:{tracks}} / {result:{response:{tracks}}} / {tracks} / [..] into card items. */
export function queueTracks(r: any): MaItem[] {
  const d = unwrap(r?.result ?? r);
  const raw = Array.isArray(d) ? d : Array.isArray(d?.tracks) ? d.tracks : [];
  return raw.map(fromQueueTrack).filter((t: MaItem) => t.uri && t.name);
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
export const libraryItems = (r: any): MaItem[] => {
  const d = unwrap(r);
  const items = Array.isArray(d?.items) ? d.items : Array.isArray(d) ? d : [];
  return items.filter((x: any) => x && x.uri && x.name).map(normItem).filter((x: MaItem) => x.name);
};
/** mass_queue config entry id: `mass_queue_entry_id`, or the 0.3.0 name `queue_config_entry_id`. Never the MA entry. */
export const queueEntryId = (c: JukeboxCardConfig) => c.mass_queue_entry_id || c.queue_config_entry_id || '';

export class JbBrowse extends LitElement {
  static properties = {
    hass: { attribute: false }, config: { attribute: false }, active: { type: Boolean },
    _cat: { state: true }, _fav: { state: true }, _sort: { state: true }, _pages: { state: true }, _avail: { state: true },
    _detail: { state: true }, _menu: { state: true }, _toast: { state: true },
  };
  hass?: HomeAssistant;
  config!: JukeboxCardConfig;
  active = false;
  private _cat = 'playlist';
  private _fav = false;
  private _sort = 'name';
  private _pages: Record<string, Page> = {};
  /** type -> has items (null = probing) */
  private _avail: Record<string, boolean | null> = {};
  private _detail: Detail | null = null;
  private _menu: { item: MaItem; type: string; pos: MenuPos } | null = null;
  private _toast = '';
  private _toastTimer?: number;
  private _probed = false;
  private press = new PressController<{ it: MaItem; type: string }>(this, (p) => this.play(p.it, p.type), (p, el) => this.openMenu(p.it, p.type, el));

  protected shouldUpdate(ch: PropertyValues) { return !(ch.size === 1 && ch.has('hass')); }
  protected willUpdate(ch: PropertyValues) {
    if ((ch.has('active') || ch.has('hass')) && this.active && this.hass && !this._probed) { this._probed = true; this.probe(); }
  }

  private get limit() { return Math.max(1, Math.min(500, this.config.browse_limit ?? 60)); }
  private key(type = this._cat, fav = this._fav, sort = this._sort) { return `${type}|${fav ? 1 : 0}|${sort}`; }
  private lib(data: Record<string, any>) {
    return this.hass!.callService('music_assistant', 'get_library', { config_entry_id: this.config.config_entry_id, ...data }, undefined, false, true);
  }

  /** One cheap get_library per type so empty categories (e.g. Radio with no radio provider) are hidden. */
  private async probe() {
    this._avail = Object.fromEntries(CATS.map((c) => [c.type, null]));
    await Promise.all(CATS.map(async (c) => {
      try {
        let n = libraryItems(await this.lib({ media_type: c.type, limit: 1 })).length;
        if (!n && c.type === 'radio') n = (await this.radioSearch(1)).length;
        this._avail = { ...this._avail, [c.type]: n > 0 };
      } catch { this._avail = { ...this._avail, [c.type]: false }; }
    }));
    const vis = this.visibleCats();
    if (!vis.some((c) => c.type === this._cat) && vis.length) this._cat = vis[0].type;
    this.load();
  }
  visibleCats() { return CATS.filter((c) => this._avail[c.type] !== false); }
  /** Radio Browser stations via music_assistant.search (used when the library has no radio). */
  private async radioSearch(limit: number): Promise<MaItem[]> {
    const r = unwrap(await this.hass!.callService('music_assistant', 'search',
      { config_entry_id: this.config.config_entry_id, name: RADIO_FALLBACK_QUERY, media_type: ['radio'], limit: Math.max(1, Math.min(100, limit)) },
      undefined, false, true)) ?? {};
    return (Array.isArray(r.radio) ? r.radio : []).filter((x: any) => x && x.uri && x.name).map(normItem).filter((x: MaItem) => x.name);
  }

  private async load(more = false) {
    if (!this.hass) return;
    const k = this.key(); const type = this._cat, fav = this._fav, sort = this._sort;
    const cur = this._pages[k];
    if (cur && (cur.loading || (!more) || cur.done)) return;
    const offset = cur ? cur.offset : 0;
    this._pages = { ...this._pages, [k]: { items: cur?.items ?? [], offset, done: false, loading: true, error: '' } };
    try {
      const data: Record<string, any> = { media_type: type, limit: this.limit, offset, order_by: sort };
      if (fav) data.favorite = true;
      let items = libraryItems(await this.lib(data));
      let src: Src = cur?.src ?? 'library';
      // Radio: an empty "Popular" (play_count) page can mean nothing was played yet -> retry A–Z; an empty library -> Radio Browser search.
      if (type === 'radio' && !offset && !items.length && !fav) {
        if (sort !== 'name') items = libraryItems(await this.lib({ ...data, order_by: 'name' }));
        if (!items.length) { items = await this.radioSearch(Math.min(100, this.limit)); src = 'search'; }
      }
      const prev = this._pages[k]?.items ?? [];
      const seen = new Set(prev.map((i) => i.uri));
      this._pages = { ...this._pages, [k]: { items: [...prev, ...items.filter((i) => !seen.has(i.uri))], offset: offset + items.length,
        done: src === 'search' || items.length < this.limit, loading: false, error: '', src } };
    } catch (err) {
      console.warn('[jukebox-card] get_library failed', err);
      this._pages = { ...this._pages, [k]: { items: cur?.items ?? [], offset, done: true, loading: false, error: 'Library unavailable. Check Music Assistant.' } };
    }
  }
  private ensure() { if (!this._pages[this.key()]) this.load(true); }
  private setCat(t: string) {
    this._cat = t; this._detail = null;
    if (!sortsFor(t).some((s) => s.id === this._sort)) this._sort = 'name';
    if (t === 'radio' && this._sort === 'name' && !this._sortTouched) this._sort = 'play_count_desc';
    this.ensure(); this.renderRoot.querySelector('.scroll')?.scrollTo({ top: 0 });
  }
  private _sortTouched = false;
  private setFav() { this._fav = !this._fav; this._detail = null; this.ensure(); }
  private cycleSort() {
    const L = sortsFor(this._cat); const i = L.findIndex((s) => s.id === this._sort);
    this._sort = L[(i + 1) % L.length].id; this._sortTouched = true; this.ensure();
  }
  private onScroll(e: Event) {
    this.press.cancel();
    const el = e.target as HTMLElement;
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 400) { if (!this._detail) this.load(true); else this.loadMoreTracks(); }
  }

  private toast(t: string) { this._toast = t; window.clearTimeout(this._toastTimer); this._toastTimer = window.setTimeout(() => (this._toast = ''), 2400); }
  async play(it: MaItem, type: string, enqueue: Enqueue = 'play', radio = false) {
    if (!this.hass) return;
    this._menu = null; this.press.release();
    try {
      const r = await playMedia(this.hass, this.config, it, type, enqueue, radio);
      this.toast(playMessage(this.hass, this.config, it, enqueue, radio));
      fire(this, 'jukebox-played', { item: it, ...r });
    } catch (err) { this.toast(`Couldn't play ${it.name}`); console.warn('[jukebox-card] play_media failed', err); }
  }
  private openMenu(it: MaItem, type: string, el: HTMLElement) {
    const root = this.renderRoot.querySelector('.bx') as HTMLElement;
    this._menu = { item: it, type, pos: menuPos(root, el, DRILL.has(type) ? 5 : type === 'radio' ? 3 : 4) };
  }

  // ---------- drill-down ----------
  private trackCall(svc: string, uri: string, page?: number) {
    const data: Record<string, any> = { config_entry_id: queueEntryId(this.config), uri };
    if (page !== undefined) data.page = Math.max(0, Math.min(QUEUE_PAGE_MAX, page));
    return this.hass!.callService('mass_queue', svc, data, undefined, false, true);
  }
  async openDetail(it: MaItem, type: string) {
    if (!this.hass) return;
    this._menu = null; this.press.release();
    const d: Detail = { item: it, type, tracks: [], albums: [], loading: true, error: '', approx: false, page: 0, more: false, loadingMore: false, firstLen: 0 };
    this._detail = d;
    const qid = queueEntryId(this.config);
    const name = it.name;
    const same = (a?: string, b?: string) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
    try {
      let tracks: MaItem[] = [], albums: MaItem[] = [], approx = false, more = false;
      if (qid) {
        const svc = type === 'artist' ? 'get_artist_tracks' : type === 'album' ? 'get_album_tracks' : 'get_playlist_tracks';
        // playlists can be thousands of tracks: ask for page 0 and fetch further pages on scroll; albums/artists come whole
        tracks = queueTracks(await this.trackCall(svc, it.uri, type === 'playlist' ? 0 : undefined));
        more = type === 'playlist' && tracks.length >= QUEUE_PAGE_MIN;
      }
      if (type === 'artist' || (!qid && type === 'album')) {
        const data: Record<string, any> = { config_entry_id: this.config.config_entry_id, name, limit: 25,
          media_type: type === 'artist' ? (qid ? ['album'] : ['album', 'track']) : ['track'] };
        if (type === 'album' && artistNames(it)) data.artist = artistNames(it).split(',')[0];
        const r = unwrap(await this.hass.callService('music_assistant', 'search', data, undefined, false, true)) ?? {};
        const by = (x: MaItem) => (x.artists ?? []).some((a: any) => same(a.name, name));
        if (type === 'artist') {
          albums = (r.albums ?? []).filter(by).map(normItem);
          if (!qid) { tracks = (r.tracks ?? []).filter(by).map(normItem); approx = true; }
        } else { tracks = (r.tracks ?? []).filter((t: MaItem) => same(t.album?.name, name)).map(normItem); approx = true; }
      }
      if (this._detail !== d) return;
      const err = !qid && type === 'playlist' ? 'Playlist tracks need mass_queue (set mass_queue_entry_id). Play or queue the whole playlist below.' : '';
      this._detail = { ...d, tracks, albums, approx, loading: false, error: err, more, firstLen: tracks.length };
      if (more) this.updateComplete.then(() => this.fillScreen());
    } catch (e) {
      console.warn('[jukebox-card] drill-down failed', e);
      if (this._detail === d) this._detail = { ...d, loading: false, error: 'Could not load tracks.' };
    }
  }
  /** If the first page does not fill the scroller there is no scroll event, so pull the next page now. */
  private fillScreen() {
    const el = this.renderRoot.querySelector('.scroll') as HTMLElement | null;
    if (el && this._detail?.more && el.scrollHeight <= el.clientHeight + 400) this.loadMoreTracks();
  }
  async loadMoreTracks() {
    const d = this._detail;
    if (!d || !d.more || d.loadingMore || d.type !== 'playlist' || !this.hass) return;
    const page = d.page + 1;
    if (page > QUEUE_PAGE_MAX) { this._detail = { ...d, more: false }; return; }
    const busy = { ...d, loadingMore: true };
    this._detail = busy;
    try {
      const got = queueTracks(await this.trackCall('get_playlist_tracks', d.item.uri, page));
      if (this._detail !== busy) return;
      const m = mergePage(d.tracks, got, d.firstLen);
      this._detail = { ...busy, tracks: m.tracks, more: m.more, page, loadingMore: false };
      if (m.more) this.updateComplete.then(() => this.fillScreen());
    } catch (e) {
      console.warn('[jukebox-card] playlist page failed', e);
      if (this._detail === busy) this._detail = { ...busy, more: false, loadingMore: false, error: 'Could not load more tracks.' };
    }
  }

  // ---------- render ----------
  private sub(it: MaItem, type: string) {
    if (type === 'track' || type === 'album') return [artistNames(it), type === 'track' ? it.album?.name : ''].filter(Boolean).join(' · ');
    if (type === 'playlist') return it.owner ?? '';
    return artistNames(it);
  }
  private tile(it: MaItem, type: string) {
    const p = this.press.handlers(it.uri, { it, type });
    const circ = type === 'artist';
    return html`<div class="tile ${circ ? 'artist' : ''} ${this.press.held === it.uri ? 'held' : ''}" data-uri=${it.uri} data-type=${type}
        @pointerdown=${p.down} @pointermove=${p.move} @pointerup=${p.up} @pointercancel=${p.cancel} @pointerleave=${p.cancel}
        @contextmenu=${(e: Event) => e.preventDefault()}>
      <div class="tw">${artTpl(it, circ ? 'big circ' : 'big')}${provTpl(it.uri, it.provider, it.media_type ?? type)}
        ${DRILL.has(type) ? html`<button class="mo open" tabindex="-1" aria-label="Open ${it.name}" @pointerdown=${noFocus}
          @click=${() => this.openDetail(it, type)}>${icon('open')}</button>` : nothing}</div>
      <b>${it.name}</b>${this.sub(it, type) ? html`<small>${this.sub(it, type)}</small>` : nothing}
    </div>`;
  }
  private row(it: MaItem, n?: number) {
    const p = this.press.handlers(it.uri, { it, type: 'track' });
    return html`<div class="row ${this.press.held === it.uri ? 'held' : ''}" data-uri=${it.uri} data-type="track"
        @pointerdown=${p.down} @pointermove=${p.move} @pointerup=${p.up} @pointercancel=${p.cancel} @pointerleave=${p.cancel}
        @contextmenu=${(e: Event) => e.preventDefault()}>
      ${n !== undefined ? html`<span class="n">${n}</span>` : artTpl(it, 'th')}
      <div class="rt"><b>${it.name}${it.version ? html` <i class="ver">${it.version}</i>` : nothing}</b><small>${this.sub(it, 'track')}</small></div>
      ${provTpl(it.uri, it.provider)}<span class="du">${fmtDur(it.duration)}</span>
      <button class="mo" tabindex="-1" aria-label="More options for ${it.name}" @pointerdown=${noFocus}
        @click=${(e: MouseEvent) => this.openMenu(it, 'track', (e.currentTarget as HTMLElement).closest('.row') as HTMLElement)}>${icon('more')}</button>
    </div>`;
  }

  private renderDetail(d: Detail) {
    const it = d.item;
    const cat = CATS.find((c) => c.type === d.type)!;
    return html`<div class="detail">
      <div class="dh">
        <button class="back" tabindex="-1" aria-label="Back" @pointerdown=${noFocus} @click=${() => (this._detail = null)}>${icon('back')}</button>
        ${artTpl(it, d.type === 'artist' ? 'dart circ' : 'dart')}
        <div class="dt"><span class="eyebrow">${cat.one}${providerLabel(it.uri) ? ` · ${providerLabel(it.uri)}` : ''}</span><h2>${it.name}</h2>
          <small>${this.sub(it, d.type)}</small>
          ${!d.loading && d.tracks.length ? html`<small class="meta" data-tracks=${d.tracks.length}>${this.meta(d)}</small>` : nothing}
          <div class="da">
            <button class="pbtn" data-action="play" tabindex="-1" @pointerdown=${noFocus} @click=${() => this.play(it, d.type)}>${icon('play')}Play</button>
            <button class="sbtn" data-action="add" tabindex="-1" @pointerdown=${noFocus} @click=${() => this.play(it, d.type, 'add')}>${icon('qadd')}Add to queue</button>
            <button class="sbtn" data-action="radio" tabindex="-1" @pointerdown=${noFocus} @click=${() => this.play(it, d.type, 'play', true)}>${icon('radio')}Radio</button>
          </div></div>
      </div>
      ${d.albums.length ? html`<h3 class="eyebrow">Albums</h3><div class="hs">${d.albums.map((a) => this.tile(a, 'album'))}</div>` : nothing}
      ${d.loading ? html`<div class="empty"><span>Loading…</span></div>` : nothing}
      ${d.error ? html`<div class="note">${d.error}</div>` : nothing}
      ${d.tracks.length ? html`<h3 class="eyebrow">Tracks${d.approx ? html` <em>matched by search</em>` : nothing}</h3>
        <div class="list">${d.tracks.map((t, i) => this.row(t, d.type === 'album' && !d.approx ? i + 1 : undefined))}</div>
        ${d.more || d.loadingMore ? html`<button class="sbtn more-t" data-action="more" tabindex="-1" ?disabled=${d.loadingMore} @pointerdown=${noFocus}
          @click=${() => this.loadMoreTracks()}>${d.loadingMore ? 'Loading more tracks…' : 'Load more tracks'}</button>` : nothing}`
        : !d.loading && !d.error ? html`<div class="empty"><span>No tracks found.</span></div>` : nothing}
    </div>`;
  }

  /** "9 tracks · 43 min" (a "+" while more playlist pages are pending). */
  private meta(d: Detail) {
    const secs = d.tracks.reduce((a, t) => a + (t.duration ?? 0), 0);
    const n = `${d.tracks.length}${d.more ? '+' : ''} track${d.tracks.length === 1 && !d.more ? '' : 's'}`;
    if (!secs) return n;
    const m = Math.round(secs / 60);
    return `${n} · ${m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`}`;
  }
  private renderGrid() {
    const pg = this._pages[this.key()];
    const cat = CATS.find((c) => c.type === this._cat)!;
    if (!pg || (pg.loading && !pg.items.length)) return html`<div class="empty"><span>Loading ${cat.label.toLowerCase()}…</span></div>`;
    if (pg.error && !pg.items.length) return html`<div class="empty"><b>Library unavailable</b><span>${pg.error}</span></div>`;
    if (!pg.items.length) return html`<div class="empty"><b>No ${this._fav ? 'favorite ' : ''}${cat.label.toLowerCase()}</b>
      <span>${this._fav ? 'Tap the heart on Now Playing to add favorites.' : 'Nothing in the library yet.'}</span></div>`;
    return this._cat === 'track'
      ? html`<div class="list">${pg.items.map((it) => this.row(it))}</div>`
      : html`${pg.src === 'search' ? html`<div class="note src" data-src="search">No stations in your library yet, showing Radio Browser results. Tap to play; long-press for more.</div>` : nothing}
        <div class="grid ${this._cat}" data-src=${pg.src ?? 'library'}>${pg.items.map((it) => this.tile(it, this._cat))}</div>
        ${pg.loading ? html`<div class="empty"><span>Loading more…</span></div>` : nothing}`;
  }

  render() {
    const cats = this.visibleCats();
    const sort = sortsFor(this._cat).find((s) => s.id === this._sort) ?? SORTS[0];
    const m = this._menu;
    return html`<div class="bx">
      <div class="bar">
        <div class="cats">${cats.map((c) => html`<button class="fc ${this._cat === c.type && !this._detail ? 'on' : ''}" data-cat=${c.type} tabindex="-1"
          @pointerdown=${noFocus} @click=${() => this.setCat(c.type)}>${c.label}</button>`)}</div>
        <button class="fc tog ${this._fav ? 'on' : ''}" data-cat="favorites" tabindex="-1" aria-pressed=${this._fav ? 'true' : 'false'}
          @pointerdown=${noFocus} @click=${() => this.setFav()}>${icon(this._fav ? 'heart' : 'heartline', 'i xs')}Favorites</button>
        <button class="fc tog sort" tabindex="-1" @pointerdown=${noFocus} @click=${() => this.cycleSort()}>${icon('sort', 'i xs')}${sort.label}</button>
      </div>
      <div class="scroll panel" @scroll=${this.onScroll}>${this._detail ? this.renderDetail(this._detail) : this.renderGrid()}</div>
      ${m ? menuTpl(m.pos, { item: m.item, sub: this.sub(m.item, m.type) || providerLabel(m.item.uri) },
        mediaActions((enq, radio) => this.play(m.item, m.type, enq, radio), DRILL.has(m.type) ? () => this.openDetail(m.item, m.type) : undefined, m.type === 'radio'),
        () => { this._menu = null; this.press.release(); }) : nothing}
      ${this._toast ? html`<div class="toast" role="status">${this._toast}</div>` : nothing}
    </div>`;
  }

  static styles = [tokens, base, mediaStyles, css`
    :host { display: block; height: 100%; min-height: 0; color: var(--_fg); font-family: var(--_font-body); }
    .bx { position: relative; height: 100%; display: flex; flex-direction: column; gap: 12px; padding: 14px var(--_pad) 12px; }
    .bar { display: flex; gap: 8px; align-items: center; min-width: 0; }
    .cats { display: flex; gap: 8px; overflow-x: auto; scrollbar-width: none; flex: 1; min-width: 0; }
    .cats::-webkit-scrollbar { display: none; }
    .fc { flex: none; display: inline-flex; align-items: center; gap: 6px; height: 42px; padding: 0 18px; border-radius: 999px; font-size: 15px; font-weight: 700;
      color: var(--_inactive); border: 1px solid #ffffff33; background: #00000055; white-space: nowrap; }
    .fc.on { background: var(--_active); color: var(--_on-accent); border-color: var(--_active); }
    .fc.tog { padding: 0 14px; font-size: 14px; }
    .scroll { flex: 1; min-height: 0; overflow-y: auto; scrollbar-width: none; overscroll-behavior: contain; padding: 16px; display: flex; flex-direction: column; gap: 14px; touch-action: pan-y; }
    .scroll::-webkit-scrollbar { display: none; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 18px 16px; }
    .tile { display: flex; flex-direction: column; gap: 4px; min-width: 0; border-radius: 12px; padding: 4px; cursor: pointer; }
    .tile.held { background: #ffffff1f; box-shadow: 0 0 0 1.5px #fff; }
    .tw { position: relative; }
    .big { width: 100%; height: auto; aspect-ratio: 1; border-radius: 10px; }
    .big.circ { border-radius: 50%; }
    .tw .pv { position: absolute; left: 8px; bottom: 8px; max-width: calc(100% - 16px); }
    .tile.artist .tw .pv { left: 50%; transform: translateX(-50%); bottom: 2px; }
    .tw .open { position: absolute; right: 6px; top: 6px; width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; background: #000000a0; color: #fff; }
    .tw .open .i { width: 20px; height: 20px; }
    .tile b { font-size: 14px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 4px; }
    .tile.artist b { text-align: center; }
    .tile small { font-size: 12px; color: var(--_muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .list { display: flex; flex-direction: column; }
    .row { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto 44px 40px; align-items: center; gap: 12px; min-height: 58px; padding: 0 4px; border-radius: 10px; cursor: pointer; }
    .row + .row { border-top: 1px solid var(--_divider); }
    .row.held { background: #ffffff1f; box-shadow: inset 0 0 0 1.5px #fff; }
    .row .n { text-align: center; color: var(--_inactive); font-size: 14px; font-variant-numeric: tabular-nums; }
    .rt { min-width: 0; display: flex; flex-direction: column; }
    .rt b { font-size: 15px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rt .ver { font-style: normal; font-weight: 500; color: var(--_muted); }
    .rt small { font-size: 13px; color: var(--_muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .meta { font-size: 13px !important; color: var(--_muted); font-variant-numeric: tabular-nums; }
    .more-t { align-self: center; min-width: 220px; justify-content: center; }
    .du { font-size: 13px; color: var(--_muted); text-align: right; font-variant-numeric: tabular-nums; }
    .mo { width: 40px; height: 40px; display: grid; place-items: center; color: var(--_inactive); }
    .hs { display: flex; gap: 14px; overflow-x: auto; scrollbar-width: none; padding: 2px; }
    .hs::-webkit-scrollbar { display: none; }
    .hs .tile { width: 140px; flex: none; }
    h3.eyebrow { font-size: 12px; color: var(--_muted); } h3 em { font-style: normal; font-weight: 600; letter-spacing: 0; text-transform: none; color: var(--_inactive); margin-left: 6px; }
    .detail { display: flex; flex-direction: column; gap: 14px; }
    .dh { display: grid; grid-template-columns: 44px auto minmax(0, 1fr); gap: 18px; align-items: center; }
    .back { width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; background: #ffffff14; align-self: start; }
    .dart { width: 150px; height: 150px; border-radius: 12px; }
    .dart.circ { border-radius: 50%; }
    .dt { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
    .dt .eyebrow { font-size: 11px; color: var(--_inactive); }
    .dt h2 { font-family: var(--_font-display); font-size: 30px; font-weight: 800; line-height: 1.1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dt small { color: var(--_muted); font-size: 15px; }
    .da { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 8px; }
    .pbtn, .sbtn { display: inline-flex; align-items: center; gap: 8px; height: 46px; padding: 0 18px; border-radius: 999px; font-weight: 700; }
    .pbtn { background: var(--_active); color: var(--_on-accent); }
    .sbtn { border: 1px solid #ffffff40; color: #fff; }
    .pbtn .i, .sbtn .i { width: 22px; height: 22px; }
    .note { font-size: 13px; color: var(--_muted); padding: 10px 12px; border-radius: 10px; border: 1px dashed #ffffff33; }
    @container np (max-width: 520px) {
      .bx { padding: 10px 12px 8px; gap: 10px; }
      .bar { flex-wrap: wrap; } .cats { flex-basis: 100%; order: 0; } .fc { height: 36px; padding: 0 13px; font-size: 13px; }
      .scroll { padding: 10px; }
      .grid { grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 12px 10px; }
      .tw .pv { font-size: 9px; left: 5px; bottom: 5px; }
      .row { grid-template-columns: 40px minmax(0, 1fr) auto 40px; gap: 8px; } .row .pv { display: none; } .row .du { font-size: 12px; } .th { width: 40px; height: 40px; }
      .dh { grid-template-columns: 40px minmax(0, 1fr); } .dart { width: 96px; height: 96px; } .dt { grid-column: 1 / -1; } .dt h2 { font-size: 24px; white-space: normal; }
      .dh .ar { grid-column: 2; }
      .hs .tile { width: 110px; }
    }
  `];
}
if (!customElements.get('jb-browse')) customElements.define('jb-browse', JbBrowse);
