import { LitElement, html, css, nothing, type PropertyValues } from 'lit';
import { tokens, base } from './styles';
import { icon } from './icons';
import { ensureFonts } from './fonts';
import './search-view';
import './now-view';
import './browse-view';
import './queue-view';
import './editor';
import './lyrics/lyrics-view';
import { LyricsStore, type LyricsStatus } from './lyrics/store';
import { QueueModel } from './queue-model';
import { roomsOf, playerArt } from './shared';
import { resolveBackdrop, drawPreblurred, BACKDROPS, prefersReducedMotion, type BackdropMode } from './backdrop';
import type { HomeAssistant, JukeboxCardConfig, TabId } from './types';

export const VERSION = '0.4.1';
const TABS: Array<{ id: TabId; label: string; icon: string }> = [
  { id: 'now', label: 'Now Playing', icon: 'disc' },
  { id: 'browse', label: 'Browse', icon: 'browse' },
  { id: 'search', label: 'Search', icon: 'search' },
  { id: 'queue', label: 'Queue', icon: 'queue' },
  { id: 'lyrics', label: 'Lyrics', icon: 'lyrics' },
];
const CHILDREN = ['jb-now', 'jb-browse', 'jb-search', 'jb-queue'];
const bool = (v: unknown) => v === undefined || typeof v === 'boolean';
const num = (v: unknown, lo: number, hi: number) => v === undefined || (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi);
/** Screensaver status line for lyrics states that have nothing to show (shown only when screensaver lyrics are on). */
const SAVER_LYRICS_STATUS: Partial<Record<LyricsStatus, string>> = { none: 'No lyrics', error: 'Lyrics unavailable', loading: 'Looking for lyrics…' };

export class JukeboxCard extends LitElement {
  static properties = {
    hass: { attribute: false },
    _config: { state: true },
    _tab: { state: true },
    _now: { state: true },
    _qcount: { state: true },
    _saver: { state: true },
    _bd: { state: true },
    _qart: { state: true },
    _stage: { state: true },
    _stageUi: { state: true },
  };
  hass?: HomeAssistant;
  private _config!: JukeboxCardConfig;
  private _tab: TabId = 'now';
  private _now = new Date();
  private _clock?: number;
  private _qcount = 0;
  /** current queue item's (https) image, the art fallback when the player has no relative entity_picture(_local) */
  private _qart = '';
  /** '' | 'on' | 'waking' */
  private _saver = '';
  private _idleTimer?: number;
  private queue = new QueueModel();
  /** resolved backdrop mode + reason (exposed as data-backdrop / data-backdrop-why on the host) */
  private _bd: BackdropMode = 'full';
  private _bdWhy = '';
  private _lightKey = '';
  private _ro?: ResizeObserver;
  private _rm?: MediaQueryList;
  private _qunsub?: () => void;
  /** one lyrics lookup per track, shared by the art overlay, Stage, the Lyrics tab and the screensaver */
  readonly lyrics = new LyricsStore();
  private _stage = false;
  private _lunsub?: () => void;
  private _lstatus = '';
  private _stageUi = false;
  private _stageNative = false;
  private _stageUiTimer?: number;

  static getConfigElement() { return document.createElement('jukebox-card-editor'); }
  static getStubConfig(): Partial<JukeboxCardConfig> {
    return {
      entity: 'media_player.everywhere',
      config_entry_id: '',
      rooms: [
        { name: 'Living Room', entity: 'media_player.living_room' },
        { name: 'Kitchen', entity: 'media_player.kitchen' },
        { name: 'Garage', entity: 'media_player.garage' },
      ],
      favorite_entity: 'button.everywhere_favorite_current_song',
      screensaver_minutes: 10,
      accent: 'mono',
      limit: 8,
    };
  }

  setConfig(config: JukeboxCardConfig) {
    if (!config) throw new Error('Invalid configuration');
    if (config.mass_queue_entry_id !== undefined && typeof config.mass_queue_entry_id !== 'string')
      throw new Error('jukebox-card: mass_queue_entry_id must be the mass_queue config entry id (a string).');
    if (!config.config_entry_id || typeof config.config_entry_id !== 'string')
      throw new Error('jukebox-card: config_entry_id is required (the Music Assistant config entry id).');
    if (!num(config.limit, 1, 50)) throw new Error('jukebox-card: limit must be between 1 and 50.');
    if (!num(config.browse_limit, 1, 500)) throw new Error('jukebox-card: browse_limit must be between 1 and 500.');
    if (!num(config.queue_limit, 1, 1000)) throw new Error('jukebox-card: queue_limit must be between 1 and 1000.');
    if (!num(config.screensaver_minutes, 0, 1440)) throw new Error('jukebox-card: screensaver_minutes must be between 0 (off) and 1440.');
    if (config.rooms !== undefined) {
      if (!Array.isArray(config.rooms)) throw new Error('jukebox-card: rooms must be a list of {name, entity}.');
      for (const r of config.rooms) {
        const e = typeof r === 'string' ? r : r?.entity;
        if (typeof e !== 'string' || !e.startsWith('media_player.')) throw new Error(`jukebox-card: each room needs a media_player entity (got ${JSON.stringify(r)}).`);
      }
    }
    if (config.favorite_entity && !/^(button|script|input_button)\./.test(config.favorite_entity))
      throw new Error('jukebox-card: favorite_entity must be a button, input_button or script entity.');
    for (const k of ['show_lyrics', 'lyrics_tab', 'screensaver_lyrics', 'lyrics_seek'] as const)
      if (!bool(config[k])) throw new Error(`jukebox-card: ${k} must be true or false.`);
    if (!num(config.lyrics_offset_ms, -5000, 5000)) throw new Error('jukebox-card: lyrics_offset_ms must be between -5000 and 5000.');
    if (config.backdrop !== undefined && !BACKDROPS.includes(config.backdrop))
      throw new Error(`jukebox-card: backdrop must be one of ${BACKDROPS.join(', ')}.`);
    const first = !this._config;
    this._config = {
      entity: 'media_player.everywhere', accent: 'mono', limit: 8,
      favorite_entity: 'button.everywhere_favorite_current_song', screensaver_minutes: 10, ...config,
    };
    if (first && config.default_tab && this.tabs().some((t) => t.id === config.default_tab)) this._tab = config.default_tab;
    if (!this.tabs().some((t) => t.id === this._tab)) this._tab = 'now';
    this.lyrics.enabled = this._config.show_lyrics !== false;
    this.lyrics.entryId = this._config.mass_queue_entry_id || (this._config as any).queue_config_entry_id || '';
    this.queue.entity = this._config.entity!;
    this.queue.limitAfter = this._config.queue_limit ?? 200;
    ensureFonts(this._config.font_base);
    this.applyBackdrop();
    this.armIdle();
  }
  private applyBackdrop = () => {
    if (!this._config) return;
    const r = resolveBackdrop(this._config.backdrop);
    this._bd = r.mode; this._bdWhy = r.why; this._lightKey = '';
    this.dataset.backdrop = r.mode; this.dataset.backdropWhy = r.why;
  };

  /** visible tabs: Lyrics only when lyrics are on and its tab is not turned off */
  private tabs() { const c = this._config; return TABS.filter((t) => t.id !== 'lyrics' || (c?.show_lyrics !== false && c?.lyrics_tab !== false)); }
  getCardSize() { return 12; }
  getGridOptions() { return { columns: 'full', rows: 'auto' }; }

  connectedCallback() {
    super.connectedCallback();
    this._clock = window.setInterval(() => (this._now = new Date()), 15000);
    // Belt and braces: if anything editable ever takes focus inside the card, drop it so no OS keyboard opens.
    this.renderRoot?.addEventListener?.('focusin', this.onFocusIn as EventListener);
    this._lunsub ??= this.lyrics.subscribe((st) => { if (st.status !== this._lstatus) { this._lstatus = st.status; this.requestUpdate(); } });
    this._qunsub = this.queue.subscribe(() => { this._qcount = this.queue.remaining; this._qart = this.art(); }) as any;
    this.addEventListener('pointerdown', this.onActivity, { capture: true });
    this.addEventListener('keydown', this.onActivity, { capture: true });
    this.addEventListener('jukebox-played', this.onPlayed as EventListener);
    this.addEventListener('jukebox-nav', this.onNav as EventListener);
    this.addEventListener('jukebox-open', this.onOpen as EventListener);
    this.addEventListener('jukebox-stage', this.onStage as EventListener);
    document.addEventListener('fullscreenchange', this.onFsChange);
    document.addEventListener('webkitfullscreenchange', this.onFsChange);
    window.addEventListener('keydown', this.onKey);
    this.armIdle();
    if (this.hass) this.queue.refreshSoon(0);
    this._rm = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
    this._rm?.addEventListener?.('change', this.applyBackdrop);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    window.clearInterval(this._clock); window.clearTimeout(this._idleTimer);
    this._qunsub?.();
    this._lunsub?.(); this._lunsub = undefined;
    this.removeEventListener('pointerdown', this.onActivity, { capture: true });
    this.removeEventListener('keydown', this.onActivity, { capture: true });
    this.removeEventListener('jukebox-played', this.onPlayed as EventListener);
    this.removeEventListener('jukebox-nav', this.onNav as EventListener);
    this.removeEventListener('jukebox-open', this.onOpen as EventListener);
    this.removeEventListener('jukebox-stage', this.onStage as EventListener);
    document.removeEventListener('fullscreenchange', this.onFsChange);
    document.removeEventListener('webkitfullscreenchange', this.onFsChange);
    window.removeEventListener('keydown', this.onKey);
    window.clearTimeout(this._stageUiTimer);
    if (this._stage) this.closeStage();
    this._rm?.removeEventListener?.('change', this.applyBackdrop);
    this._ro?.disconnect(); this._ro = undefined;
  }
  protected firstUpdated() {
    this.renderRoot.addEventListener('focusin', this.onFocusIn as EventListener);
    const np = this.renderRoot.querySelector('main.np');
    if ('ResizeObserver' in window) {
      this._ro = new ResizeObserver(() => { this.updateScale(); this._lightKey = ''; this.updateLight(); });
      this._ro.observe(this);
    }
    this.updateScale();
  }
  protected updated() { this.updateLight(); }
  /** Now-playing art for the backdrop and screensaver (see playerArt: never an absolute entity_picture). */
  private art() {
    const ent = this.hass?.states[this._config?.entity ?? 'media_player.everywhere'];
    return playerArt(ent?.attributes, this.queue.currentItem);
  }
  /** Large-screen scale: the layout is designed around ~1280x800; on bigger panels zoom it so art/text grow instead of spreading thin. */
  private _scale = 1;
  private updateScale() {
    const c = this._config; if (!c) return;
    const w = this.clientWidth, h = this.clientHeight;
    let z = 1;
    if (typeof c.scale === 'number' && c.scale > 0) z = c.scale;
    else if (w && h) { const auto = Math.min(w / 1420, h / 800); z = auto >= 1.15 ? Math.min(1.8, Math.round(auto * 20) / 20) : 1; }
    if (z === this._scale) return;
    this._scale = z;
    this.style.setProperty('--_z', String(z));
    this.dataset.scale = String(z);
  }
  /** light mode: re-draw the 64px pre-blurred canvas only when the art (or the box aspect) changes */
  private updateLight() {
    if (this._bd !== 'light') return;
    const cv = this.renderRoot.querySelector('canvas.bdl') as HTMLCanvasElement | null;
    const np = this.renderRoot.querySelector('main.np') as HTMLElement | null;
    const pic = this.art();
    if (!cv || !np) return;
    const w = np.clientWidth, h = np.clientHeight;
    const key = `${pic}|${Math.round((w / Math.max(1, h)) * 10)}`;
    if (key === this._lightKey) return;
    this._lightKey = key;
    if (!pic) { cv.classList.remove('ready'); return; }
    const t0 = performance.now();
    drawPreblurred(cv, pic, w, h).then((ok) => {
      if (this._lightKey !== key) return;
      cv.classList.toggle('ready', ok);
      cv.dataset.drawMs = String(Math.round(performance.now() - t0));
      cv.dataset.draws = String(Number(cv.dataset.draws ?? 0) + 1);
    });
  }

  // ---------- screensaver ----------
  private armIdle() {
    window.clearTimeout(this._idleTimer);
    const m = this._config?.screensaver_minutes ?? 10;
    if (!m || !this.isConnected) return;
    this._idleTimer = window.setTimeout(() => { this._saver = 'on'; }, m * 60_000);
  }
  private onActivity = () => { if (!this._saver) this.armIdle(); };
  private wake = (e: Event) => {
    // Swallow the waking touch: keep the overlay up briefly so the follow-up click can't hit a control underneath.
    e.preventDefault(); e.stopPropagation();
    if (this._saver !== 'on') return;
    this._saver = 'waking';
    window.setTimeout(() => { this._saver = ''; this.armIdle(); }, 350);
  };

  // ---------- child events ----------
  private onPlayed = () => this.queue.refreshSoon(800);
  private onNav = (e: CustomEvent) => { const t = e.detail?.tab; if (this.tabs().some((x) => x.id === t)) this._tab = t; };

  // ---------- Stage (full-screen art + lyrics) ----------
  private onStage = (e: CustomEvent) => { if (e.detail?.open === false) this.closeStage(); else this.openStage(); };
  /** Must run synchronously inside the tap that opened it, or browsers refuse requestFullscreen. */
  openStage() {
    this._stage = true;
    this.showStageUi();
    this._stageNative = false;
    const el = this as any;
    const req = el.requestFullscreen ?? el.webkitRequestFullscreen;
    const can = (document as any).fullscreenEnabled ?? (document as any).webkitFullscreenEnabled;
    if (req && can !== false) {
      try {
        this._stageNative = true;
        const r = req.call(el);
        r?.catch?.(() => { this._stageNative = false; this.dataset.stage = 'overlay'; });
      } catch { this._stageNative = false; }
    }
    this.dataset.stage = this._stageNative ? 'fullscreen' : 'overlay';
  }
  closeStage() {
    this._stage = false; this._stageUi = false;
    delete this.dataset.stage;
    const d = document as any;
    const fs = d.fullscreenElement ?? d.webkitFullscreenElement;
    this._stageNative = false;
    if (fs === this) { try { const r = (d.exitFullscreen ?? d.webkitExitFullscreen)?.call(d); r?.catch?.(() => {}); } catch { /* */ } }
  }
  private onFsChange = () => {
    const d = document as any;
    const fs = d.fullscreenElement ?? d.webkitFullscreenElement;
    // left fullscreen with Esc / the system gesture: close the Stage too
    if (!fs && this._stage && this._stageNative) { this._stageNative = false; this.closeStage(); }
  };
  private onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && this._stage) { e.preventDefault(); this.closeStage(); } };
  private showStageUi() {
    this._stageUi = true;
    window.clearTimeout(this._stageUiTimer);
    this._stageUiTimer = window.setTimeout(() => (this._stageUi = false), 4000);
  }
  private stageTap = () => { if (this._stageUi) { this._stageUi = false; window.clearTimeout(this._stageUiTimer); } else this.showStageUi(); };
  private stageCall(service: string) {
    this.showStageUi();
    this.hass?.callService('media_player', service, {}, { entity_id: this._config.entity! })?.catch?.((err: any) => console.warn('[jukebox-card]', service, err));
  }
  private renderStage() {
    const c = this._config, ent = this.hass?.states[c.entity!];
    const a = ent?.attributes ?? {};
    const pic = this.art();
    const bd = this._bd;
    const lyr = c.show_lyrics !== false;
    const stop = (e: Event) => e.stopPropagation();
    const bg = pic && (bd === 'full' || bd === 'light') ? `background-image:url("${pic.replace(/"/g, '%22')}")` : '';
    return html`<div class="stage ${this._stageUi ? 'ui' : ''} ${lyr ? '' : 'nolyr'}" role="dialog" aria-label="Stage" @click=${this.stageTap}>
      ${bg ? html`<div class="st-bg st-${bd}" style=${bg}></div>` : nothing}
      <div class="st-main">
        <div class="st-left">
          <div class="st-art">${pic ? html`<img src=${pic} alt="" draggable="false" />` : html`<span class="st-ph">${icon('disc')}</span>`}</div>
          <div class="st-meta"><b>${a.media_title ?? 'Nothing playing'}</b><small>${a.media_artist ?? ''}</small></div>
        </div>
        ${lyr ? html`<jb-lyrics class="st-ly" mode="stage" .hass=${this.hass} .config=${c} .store=${this.lyrics} ?active=${!this._saver}></jb-lyrics>` : nothing}
      </div>
      <div class="st-top" @click=${stop}>
        <button class="st-x" aria-label="Close" tabindex="-1" @click=${() => this.closeStage()}>${icon('close')}</button>
      </div>
      <div class="st-ctl" @click=${stop}>
        <button aria-label="Previous" tabindex="-1" @click=${() => this.stageCall('media_previous_track')}>${icon('prev')}</button>
        <button class="pp" aria-label=${ent?.state === 'playing' ? 'Pause' : 'Play'} tabindex="-1"
          @click=${() => this.stageCall(ent?.state === 'playing' ? 'media_pause' : 'media_play')}>${icon(ent?.state === 'playing' ? 'pause' : 'play')}</button>
        <button aria-label="Next" tabindex="-1" @click=${() => this.stageCall('media_next_track')}>${icon('next')}</button>
      </div>
    </div>`;
  }
  private onOpen = (e: CustomEvent) => {
    const { item, type } = e.detail ?? {};
    if (!item) return;
    this._tab = 'browse';
    (this.renderRoot.querySelector('jb-browse') as any)?.openDetail(item, type);
  };

  protected willUpdate(changed: PropertyValues) {
    if ((changed.has('hass') || changed.has('_config')) && this.hass && this._config) this.lyrics.follow(this.hass, this.hass.states[this._config.entity!]);
    if (changed.has('hass') && this.hass) {
      const old = changed.get('hass') as HomeAssistant | undefined;
      this.queue.hass = this.hass;
      const id = this._config.entity!;
      const a = this.hass.states[id], b = old?.states[id];
      if (!old) this.queue.refreshSoon(0);
      else if (a !== b && (a?.state !== b?.state || a?.attributes?.media_content_id !== b?.attributes?.media_content_id
        || a?.attributes?.media_title !== b?.attributes?.media_title || a?.attributes?.shuffle !== b?.attributes?.shuffle)) this.queue.refreshSoon();
    }
  }
  private onFocusIn = (e: FocusEvent) => {
    const t = e.composedPath()[0] as HTMLElement;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) t.blur();
  };

  protected shouldUpdate(changed: PropertyValues) {
    if (!this._config) return false;
    if (changed.size === 1 && changed.has('hass')) {
      const old = changed.get('hass') as HomeAssistant | undefined;
      const id = this._config.entity!;
      // Re-render the shell only when our player changed; the search view gets hass directly.
      for (const tag of CHILDREN) { const el = this.renderRoot?.querySelector(tag) as any; if (el) el.hass = this.hass; }
      return !old || old.states[id] !== this.hass?.states[id];
    }
    return true;
  }

  private timeStr() {
    const lang = this.hass?.locale?.language || this.hass?.language || undefined;
    try { return this._now.toLocaleTimeString(lang, { hour: 'numeric', minute: '2-digit' }); }
    catch { return this._now.toLocaleTimeString(); }
  }

  private renderSaver() {
    const ent = this.hass?.states[this._config.entity!];
    const at = ent?.attributes ?? {};
    const pic = this.art();
    const playing = ent?.state === 'playing' || ent?.state === 'paused';
    const lang = this.hass?.locale?.language || this.hass?.language || undefined;
    const ls = this.lyrics.state.status;
    const svOn = playing && this._config.show_lyrics !== false && this._config.screensaver_lyrics !== false;
    const svLyrics = svOn && (ls === 'synced' || ls === 'plain');
    // No lyrics to show: a small, quiet status line instead, inside the drifting block so it moves with the burn-in shift.
    const svStatus = svOn ? SAVER_LYRICS_STATUS[ls] : undefined;
    let date = '';
    try { date = this._now.toLocaleDateString(lang, { weekday: 'long', month: 'long', day: 'numeric' }); } catch { /* */ }
    return html`<div class="saver ${this._saver}" role="button" aria-label="Wake" @pointerdown=${this.wake} @click=${this.wake}
        @pointerup=${(e: Event) => { e.preventDefault(); e.stopPropagation(); }}>
      ${pic && (this._bd === 'full' || this._bd === 'light') ? html`<div class="sv-bg" style=${`background-image:url("${pic.replace(/"/g, '%22')}")`}></div>` : nothing}
      <div class="sv-drift ${svLyrics ? 'has-ly' : ''}">
        <div class="sv-clock">${this.timeStr()}</div>
        <div class="sv-date">${date}</div>
        ${playing && at.media_title ? html`<div class="sv-np">${pic ? html`<img src=${pic} alt="" draggable="false" />` : nothing}
          <span><b>${at.media_title}</b><small>${[at.media_artist, ent?.state === 'paused' ? 'Paused' : ''].filter(Boolean).join(' · ')}</small></span></div>` : nothing}
        ${svLyrics ? html`<jb-lyrics class="sv-ly" mode="saver" .hass=${this.hass} .config=${this._config} .store=${this.lyrics} ?active=${this._saver === 'on'}></jb-lyrics>` : nothing}
        ${svStatus ? html`<div class="sv-lys" role="status" data-status=${ls}>${svStatus}</div>` : nothing}
      </div>
      <div class="sv-hint">Tap to wake</div>
    </div>`;
  }

  render() {
    if (!this._config) return nothing;
    const ent = this.hass?.states[this._config.entity!];
    const pic = this.art();
    const name = ent?.attributes?.friendly_name ?? 'Everywhere';
    const rooms = roomsOf(this._config, this.hass).length;
    const bd = this._bd;
    const artStyle = pic && bd === 'full' ? `--_art:url("${pic.replace(/"/g, '%22')}")` : '';
    const view = (id: TabId, child: unknown) => html`<div class="view" data-view=${id} ?hidden=${this._tab !== id}>${child}</div>`;
    const c = this._config, h = this.hass, q = this.queue, tabs = this.tabs();
    return html`
      <ha-card class="app bd-${bd} ${bd === 'full' ? '' : 'solid'} ${prefersReducedMotion() ? 'rm' : ''}" style="${c.height ? `--jb-height:${c.height}` : ''}">
        <header class="top">
          <div class="brand">${icon('disc', 'i brand-i')}<span>${c.title ?? 'Jukebox'}</span></div>
          <div class="pill" title=${c.entity!}>${icon('group', 'i xs')}${name}${rooms ? html`<b>· ${rooms} room${rooms === 1 ? '' : 's'} synced</b>` : nothing}</div>
          <div class="spacer"></div>
          <div class="clock">${this.timeStr()}</div>
        </header>
        <main class="np ${pic ? 'has-art' : ''}" style=${artStyle}>
          ${bd === 'light' ? html`<canvas class="bdl" width="64" height="40" aria-hidden="true"></canvas>` : nothing}
          ${view('now', html`<jb-now .hass=${h} .config=${c} .queue=${q} .lyrics=${this.lyrics} ?active=${this._tab === 'now' && !this._saver && !this._stage}></jb-now>`)}
          ${view('browse', html`<jb-browse .hass=${h} .config=${c} ?active=${this._tab === 'browse'}></jb-browse>`)}
          ${view('search', html`<jb-search .hass=${h} .config=${c} ?active=${this._tab === 'search'}></jb-search>`)}
          ${view('queue', html`<jb-queue .hass=${h} .config=${c} .queue=${q} ?active=${this._tab === 'queue'}></jb-queue>`)}
          ${tabs.some((t) => t.id === 'lyrics') ? view('lyrics', html`<jb-lyrics mode="tab" .hass=${h} .config=${c} .store=${this.lyrics} .art=${pic}
            ?active=${this._tab === 'lyrics' && !this._saver && !this._stage}></jb-lyrics>`) : nothing}
        </main>
        <nav class="tabs" role="tablist" style=${`--tabs:${tabs.length}`}>
          ${tabs.map((t) => html`<button class="tab ${this._tab === t.id ? 'active' : ''}" role="tab" tabindex="-1" data-tab=${t.id}
              aria-selected=${this._tab === t.id ? 'true' : 'false'}
              @pointerdown=${(e: PointerEvent) => e.preventDefault()} @click=${() => (this._tab = t.id)}>${icon(t.icon)}<span>${t.label}</span>${t.id === 'queue' && this._qcount
                ? html`<em class="badge">${this._qcount > 99 ? '99+' : this._qcount}</em>` : nothing}</button>`)}
        </nav>
        ${this._stage ? this.renderStage() : nothing}
        ${this._saver ? this.renderSaver() : nothing}
      </ha-card>`;
  }

  static styles = [tokens, base, css`
    :host { display: block; height: var(--jb-height, 100dvh); }
    .app {
      height: calc(var(--jb-height, 100vh) / var(--_z, 1)); height: calc(var(--jb-height, 100dvh) / var(--_z, 1));
      zoom: var(--_z, 1); /* large-screen scale, set from ResizeObserver; lengths inside are multiplied, so the height is pre-divided */
      display: grid; grid-template-rows: auto minmax(0, 1fr) auto; grid-template-columns: minmax(0, 1fr);
      position: relative; isolation: isolate; overflow: hidden;
      background: var(--_bg); color: var(--_fg); font-family: var(--_font-body); -webkit-font-smoothing: antialiased;
      border-radius: var(--jb-card-radius, 0); border: 0; box-shadow: none;
      user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
    }
    .top { display: flex; align-items: center; gap: 14px; padding: 12px var(--_pad) 12px; min-height: 60px; position: relative; z-index: 2;
      background: #000; border-bottom: 1px solid var(--_hairline); }
    .brand { display: flex; align-items: center; gap: 10px; font-family: var(--_font-display); font-weight: 800; font-size: 22px; }
    .brand-i { width: 28px; height: 28px; color: var(--_active); }
    .pill { white-space: nowrap; display: flex; align-items: center; gap: 6px; padding: 7px 14px; border-radius: 999px; background: #ffffff0f;
      border: 1px solid #ffffff1a; font-size: 14px; font-weight: 600; }
    .pill b { font-weight: 500; color: var(--_muted); }
    .spacer { flex: 1; }
    .clock { white-space: nowrap; font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .np { container: np / size; min-height: 0; position: relative; overflow: hidden; background: #000; }
    .np::before { content: ""; position: absolute; inset: -80px; z-index: 0;
      background: var(--_art, radial-gradient(60% 50% at 25% 20%, #2a2a2a 0%, transparent 70%), linear-gradient(160deg, #161616, #050505));
      background-size: cover; background-position: center; filter: blur(var(--_backdrop-blur)) saturate(var(--_backdrop-saturate)); }
    .np::after { content: ""; position: absolute; inset: 0; z-index: 0; background: var(--_vignette), var(--_shade); pointer-events: none; }
    /* ---- backdrop modes (see src/backdrop.ts) ---- */
    .app.solid { --jb-panel-filter: none; --jb-surface: rgba(0, 0, 0, 0.6); --jb-panel-solid: rgba(0, 0, 0, 0.6); }
    .bd-light .np::before { background: linear-gradient(160deg, #161616, #050505); filter: none; inset: 0; }
    .bdl { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 0; opacity: 0; transition: opacity 600ms ease; pointer-events: none; }
    .bdl.ready { opacity: 1; }
    .bd-static .np::before { background: radial-gradient(70% 60% at 25% 15%, #262626 0%, transparent 70%), linear-gradient(160deg, #141414, #030303); filter: none; inset: 0; }
    .bd-off .np::before, .bd-off .np::after { display: none; }
    .view { position: absolute; inset: 0; z-index: 1; }
    .view[hidden] { display: none; }
    .badge { position: absolute; top: 6px; left: calc(50% + 8px); min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px; background: var(--_active);
      color: var(--_on-accent); font-style: normal; font-size: 11px; font-weight: 800; display: grid; place-items: center; font-variant-numeric: tabular-nums; }
    .saver { position: absolute; inset: 0; z-index: 50; background: #000; overflow: hidden; cursor: none; touch-action: none; animation: svin 900ms ease both; }
    .saver.waking { animation: svout 340ms ease both; }
    @keyframes svin { from { opacity: 0 } to { opacity: 1 } }
    @keyframes svout { to { opacity: 0 } }
    .sv-bg { position: absolute; inset: -4%; background-size: cover; background-position: center; opacity: .85; filter: saturate(1.05);
      animation: kb 90s ease-in-out infinite alternate; }
    .sv-bg::after { content: ""; position: absolute; inset: 0; background: radial-gradient(90% 90% at 50% 50%, #0000 40%, #000a 100%), linear-gradient(#0000004d, #00000080); }
    @keyframes kb { from { transform: scale(1) translate(0, 0) } to { transform: scale(1.08) translate(-2%, 1.5%) } }
    .sv-drift { position: absolute; left: 8%; top: 12%; display: flex; flex-direction: column; gap: 6px; animation: drift 240s ease-in-out infinite alternate; }
    @keyframes drift {
      0% { transform: translate(0, 0) } 25% { transform: translate(calc(70cqw - 100%), 18cqh) } 50% { transform: translate(28cqw, calc(64cqh - 100%)) }
      75% { transform: translate(calc(78cqw - 100%), 4cqh) } 100% { transform: translate(6cqw, calc(60cqh - 100%)) } }
    .saver { container-type: size; }
    .sv-clock { font-family: var(--_font-display); font-weight: 800; font-size: clamp(72px, 16cqw, 200px); line-height: .95; letter-spacing: -.03em; font-variant-numeric: tabular-nums; text-shadow: 0 4px 40px #0008; }
    .sv-date { font-size: clamp(16px, 2.4cqw, 26px); color: #ffffffc0; font-weight: 600; }
    .sv-np { display: flex; align-items: center; gap: 14px; margin-top: 18px; max-width: min(560px, 80cqw); }
    .sv-np img { width: 64px; height: 64px; border-radius: 10px; object-fit: cover; box-shadow: 0 8px 30px #0009; }
    .sv-np span { display: flex; flex-direction: column; min-width: 0; }
    .sv-np b { font-size: 20px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sv-np small { font-size: 15px; color: #ffffffa8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sv-hint { position: absolute; bottom: 22px; left: 0; right: 0; text-align: center; font-size: 13px; letter-spacing: .14em; text-transform: uppercase; color: #ffffff55; }
    /* reduced motion: no drift and no Ken Burns. The text block still jumps (no animation) to one of 10 spots every 60 s, so a
       static screen can't burn in. The .rm class mirrors the media query so the dev harness/tests can force it. */
    @media (prefers-reduced-motion: reduce) { .sv-drift, .sv-bg { animation: none; } .sv-drift { animation: hop 600s step-end infinite; } }
    .rm .sv-drift, .rm .sv-bg { animation: none; } .rm .sv-drift { animation: hop 600s step-end infinite; }
    @keyframes hop { 0% { transform: translate(0, 0) } 10% { transform: translate(calc(70cqw - 100%), 18cqh) } 20% { transform: translate(28cqw, calc(64cqh - 100%)) } 30% { transform: translate(calc(78cqw - 100%), 4cqh) } 40% { transform: translate(6cqw, calc(60cqh - 100%)) } 50% { transform: translate(calc(50cqw - 50%), 30cqh) } 60% { transform: translate(calc(74cqw - 100%), calc(66cqh - 100%)) } 70% { transform: translate(12cqw, 10cqh) } 80% { transform: translate(calc(60cqw - 100%), calc(40cqh - 50%)) } 90% { transform: translate(20cqw, calc(66cqh - 100%)) } 100% { transform: translate(0, 0) } }
    .bd-static .saver, .bd-off .saver { background: #000; }
    .sv-drift.has-ly .sv-clock { font-size: clamp(56px, 10cqw, 140px); }
    .sv-ly { margin-top: 18px; width: min(820px, 72cqw); }
    .sv-lys { margin-top: 14px; font-size: clamp(12px, 1.1cqw, 15px); font-weight: 600; letter-spacing: .04em; color: #ffffff6b; text-shadow: 0 1px 8px #000a; white-space: nowrap; }
    /* ---- Stage ---- */
    :host(:fullscreen), :host(:-webkit-full-screen) { background: #000; }
    .stage { position: absolute; inset: 0; z-index: 45; background: #000; overflow: hidden; container: stage / size; animation: svin 300ms ease both; cursor: default; }
    .st-bg { position: absolute; inset: -6%; background-size: cover; background-position: center; pointer-events: none; }
    .st-full { filter: blur(60px) saturate(1.2); opacity: .55; transform: translateZ(0); }
    .st-light { opacity: .22; }
    .st-bg::after { content: ""; position: absolute; inset: 0; background: linear-gradient(90deg, #000d 0%, #0008 45%, #000c 100%); }
    .st-main { position: absolute; inset: 0; display: grid; grid-template-columns: minmax(0, 46fr) minmax(0, 54fr); align-items: center; gap: 4cqw; padding: 6cqh 5cqw; }
    .nolyr .st-main { grid-template-columns: minmax(0, 1fr); justify-items: center; }
    .st-left { display: flex; flex-direction: column; gap: 18px; min-width: 0; align-items: flex-start; }
    .nolyr .st-left { align-items: center; text-align: center; }
    .st-art { width: min(40cqw, 68cqh); aspect-ratio: 1; border-radius: 14px; overflow: hidden; background: #111; box-shadow: 0 30px 80px #000c; }
    .st-art img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .st-ph { display: grid; place-items: center; width: 100%; height: 100%; } .st-ph .i { width: 40%; height: 40%; color: #ffffff26; }
    .st-meta { display: flex; flex-direction: column; gap: 4px; min-width: 0; max-width: min(40cqw, 68cqh); }
    .nolyr .st-meta { max-width: 80cqw; }
    .st-meta b { font-family: var(--_font-display); font-size: clamp(20px, 2.6cqw, 40px); font-weight: 800; line-height: 1.1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .st-meta small { font-size: clamp(15px, 1.7cqw, 24px); color: #ffffffa8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .st-ly { height: 100%; min-height: 0; }
    .st-top { position: absolute; top: 16px; right: 16px; z-index: 3; }
    .st-x, .st-ctl button { display: grid; place-items: center; border-radius: 50%; color: #fff; background: #000000a6; border: 1px solid #ffffff2e; }
    .st-x { width: 52px; height: 52px; } .st-x .i { width: 26px; height: 26px; }
    .st-ctl { position: absolute; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 3; display: flex; gap: 18px; align-items: center;
      padding: 10px 16px; border-radius: 999px; background: #000000b3; border: 1px solid #ffffff1f; }
    .st-ctl button { width: 56px; height: 56px; background: transparent; border: 0; } .st-ctl .i { width: 30px; height: 30px; }
    .st-ctl .pp { width: 64px; height: 64px; background: #fff; color: #000; } .st-ctl .pp .i { width: 34px; height: 34px; }
    .st-top, .st-ctl { opacity: 0; pointer-events: none; transition: opacity 250ms ease; }
    .stage.ui .st-top, .stage.ui .st-ctl { opacity: 1; pointer-events: auto; }
    @container stage (max-aspect-ratio: 1/1) {
      .st-main { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); align-items: stretch; padding: 64px 6cqw 4cqh; gap: 3cqh; }
      .st-left { flex-direction: row; align-items: center; gap: 16px; }
      .st-art { width: min(34cqw, 26cqh); border-radius: 10px; }
      .st-meta { max-width: none; flex: 1; }
      .nolyr .st-main { grid-template-rows: minmax(0, 1fr); align-content: center; }
      .nolyr .st-left { flex-direction: column; } .nolyr .st-art { width: min(82cqw, 56cqh); }
    }
    .tabs { display: grid; grid-template-columns: repeat(var(--tabs, 4), minmax(0, 1fr)); padding: 6px var(--_pad) calc(8px + env(safe-area-inset-bottom)); background: #000;
      border-top: 1px solid var(--_hairline); position: relative; z-index: 2; }
    .tab { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; min-height: 64px; border-radius: var(--_radius-s);
      color: var(--_inactive); font-size: 13px; font-weight: 600; letter-spacing: .02em; position: relative; }
    .tab .i { width: 28px; height: 28px; }
    .tab.active { color: var(--_active); }
    .tab.active::after { content: ""; position: absolute; top: -7px; left: 34%; right: 34%; height: 2px; background: var(--_active); }
    @container np (max-width: 520px) { }
    @media (max-width: 960px) { .pill b { display: none; } }
    @media (max-width: 640px) {
      .pill { display: none; } .clock { font-size: 18px; } .top { min-height: 52px; padding-top: 10px; padding-bottom: 10px; }
      .tab { min-height: 56px; font-size: 11px; } .tab .i { width: 24px; height: 24px; }
    }
  `];
}
if (!customElements.get('jukebox-card')) customElements.define('jukebox-card', JukeboxCard);

(window as any).customCards = (window as any).customCards || [];
if (!(window as any).customCards.some((c: any) => c.type === 'jukebox-card'))
  (window as any).customCards.push({ type: 'jukebox-card', name: 'Jukebox', description: 'Kiosk jukebox for Music Assistant: Now Playing, Browse, Search and Queue', preview: false });
// eslint-disable-next-line no-console
console.info(`%c JUKEBOX-CARD %c ${VERSION} `, 'background:#fff;color:#000;font-weight:700', 'background:#000;color:#fff');
