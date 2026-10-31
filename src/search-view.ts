import { LitElement, html, css, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { tokens, base } from './styles';
import { icon } from './icons';
import { providerLabel } from './providers';
import { SearchEngine } from './search-engine';
import { localRect, imageOf, normItem } from './shared';
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
const LONG_PRESS_MS = 500;
const MOVE_CANCEL_PX = 10;
const MAX_QUERY = 60;

interface MenuState { item: MaItem; group: GroupKey; sheet: boolean; top: number; right: number; up: boolean }

const ART = [
  'linear-gradient(135deg,#ff2e7e,#ff9a3d)', 'linear-gradient(135deg,#3b2cff,#00d4c4)', 'linear-gradient(135deg,#ffd23f,#ff4f8b)',
  'linear-gradient(135deg,#00b37e,#1e3cff)', 'linear-gradient(135deg,#c42fd8,#ffd23f)', 'linear-gradient(135deg,#ff7a3d,#7a2cff)',
];
const hash = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); };

export { imageOf };
const artistNames = (it: MaItem) =>
  it.artists?.length ? it.artists.map((a) => (typeof a === 'string' ? a : a.name)).join(', ')
    : typeof it.artist === 'string' ? it.artist : it.artist?.name ?? '';
const fmtDur = (s?: number) => (s && s > 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '');

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
    _held: { state: true },
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
  private _held = '';
  private _toastTimer?: number;
  private _press?: { uri: string; x: number; y: number; timer: number; fired: boolean; item: MaItem; group: GroupKey; el: HTMLElement };
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
    this._menu = null;
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
    else if (e.key === 'Escape') { if (this._menu) this._menu = null; else this.setQuery(''); }
    else if (e.key === 'Enter') this.playTop();
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
    const entity_id = this.config.entity || 'media_player.everywhere';
    const data: Record<string, any> = { media_id: it.uri, media_type: this.mediaType(it, g), enqueue };
    if (radio && data.media_type !== 'radio') data.radio_mode = true;
    this._menu = null;
    this.addRecent(this._shownQuery || this._query);
    const name = this.hass.states[entity_id]?.attributes?.friendly_name ?? 'Everywhere';
    const msg = radio ? `Starting radio from ${it.name}` : enqueue === 'next' ? `${it.name} plays next`
      : enqueue === 'add' ? `Added ${it.name} to the queue` : enqueue === 'replace' ? `Queue replaced with ${it.name}` : `Playing ${it.name} on ${name}`;
    try {
      await this.hass.callService('music_assistant', 'play_media', data, { entity_id });
      this.toast(msg);
      this.dispatchEvent(new CustomEvent('jukebox-played', { detail: { item: it, data, entity_id }, bubbles: true, composed: true }));
    } catch (err) {
      this.toast(`Couldn't play ${it.name}`);
      console.warn('[jukebox-card] play_media failed', err);
    }
  }
  private playTop() {
    const r = this._results; if (!r) return;
    for (const g of ['tracks', 'albums', 'artists', 'playlists', 'radio'] as GroupKey[]) {
      const it = r[g]?.[0]; if (it) { this.play(it, g); return; }
    }
  }
  private toast(t: string) {
    this._toast = t; window.clearTimeout(this._toastTimer);
    this._toastTimer = window.setTimeout(() => (this._toast = ''), 2400);
  }

  // ---------- press handling (tap = play, long-press = menu) ----------
  private onItemDown(e: PointerEvent, it: MaItem, g: GroupKey) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if ((e.target as HTMLElement).closest('.mo')) return;
    e.preventDefault(); // no focus, no text selection
    const el = e.currentTarget as HTMLElement;
    this.cancelPress();
    const timer = window.setTimeout(() => {
      if (!this._press) return;
      this._press.fired = true;
      this.openMenu(it, g, el);
    }, LONG_PRESS_MS);
    this._press = { uri: it.uri, x: e.clientX, y: e.clientY, timer, fired: false, item: it, group: g, el };
    this._held = it.uri;
  }
  private onItemMove(e: PointerEvent) {
    const p = this._press; if (!p || p.fired) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE_CANCEL_PX) this.cancelPress();
  }
  private onItemUp(e: PointerEvent) {
    const p = this._press; if (!p) return;
    window.clearTimeout(p.timer);
    this._press = undefined;
    if (!p.fired) { this._held = ''; this.play(p.item, p.group); }
    e.preventDefault();
  }
  private cancelPress() {
    if (this._press) { window.clearTimeout(this._press.timer); if (!this._press.fired) this._held = ''; }
    this._press = undefined;
  }
  private openMenu(it: MaItem, g: GroupKey, anchor: HTMLElement) {
    const root = this.renderRoot.querySelector('.sx') as HTMLElement;
    const rr = localRect(root);
    const ar = localRect(anchor);
    const sheet = rr.width <= 520;
    const menuH = (['artists', 'albums', 'playlists'].includes(g) ? 5 : 4) * 46 + 46;
    const below = ar.bottom - rr.top - 6;
    const up = below + menuH > rr.height - 8;
    const top = up ? Math.max(8, ar.top - rr.top - menuH + 6) : below;
    const right = Math.max(8, rr.right - ar.right + 44);
    this._held = it.uri;
    this._menu = { item: it, group: g, sheet, top, right, up };
    this.dispatchEvent(new CustomEvent('jukebox-menu', { detail: { item: it }, bubbles: true, composed: true }));
  }
  private openItem(it: MaItem, g: GroupKey) {
    this.closeMenu();
    this.dispatchEvent(new CustomEvent('jukebox-open', { detail: { item: it, type: this.mediaType(it, g) }, bubbles: true, composed: true }));
  }
  private closeMenu() { this._menu = null; this._held = ''; }

  // ---------- render ----------
  private pressAttrs(it: MaItem, g: GroupKey) {
    return {
      down: (e: PointerEvent) => this.onItemDown(e, it, g),
      move: (e: PointerEvent) => this.onItemMove(e),
      up: (e: PointerEvent) => this.onItemUp(e),
      cancel: () => this.cancelPress(),
    };
  }

  private art(it: MaItem, cls: string) {
    const src = imageOf(it);
    return html`<span class="ar ${cls}" style="background:${ART[hash(it.name) % ART.length]}">${src
      ? html`<img src=${src} alt="" loading="lazy" draggable="false" @error=${(e: Event) => ((e.target as HTMLElement).style.display = 'none')} />`
      : nothing}</span>`;
  }
  private prov(it: MaItem) {
    const p = it.media_type === 'radio' ? 'Radio' : providerLabel(it.uri, it.provider);
    return p ? html`<span class="pv">${p}</span>` : nothing;
  }
  private sub(it: MaItem, g: GroupKey) {
    if (g === 'tracks') return [artistNames(it), it.album?.name].filter(Boolean).join(' · ');
    if (g === 'albums') return artistNames(it);
    if (g === 'playlists') return it.owner ?? '';
    if (g === 'radio') return it.metadata && (it.metadata as any).description ? (it.metadata as any).description : 'Live radio';
    return artistNames(it);
  }

  private tile(it: MaItem, g: GroupKey) {
    const p = this.pressAttrs(it, g);
    const circ = g === 'artists';
    return html`<div class="${circ ? 'ac' : 'al'} ${this._held === it.uri ? 'held' : ''}" data-uri=${it.uri} data-group=${g}
        @pointerdown=${p.down} @pointermove=${p.move} @pointerup=${p.up} @pointercancel=${p.cancel} @pointerleave=${p.cancel}
        @contextmenu=${(e: Event) => e.preventDefault()}>
      ${this.art(it, circ ? 'circ' : 'sq')}<b>${it.name}</b>${circ ? nothing : html`<small>${this.sub(it, g)}</small>`}${this.prov(it)}
    </div>`;
  }
  private row(it: MaItem, g: GroupKey) {
    const p = this.pressAttrs(it, g);
    return html`<div class="row ${this._held === it.uri ? 'held' : ''}" data-uri=${it.uri} data-group=${g}
        @pointerdown=${p.down} @pointermove=${p.move} @pointerup=${p.up} @pointercancel=${p.cancel} @pointerleave=${p.cancel}
        @contextmenu=${(e: Event) => e.preventDefault()}>
      ${this.art(it, 'th')}
      <div class="rt"><b>${it.name}${it.version ? html` <i class="ver">${it.version}</i>` : nothing}</b><small>${this.sub(it, g)}</small></div>
      ${this.prov(it)}<span class="du">${fmtDur(it.duration)}</span>
      <button class="mo" tabindex="-1" aria-label="More options for ${it.name}"
        @pointerdown=${(e: PointerEvent) => e.preventDefault()}
        @click=${(e: MouseEvent) => this.openMenu(it, g, (e.currentTarget as HTMLElement).closest('.row') as HTMLElement)}>${icon('more')}</button>
    </div>`;
  }

  private group(g: (typeof GROUPS)[number], items: MaItem[], full: boolean): TemplateResult {
    const tiles = g.key === 'artists' || g.key === 'albums';
    return html`<div class="grp ${g.key}">
      <h3>${g.label}<em>${items.length}</em>${!full ? html`<button class="sa" tabindex="-1"
        @pointerdown=${(e: PointerEvent) => e.preventDefault()} @click=${() => (this._filter = g.key)}>See all</button>` : nothing}</h3>
      ${tiles ? html`<div class="hs ${full ? 'wrap' : ''}">${items.map((it) => this.tile(it, g.key))}</div>`
        : html`<div class="list">${items.map((it) => this.row(it, g.key))}</div>`}
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
    const present = GROUPS.filter((g) => r[g.key]?.length);
    const main = present.filter((g) => !['playlists', 'radio'].includes(g.key));
    const pair = present.filter((g) => ['playlists', 'radio'].includes(g.key));
    return html`${main.map((g) => this.group(g, r[g.key]!, false))}
      ${pair.length ? html`<div class="pair">${pair.map((g) => this.group(g, r[g.key]!, false))}</div>` : nothing}`;
  }

  private renderMenu() {
    const m = this._menu; if (!m) return nothing;
    const it = m.item, g = m.group;
    const btn = (ic: string, label: string, act: () => void, id: string) =>
      html`<button class="mi" data-action=${id} tabindex="-1" role="menuitem" @pointerdown=${(e: PointerEvent) => e.preventDefault()} @click=${act}>${icon(ic)}${label}</button>`;
    const items = html`
      ${m.sheet ? btn('play', 'Play now', () => this.play(it, g, 'play'), 'play') : nothing}
      ${btn('qnext', 'Play next', () => this.play(it, g, 'next'), 'next')}
      ${btn('qadd', 'Add to queue', () => this.play(it, g, 'add'), 'add')}
      ${btn('swap', 'Replace queue', () => this.play(it, g, 'replace'), 'replace')}
      ${g === 'radio' ? nothing : btn('radio', 'Start radio', () => this.play(it, g, 'play', true), 'radio')}
      ${['artists', 'albums', 'playlists'].includes(g) ? btn('open', 'Open', () => this.openItem(it, g), 'open') : nothing}`;
    return html`<div class="scrim ${m.sheet ? 'dim' : ''}" @pointerdown=${(e: PointerEvent) => { e.preventDefault(); this.closeMenu(); }}></div>
      <div class="menu ${m.sheet ? 'sheet' : ''}" role="menu" aria-label="${it.name} options"
        style=${m.sheet ? '' : `top:${m.top}px;right:${m.right}px`}>
        <div class="mh">${m.sheet ? html`${this.art(it, 'th')}<span><b>${it.name}</b><small>${this.sub(it, g) || providerLabel(it.uri)}</small></span>` : html`Long-press · ${it.name}`}</div>
        ${items}
      </div>`;
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
          ${present.length > 1 ? html`<div class="filters">
            ${(['all', ...present.map((g) => g.key)] as Array<GroupKey | 'all'>).map((k) => html`<button class="fc ${this._filter === k ? 'on' : ''}" tabindex="-1"
              @pointerdown=${(e: PointerEvent) => e.preventDefault()} @click=${() => (this._filter = k)}>${k === 'all' ? 'All' : GROUPS.find((g) => g.key === k)!.label}</button>`)}
          </div>` : nothing}
          <div class="scroll" @scroll=${() => this.cancelPress()}>${this.renderResults()}</div>
          ${this._toast ? html`<div class="toast" role="status">${this._toast}</div>` : nothing}
        </section>
        <jb-keyboard class="kbd" @jb-key=${this.onKey}></jb-keyboard>
        ${this._kbHidden ? html`<button class="kb-open" tabindex="-1" aria-label="Show keyboard"
          @pointerdown=${(e: PointerEvent) => e.preventDefault()} @click=${() => (this._kbHidden = false)}>${icon('keyboard')}<span>Keyboard</span></button>` : nothing}
        ${this.renderMenu()}
      </div>`;
  }

  static styles = [tokens, base, css`
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
    .empty { margin: auto; display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center; color: var(--_muted); font-size: 14px; padding: 24px; }
    .empty b { color: var(--_fg); font-family: var(--_font-display); font-size: 18px; }
    .grp { min-width: 0; }
    h3 { display: flex; align-items: baseline; gap: 8px; font-size: 12px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; margin-bottom: 8px; }
    h3 em { font-style: normal; font-weight: 600; color: var(--_inactive); letter-spacing: 0; }
    h3 .sa { margin-left: auto; font-size: 12px; font-weight: 600; letter-spacing: 0; text-transform: none; color: var(--_inactive); padding: 4px 0 4px 12px; }
    .hs { display: flex; gap: 14px; overflow-x: auto; scrollbar-width: none; touch-action: pan-x pan-y; padding: 2px; }
    .hs::-webkit-scrollbar { display: none; }
    .hs.wrap { flex-wrap: wrap; overflow: visible; }
    .ar { position: relative; display: block; flex: none; overflow: hidden; box-shadow: 0 0 0 1px #ffffff1a; }
    .ar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
    .circ { width: 64px; height: 64px; border-radius: 50%; }
    .sq { width: 100px; height: 100px; border-radius: 10px; }
    .th { width: 44px; height: 44px; border-radius: 8px; }
    .ac { width: 96px; display: flex; flex-direction: column; align-items: center; gap: 4px; text-align: center; flex: none; border-radius: 12px; padding: 4px 0; cursor: pointer; user-select: none; -webkit-user-select: none; }
    .al { width: 100px; display: flex; flex-direction: column; gap: 3px; flex: none; border-radius: 12px; cursor: pointer; user-select: none; -webkit-user-select: none; }
    .ac b, .al b { font-size: 13px; font-weight: 700; width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .al small { font-size: 12px; color: var(--_muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ac.held, .al.held { background: #ffffff1f; box-shadow: 0 0 0 1.5px #fff; }
    .pv { display: inline-block; width: max-content; max-width: 100%; overflow: hidden; text-overflow: ellipsis; font-size: 10px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
      padding: 2px 7px; border-radius: 999px; color: var(--_prov-fg); border: 1px solid var(--_prov-border); background: var(--_prov-bg); white-space: nowrap; }
    .list { position: relative; display: flex; flex-direction: column; }
    .row { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto 40px 40px; align-items: center; gap: 12px; min-height: 56px; padding: 0 4px; border-radius: 10px;
      cursor: pointer; user-select: none; -webkit-user-select: none; }
    .row + .row { border-top: 1px solid var(--_divider); }
    .rt { min-width: 0; display: flex; flex-direction: column; }
    .rt b { font-size: 15px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rt .ver { font-style: normal; font-weight: 500; color: var(--_muted); }
    .rt small { font-size: 13px; color: var(--_muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .du { font-size: 13px; color: var(--_muted); text-align: right; font-variant-numeric: tabular-nums; }
    .mo { width: 40px; height: 40px; display: grid; place-items: center; color: var(--_inactive); }
    .row.held { background: #ffffff1f; box-shadow: inset 0 0 0 1.5px #fff; }
    .pair { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; }
    .pair .row { grid-template-columns: 44px minmax(0, 1fr) auto 40px; } .pair .du { display: none; }
    @container res (min-width: 620px) { .pair { grid-template-columns: 1fr 1fr; } }
    .toast { position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%); max-width: calc(100% - 24px); padding: 10px 16px; border-radius: 999px;
      background: var(--_active); color: var(--_on-accent); font-size: 14px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-shadow: 0 10px 30px #000a; z-index: 4; }
    .scrim { position: absolute; inset: -200px; z-index: 6; }
    .scrim.dim { background: #000000a0; }
    .menu { position: absolute; z-index: 7; width: 220px; padding: 6px; border-radius: 14px; background: #0a0a0af5; border: 1px solid #ffffff33; box-shadow: 0 20px 50px #000c; }
    .mh { font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--_inactive); padding: 6px 10px 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .mi { display: flex; align-items: center; gap: 12px; width: 100%; height: 46px; padding: 0 10px; border-radius: 9px; font-size: 15px; font-weight: 600; color: #fff; text-align: left; }
    .mi:active { background: #ffffff1f; }
    .mi .i { width: 22px; height: 22px; }
    .menu.sheet { left: 0; right: 0; bottom: 0; width: auto; border-radius: 20px 20px 0 0; padding: 10px 12px calc(14px + env(safe-area-inset-bottom)); }
    .menu.sheet .mh { display: flex; align-items: center; gap: 12px; text-transform: none; letter-spacing: 0; padding: 6px 6px 12px; border-bottom: 1px solid var(--_divider); margin-bottom: 6px; }
    .menu.sheet .mh span { display: flex; flex-direction: column; min-width: 0; }
    .menu.sheet .mh b { color: #fff; font-size: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .menu.sheet .mh small { font-size: 13px; font-weight: 500; color: var(--_muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .menu.sheet .mi { height: 52px; font-size: 16px; }
    .kb-open { position: absolute; right: var(--_pad); bottom: 16px; z-index: 5; display: flex; align-items: center; gap: 8px; height: 48px; padding: 0 18px;
      border-radius: 999px; background: var(--_active); color: var(--_on-accent); font-weight: 700; box-shadow: 0 10px 30px #000a; }
    /* landscape: query + recents + keyboard on the left, results on the right */
    @container np (orientation: landscape) and (min-width: 700px) {
      .sx { grid-template-columns: minmax(400px, 40%) minmax(0, 1fr); grid-template-rows: auto auto 1fr; column-gap: clamp(16px, 2.5cqw, 32px);
        grid-template-areas: "q res" "rec res" "kb res";
        --kh: clamp(56px, calc((100cqh - 200px) / 5 - 12px), 88px); --kgap: 10px; --kfs: clamp(22px, 2cqw, 26px); }
      .kbd { align-self: end; --jb-kb-handle-display: none; }
      .sx.kb-hidden .kbd { display: block; }
      .kb-open { display: none; }
    }
    @container np (orientation: landscape) and (max-height: 520px) {
      .sx { --kh: 46px; --kgap: 6px; } .recents { display: none; }
    }
    /* phone */
    @container np (max-width: 520px) {
      .sx { --kh: 44px; --kgap: 5px; --kfs: 19px; gap: 9px; padding: 10px 12px 8px; }
      .qbar { height: 50px; padding-left: 14px; } .q { font-size: 21px; } .caret { height: 24px; } .q .ph { font-size: 15px; }
      .qmeta { font-size: 12px; margin-top: 5px; }
      .chip { height: 32px; font-size: 13px; padding: 0 12px; }
      .kbd { --jb-kb-handle-h: 22px; --jb-kb-handle-label: none; }
      .scroll { padding: 10px; gap: 12px; }
      .circ { width: 54px; height: 54px; } .ac { width: 74px; } .sq { width: 84px; height: 84px; } .al { width: 84px; }
      .row { grid-template-columns: 40px minmax(0, 1fr) auto 32px; gap: 9px; } .row .du { display: none; } .th { width: 40px; height: 40px; }
      .pair .row { grid-template-columns: 40px minmax(0, 1fr) auto 32px; }
      .fc { height: 30px; padding: 0 11px; font-size: 12px; }
    }
  `];
}
if (!customElements.get('jb-search')) customElements.define('jb-search', JbSearch);
