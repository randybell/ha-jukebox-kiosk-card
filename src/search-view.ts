import { LitElement, html, css, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { tokens, base } from './styles';
import { icon } from './icons';
import { providerLabel } from './providers';
import { SearchEngine } from './search-engine';
import {
  imageOf, normItem, mediaStyles, artTpl, provTpl, artistNames, fmtDur, fire, PressController, menuPos, menuTpl,
  playMedia, playMessage, drillable, canRadio, rowActsTpl, foldedActions, confirmTpl, type MenuAction, type MenuPos, type RowAct, type ConfirmState,
} from './shared';
import './detail-view';
import type { DetailEntry } from './detail-view';
import type { KeyDetail } from './keyboard';
import './keyboard';
import type { Enqueue, GroupKey, HomeAssistant, JukeboxCardConfig, MaItem, SearchResults } from './types';

const GROUPS: Array<{ key: GroupKey; label: string; type: string }> = [
  { key: 'artists', label: 'Artists', type: 'artist' },
  { key: 'albums', label: 'Albums', type: 'album' },
  { key: 'tracks', label: 'Tracks', type: 'track' },
  { key: 'playlists', label: 'Playlists', type: 'playlist' },
  { key: 'radio', label: 'Radio', type: 'radio' },
  { key: 'podcasts', label: 'Podcasts', type: 'podcast' },
  { key: 'audiobooks', label: 'Audiobooks', type: 'audiobook' },
];
const SEARCH_TYPES = ['artist', 'album', 'track', 'playlist', 'radio', 'audiobook', 'podcast'];
const RECENTS_KEY = 'jukebox-card:recents:v1';
const MAX_RECENTS = 8;
const MAX_QUERY = 60;

interface MenuState { item: MaItem; group: GroupKey; pos: MenuPos; actions: MenuAction[] }

export { imageOf };
/** Accept {response:{...}}, a bare dict, or an entity-keyed dict. */
export function normaliseResponse(r: any): SearchResults {
  // HA frontend callService -> {context, response}; raw WS -> {result: {response}}; bare dict also accepted.
  let d = r?.response ?? r?.result?.response ?? r ?? {};
  if (d && !GROUPS.some((g) => Array.isArray(d[g.key]))) {
    const inner = Object.values(d).find((v: any) => v && typeof v === 'object' && GROUPS.some((g) => Array.isArray(v[g.key])));
    if (inner) d = inner;
  }
  const out: SearchResults = {};
  for (const g of GROUPS) if (Array.isArray(d[g.key])) out[g.key] = d[g.key].filter((x: any) => x && x.uri && x.name).map(normItem).filter((x: MaItem) => x.name);
  return out;
}

export class JbSearch extends LitElement {
  static properties = {
    hass: { attribute: false },
    config: { attribute: false },
    active: { type: Boolean },
    _query: { state: true },
    _results: { state: true },
    _shownQuery: { state: true },
    _loading: { state: true },
    _filter: { state: true },
    _menu: { state: true },
    _kbHidden: { state: true },
    _recents: { state: true },
    _error: { state: true },
    _toast: { state: true },
    _stack: { state: true },
    _confirm: { state: true },
    _sel: { state: true },
  };
  hass?: HomeAssistant;
  config!: JukeboxCardConfig;
  active = false;
  private _query = '';
  private _results: SearchResults | null = null;
  private _shownQuery = '';
  private _loading = false;
  private _filter: GroupKey | 'all' = 'all';
  private _menu: MenuState | null = null;
  private _kbHidden = false;
  private _recents: string[] = [];
  private _error = '';
  private _toast = '';
  private _toastTimer?: number;
  /** detail back stack shown over the results (artist -> album -> ...); empty = results */
  private _stack: DetailEntry[] = [];
  /** Replace queue / Start radio wait here for Cancel or Replace (guests use the kiosk: never clear the queue silently) */
  private _confirm: ConfirmState | null = null;
  /** a tapped track / station row is only highlighted; its row icons do the playing */
  private _sel = '';
  private _resScroll = 0;
  private _kbBefore = false;
  /** A row tap never plays: artists / albums / playlists (podcasts with mass_queue) open a detail, anything else is highlighted. */
  private press = new PressController<{ it: MaItem; g: GroupKey }>(this, (p) => this.tap(p.it, p.g), (p) => this.tap(p.it, p.g));
  private _chipTimer?: number;
  private _chipFired = false;
  private _seqShown = 0;

  engine = new SearchEngine({
    fetch: (q, limit) => this.fetchSearch(q, limit),
    onResults: (q, res, info) => {
      this._seqShown = info.seq;
      this._results = res;
      this._shownQuery = res ? q : '';
      this._error = '';
      if (res && this._filter !== 'all' && !res[this._filter]?.length) this._filter = 'all';
      this.dispatchEvent(new CustomEvent('jukebox-search-results', {
        detail: { query: q, seq: info.seq, cached: info.cached, count: res ? this.count(res) : 0 }, bubbles: true, composed: true,
      }));
    },
    onLoading: (l) => { this._loading = l; },
    onError: (q, err) => {
      this._error = 'Search unavailable. Check Music Assistant.';
      // eslint-disable-next-line no-console
      console.warn('[jukebox-card] search failed for', q, err);
    },
  });

  connectedCallback() {
    super.connectedCallback();
    this._recents = this.loadRecents();
    window.addEventListener('keydown', this.onHwKey, true);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this.onHwKey, true);
  }

  protected willUpdate(changed: PropertyValues) {
    if (changed.has('config') && this.config) {
      this.engine.setLimit(this.config.limit ?? 8);
      this.engine.setSlowMs(this.config.slow_ms ?? 800);
    }
  }

  // ---------- data ----------
  private async fetchSearch(name: string, limit: number): Promise<SearchResults> {
    if (!this.hass) throw new Error('hass not ready');
    const data: Record<string, any> = {
      config_entry_id: this.config.config_entry_id,
      name,
      limit,
      media_type: SEARCH_TYPES,
      library_only: this.config.library_only ?? false,
    };
    const r = await this.hass.callService('music_assistant', 'search', data, undefined, false, true);
    return normaliseResponse(r);
  }

  private count(r: SearchResults) { return GROUPS.reduce((n, g) => n + (r[g.key]?.length ?? 0), 0); }

  // ---------- query editing ----------
  private setQuery(q: string) {
    q = q.slice(0, MAX_QUERY).replace(/^\s+/, '');
    if (q === this._query) return;
    this._query = q;
    this._menu = null; this._confirm = null; this._sel = '';
    // typing is a new search: leave any detail view (results update on every keystroke, no debounce)
    if (this._stack.length) this.closeDetails(false);
    this.engine.query(q); // every keystroke, from 1 character, including backspace
  }
  private onKey = (e: CustomEvent<KeyDetail>) => {
    const d = e.detail;
    if (d.type === 'char') this.setQuery(this._query + d.value);
    else if (d.type === 'backspace') this.setQuery(this._query.slice(0, -1));
    else if (d.type === 'clear') this.setQuery('');
    else if (d.type === 'hide') this._kbHidden = true;
  };

  /** Hardware keyboard (USB/BT keyboard, or desktop testing). */
  private onHwKey = (e: KeyboardEvent) => {
    if (!this.active || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    const path = e.composedPath() as HTMLElement[];
    if (path.some((n) => n instanceof HTMLElement && (n.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName)))) return;
    let handled = true;
    if (e.key === 'Backspace') this.setQuery(this._query.slice(0, -1));
    else if (e.key === 'Escape') { if (this._confirm) this._confirm = null; else if (this._menu) this.closeMenu(); else if (this._stack.length) this.back(); else this.setQuery(''); }
    else if (e.key === 'Enter') this.openTop();
    else if (e.key.length === 1 && /[\p{L}\p{N}\p{P}\p{S} ]/u.test(e.key)) this.setQuery(this._query + e.key.toUpperCase());
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };

  // ---------- recents ----------
  private loadRecents(): string[] {
    try { const v = JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, MAX_RECENTS) : []; }
    catch { return []; }
  }
  private saveRecents() { try { localStorage.setItem(RECENTS_KEY, JSON.stringify(this._recents)); } catch { /* private mode */ } }
  private addRecent(q: string) {
    q = q.trim(); if (!q) return;
    this._recents = [q, ...this._recents.filter((r) => r.toLowerCase() !== q.toLowerCase())].slice(0, MAX_RECENTS);
    this.saveRecents();
  }
  private removeRecent(q: string) { this._recents = this._recents.filter((r) => r !== q); this.saveRecents(); }

  // ---------- playback ----------
  private mediaType(it: MaItem, g: GroupKey) { return GROUPS.find((x) => x.key === g)?.type ?? it.media_type ?? 'track'; }

  async play(it: MaItem, g: GroupKey, enqueue: Enqueue = 'play', radio = false) {
    if (!this.hass) return;
    this.closeMenu();
    this.addRecent(this._shownQuery || this._query);
    try {
      const r = await playMedia(this.hass, this.config, it, this.mediaType(it, g), enqueue, radio);
      if (!r) return;
      this.toast(playMessage(this.hass, this.config, it, enqueue, radio));
      fire(this, 'jukebox-played', { item: it, ...r });
    } catch (err) {
      this.toast(`Couldn't play ${it.name}`);
      console.warn('[jukebox-card] play_media failed', err);
    }
  }
  /** Hardware Enter: act on the first result as a tap would (open it, or highlight it). Never plays by itself. */
  private openTop() {
    const r = this._results; if (!r || this._stack.length || this._menu || this._confirm) return;
    for (const g of GROUPS) {
      const it = r[g.key]?.[0];
      if (it) { this.tap(it, g.key); return; }
    }
  }
  private toast(t: string) {
    this._toast = t; window.clearTimeout(this._toastTimer);
    this._toastTimer = window.setTimeout(() => (this._toast = ''), 2400);
  }

  // ---------- taps, menus, detail stack ----------
  private root() { return this.renderRoot.querySelector('.sx') as HTMLElement; }
  private tap(it: MaItem, g: GroupKey) {
    const type = this.mediaType(it, g);
    if (drillable(type, this.config)) { this.openDetail(it, type); return; }
    this._sel = this._sel === it.uri ? '' : it.uri;
  }
  /** Row icons. Add / Play next run at once; Replace queue and Start radio (enqueue replace) ask first. */
  private rowAct(it: MaItem, g: GroupKey, a: RowAct | 'more', el: HTMLElement) {
    const type = this.mediaType(it, g);
    const ask = (k: RowAct) => {
      this.closeMenu();
      if (k === 'add' || k === 'next') { this.play(it, g, k); return; }
      this._confirm = { kind: k, item: it, run: () => this.play(it, g, 'replace', k === 'radio') };
    };
    if (a === 'more') this.showMenu(it, g, el.closest('.row') as HTMLElement, foldedActions(canRadio(type, it), ask));
    else ask(a);
  }
  private showMenu(it: MaItem, g: GroupKey, anchor: HTMLElement | null, actions: MenuAction[]) {
    this.press.held = it.uri;
    this._menu = { item: it, group: g, pos: menuPos(this.root(), anchor, actions.length), actions };
    fire(this, 'jukebox-menu', { item: it });
  }
  private closeMenu() { this._menu = null; this.press.release(); }
  /** Push a detail view over the results. On a phone the on-screen keyboard is tucked away while browsing it. */
  openDetail(it: MaItem, type: string) {
    this.closeMenu(); this._confirm = null;
    if (!this._stack.length) {
      this._resScroll = (this.renderRoot.querySelector('.res .scroll') as HTMLElement | null)?.scrollTop ?? 0;
      this._kbBefore = this._kbHidden;
      this._kbHidden = true;
      this.addRecent(this._shownQuery || this._query);
    }
    this._stack = [...this._stack, { item: it, type }];
  }
  async back() {
    this.closeMenu();
    this._stack = this._stack.slice(0, -1);
    if (!this._stack.length) await this.closeDetails(true);
  }
  private async closeDetails(restore: boolean) {
    this._stack = [];
    this._kbHidden = this._kbBefore;
    if (!restore) return;
    await this.updateComplete;
    const el = this.renderRoot.querySelector('.res .scroll') as HTMLElement | null;
    if (el) el.scrollTop = this._resScroll;
  }
  private onNav(e: CustomEvent) {
    e.stopPropagation();
    if (e.detail.op === 'back') this.back(); else this.openDetail(e.detail.item, e.detail.type);
  }

  // ---------- render ----------
  private sub(it: MaItem, g: GroupKey) {
    if (g === 'tracks') return [artistNames(it), it.album?.name].filter(Boolean).join(' · ');
    if (g === 'artists') return 'Artist';
    if (g === 'albums') return ['Album', artistNames(it)].filter(Boolean).join(' · ');
    if (g === 'playlists') return ['Playlist', it.owner].filter(Boolean).join(' · ');
    if (g === 'radio') return it.metadata && (it.metadata as any).description ? (it.metadata as any).description : 'Radio station';
    if (g === 'podcasts') return ['Podcast', (it as any).publisher ?? artistNames(it)].filter(Boolean).join(' · ');
    if (g === 'audiobooks') return ['Audiobook', artistNames(it)].filter(Boolean).join(' · ');
    return artistNames(it);
  }

  /** One result row: art, title, subtitle (provider badge + artist / type), duration, and the row icons. */
  private row(it: MaItem, g: GroupKey) {
    const type = this.mediaType(it, g);
    const drill = drillable(type, this.config);
    const p = this.press.handlers(it.uri, { it, g });
    return html`<div class="row ${drill ? 'drill' : ''} ${this.press.held === it.uri ? 'held' : ''} ${this._sel === it.uri ? 'sel' : ''}"
        data-uri=${it.uri} data-group=${g} data-type=${type} aria-label=${drill ? `Open ${it.name}` : it.name}
        @pointerdown=${p.down} @pointermove=${p.move} @pointerup=${p.up} @pointercancel=${p.cancel} @pointerleave=${p.cancel}
        @contextmenu=${(e: Event) => e.preventDefault()}>
      ${artTpl(it, g === 'artists' ? 'th circ' : 'th')}
      <div class="rt"><b>${it.name}${it.version ? html` <i class="ver">${it.version}</i>` : nothing}</b>
        <small>${provTpl(it.uri, it.provider, it.media_type)}${it.duration ? html`<span class="du2">${fmtDur(it.duration)}</span>` : nothing}<span class="st">${this.sub(it, g)}</span></small></div>
      <span class="du">${fmtDur(it.duration)}</span>
      ${rowActsTpl(it, canRadio(type, it), (a, el) => this.rowAct(it, g, a, el))}
    </div>`;
  }

  private group(g: (typeof GROUPS)[number], items: MaItem[], full: boolean): TemplateResult {
    return html`<div class="grp ${g.key}">
      <h3>${g.label}<em>${items.length}</em>${!full ? html`<button class="sa" tabindex="-1"
        @pointerdown=${(e: PointerEvent) => e.preventDefault()} @click=${() => (this._filter = g.key)}>See all</button>` : nothing}</h3>
      <div class="list">${items.map((it) => this.row(it, g.key))}</div>
    </div>`;
  }

  private renderResults() {
    const r = this._results;
    if (!this._query && !r) {
      return html`<div class="empty"><b>Start typing</b><span>Results update on every key, across every music provider.</span></div>`;
    }
    if (!r) return html`<div class="empty"><span>Searching…</span></div>`;
    if (!this.count(r)) return html`<div class="empty"><b>No results for “${this._shownQuery}”</b><span>Try fewer letters or another spelling.</span></div>`;
    if (this._filter !== 'all') {
      const g = GROUPS.find((x) => x.key === this._filter)!;
      return this.group(g, r[g.key] ?? [], true);
    }
    return html`${GROUPS.filter((g) => r[g.key]?.length).map((g) => this.group(g, r[g.key]!, false))}`;
  }

  private renderMenu() {
    const m = this._menu; if (!m) return nothing;
    return menuTpl(m.pos, { item: m.item, sub: this.sub(m.item, m.group) || providerLabel(m.item.uri) }, m.actions, () => this.closeMenu());
  }

  render() {
    const r = this._results;
    const count = r ? this.count(r) : 0;
    const present = r ? GROUPS.filter((g) => r[g.key]?.length) : [];
    const status = this._error ? this._error
      : !this._query ? 'Type to search all providers'
      : !r ? 'Searching…'
      : count ? `${count} result${count === 1 ? '' : 's'} for “${this._shownQuery}” · all providers`
      : `No results for “${this._shownQuery}”`;
    return html`
      <div class="sx ${this._kbHidden ? 'kb-hidden' : ''}">
        <div class="qwrap">
          <div class="qbar" @pointerdown=${(e: PointerEvent) => { e.preventDefault(); this._kbHidden = false; }}>
            ${icon('search', 'i qi')}
            <div class="q" role="searchbox" aria-label="Search music" aria-readonly="true" aria-live="polite" data-query=${this._query}>
              ${this._query ? html`<span class="qt">${this._query}</span>` : html`<span class="ph">Search artists, songs, radio…</span>`}<i class="caret" aria-hidden="true"></i>
            </div>
            ${this._query ? html`<button class="qx" tabindex="-1" aria-label="Clear search"
              @pointerdown=${(e: PointerEvent) => e.preventDefault()} @click=${() => this.setQuery('')}>${icon('close')}</button>` : nothing}
            <span class="hair ${this._loading ? 'on' : ''}" aria-hidden="true"></span>
          </div>
          <div class="qmeta" data-loading=${this._loading ? '1' : '0'}><span class="live ${this._loading ? 'busy' : ''}"></span>${status}</div>
        </div>
        ${this._recents.length ? html`<div class="recents" aria-label="Recent searches"><span class="rl">${icon('history', 'i xs')}Recent</span>
          ${this._recents.map((q) => html`<button class="chip" tabindex="-1"
              @pointerdown=${(e: PointerEvent) => { e.preventDefault(); this._chipFired = false; this._chipTimer = window.setTimeout(() => { this._chipFired = true; this.removeRecent(q); }, 700); }}
              @pointerup=${() => window.clearTimeout(this._chipTimer)} @pointerleave=${() => window.clearTimeout(this._chipTimer)}
              @click=${() => { if (!this._chipFired) this.setQuery(q.toUpperCase()); }}>${q}</button>`)}
        </div>` : html`<div class="recents"></div>`}
        <section class="res" aria-label="Search results" data-shown-query=${this._shownQuery} data-seq=${this._seqShown}>
          ${this._stack.length ? html`<jb-detail class="dv" .hass=${this.hass} .config=${this.config} .entry=${this._stack[this._stack.length - 1]}
              .trail=${[`Search “${this._shownQuery || this._query}”`, ...this._stack.slice(0, -1).map((x) => x.item.name)]} @jb-nav=${this.onNav}></jb-detail>`
          : html`${present.length > 1 ? html`<div class="filters">
            ${(['all', ...present.map((g) => g.key)] as Array<GroupKey | 'all'>).map((k) => html`<button class="fc ${this._filter === k ? 'on' : ''}" tabindex="-1"
              @pointerdown=${(e: PointerEvent) => e.preventDefault()} @click=${() => (this._filter = k)}>${k === 'all' ? 'All' : GROUPS.find((g) => g.key === k)!.label}</button>`)}
          </div>` : nothing}
          <div class="scroll" @scroll=${() => this.press.scrolled()}>${this.renderResults()}</div>`}
          ${this._toast ? html`<div class="toast" role="status">${this._toast}</div>` : nothing}
        </section>
        <jb-keyboard class="kbd" @jb-key=${this.onKey}></jb-keyboard>
        ${this._kbHidden ? html`<button class="kb-open" tabindex="-1" aria-label="Show keyboard"
          @pointerdown=${(e: PointerEvent) => e.preventDefault()} @click=${() => (this._kbHidden = false)}>${icon('keyboard')}<span>Keyboard</span></button>` : nothing}
        ${this.renderMenu()}
        ${confirmTpl(this._confirm, () => (this._confirm = null))}
      </div>`;
  }

  static styles = [tokens, base, mediaStyles, css`
    :host { display: block; height: 100%; min-height: 0; color: var(--_fg); font-family: var(--_font-body); }
    .sx {
      position: relative; z-index: 1; height: 100%; display: grid; gap: 12px; padding: 14px var(--_pad) 12px;
      grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto minmax(0, 1fr) auto;
      grid-template-areas: "q" "rec" "res" "kb";
      --kh: 60px; --kgap: 8px; --kfs: 22px;
    }
    .qwrap { grid-area: q; min-width: 0; } .recents { grid-area: rec; } .res { grid-area: res; } .kbd { grid-area: kb; }
    .sx.kb-hidden .kbd { display: none; }
    .qbar {
      position: relative; display: flex; align-items: center; gap: 12px; height: 60px; padding: 0 8px 0 18px; border-radius: 16px;
      background: var(--jb-panel-solid, #00000080); border: 1.5px solid #ffffffd9; -webkit-backdrop-filter: var(--jb-panel-filter, blur(14px)); backdrop-filter: var(--jb-panel-filter, blur(14px)); overflow: hidden;
    }
    .qi { width: 26px; height: 26px; color: #fff; }
    .q { flex: 1; min-width: 0; display: flex; align-items: center; justify-content: flex-start; font-size: 26px; font-weight: 700; letter-spacing: .06em;
      white-space: pre; overflow: hidden; user-select: none; -webkit-user-select: none; }
    .q .qt { overflow: hidden; text-overflow: clip; direction: ltr; }
    .q .ph { font-size: 18px; font-weight: 600; letter-spacing: 0; color: var(--_inactive); order: 2; margin-left: 6px; overflow: hidden; text-overflow: ellipsis; }
    .caret { display: inline-block; flex: none; width: 3px; height: 30px; margin-left: 3px; background: #fff; border-radius: 2px; animation: blink 1.06s steps(1) infinite; }
    @keyframes blink { 0%, 55% { opacity: 1 } 56%, 100% { opacity: 0 } }
    .qx { width: 44px; height: 44px; flex: none; border-radius: 50%; display: grid; place-items: center; color: var(--_inactive); background: #ffffff14; }
    .qx .i { width: 22px; height: 22px; }
    /* loading hairline: 2px white at ~60% under the query text, no blank flash */
    .hair { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; overflow: hidden; opacity: 0; transition: opacity 120ms; pointer-events: none; }
    .hair::before { content: ""; position: absolute; top: 0; bottom: 0; width: 40%; left: -40%; background: rgba(255, 255, 255, .6); animation: hair 900ms ease-in-out infinite; }
    .hair.on { opacity: 1; }
    @keyframes hair { from { left: -40% } to { left: 100% } }
    .qmeta { display: flex; align-items: center; gap: 8px; margin: 7px 4px 0; font-size: 13px; color: var(--_muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .live { width: 7px; height: 7px; border-radius: 50%; background: #fff; box-shadow: 0 0 0 3px #ffffff33; flex: none; }
    .live.busy { animation: pulse 800ms ease-in-out infinite alternate; }
    @keyframes pulse { from { opacity: 1 } to { opacity: .35 } }
    .recents { display: flex; align-items: center; gap: 8px; overflow-x: auto; scrollbar-width: none; white-space: nowrap; min-width: 0; min-height: 0;
      -webkit-mask-image: linear-gradient(90deg, #000 85%, transparent); mask-image: linear-gradient(90deg, #000 85%, transparent); }
    .recents::-webkit-scrollbar { display: none; }
    .recents:empty { display: none; }
    .rl { display: flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--_inactive); flex: none; }
    .chip { flex: none; height: 36px; padding: 0 14px; border-radius: 999px; font-size: 14px; font-weight: 600; color: #fff; background: #ffffff14; border: 1px solid #ffffff2e; }
    .res { position: relative; min-height: 0; display: flex; flex-direction: column; gap: 10px; min-width: 0; container: res / inline-size; }
    .filters { display: flex; gap: 8px; overflow-x: auto; scrollbar-width: none; flex: none; }
    .filters::-webkit-scrollbar { display: none; }
    .fc { flex: none; height: 34px; padding: 0 14px; border-radius: 999px; font-size: 13px; font-weight: 700; color: var(--_inactive); border: 1px solid #ffffff33; }
    .fc.on { background: var(--_active); color: var(--_on-accent); border-color: var(--_active); }
    .scroll { min-height: 0; flex: 1; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: none; display: flex; flex-direction: column; gap: 14px;
      padding: 12px 14px 24px; border-radius: var(--_radius); background: var(--_surface); border: 1px solid var(--_surface-border);
      -webkit-backdrop-filter: var(--jb-panel-filter, blur(14px)); backdrop-filter: var(--jb-panel-filter, blur(14px)); touch-action: pan-y; }
    .scroll::-webkit-scrollbar { display: none; }
    .dv { flex: 1; min-height: 0; }
    .grp { min-width: 0; }
    h3 { display: flex; align-items: baseline; gap: 8px; font-size: 12px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; margin-bottom: 8px; }
    h3 em { font-style: normal; font-weight: 600; color: var(--_inactive); letter-spacing: 0; }
    h3 .sa { margin-left: auto; font-size: 12px; font-weight: 600; letter-spacing: 0; text-transform: none; color: var(--_inactive); padding: 4px 0 4px 12px; }
    .kb-open { position: absolute; right: var(--_pad); bottom: 16px; z-index: 5; display: flex; align-items: center; gap: 8px; height: 48px; padding: 0 18px;
      border-radius: 999px; background: var(--_active); color: var(--_on-accent); font-weight: 700; box-shadow: 0 10px 30px #000a; }
    /* while the floating Keyboard pill shows, lists (results and detail views) get room below their last row so nothing hides under it */
    .sx.kb-hidden { --jb-fab-space: 72px; }
    /* landscape: query + recents + keyboard on the left, results on the right */
    @container np (orientation: landscape) and (min-width: 700px) {
      .sx { grid-template-columns: minmax(400px, 40%) minmax(0, 1fr); grid-template-rows: auto auto 1fr; column-gap: clamp(16px, 2.5cqw, 32px);
        grid-template-areas: "q res" "rec res" "kb res";
        --kh: clamp(56px, calc((100cqh - 200px) / 5 - 12px), 88px); --kgap: 10px; --kfs: clamp(22px, 2cqw, 26px); }
      .kbd { align-self: end; --jb-kb-handle-display: none; }
      .sx.kb-hidden .kbd { display: block; }
      .kb-open { display: none; }
      .sx.kb-hidden { --jb-fab-space: 0px; }
    }
    @container np (orientation: landscape) and (max-height: 520px) {
      .sx { --kh: 46px; --kgap: 6px; } .recents { display: none; }
    }
    /* very short landscape (phone on its side under the HA toolbar): keyboard alone on the left at full height,
       query above the results on the right, keys sized to the space so no row is clipped */
    @container np (orientation: landscape) and (min-width: 700px) and (max-height: 400px) {
      .sx { grid-template-rows: auto minmax(0, 1fr); grid-template-areas: "kb q" "kb res"; row-gap: 8px; padding-top: 8px; padding-bottom: 8px;
        --kgap: 4px; --kh: clamp(28px, calc((100cqh - 50px) / 5 - 1px), 46px); }
      .kbd { align-self: center; }
      .qbar { height: 48px; } .qmeta { margin-top: 4px; }
    }
    /* phone */
    @container np (max-width: 520px) {
      .sx { --kh: 44px; --kgap: 5px; --kfs: 19px; gap: 9px; padding: 10px 12px 8px; }
      .qbar { height: 50px; padding-left: 14px; } .q { font-size: 21px; } .caret { height: 24px; } .q .ph { font-size: 15px; }
      .qmeta { font-size: 12px; margin-top: 5px; }
      .chip { height: 32px; font-size: 13px; padding: 0 12px; }
      .kbd { --jb-kb-handle-h: 22px; --jb-kb-handle-label: none; }
      .scroll { padding: 10px; gap: 12px; }
      .fc { height: 30px; padding: 0 11px; font-size: 12px; }
    }
    .sx.kb-hidden .res .scroll { padding-bottom: calc(10px + var(--jb-fab-space, 0px)); scroll-padding-bottom: var(--jb-fab-space, 0px); }
  `];
}
if (!customElements.get('jb-search')) customElements.define('jb-search', JbSearch);
