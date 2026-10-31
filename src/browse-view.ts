import { LitElement, html, css, nothing, type PropertyValues } from 'lit';
import { tokens, base } from './styles';
import { icon } from './icons';
import { providerLabel } from './providers';
import {
  mediaStyles, noFocus, artTpl, provTpl, artistNames, fmtDur, unwrap, fire, PressController, menuPos, menuTpl, mediaActions, tapActions,
  playMedia, playMessage, normItem, drillable, canRadio, confirmTpl, type MenuAction, type MenuPos, type ConfirmState,
} from './shared';
import './detail-view';
import type { DetailEntry, JbDetail } from './detail-view';
export { fromQueueTrack, queueTracks, mergePage, queueEntryId, QUEUE_PAGE_MIN, QUEUE_PAGE_MAX } from './detail-view';
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

interface Page { items: MaItem[]; offset: number; done: boolean; loading: boolean; error: string; src?: Src }
/** Where the radio grid came from: the MA library, or a Radio Browser search because the library had no stations. */
type Src = 'library' | 'search';

export const libraryItems = (r: any): MaItem[] => {
  const d = unwrap(r);
  const items = Array.isArray(d?.items) ? d.items : Array.isArray(d) ? d : [];
  return items.filter((x: any) => x && x.uri && x.name).map(normItem).filter((x: MaItem) => x.name);
};
export class JbBrowse extends LitElement {
  static properties = {
    hass: { attribute: false }, config: { attribute: false }, active: { type: Boolean },
    _cat: { state: true }, _fav: { state: true }, _sort: { state: true }, _pages: { state: true }, _avail: { state: true },
    _stack: { state: true }, _menu: { state: true }, _toast: { state: true }, _confirm: { state: true },
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
  /** detail back stack (artist -> album -> ...); empty = the category grid */
  private _stack: DetailEntry[] = [];
  private _gridScroll = 0;
  private _menu: { item: MaItem; type: string; pos: MenuPos; actions: MenuAction[] } | null = null;
  private _toast = '';
  /** Replace queue / Start radio from the long-press menu wait here for Cancel / confirm */
  private _confirm: ConfirmState | null = null;
  private _toastTimer?: number;
  private _probed = false;
  /** Tap never plays: artists / albums / playlists (and podcasts with mass_queue) open their detail, everything else a sheet. */
  private press = new PressController<{ it: MaItem; type: string }>(this, (p, el) => this.tap(p.it, p.type, el), (p, el) => this.openMenu(p.it, p.type, el));

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
    this._cat = t; this._stack = [];
    if (!sortsFor(t).some((s) => s.id === this._sort)) this._sort = 'name';
    if (t === 'radio' && this._sort === 'name' && !this._sortTouched) this._sort = 'play_count_desc';
    this.ensure(); this.renderRoot.querySelector('.scroll')?.scrollTo({ top: 0 });
  }
  private _sortTouched = false;
  private setFav() { this._fav = !this._fav; this._stack = []; this.ensure(); }
  private cycleSort() {
    const L = sortsFor(this._cat); const i = L.findIndex((s) => s.id === this._sort);
    this._sort = L[(i + 1) % L.length].id; this._sortTouched = true; this.ensure();
  }
  private onScroll(e: Event) {
    this.press.scrolled();
    const el = e.target as HTMLElement;
    if (!this._stack.length && el.scrollTop + el.clientHeight > el.scrollHeight - 400) this.load(true);
  }

  private toast(t: string) { this._toast = t; window.clearTimeout(this._toastTimer); this._toastTimer = window.setTimeout(() => (this._toast = ''), 2400); }
  async play(it: MaItem, type: string, enqueue: Enqueue = 'play', radio = false) {
    if (!this.hass) return;
    this._menu = null; this.press.release();
    try {
      const r = await playMedia(this.hass, this.config, it, type, enqueue, radio);
      if (!r) return;
      this.toast(playMessage(this.hass, this.config, it, enqueue, radio));
      fire(this, 'jukebox-played', { item: it, ...r });
    } catch (err) { this.toast(`Couldn't play ${it.name}`); console.warn('[jukebox-card] play_media failed', err); }
  }
  private root() { return this.renderRoot.querySelector('.bx') as HTMLElement; }
  private tap(it: MaItem, type: string, el: HTMLElement) {
    if (drillable(type, this.config)) { this.press.release(); this.openDetail(it, type); return; }
    const actions = tapActions((enq) => this.play(it, type, enq), type === 'radio');
    this._menu = { item: it, type, pos: menuPos(this.root(), el, actions.length), actions };
  }
  private openMenu(it: MaItem, type: string, el: HTMLElement) {
    const ask = (kind: 'replace' | 'radio') => { this._menu = null; this.press.release(); this._confirm = { kind, item: it, run: () => this.play(it, type, 'replace', kind === 'radio') }; };
    const actions = mediaActions((enq) => this.play(it, type, enq), drillable(type, this.config) ? () => this.openDetail(it, type) : undefined, ask, canRadio(type, it));
    this._menu = { item: it, type, pos: menuPos(this.root(), el, actions.length), actions };
  }

  // ---------- drill-down (back stack) ----------
  /** Open a detail view on top of the current one (from the grid it starts the stack). Never plays. */
  openDetail(it: MaItem, type: string) {
    this._menu = null; this.press.release();
    if (!this._stack.length) this._gridScroll = (this.renderRoot.querySelector('.scroll') as HTMLElement | null)?.scrollTop ?? 0;
    this._stack = [...this._stack, { item: it, type }];
  }
  /** Back: the previous detail (its scroll position restored by jb-detail) or the grid at its old scroll position. */
  async back() {
    this._menu = null;
    this._stack = this._stack.slice(0, -1);
    if (!this._stack.length) {
      await this.updateComplete;
      const el = this.renderRoot.querySelector('.scroll') as HTMLElement | null;
      if (el) el.scrollTop = this._gridScroll;
    }
  }
  get detail(): JbDetail | null { return this.renderRoot.querySelector('jb-detail') as JbDetail | null; }
  private onNav(e: CustomEvent) {
    e.stopPropagation();
    if (e.detail.op === 'back') this.back(); else this.openDetail(e.detail.item, e.detail.type);
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
        ${drillable(type, this.config) ? html`<button class="mo open" tabindex="-1" aria-label="Open ${it.name}" @pointerdown=${noFocus}
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

  private renderGrid() {
    const pg = this._pages[this.key()];
    const cat = CATS.find((c) => c.type === this._cat)!;
    if (!pg || (pg.loading && !pg.items.length)) return html`<div class="empty"><span>Loading ${cat.label.toLowerCase()}…</span></div>`;
    if (pg.error && !pg.items.length) return html`<div class="empty"><b>Library unavailable</b><span>${pg.error}</span></div>`;
    if (!pg.items.length) return html`<div class="empty"><b>No ${this._fav ? 'favorite ' : ''}${cat.label.toLowerCase()}</b>
      <span>${this._fav ? 'Tap the heart on Now Playing to add favorites.' : 'Nothing in the library yet.'}</span></div>`;
    return this._cat === 'track'
      ? html`<div class="list">${pg.items.map((it) => this.row(it))}</div>`
      : html`${pg.src === 'search' ? html`<div class="note src" data-src="search">No stations in your library yet, showing Radio Browser results. Tap a station to play it.</div>` : nothing}
        <div class="grid ${this._cat}" data-src=${pg.src ?? 'library'}>${pg.items.map((it) => this.tile(it, this._cat))}</div>
        ${pg.loading ? html`<div class="empty"><span>Loading more…</span></div>` : nothing}`;
  }

  render() {
    const cats = this.visibleCats();
    const sort = sortsFor(this._cat).find((s) => s.id === this._sort) ?? SORTS[0];
    const m = this._menu;
    const top = this._stack[this._stack.length - 1];
    const cat = CATS.find((c) => c.type === this._cat)!;
    return html`<div class="bx">
      <div class="bar">
        <div class="cats">${cats.map((c) => html`<button class="fc ${this._cat === c.type && !top ? 'on' : ''}" data-cat=${c.type} tabindex="-1"
          @pointerdown=${noFocus} @click=${() => this.setCat(c.type)}>${c.label}</button>`)}</div>
        <button class="fc tog ${this._fav ? 'on' : ''}" data-cat="favorites" tabindex="-1" aria-pressed=${this._fav ? 'true' : 'false'}
          @pointerdown=${noFocus} @click=${() => this.setFav()}>${icon(this._fav ? 'heart' : 'heartline', 'i xs')}Favorites</button>
        <button class="fc tog sort" tabindex="-1" @pointerdown=${noFocus} @click=${() => this.cycleSort()}>${icon('sort', 'i xs')}${sort.label}</button>
      </div>
      ${top ? html`<jb-detail class="dv" .hass=${this.hass} .config=${this.config} .entry=${top}
          .trail=${[`Browse ${cat.label}`, ...this._stack.slice(0, -1).map((x) => x.item.name)]} @jb-nav=${this.onNav}></jb-detail>`
        : html`<div class="scroll panel" @scroll=${this.onScroll}>${this.renderGrid()}</div>`}
      ${m ? menuTpl(m.pos, { item: m.item, sub: this.sub(m.item, m.type) || providerLabel(m.item.uri) }, m.actions,
        () => { this._menu = null; this.press.release(); }) : nothing}
      ${confirmTpl(this._confirm, () => (this._confirm = null))}
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
    .du { font-size: 13px; color: var(--_muted); text-align: right; font-variant-numeric: tabular-nums; }
    .mo { width: 40px; height: 40px; display: grid; place-items: center; color: var(--_inactive); }
    .dv { flex: 1; min-height: 0; }
    .note { font-size: 13px; color: var(--_muted); padding: 10px 12px; border-radius: 10px; border: 1px dashed #ffffff33; }
    @container np (max-width: 520px) {
      .bx { padding: 10px 12px 8px; gap: 10px; }
      .bar { flex-wrap: wrap; } .cats { flex-basis: 100%; order: 0; } .fc { height: 36px; padding: 0 13px; font-size: 13px; }
      .scroll { padding: 10px; }
      .grid { grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 12px 10px; }
      .tw .pv { font-size: 9px; left: 5px; bottom: 5px; }
      .row { grid-template-columns: 40px minmax(0, 1fr) auto 40px; gap: 8px; } .row .pv { display: none; } .row .du { font-size: 12px; } .th { width: 40px; height: 40px; }
    }
  `];
}
if (!customElements.get('jb-browse')) customElements.define('jb-browse', JbBrowse);
