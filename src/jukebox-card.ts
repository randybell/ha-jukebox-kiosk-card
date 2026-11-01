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
import './speakers-view';
import type { JbSpeakers } from './speakers-view';
import { SpeakerStore } from './speakers/ma';
import { canGroup, canJumpQueue, targetsOf, targetMa, isActive, validPreset, validQuiet } from './speakers/model';
import { resolveBackdrop, drawPreblurred, BACKDROPS, prefersReducedMotion, type BackdropMode } from './backdrop';
import type { HomeAssistant, JukeboxCardConfig, TabId } from './types';

export const VERSION = '0.5.1';
const TABS: Array<{ id: TabId; label: string; icon: string }> = [
  { id: 'now', label: 'Now Playing', icon: 'disc' },
  { id: 'browse', label: 'Browse', icon: 'browse' },
  { id: 'search', label: 'Search', icon: 'search' },
  { id: 'queue', label: 'Queue', icon: 'queue' },
  { id: 'lyrics', label: 'Lyrics', icon: 'lyrics' },
];
const CHILDREN = ['jb-now', 'jb-browse', 'jb-search', 'jb-queue', 'jb-speakers'];
/** dynamic mode: the group this device plays on, remembered per device */
const TARGET_KEY = 'jukebox-card:target:v1';
const bool = (v: unknown) => v === undefined || typeof v === 'boolean';
const num = (v: unknown, lo: number, hi: number) => v === undefined || (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi);
/** Screensaver status line for lyrics states that have nothing to show (shown only when screensaver lyrics are on). */
/** Fit-to-panel: never shorter than this (px). Below it the card keeps this height and the page scrolls, as a regular card would. */
const FIT_MIN = 320;
/** Short-viewport compaction thresholds for the fitted card height (px). */
const SHORT_H = 700, TINY_H = 560;
const SAVER_LYRICS_STATUS: Partial<Record<LyricsStatus, string>> = { none: 'No lyrics', error: 'Lyrics unavailable', loading: 'Looking for lyrics…' };

/** 0.5.0 speaker keys; throws like the rest of setConfig */
function validateSpeakers(c: JukeboxCardConfig) {
  const oneOf = (k: keyof JukeboxCardConfig, vals: string[]) => {
    if (c[k] !== undefined && !vals.includes(c[k] as string)) throw new Error(`jukebox-card: ${String(k)} must be one of ${vals.join(', ')}.`);
  };
  oneOf('speaker_mode', ['fixed', 'dynamic']);
  oneOf('grouping', ['admins', 'everyone', 'nobody']);
  oneOf('guest_access', ['volume', 'none']);
  oneOf('leader_drop', ['block', 'allow']);
  if (!bool(c.large_buttons)) throw new Error('jukebox-card: large_buttons must be true or false.');
  if (c.grouping_users !== undefined && (!Array.isArray(c.grouping_users) || !c.grouping_users.every((u) => typeof u === 'string')))
    throw new Error('jukebox-card: grouping_users must be a list of user names or ids.');
  if (c.targets !== undefined) {
    if (!Array.isArray(c.targets)) throw new Error('jukebox-card: targets must be a list of {entity, name, members}.');
    for (const t of c.targets) {
      const e = typeof t === 'string' ? t : t?.entity;
      if (typeof e !== 'string' || !e.startsWith('media_player.')) throw new Error(`jukebox-card: each target needs a media_player entity (got ${JSON.stringify(t)}).`);
      if (typeof t === 'object' && t.members !== undefined && (!Array.isArray(t.members) || !t.members.every((m) => typeof m === 'string' && m.startsWith('media_player.'))))
        throw new Error(`jukebox-card: target ${e}: members must be media_player entities.`);
    }
  }
  if (c.presets !== undefined) {
    if (!Array.isArray(c.presets)) throw new Error('jukebox-card: presets must be a list of {name, members, volumes}.');
    for (const p of c.presets) if (!validPreset(p)) throw new Error(`jukebox-card: preset ${JSON.stringify((p as any)?.name ?? p)} needs a name, media_player members and volumes 0-100.`);
  }
  if (c.quiet_hours !== undefined && !validQuiet(c.quiet_hours))
    throw new Error('jukebox-card: quiet_hours needs start and end (HH:MM) and max_volume (0-100).');
}

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
    _spk: { state: true },
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
  /** fitted height (px) written to --_fit-h; 0 = not measured yet */
  private _fitH = 0;
  private _fitRaf = 0;
  private _fitTrail = 0;
  private _fitTimer?: number;
  private _fitRo?: ResizeObserver;
  /** config with defaults, before the dynamic-mode target is applied (fixed mode: _config === _base) */
  private _base!: JukeboxCardConfig;
  private _spk = false;
  /** Music Assistant players (dynamic mode only; fixed mode never calls it) */
  readonly speakers = new SpeakerStore();

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
    validateSpeakers(config);
    const first = !this._config;
    this._base = {
      entity: 'media_player.everywhere', accent: 'mono', limit: 8,
      favorite_entity: 'button.everywhere_favorite_current_song', screensaver_minutes: 10, ...config,
    };
    this._config = this.effective();
    if (first && config.default_tab && this.tabs().some((t) => t.id === config.default_tab)) this._tab = config.default_tab;
    if (!this.tabs().some((t) => t.id === this._tab)) this._tab = 'now';
    this.lyrics.enabled = this._config.show_lyrics !== false;
    this.lyrics.entryId = this._config.mass_queue_entry_id || (this._config as any).queue_config_entry_id || '';
    this.speakers.entryId = this.lyrics.entryId;
    this.queue.entryId = this.lyrics.entryId || undefined;
    this.queue.readsBuffer = () => !!this._config && canJumpQueue(this._config, this.hass?.user);
    this.queue.entity = this._config.entity!;
    this.queue.limitAfter = this._config.queue_limit ?? 200;
    ensureFonts(this._config.font_base);
    this.applyBackdrop();
    this.armIdle();
  }
  /** fixed mode: the config as given. dynamic: entity = the remembered target (when it is one of the targets) + start guard. */
  private effective(): JukeboxCardConfig {
    const b = this._base;
    if (b.speaker_mode !== 'dynamic') return b;
    let t = '';
    try { t = localStorage.getItem(TARGET_KEY) ?? ''; } catch { /* private mode */ }
    const ok = !!t && (b.targets?.length ? targetsOf(b, this.hass).some((x) => x.entity === t) : t.startsWith('media_player.'));
    return { ...b, entity: ok ? t : b.entity, _guard: this.guard };
  }
  /** Move the card to another group (from the Speakers panel). Allowed users only; remembered per device. */
  private onTarget = (e: CustomEvent) => {
    const t = e.detail?.entity as string | undefined;
    if (!t || this._base?.speaker_mode !== 'dynamic' || !canGroup(this._base, this.hass?.user) || t === this._config.entity) return;
    try { localStorage.setItem(TARGET_KEY, t); } catch { /* */ }
    this._config = this.effective();
    this.queue.entity = this._config.entity!;
    this.queue.refreshSoon(0);
  };
  private onSpeakers = (e: CustomEvent) => { this._spk = e.detail?.open !== false; };
  /** Start guard (dynamic mode): starting an idle group takes speakers from other groups: say which, and ask. */
  private guard = async (entity: string): Promise<boolean> => {
    const st = this.hass?.states[entity]?.state;
    if (st === 'playing' || st === 'paused') return true;
    if (!this.speakers.entryId) return true;
    const players = await this.speakers.refresh();
    await this.speakers.loadConfigs(); // the group's default speakers (config/players/get), when MA lets us read them
    const ma = targetMa(entity, this.hass, players);
    if (!ma || isActive(players.get(ma))) return true;
    const el = this.renderRoot.querySelector('jb-speakers') as JbSpeakers | null;
    if (!el) return true;
    const { lines } = el.startTakeovers(entity, players);
    if (!lines.length) return true;
    const name = (this.hass?.states[entity]?.attributes?.friendly_name as string) ?? entity;
    return el.ask({ title: `Start ${name}?`, sub: 'Speakers playing elsewhere switch over.', lines, ok: 'Start' });
  };
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
    this.addEventListener('jukebox-target', this.onTarget as EventListener);
    this.addEventListener('jukebox-speakers', this.onSpeakers as EventListener);
    document.addEventListener('fullscreenchange', this.onFsChange);
    document.addEventListener('webkitfullscreenchange', this.onFsChange);
    window.addEventListener('keydown', this.onKey);
    this.armIdle();
    if (this.hass) this.queue.refreshSoon(0);
    this._rm = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
    this._rm?.addEventListener?.('change', this.applyBackdrop);
    window.addEventListener('resize', this.scheduleFit);
    window.addEventListener('orientationchange', this.scheduleFit);
    window.addEventListener('location-changed', this.scheduleFit);
    window.visualViewport?.addEventListener('resize', this.scheduleFit);
    document.addEventListener('fullscreenchange', this.scheduleFit);
    if ('ResizeObserver' in window) {
      // page layout changes that move the card without resizing it (HA toolbar shown/hidden, sidebar, cards above it)
      this._fitRo = new ResizeObserver(this.scheduleFit);
      this._fitRo.observe(document.documentElement);
      if (this.parentElement) this._fitRo.observe(this.parentElement);
    }
    // cheap safety net for offset changes no observer reports (e.g. a kiosk-mode plugin hiding the toolbar): one rect read every 2 s
    this._fitTimer = window.setInterval(this.scheduleFit, 2000);
    this.scheduleFit();
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
    this.removeEventListener('jukebox-target', this.onTarget as EventListener);
    this.removeEventListener('jukebox-speakers', this.onSpeakers as EventListener);
    this.speakers.stopPolling();
    document.removeEventListener('fullscreenchange', this.onFsChange);
    document.removeEventListener('webkitfullscreenchange', this.onFsChange);
    window.removeEventListener('keydown', this.onKey);
    window.clearTimeout(this._stageUiTimer);
    if (this._stage) this.closeStage();
    this._rm?.removeEventListener?.('change', this.applyBackdrop);
    this._ro?.disconnect(); this._ro = undefined;
    window.removeEventListener('resize', this.scheduleFit);
    window.removeEventListener('orientationchange', this.scheduleFit);
    window.removeEventListener('location-changed', this.scheduleFit);
    window.visualViewport?.removeEventListener('resize', this.scheduleFit);
    document.removeEventListener('fullscreenchange', this.scheduleFit);
    this._fitRo?.disconnect(); this._fitRo = undefined;
    window.clearInterval(this._fitTimer); cancelAnimationFrame(this._fitRaf); this._fitRaf = 0;
  }
  // ---------- fit to the available panel height ----------
  private scheduleFit = () => {
    if (this._fitRaf) return;
    this._fitRaf = requestAnimationFrame(() => { this._fitRaf = 0; this.fit(); });
  };
  /**
   * Size the card to the space that is really left below it, in CSS px (so it is right at any browser zoom):
   * viewport height − the host's top in the document (HA toolbar, safe-area padding, cards above). 100dvh alone
   * overflowed by the toolbar height in a normal HA dashboard and pushed the tab bar below the fold.
   */
  fit() {
    if (!this.isConnected || !this._config) return;
    const d = document as any;
    const fs = d.fullscreenElement ?? d.webkitFullscreenElement;
    const vv = window.visualViewport;
    const de = document.documentElement;
    // layout viewport height; the visual viewport only when unzoomed (pinch-zoom must not shrink the card)
    let vh = Math.min(window.innerHeight, de.clientHeight || window.innerHeight);
    if (vv && Math.abs(vv.scale - 1) < 0.01) vh = Math.min(vh, vv.height);
    let h: number;
    if (fs === this) h = vh;
    else {
      const top = Math.max(0, this.getBoundingClientRect().top + (window.scrollY || 0));
      h = vh - top;
      if (h < FIT_MIN) {
        // a regular card far down a masonry/sections view: one screen tall minus HA's toolbar (its own CSS var), not the space left
        const hdr = parseFloat(getComputedStyle(this).getPropertyValue('--header-height')) || 0;
        h = vh - hdr;
      } else {
        // trailing padding below the card (e.g. HA view padding-bottom) would still make the page scroll: take it off too.
        // Only measurable while the page overflows, so remember it (no oscillation once the card fits).
        if (de.scrollHeight > vh + 0.5) {
          const below = de.scrollHeight - (top + this.offsetHeight);
          if (below >= 0 && below <= 48) this._fitTrail = Math.ceil(below);
        }
        h -= this._fitTrail;
      }
    }
    h = Math.max(FIT_MIN, Math.floor(h));
    if (h === this._fitH) return;
    this._fitH = h;
    this.style.setProperty('--_fit-h', `${h}px`);
    this.dataset.fitH = String(h);
    const size = h < TINY_H ? 'tiny' : h < SHORT_H ? 'short' : '';
    if (size) this.dataset.fit = size; else delete this.dataset.fit;
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
  /** tablist keyboard support (roving tabindex): ←/→/Home/End select a tab and move the focus ring with it */
  private onTabKey = (e: KeyboardEvent) => {
    const ids = this.tabs().map((t) => t.id), n = ids.length;
    let i = ids.indexOf(this._tab);
    if (e.key === 'ArrowRight') i = (i + 1) % n; else if (e.key === 'ArrowLeft') i = (i - 1 + n) % n;
    else if (e.key === 'Home') i = 0; else if (e.key === 'End') i = n - 1; else return;
    e.preventDefault();
    this._tab = ids[i]; this._spk = false;
    this.updateComplete.then(() => (this.renderRoot.querySelector(`.tab[data-tab="${ids[i]}"]`) as HTMLElement | null)?.focus());
  };
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
      this.speakers.hass = this.hass;
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
    const dyn = this._config.speaker_mode === 'dynamic';
    const gm = ent?.attributes?.group_members;
    const live = dyn && ent && ['playing', 'paused', 'buffering'].includes(ent.state) && Array.isArray(gm) ? gm.length : 0;
    const rooms = roomsOf(this._config, this.hass).length;
    const bd = this._bd;
    const artStyle = pic && bd === 'full' ? `--_art:url("${pic.replace(/"/g, '%22')}")` : '';
    const view = (id: TabId, child: unknown) => html`<div class="view" data-view=${id} ?hidden=${this._tab !== id}>${child}</div>`;
    const c = this._config, h = this.hass, q = this.queue, tabs = this.tabs();
    return html`
      <ha-card class="app bd-${bd} ${bd === 'full' ? '' : 'solid'} ${prefersReducedMotion() ? 'rm' : ''} ${c.large_buttons ? 'lg' : ''}" style="${c.height ? `--jb-height:${c.height}` : ''}">
        <header class="top">
          <div class="brand">${icon('disc', 'i brand-i')}<span>${c.title ?? 'Jukebox'}</span></div>
          <button class="pill" title=${c.entity!} tabindex="-1" aria-label="Speakers: ${name}" aria-haspopup="dialog" @pointerdown=${(e: PointerEvent) => e.preventDefault()}
            @click=${() => (this._spk = !this._spk)}>${icon('group', 'i xs')}<span class="pn">${name}</span>${dyn
              ? html`<b>· ${live ? `${live} speaker${live === 1 ? '' : 's'}` : ent?.state === 'buffering' ? 'regrouping…' : 'idle'}</b>`
              : rooms ? html`<b>· ${rooms} room${rooms === 1 ? '' : 's'} synced</b>` : nothing}</button>
          <div class="spacer"></div>
          <div class="clock">${this.timeStr()}</div>
        </header>
        <main class="np ${pic ? 'has-art' : ''}" style=${artStyle}>
          ${bd === 'light' ? html`<canvas class="bdl" width="64" height="40" aria-hidden="true"></canvas>` : nothing}
          ${view('now', html`<jb-now ?large=${!!c.large_buttons} .hass=${h} .config=${c} .queue=${q} .lyrics=${this.lyrics} ?active=${this._tab === 'now' && !this._saver && !this._stage}></jb-now>`)}
          ${view('browse', html`<jb-browse ?large=${!!c.large_buttons} .hass=${h} .config=${c} ?active=${this._tab === 'browse'}></jb-browse>`)}
          ${view('search', html`<jb-search ?large=${!!c.large_buttons} .hass=${h} .config=${c} ?active=${this._tab === 'search'}></jb-search>`)}
          ${view('queue', html`<jb-queue ?large=${!!c.large_buttons} .hass=${h} .config=${c} .queue=${q} ?active=${this._tab === 'queue'}></jb-queue>`)}
          ${tabs.some((t) => t.id === 'lyrics') ? view('lyrics', html`<jb-lyrics mode="tab" .hass=${h} .config=${c} .store=${this.lyrics} .art=${pic}
            ?active=${this._tab === 'lyrics' && !this._saver && !this._stage}></jb-lyrics>`) : nothing}
          <!-- inside the middle: the fitted header and tab bar stay visible and tappable while the panel is open -->
          <jb-speakers .hass=${h} .config=${c} .store=${this.speakers} ?open=${this._spk} ?large=${!!c.large_buttons}></jb-speakers>
        </main>
        <nav class="tabs" role="tablist" style=${`--tabs:${tabs.length}`} @keydown=${this.onTabKey}>
          ${tabs.map((t) => html`<button class="tab ${this._tab === t.id ? 'active' : ''}" role="tab" tabindex=${this._tab === t.id ? '0' : '-1'} data-tab=${t.id}
              aria-selected=${this._tab === t.id ? 'true' : 'false'}
              @pointerdown=${(e: PointerEvent) => e.preventDefault()} @click=${() => { this._tab = t.id; this._spk = false; }}>${icon(t.icon)}<span>${t.label}</span>${t.id === 'queue' && this._qcount
                ? html`<em class="badge">${this._qcount > 99 ? '99+' : this._qcount}</em>` : nothing}</button>`)}
        </nav>
        ${this._stage ? this.renderStage() : nothing}
        ${this._saver ? this.renderSaver() : nothing}
      </ha-card>`;
  }

  static styles = [tokens, base, css`
    :host { display: block; height: var(--jb-height, var(--_fit-h, 100dvh)); min-height: 0; }
    .app {
      /* --_fit-h: measured space below the card's top (see fit()); 100dvh only until the first measurement */
      height: calc(var(--jb-height, var(--_fit-h, 100vh)) / var(--_z, 1)); height: calc(var(--jb-height, var(--_fit-h, 100dvh)) / var(--_z, 1));
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
    .pill { color: var(--_fg); min-height: 40px; cursor: pointer; } .pill:active { background: #ffffff26; }
    .lg .pill { min-height: 52px; font-size: 17px; padding: 0 18px; }
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
    .rm { --jb-ly-slide: 0ms; } /* inherited into jb-lyrics: the screensaver lyrics move without sliding */
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
    /* Tab bar (0.5.0, segmented): one rounded translucent track on the black footer, equal segments with hairline
       dividers, the active segment solid white. Only colour/transform transitions (no layout, no blur). */
    .tabs { display: grid; grid-template-columns: repeat(var(--tabs, 4), minmax(0, 1fr)); gap: 4px;
      padding: 11px calc(var(--_pad) + 4px) calc(13px + env(safe-area-inset-bottom)); background: #000;
      border-top: 1px solid var(--_hairline); position: relative; z-index: 2; }
    .tabs::before { content: ""; position: absolute; top: 7px; left: var(--_pad); right: var(--_pad); bottom: calc(9px + env(safe-area-inset-bottom));
      border-radius: 18px; background: rgba(255, 255, 255, .08); border: 1px solid rgba(255, 255, 255, .16); pointer-events: none; }
    .tab { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px; min-width: 0; min-height: 58px;
      padding: 3px; border-radius: 14px; background: transparent; border: 0;
      color: rgba(255, 255, 255, .78); font-size: 16px; font-weight: 600; line-height: 1.15; letter-spacing: .01em; position: relative;
      transition: background-color 120ms ease, color 120ms ease, transform 120ms ease; }
    .tab span { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tab .i { width: 30px; height: 30px; }
    .tab + .tab::before { content: ""; position: absolute; left: -2.5px; top: 25%; bottom: 25%; width: 1px; background: rgba(255, 255, 255, .16); transition: opacity 120ms ease; }
    .tab.active::before, .tab.active + .tab::before, .tab:hover::before, .tab:hover + .tab::before { opacity: 0; }
    @media (hover: hover) { .tab:hover { background: rgba(255, 255, 255, .12); color: #fff; } }
    .tab:active { transform: scale(.97); background: rgba(255, 255, 255, .2); color: #fff; }
    .tab.active, .tab.active:hover, .tab.active:active { background: var(--_active); color: var(--_on-accent); }
    .tab:focus-visible { outline: 2px solid var(--_active); outline-offset: 3px; }
    .tab .badge { top: 4px; left: calc(50% + 6px); }
    .tab.active .badge { background: var(--_on-accent); color: var(--_active); }
    .lg .tab { min-height: 80px; font-size: 17px; } .lg .tab .i { width: 34px; height: 34px; }
    @container np (max-width: 520px) { }
    @media (max-width: 960px) { .pill b { display: none; } }
    @media (max-width: 640px) {
      .pill { padding: 0; width: 44px; min-height: 44px; justify-content: center; } .pill .pn, .pill b { display: none; } .lg .pill { width: 56px; min-height: 56px; } .clock { font-size: 18px; } .top { min-height: 52px; padding-top: 10px; padding-bottom: 10px; }
      .tabs { gap: 2px; padding-left: calc(var(--_pad) + 3px); padding-right: calc(var(--_pad) + 3px); }
      .tab { font-size: 12px; letter-spacing: 0; } .tab .i { width: 26px; height: 26px; }
      .tab span { white-space: normal; text-align: center; line-height: 1.1; }
      .lg .tab { min-height: 68px; font-size: 13px; } .lg .tab .i { width: 30px; height: 30px; }
    }
    /* short panels (fitted height < 700 / < 560 px): tighter header and tab bar so the middle keeps the room */
    :host([data-fit]) .top { min-height: 50px; padding-top: 7px; padding-bottom: 7px; }
    :host([data-fit]) .brand { font-size: 19px; } :host([data-fit]) .brand-i { width: 24px; height: 24px; } :host([data-fit]) .clock { font-size: 19px; }
    :host([data-fit]) .pill { padding: 5px 12px; font-size: 13px; }
    :host([data-fit]) .tabs { gap: 3px; padding: 7px calc(var(--_pad) + 3px) calc(8px + env(safe-area-inset-bottom)); }
    :host([data-fit]) .tabs::before { top: 4px; bottom: calc(5px + env(safe-area-inset-bottom)); border-radius: 15px; }
    :host([data-fit]) .tab { min-height: 50px; padding: 3px; gap: 3px; font-size: 14px; border-radius: 12px; } :host([data-fit]) .tab .i { width: 24px; height: 24px; }
    :host([data-fit]) .tab + .tab::before { left: -2px; }
    :host([data-fit]) .lg .tab { min-height: 60px; font-size: 15px; } :host([data-fit]) .lg .tab .i { width: 28px; height: 28px; }
    :host([data-fit=tiny]) .top { min-height: 44px; padding-top: 5px; padding-bottom: 5px; }
    /* tiny (< 560 px): one row, icon + small label side by side (icons only on narrow screens) */
    :host([data-fit=tiny]) .tabs { padding: 6px calc(var(--_pad) + 3px) calc(6px + env(safe-area-inset-bottom)); }
    :host([data-fit=tiny]) .tabs::before { top: 3px; bottom: calc(3px + env(safe-area-inset-bottom)); border-radius: 14px; }
    :host([data-fit=tiny]) .tab { flex-direction: row; gap: 8px; min-height: 44px; font-size: 13px; border-radius: 11px; }
    :host([data-fit=tiny]) .tab .i { width: 22px; height: 22px; }
    :host([data-fit=tiny]) .tab .badge { position: static; min-width: 18px; height: 18px; padding: 0 5px; font-size: 10px; flex: none; }
    :host([data-fit=tiny]) .lg .tab { min-height: 52px; font-size: 14px; } :host([data-fit=tiny]) .lg .tab .i { width: 26px; height: 26px; }
    @media (max-width: 640px) { :host([data-fit=tiny]) .tab span { display: none; } }
  `];
}
if (!customElements.get('jukebox-card')) customElements.define('jukebox-card', JukeboxCard);

(window as any).customCards = (window as any).customCards || [];
if (!(window as any).customCards.some((c: any) => c.type === 'jukebox-card'))
  (window as any).customCards.push({ type: 'jukebox-card', name: 'Jukebox', description: 'Kiosk jukebox for Music Assistant: Now Playing, Browse, Search and Queue', preview: false });
// eslint-disable-next-line no-console
console.info(`%c JUKEBOX-CARD %c ${VERSION} `, 'background:#fff;color:#000;font-weight:700', 'background:#000;color:#fff');
