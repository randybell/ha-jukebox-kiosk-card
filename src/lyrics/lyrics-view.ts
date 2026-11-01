import { LitElement, html, css, nothing, type PropertyValues } from 'lit';
import { tokens, base } from '../styles';
import { icon } from '../icons';
import { fmtTime, prefersReducedMotionSafe } from './util';
import { indexAt, positionOf } from './lrc';
import type { LyricsState, LyricsStore } from './store';
import type { HassEntity, HomeAssistant, JukeboxCardConfig } from '../types';

export type LyricsMode = 'overlay' | 'tab' | 'stage' | 'saver';
/** HA media_player SEEK feature bit */
const SEEK = 2;
export const LONG_PRESS_MS = 550;
const MOVE_CANCEL_PX = 10;
const USER_SCROLL_HOLD_MS = 6000;
export const DEFAULT_LYRICS_OFFSET_MS = 500;
export const MSG = { loading: 'Looking for lyrics…', none: 'No lyrics found', error: 'Lyrics unavailable', idle: 'Nothing playing' };

/**
 * One lyrics surface. Every surface reads the same LyricsStore, so a track change costs one lookup however many are shown.
 * Synced: the current line follows the interpolated player position (media_position + time since media_position_updated_at
 * + lyrics_offset_ms). A timer is set for the next line's timestamp; there is no per-frame loop.
 * Long-press a synced line (not on radio, only when the player can seek) to jump there. A plain tap does nothing.
 * Plain lyrics scroll gently in proportion to the track progress; touching or scrolling them pauses that for a few seconds.
 * Lines always move UP as the song advances: a ResizeObserver re-centres instantly when the layout changes (fonts, Stage,
 * fit, rotation), so the next smooth scroll never has to go backwards. The screensaver slides a column of lines (transform only).
 * Lyrics are rendered as text, never as HTML.
 */
export class JbLyrics extends LitElement {
  static properties = {
    hass: { attribute: false }, config: { attribute: false }, store: { attribute: false },
    mode: { reflect: true }, active: { type: Boolean }, art: { attribute: false },
    _s: { state: true }, _press: { state: true }, _flash: { state: true }, _chip: { state: true },
  };
  hass?: HomeAssistant;
  config!: JukeboxCardConfig;
  store?: LyricsStore;
  mode: LyricsMode = 'tab';
  active = false;
  art = '';
  private _s: LyricsState = { status: 'idle', lines: [] };
  private _press = -1;
  private _flash = -1;
  private _chip = '';
  private _unsub?: () => void;
  private _timer?: number;
  private _holdTimer?: number;
  private _chipTimer?: number;
  private _start?: { x: number; y: number; id: number };
  private _suppressClick = false;
  private _userAt = 0;
  private _lastCur = -2;
  private _lastLines?: unknown;
  private _seekHold?: { v: number; t: number; upd?: string };
  private _ro?: ResizeObserver;
  private _roEls: Element[] = [];
  /** screensaver column offset (px) last applied */
  private _svY?: number;
  /** index of the highlighted line at the last render (tests read data-cur) */
  cur = -1;

  private get eid() { return this.config?.entity || 'media_player.everywhere'; }
  private get ent(): HassEntity | undefined { return this.hass?.states[this.eid]; }

  connectedCallback() {
    super.connectedCallback();
    if (this.store && !this._unsub) this._unsub = this.store.subscribe((s) => (this._s = s));
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsub?.(); this._unsub = undefined;
    window.clearTimeout(this._timer); window.clearTimeout(this._holdTimer); window.clearTimeout(this._chipTimer);
    this._ro?.disconnect(); this._roEls = []; this._svY = undefined;
  }
  protected willUpdate(ch: PropertyValues) {
    if (ch.has('store')) { this._unsub?.(); this._unsub = this.isConnected ? this.store?.subscribe((s) => (this._s = s)) : undefined; }
  }
  protected shouldUpdate(ch: PropertyValues) {
    if (ch.size === 1 && ch.has('hass')) {
      const old = ch.get('hass') as HomeAssistant | undefined;
      return !old || !this.hass || old.states[this.eid] !== this.hass.states[this.eid];
    }
    return true;
  }

  // ---------- position ----------
  private offset() { const o = Number(this.config?.lyrics_offset_ms ?? DEFAULT_LYRICS_OFFSET_MS); return Number.isFinite(o) ? o / 1000 : 0; }
  /** player position in seconds (no offset), holding an optimistic value right after a long-press seek */
  position(now = Date.now()) {
    const e = this.ent;
    const upd = e?.attributes?.media_position_updated_at;
    if (this._seekHold) {
      if (upd !== this._seekHold.upd || now - this._seekHold.t > 4000) this._seekHold = undefined;
      else return this._seekHold.v + (e?.state === 'playing' ? (now - this._seekHold.t) / 1000 : 0);
    }
    return positionOf(e?.attributes, e?.state, now);
  }
  private playing() { return this.ent?.state === 'playing'; }
  seekable() {
    const s = this._s, e = this.ent;
    if (s.status !== 'synced' || !s.track || s.track.radio || this.config?.lyrics_seek === false) return false;
    const dur = Number(e?.attributes?.media_duration) || s.track.duration;
    if (!(dur > 0)) return false;
    const f = e?.attributes?.supported_features;
    return typeof f !== 'number' || (f & SEEK) === SEEK;
  }

  // ---------- long-press seek ----------
  private lineOf(ev: Event): HTMLElement | null {
    for (const n of ev.composedPath()) { const el = n as HTMLElement; if (el?.classList?.contains('ln')) return el; if (el === this) break; }
    return null;
  }
  private onDown = (ev: PointerEvent) => {
    this._userAt = Date.now();
    if (!this.seekable() || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
    const el = this.lineOf(ev); if (!el) return;
    const i = Number(el.dataset.i);
    const line = this._s.lines[i]; if (!line) return;
    this._start = { x: ev.clientX, y: ev.clientY, id: ev.pointerId };
    this._press = i;
    window.clearTimeout(this._holdTimer);
    this._holdTimer = window.setTimeout(() => this.fireSeek(i), LONG_PRESS_MS);
  };
  private onMove = (ev: PointerEvent) => {
    if (!this._start || ev.pointerId !== this._start.id) return;
    if (Math.hypot(ev.clientX - this._start.x, ev.clientY - this._start.y) > MOVE_CANCEL_PX) this.cancelPress();
  };
  private cancelPress = () => { window.clearTimeout(this._holdTimer); this._start = undefined; if (this._press >= 0) this._press = -1; };
  private onClickCapture = (ev: Event) => {
    // the click that ends a long-press must not reach anything underneath (Stage taps toggle its controls)
    if (this._suppressClick) { this._suppressClick = false; ev.stopPropagation(); ev.preventDefault(); }
  };
  private fireSeek(i: number) {
    const line = this._s.lines[i];
    this._start = undefined; this._press = -1;
    if (!line || !this.hass || !this.seekable()) return;
    const p = Math.max(0, Math.floor(line.t));
    this._suppressClick = true;
    window.setTimeout(() => (this._suppressClick = false), 800);
    this._seekHold = { v: line.t, t: Date.now(), upd: this.ent?.attributes?.media_position_updated_at };
    this._userAt = 0;
    this._flash = i;
    this._chip = `Jumped to ${fmtTime(p)}`;
    window.clearTimeout(this._chipTimer);
    this._chipTimer = window.setTimeout(() => { this._flash = -1; this._chip = ''; }, 1400);
    try { navigator.vibrate?.(12); } catch { /* */ }
    this.hass.callService('media_player', 'media_seek', { seek_position: p }, { entity_id: this.eid }).catch((err: any) => {
      console.warn('[jukebox-card] lyrics seek failed', err);
      this._seekHold = undefined; this._chip = 'Could not seek'; this.requestUpdate();
    });
    this.dispatchEvent(new CustomEvent('jukebox-lyrics-seek', { detail: { position: p, line: i }, bubbles: true, composed: true }));
  }
  private onUserScroll = () => { this._userAt = Date.now(); };

  // ---------- timers / scrolling ----------
  protected updated() {
    window.clearTimeout(this._timer);
    const s = this._s;
    this.dataset.status = s.status;
    this.dataset.cur = String(this.cur);
    this.observeSize();
    if (!this.active || (s.status !== 'synced' && s.status !== 'plain')) return;
    const linesChanged = this._lastLines !== s.lines;
    this._lastLines = s.lines;
    if (this.mode === 'saver') this.slideSaver(linesChanged);
    else {
      const sc = this.renderRoot.querySelector('.sc') as HTMLElement | null;
      if (s.status === 'synced') {
        if (sc && (this.cur !== this._lastCur || linesChanged) && Date.now() - this._userAt > USER_SCROLL_HOLD_MS) this.center(sc, linesChanged, this.cur > this._lastCur);
      } else if (sc) this.plainScroll(sc, linesChanged);
    }
    this._lastCur = this.cur;
    if (!this.playing()) return;
    if (s.status === 'synced') {
      const nxt = s.lines[this.cur + 1];
      if (nxt) {
        const ms = (nxt.t - (this.position() + this.offset())) * 1000 + 30;
        this._timer = window.setTimeout(() => this.requestUpdate(), Math.max(60, Math.min(15_000, ms)));
      }
    } else this._timer = window.setTimeout(() => this.updated(), 2000);
  }
  /** Watch the scroller and the lines for size changes. A layout change (fonts loading, the Stage opening, fit, rotation,
   *  the overlay resizing) moves every line; re-centre at once (no animation) so the next line change scrolls forward
   *  from the right place instead of sliding back down from a stale scroll position. */
  private observeSize() {
    const els = [...this.renderRoot.querySelectorAll('.sc, .sc > .col, .win, .win > .col')];
    if (els.length === this._roEls.length && els.every((e, i) => e === this._roEls[i])) return;
    if (typeof ResizeObserver === 'undefined') return;
    this._ro ??= new ResizeObserver(() => this.onResize());
    this._ro.disconnect();
    this._roEls = els;
    els.forEach((e) => this._ro!.observe(e));
  }
  private onResize() {
    const s = this._s;
    if (!this.active || (s.status !== 'synced' && s.status !== 'plain')) return;
    if (this.mode === 'saver') { this.slideSaver(true); return; }
    const sc = this.renderRoot.querySelector('.sc') as HTMLElement | null;
    if (!sc) return;
    if (s.status === 'synced') { if (Date.now() - this._userAt > USER_SCROLL_HOLD_MS) this.center(sc, true); }
    else this.plainScroll(sc, true);
  }
  private center(sc: HTMLElement, jump: boolean, forward = false) {
    const el = sc.querySelector(`.ln[data-i="${Math.max(0, this.cur)}"]`) as HTMLElement | null;
    if (!el) return;
    const top = Math.max(0, el.offsetTop - (sc.clientHeight - el.offsetHeight) / 2);
    // the song moved forward but the target is above us (a stale position): never animate the lines downwards, jump instead
    if (forward && top < sc.scrollTop - 1) jump = true;
    sc.scrollTo({ top, behavior: jump || prefersReducedMotionSafe() ? 'auto' : 'smooth' });
  }
  private plainScroll(sc: HTMLElement, jump: boolean) {
    if (Date.now() - this._userAt < USER_SCROLL_HOLD_MS * 1.5) return;
    const dur = Number(this.ent?.attributes?.media_duration) || this._s.track?.duration || 0;
    const max = sc.scrollHeight - sc.clientHeight;
    if (!dur || max <= 0) return;
    const top = Math.round(this.plainFrac(dur) * max);
    sc.scrollTo({ top, behavior: jump || top < sc.scrollTop - 1 || prefersReducedMotionSafe() ? 'auto' : 'smooth' });
  }
  /** how far through plain (untimed) lyrics we are: 0 for the first 10 s, 1 for the last 20 s */
  private plainFrac(dur: number) { return Math.max(0, Math.min(1, (this.position() - 10) / Math.max(1, dur - 30))); }
  /** Screensaver: a column of lines inside a clipped window, moved with a transform transition (no scrolling, no layout
   *  per frame). Synced: the current line sits in the middle slot, so on each line change the old line slides up into the
   *  "past" slot and the next one slides up from the bottom. Plain: the column steps up one line at a time with progress.
   *  Going backwards (a seek back, a new track) jumps instead of sliding down. */
  private slideSaver(jump: boolean) {
    const win = this.renderRoot.querySelector('.win') as HTMLElement | null;
    const col = win?.querySelector('.col') as HTMLElement | null;
    if (!win || !col) return;
    const rows = col.children as HTMLCollectionOf<HTMLElement>;
    if (!rows.length) return;
    let y = 0;
    if (this._s.status === 'synced') {
      const el = col.querySelector(`.ln[data-i="${this.cur}"]`) as HTMLElement | null;
      const pitch = rows.length > 1 ? rows[1].offsetTop - rows[0].offsetTop : rows[0].offsetHeight;
      if (el) y = el.offsetTop - pitch;
    } else {
      const dur = Number(this.ent?.attributes?.media_duration) || this._s.track?.duration || 0;
      const max = col.offsetHeight - win.clientHeight;
      if (dur && max > 0) {
        const k = Math.min(rows.length - 1, Math.floor(this.plainFrac(dur) * rows.length));
        y = Math.max(0, Math.min(max, rows[k].offsetTop - Math.round(win.clientHeight / 3)));
      }
    }
    y = Math.round(y);
    if (y === this._svY && !jump) return;
    const instant = jump || this._svY === undefined || y < this._svY || prefersReducedMotionSafe();
    if (instant) col.classList.add('jump');
    col.style.transform = `translate3d(0, ${-y}px, 0)`;
    if (instant) { void col.offsetHeight; col.classList.remove('jump'); }
    this._svY = y;
    col.dataset.y = String(y);
  }

  // ---------- render ----------
  private msg(text: string, sub?: unknown) {
    return html`<div class="msg" role="status"><span class="mt">${text}</span>${sub ?? nothing}</div>`;
  }
  private header() {
    const a = this.ent?.attributes ?? {};
    const t = this._s.track;
    if (!t && !a.media_title) return nothing;
    return html`<div class="hd">${this.art ? html`<img class="ha" src=${this.art} alt="" draggable="false" @error=${(e: Event) => ((e.target as HTMLElement).style.visibility = 'hidden')} />` : html`<span class="ha ph">${icon('disc')}</span>`}
      <span class="hm"><b>${t?.title ?? a.media_title}</b><small>${t?.artist ?? a.media_artist ?? ''}</small></span>
      ${this._s.status === 'plain' ? html`<span class="chip">Unsynced</span>` : nothing}</div>`;
  }
  render() {
    const s = this._s;
    const mode = this.mode;
    const synced = s.status === 'synced';
    this.cur = synced ? indexAt(s.lines, this.position() + this.offset()) : -1;
    if (mode === 'saver') return this.renderSaver();
    const sub = s.status === 'error' && mode !== 'overlay'
      ? (s.reason === 'config' ? html`<small>Set mass_queue_entry_id in the card options.</small>`
        : html`${s.reason === 'permission' ? html`<small>This Home Assistant user may not be allowed to run mass_queue.send_command (an admin user may be needed).</small>` : nothing}<button class="retry" tabindex="-1" @click=${(e: Event) => { e.stopPropagation(); this.store?.retry(); }}>Try again</button>`)
      : s.status === 'none' && s.track?.radio && mode !== 'overlay' ? html`<small>${s.track.artist} · ${s.track.title}</small>` : nothing;
    let body: unknown;
    switch (s.status) {
      case 'loading': body = this.msg(MSG.loading); break;
      case 'none': body = this.msg(MSG.none, sub); break;
      case 'error': body = this.msg(MSG.error, sub); break;
      case 'idle': case 'off': body = mode === 'overlay' ? nothing : this.msg(MSG.idle); break;
      default: {
        const seek = this.seekable();
        body = html`<div class="sc ${synced ? 'synced' : 'plain'} ${seek ? 'seekable' : ''}" @wheel=${this.onUserScroll} @touchmove=${this.onUserScroll} @keydown=${this.onUserScroll}>
          <div class="pad"></div><div class="col">
          ${s.lines.map((l, i) => html`<p class="ln ${i === this.cur ? 'cur' : i < this.cur ? 'past' : ''} ${i === this._press ? 'press' : ''} ${i === this._flash ? 'flash' : ''} ${l.text ? '' : 'gap'}"
            data-i=${i} data-t=${synced ? l.t : nothing}>${l.text || (synced ? '♪' : '\u00a0')}</p>`)}
          </div><div class="pad"></div>
        </div>`;
      }
    }
    return html`<div class="ly m-${mode} st-${s.status}" @pointerdown=${this.onDown} @pointermove=${this.onMove} @pointerup=${this.cancelPress}
        @pointercancel=${this.cancelPress} @pointerleave=${this.cancelPress} @click=${this.onClickCapture} @contextmenu=${(e: Event) => e.preventDefault()}>
      ${mode === 'tab' ? this.header() : nothing}
      ${mode !== 'tab' && s.status === 'plain' ? html`<span class="chip fl">Unsynced</span>` : nothing}
      ${body}
      ${this._chip ? html`<div class="toast" role="status">${this._chip}</div>` : nothing}
    </div>`;
  }
  private renderSaver() {
    const s = this._s;
    if (s.status === 'synced') {
      const i = this.cur;
      return html`<div class="ly m-saver st-synced"><div class="win"><div class="col">
        <p class="ln intro ${i < 0 ? 'cur' : 'past'}" data-i="-1">♪</p>
        ${s.lines.map((l, k) => html`<p class="ln ${k === i ? 'cur' : k < i ? 'past' : ''}" data-i=${k}>${l.text || '♪'}</p>`)}</div></div></div>`;
    }
    if (s.status === 'plain')
      return html`<div class="ly m-saver st-plain"><div class="win"><div class="col">${s.lines.map((l, i) => html`<p class="ln ${l.text ? '' : 'gap'}" data-i=${i}>${l.text || '\u00a0'}</p>`)}</div></div></div>`;
    return nothing;
  }

  static styles = [tokens, base, css`
    :host { display: block; min-height: 0; color: #fff; font-family: var(--_font-body); }
    :host(:not([mode=saver])) { height: 100%; }
    .ly { position: relative; height: 100%; min-height: 0; display: flex; flex-direction: column; }
    .sc { position: relative; flex: 1; min-height: 0; overflow-y: auto; scrollbar-width: none; overscroll-behavior: contain; overflow-anchor: none; -webkit-overflow-scrolling: touch;
      -webkit-mask-image: linear-gradient(transparent 0, #000 16%, #000 84%, transparent 100%); mask-image: linear-gradient(transparent 0, #000 16%, #000 84%, transparent 100%); }
    .sc::-webkit-scrollbar { display: none; }
    .pad { height: 42%; }
    .ln { font-family: var(--_font-display); font-weight: 700; line-height: 1.25; color: rgba(255, 255, 255, .45); padding: .28em 0;
      transition: color 300ms ease, opacity 300ms ease, transform 300ms ease; transform-origin: left center; text-wrap: balance; overflow-wrap: anywhere; }
    .plain .ln { color: rgba(255, 255, 255, .82); font-weight: 600; }
    .synced .ln.past { color: rgba(255, 255, 255, .32); }
    .synced .ln.cur { color: #fff; }
    .ln.gap { opacity: .6; }
    .seekable .ln { cursor: pointer; position: relative; }
    /* long-press feedback: a white bar fills under the line while held, then the line flashes */
    .seekable .ln::after { content: ""; position: absolute; left: 0; bottom: .05em; height: 3px; width: 0; background: #fff; border-radius: 2px; opacity: 0; }
    .seekable .ln.press::after { width: min(100%, 220px); opacity: .9; transition: width ${LONG_PRESS_MS}ms linear, opacity 120ms; }
    .ln.press { transform: scale(.985); }
    .ln.flash { color: #fff !important; animation: flash 900ms ease; }
    @keyframes flash { 0% { background: #ffffff33 } 100% { background: transparent } }
    .msg { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; text-align: center; padding: 16px; }
    .mt { font-size: 18px; font-weight: 600; color: rgba(255, 255, 255, .78); }
    .st-loading .mt { animation: breathe 1.8s ease-in-out infinite; }
    @keyframes breathe { 50% { opacity: .45 } }
    .msg small { font-size: 13px; color: rgba(255, 255, 255, .55); }
    .retry { margin-top: 2px; padding: 8px 16px; border-radius: 999px; border: 1px solid #ffffff40; font-size: 14px; font-weight: 600; color: #fff; }
    .chip { font-size: 10px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; color: rgba(255, 255, 255, .7);
      padding: 4px 8px; border-radius: 999px; border: 1px solid #ffffff40; background: #0000008c; white-space: nowrap; }
    .chip.fl { position: absolute; top: 10px; left: 10px; z-index: 2; }
    .toast { position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%); z-index: 3; padding: 8px 14px; border-radius: 999px;
      background: #fff; color: #000; font-size: 13px; font-weight: 700; white-space: nowrap; box-shadow: 0 6px 24px #0008; }

    /* over the Now Playing art: a shade keeps the text readable on any cover, no backdrop-filter */
    .m-overlay { background: linear-gradient(to top, rgba(0, 0, 0, .8), rgba(0, 0, 0, .42)); padding: 0 6%; container-type: inline-size; }
    .m-overlay .ln { font-size: clamp(14px, 6.4cqw, 30px); text-shadow: 0 1px 12px #000c; }
    .m-overlay .msg .mt { font-size: clamp(14px, 5cqw, 20px); text-shadow: 0 1px 10px #000; }

    .m-tab { padding: 0 var(--_pad); }
    .m-tab .hd { display: flex; align-items: center; gap: 14px; padding: 16px 0 10px; border-bottom: 1px solid var(--_hairline); }
    .m-tab .ha { width: 56px; height: 56px; border-radius: 10px; object-fit: cover; flex: none; background: #111; box-shadow: 0 6px 20px #0008; }
    .m-tab .ha.ph { display: grid; place-items: center; } .m-tab .ha.ph .i { width: 28px; height: 28px; color: #ffffff40; }
    .m-tab .hm { display: flex; flex-direction: column; min-width: 0; flex: 1; }
    .m-tab .hm b { font-size: 18px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .m-tab .hm small { font-size: 14px; color: var(--_muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .m-tab .sc { max-width: 980px; width: 100%; margin: 0 auto; }
    .m-tab .ln { font-size: clamp(22px, 3.4vw, 40px); text-shadow: 0 2px 18px #0009; }
    .m-tab .plain .ln { font-size: clamp(19px, 2.6vw, 30px); }

    .m-stage .ln { font-size: clamp(24px, 3.6vw, 52px); text-shadow: 0 2px 24px #000b; }
    .m-stage .plain .ln { font-size: clamp(20px, 2.8vw, 38px); }
    .m-stage .chip.fl { top: 4px; left: 0; }

    /* screensaver: a clipped window over a column that slides up (transform only); --jb-ly-slide is 0ms under reduced motion */
    .m-saver { height: auto; }
    .m-saver .win { position: relative; overflow: hidden; }
    .m-saver .col { position: relative; transition: transform var(--jb-ly-slide, 650ms) cubic-bezier(.22, .8, .24, 1); }
    .m-saver .col.jump, .m-saver .col.jump .ln { transition: none; }
    .m-saver.st-synced .win { height: 5.25em; font-size: clamp(18px, 2.6cqw, 34px);
      -webkit-mask-image: linear-gradient(transparent 0, #000 12%, #000 88%, transparent 100%); mask-image: linear-gradient(transparent 0, #000 12%, #000 88%, transparent 100%); }
    .m-saver.st-synced .ln { font-size: 1em; height: 1.75em; line-height: 1.75em; padding: 0; width: 74%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      text-wrap: nowrap; text-shadow: 0 2px 24px #000c; transform-origin: left center;
      transition: color var(--jb-ly-slide, 650ms) ease, transform var(--jb-ly-slide, 650ms) cubic-bezier(.22, .8, .24, 1); }
    /* the current line is bigger by scale, not font-size, so every row keeps the same height and the slide stays one row */
    .m-saver.st-synced .ln.cur { color: #fff; transform: scale(1.35); }
    .m-saver.st-synced .ln.past { color: rgba(255, 255, 255, .4); }
    .m-saver.st-plain .win { height: 7.5em; font-size: clamp(16px, 2.2cqw, 28px); -webkit-mask-image: linear-gradient(transparent, #000 25%, #000 75%, transparent);
      mask-image: linear-gradient(transparent, #000 25%, #000 75%, transparent); }
    .m-saver.st-plain .ln { font-size: 1em; color: rgba(255, 255, 255, .8); font-weight: 600; white-space: normal; text-shadow: 0 2px 24px #000c; }
    @media (prefers-reduced-motion: reduce) { .ln, .m-saver .col { transition: none; animation: none; } }
  `];
}
if (!customElements.get('jb-lyrics')) customElements.define('jb-lyrics', JbLyrics);
