import { LitElement, html, css, nothing, type PropertyValues } from 'lit';
import { tokens, base } from './styles';
import { icon } from './icons';
import { providerLabel } from './providers';
import { mediaStyles, noFocus, fmtTime, provTpl, roomsOf, fire, ART, hash, playerArt, isRadio, RADIO_ART } from './shared';
import { throttle } from './slider';
import './slider';
import './lyrics/lyrics-view';
import type { LyricsStore } from './lyrics/store';
import type { QueueModel, QueueSnapshot } from './queue-model';
import type { HassEntity, HomeAssistant, JukeboxCardConfig } from './types';
import { volumeCap, canVolume, capVol } from './speakers/model';

const VOL_THROTTLE_MS = 200;
/** dynamic mode: what a room plays when it is not part of the current target ('' when it is, or idle) */
export function roomElsewhere(hass: HomeAssistant | undefined, target: string, room: string): string {
  const r = hass?.states[room], t = hass?.states[target];
  if (!r || !['playing', 'paused'].includes(r.state) || !r.attributes?.media_title) return '';
  const inT = ['playing', 'paused', 'buffering'].includes(t?.state ?? '') && Array.isArray(t?.attributes?.group_members) && t!.attributes.group_members.includes(room);
  return inT ? '' : `${r.state === 'paused' ? 'Paused: ' : ''}${r.attributes.media_title}`;
}
const HOLD_MS = 4000; // keep optimistic values this long unless the entity confirms sooner
const REPEAT_NEXT: Record<string, string> = { off: 'all', all: 'one', one: 'off' };

interface Pending<T> { v: T; t: number }

export class JbNow extends LitElement {
  static properties = {
    hass: { attribute: false }, config: { attribute: false }, queue: { attribute: false }, active: { type: Boolean }, lyrics: { attribute: false },
    _overlay: { state: true }, _tick: { state: true }, _snap: { state: true }, _toast: { state: true },
  };
  hass?: HomeAssistant;
  config!: JukeboxCardConfig;
  queue?: QueueModel;
  active = false;
  lyrics?: LyricsStore;
  /** lyrics over the art, remembered per device */
  private _overlay = readOverlay();
  private _tick = 0;
  private _snap?: QueueSnapshot;
  private _toast = '';
  private _toastTimer?: number;
  private _timer?: number;
  private _unsub?: () => void;
  private vol = new Map<string, Pending<number>>();
  private mute = new Map<string, Pending<boolean>>();
  private flags = new Map<string, Pending<any>>(); // shuffle / repeat / state / favorite
  private seek?: Pending<number> & { upd?: string };
  private senders = new Map<string, ReturnType<typeof throttle<[number]>>>();

  private get eid() { return this.config.entity || 'media_player.everywhere'; }
  private get ent(): HassEntity | undefined { return this.hass?.states[this.eid]; }

  connectedCallback() {
    super.connectedCallback();
    this._timer = window.setInterval(() => { if (this.active && this.ent?.state === 'playing') this._tick++; }, 1000);
  }
  disconnectedCallback() { super.disconnectedCallback(); window.clearInterval(this._timer); this._unsub?.(); this._unsub = undefined; }
  protected willUpdate(ch: PropertyValues) {
    if (ch.has('queue')) { this._unsub?.(); this._unsub = this.queue?.subscribe((s) => (this._snap = s)) as any; }
  }
  /** Re-render only when an entity we draw changed. */
  protected shouldUpdate(ch: PropertyValues) {
    if (ch.size === 1 && ch.has('hass')) {
      const old = ch.get('hass') as HomeAssistant | undefined;
      if (!old || !this.hass) return true;
      const ids = [this.eid, ...roomsOf(this.config).map((r) => r.entity)];
      return ids.some((id) => old.states[id] !== this.hass!.states[id]);
    }
    return true;
  }

  private toggleOverlay = () => { this._overlay = !this._overlay; writeOverlay(this._overlay); };

  // ---------- optimistic helpers ----------
  private held<T>(m: Map<string, Pending<T>>, key: string, actual: T, eq: (a: T, b: T) => boolean): T {
    const p = m.get(key);
    if (!p) return actual;
    if (Date.now() - p.t > HOLD_MS || eq(actual, p.v)) { m.delete(key); return actual; }
    return p.v;
  }
  private volOf(id: string) {
    const a = Number(this.hass?.states[id]?.attributes?.volume_level ?? 0);
    return this.held(this.vol, id, a, (x, y) => Math.abs(x - y) < 0.011);
  }
  private mutedOf(id: string) { return this.held(this.mute, id, !!this.hass?.states[id]?.attributes?.is_volume_muted, (x, y) => x === y); }
  private flag<T>(k: string, actual: T) { return this.held(this.flags, k, actual, (x, y) => x === y); }

  private call(domain: string, service: string, data: Record<string, any>, entity_id: string) {
    return this.hass!.callService(domain, service, data, { entity_id }).catch((err: any) => {
      console.warn(`[jukebox-card] ${domain}.${service} failed`, err);
      this.toast('That did not work. Check the player.');
    });
  }
  private toast(t: string) { this._toast = t; window.clearTimeout(this._toastTimer); this._toastTimer = window.setTimeout(() => (this._toast = ''), 2400); }

  // ---------- transport ----------
  private isPlaying() { return this.flag('state', this.ent?.state) === 'playing'; }
  playPause() {
    const playing = this.isPlaying();
    // dynamic speakers: starting an idle group may take speakers from other groups; the card asks first (fixed mode: no guard)
    const guard = this.config._guard;
    if (!playing && guard && !['playing', 'paused'].includes(this.ent?.state ?? '')) { void guard(this.eid).then((ok) => { if (ok) this.doPlayPause(false); }); return; }
    this.doPlayPause(playing);
  }
  private doPlayPause(playing: boolean) {
    this.flags.set('state', { v: playing ? 'paused' : 'playing', t: Date.now() }); this.requestUpdate();
    this.call('media_player', playing ? 'media_pause' : 'media_play', {}, this.eid);
  }
  prev() { this.call('media_player', 'media_previous_track', {}, this.eid); }
  next() { this.call('media_player', 'media_next_track', {}, this.eid); }
  toggleShuffle() {
    const v = !this.flag('shuffle', !!this.ent?.attributes?.shuffle);
    this.flags.set('shuffle', { v, t: Date.now() }); this.requestUpdate();
    this.call('media_player', 'shuffle_set', { shuffle: v }, this.eid);
  }
  cycleRepeat() {
    const cur = this.flag('repeat', (this.ent?.attributes?.repeat as string) ?? 'off');
    const v = REPEAT_NEXT[cur] ?? 'off';
    this.flags.set('repeat', { v, t: Date.now() }); this.requestUpdate();
    this.call('media_player', 'repeat_set', { repeat: v }, this.eid);
  }
  private isFav() {
    const cur = this._snap && this._snap.current >= 0 ? this._snap.items[this._snap.current] : undefined;
    return this.flag('fav:' + (this.ent?.attributes?.media_content_id ?? ''), !!cur?.favorite);
  }
  toggleFavorite() {
    const btn = this.config.favorite_entity ?? 'button.everywhere_favorite_current_song';
    const fav = this.isFav();
    this.flags.set('fav:' + (this.ent?.attributes?.media_content_id ?? ''), { v: !fav, t: Date.now() + 26000 }); this.requestUpdate();
    if (fav) {
      this.hass!.callService('mass_queue', 'unfavorite_current_item', { entity: this.eid }).catch((e: any) => console.warn(e));
      this.toast('Removed from favorites');
    } else {
      this.call('button', 'press', {}, btn);
      this.toast('Added to favorites');
    }
  }

  // ---------- progress ----------
  private position(): { pos: number; dur: number } {
    const a = this.ent?.attributes ?? {};
    const dur = Number(a.media_duration) || 0;
    let pos = Number(a.media_position) || 0;
    const upd = a.media_position_updated_at as string | undefined;
    if (this.ent?.state === 'playing' && upd) pos += (Date.now() - Date.parse(upd)) / 1000;
    if (this.seek) {
      if (upd !== this.seek.upd || Date.now() - this.seek.t > HOLD_MS) this.seek = undefined;
      else pos = this.seek.v + (this.ent?.state === 'playing' ? (Date.now() - this.seek.t) / 1000 : 0);
    }
    return { pos: dur ? Math.max(0, Math.min(dur, pos)) : pos, dur };
  }
  private onSeekInput = (e: CustomEvent) => {
    const { dur } = this.position();
    const el = this.renderRoot.querySelector('.tl') as HTMLElement | null;
    if (el) el.dataset.v = fmtTime(e.detail.value * dur);
  };
  private onSeek = (e: CustomEvent) => {
    const { dur } = this.position(); if (!dur) return;
    const p = Math.round(e.detail.value * dur);
    this.seek = { v: p, t: Date.now(), upd: this.ent?.attributes?.media_position_updated_at };
    this.call('media_player', 'media_seek', { seek_position: p }, this.eid);
    this.requestUpdate();
  };

  // ---------- volume ----------
  private sender(id: string) {
    let s = this.senders.get(id);
    if (!s) {
      s = throttle((v: number) => { this.call('media_player', 'volume_set', { volume_level: v }, id); }, VOL_THROTTLE_MS);
      this.senders.set(id, s);
    }
    return s;
  }
  /** quiet-hours cap for this user (undefined = none) */
  private cap() { return volumeCap(this.config, this.hass?.user); }
  private onVolInput(id: string, e: CustomEvent) {
    const v = capVol(e.detail.value, this.cap());
    this.vol.set(id, { v, t: Date.now() });
    this.setVolLabel(id, v);
    this.sender(id)(v);
  }
  private onVolChange(id: string, e: CustomEvent) {
    const v = capVol(e.detail.value, this.cap());
    this.vol.set(id, { v, t: Date.now() });
    this.sender(id).flush(v); // always send the final value on release
    this.requestUpdate();
  }
  private setVolLabel(id: string, v: number) {
    const el = this.renderRoot.querySelector(`.vr[data-entity="${id}"] .vv`) as HTMLElement | null;
    if (el) el.dataset.v = String(Math.round(v * 100));
  }
  private toggleMute(id: string) {
    const v = !this.mutedOf(id);
    this.mute.set(id, { v, t: Date.now() }); this.requestUpdate();
    this.call('media_player', 'volume_mute', { is_volume_muted: v }, id);
  }

  // ---------- render ----------
  private volRow(id: string, name: string, main: boolean) {
    const st = this.hass?.states[id];
    const off = !st || st.state === 'unavailable' || st.state === 'off';
    const ro = !canVolume(this.config, this.hass?.user);
    const muted = this.mutedOf(id);
    const v = this.volOf(id);
    const ic = muted ? 'volmute' : main ? 'vol' : 'speaker';
    const elsewhere = !main && this.config.speaker_mode === 'dynamic' ? roomElsewhere(this.hass, this.eid, id) : '';
    return html`<div class="vr ${main ? 'main' : 'room'} ${muted ? 'muted' : ''} ${off ? 'off' : ''}" data-entity=${id}>
      <button class="vm" tabindex="-1" aria-label="${muted ? 'Unmute' : 'Mute'} ${name}" ?disabled=${off || ro}
        @pointerdown=${noFocus} @click=${() => this.toggleMute(id)}>${icon(ic)}</button>
      <span class="vn">${name}${off ? html` <i>offline</i>` : nothing}${elsewhere ? html`<small class="else">${elsewhere}</small>` : nothing}</span>
      <jb-slider class="vs" .value=${muted ? 0 : v} .max=${this.cap()} ?disabled=${off || ro} .label=${`${name} volume`}
        @jb-input=${(e: CustomEvent) => this.onVolInput(id, e)} @jb-change=${(e: CustomEvent) => this.onVolChange(id, e)}></jb-slider>
      <span class="vv" data-v=${muted ? '–' : String(Math.round(v * 100))}></span>
    </div>`;
  }

  render() {
    if (!this.config) return nothing;
    const e = this.ent;
    const a = e?.attributes ?? {};
    const title = a.media_title as string | undefined;
    const idle = !e || !title || ['off', 'idle', 'unavailable', 'standby'].includes(e.state);
    const cur = this._snap && this._snap.current >= 0 ? this._snap.items[this._snap.current] : undefined;
    const radioNow = a.media_content_type === 'radio' || isRadio({ uri: a.media_content_id ?? '' } as any);
    const pic = playerArt(a, cur) || (radioNow && !idle ? RADIO_ART : '');
    const prov = providerLabel(a.media_content_id);
    const playing = this.isPlaying();
    const shuffle = this.flag('shuffle', !!a.shuffle);
    const repeat = this.flag('repeat', (a.repeat as string) ?? 'off');
    const { pos, dur } = this.position();
    const where = (a.friendly_name as string) ?? 'Everywhere';
    const stateWord = playing ? 'Playing on' : e?.state === 'paused' || this.flag('state', e?.state) === 'paused' ? 'Paused on' : 'Ready on';
    const rooms = roomsOf(this.config, this.hass);
    const up = this.queue?.upNext ?? [];
    const nextIt = up[0];
    const more = Math.max(0, (this.queue?.remaining ?? up.length) - 1);
    const favOn = this.isFav();
    const showFav = (this.config.favorite_entity ?? 'button.everywhere_favorite_current_song') !== '';
    const tb = (cls: string, ic: string, label: string, fn: () => void, on?: boolean, dot = false, dis = false) =>
      html`<button class="tb ${cls} ${on ? 'on' : ''}" tabindex="-1" aria-label=${label} aria-pressed=${on === undefined ? nothing : on ? 'true' : 'false'}
        ?disabled=${dis} @pointerdown=${noFocus} @click=${fn}>${icon(ic)}${dot ? html`<i class="dot"></i>` : nothing}</button>`;
    const showLyr = !idle && this.config.show_lyrics !== false && !!this.lyrics;
    return html`<div class="nw ${idle ? 'idle' : ''}" data-state=${e?.state ?? 'unknown'}>
      <div class="art ${showLyr && this._overlay ? 'lyr-on' : ''}" style="background:${ART[hash(title || 'x') % ART.length]}">
        ${pic ? html`<img src=${pic} alt="" draggable="false" @error=${(ev: Event) => ((ev.target as HTMLElement).style.display = 'none')} />`
          : html`<span class="ph">${icon('disc')}</span>`}
        ${showLyr && this._overlay ? html`<jb-lyrics class="ovl" mode="overlay" .hass=${this.hass} .config=${this.config} .store=${this.lyrics}
          ?active=${this.active}></jb-lyrics>` : nothing}
        ${idle ? nothing : html`<div class="art-btns">
          ${showLyr ? html`<button class="ab lyr ${this._overlay ? 'on' : ''}" tabindex="-1" aria-label="Lyrics" aria-pressed=${this._overlay ? 'true' : 'false'}
            @pointerdown=${noFocus} @click=${this.toggleOverlay}>${icon('lyrics')}</button>` : nothing}
          <button class="ab stg" tabindex="-1" aria-label="Full screen" @pointerdown=${noFocus}
            @click=${() => fire(this, 'jukebox-stage', { open: true })}>${icon('fullscreen')}</button>
        </div>`}
      </div>
      <div class="info">
        <div class="badges">${prov ? html`<span class="pv big">${prov}</span>` : nothing}
          <span class="where">${icon('eq', 'i xs')}${stateWord} ${where}</span></div>
        <h1 class="ti">${idle ? 'Nothing playing' : title}</h1>
        <div class="sub">${idle ? 'Pick something in Search or Browse.' : [a.media_artist, a.media_album_name].filter(Boolean).join(' · ')}</div>
        <div class="prog ${dur ? '' : 'nodur'}">
          <span class="tl" data-v=${fmtTime(pos)}></span>
          <jb-slider class="ps" .value=${dur ? pos / dur : 0} ?disabled=${!dur || idle} .label=${'Seek'}
            @jb-input=${this.onSeekInput} @jb-change=${this.onSeek}></jb-slider>
          <span class="tr">${dur ? fmtTime(dur) : a.media_content_type === 'radio' || !dur ? 'LIVE' : ''}</span>
        </div>
        <div class="tp">
          ${tb('sh', 'shuffle', 'Shuffle', () => this.toggleShuffle(), shuffle, shuffle)}
          ${tb('pr', 'prev', 'Previous', () => this.prev())}
          ${tb('pp', playing ? 'pause' : 'play', playing ? 'Pause' : 'Play', () => this.playPause())}
          ${tb('nx', 'next', 'Next', () => this.next())}
          ${tb('rp', repeat === 'one' ? 'repeat1' : 'repeat', `Repeat ${repeat}`, () => this.cycleRepeat(), repeat !== 'off', repeat !== 'off')}
          ${showFav ? tb('fv', favOn ? 'heart' : 'heartline', favOn ? 'Remove from favorites' : 'Add to favorites', () => this.toggleFavorite(), favOn, false, idle) : nothing}
        </div>
        ${nextIt ? html`<button class="upn panel" tabindex="-1" @pointerdown=${noFocus} @click=${() => fire(this, 'jukebox-nav', { tab: 'queue' })}>
            <span class="eyebrow">Up next</span><b>${nextIt.media_title}</b>${provTpl(nextIt.media_content_id)}
            <span class="more">${more ? `+ ${more} more` : ''}</span></button>` : nothing}
        <div class="vol panel">
          ${this.volRow(this.eid, where, true)}
          ${rooms.length ? html`<div class="rooms">${rooms.map((r) => this.volRow(r.entity, r.name, false))}</div>` : nothing}
        </div>
      </div>
      ${this._toast ? html`<div class="toast" role="status">${this._toast}</div>` : nothing}
    </div>`;
  }

  static styles = [tokens, base, mediaStyles, css`
    :host { display: block; height: 100%; min-height: 0; color: var(--_fg); font-family: var(--_font-body); }
    .nw { position: relative; height: 100%; display: grid; overflow-y: auto; scrollbar-width: none; overscroll-behavior: contain;
      grid-template-columns: minmax(0, 1fr); justify-items: center; align-content: start; gap: 24px; padding: 14px calc(var(--_pad) + 12px) 20px; }
    .nw::-webkit-scrollbar { display: none; }
    .art { position: relative; width: min(calc(100cqw - 2 * var(--_pad)), 44cqh, 580px); aspect-ratio: 1; border-radius: 14px; overflow: hidden;
      box-shadow: 0 24px 60px #000000b3, 0 0 0 1px #ffffff14; }
    .art .ovl { position: absolute; inset: 0; z-index: 1; }
    .art-btns { position: absolute; top: 10px; right: 10px; z-index: 2; display: flex; gap: 8px; }
    .ab { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; background: #000000a6; color: rgba(255, 255, 255, .72);
      border: 1px solid #ffffff2e; box-shadow: 0 4px 14px #0007; transition: background 150ms, color 150ms; }
    .ab .i { width: 22px; height: 22px; }
    .ab.on { background: #fff; color: #000; border-color: #fff; }
    .ab:active { transform: scale(.94); }
    .art img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
    .art .ph { position: absolute; inset: 0; display: grid; place-items: center; background: #111; }
    .art .ph .i { width: 30%; height: 30%; color: #ffffff30; }
    .info { width: 100%; max-width: 760px; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
    .badges { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .pv.big { font-size: 11px; padding: 4px 10px; }
    .where { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
      padding: 4px 10px; border-radius: 999px; background: #00000066; border: 1px solid #ffffff1f; color: var(--_muted); }
    .ti { font-family: var(--_font-display); font-weight: 800; font-size: clamp(28px, 4.6cqw, 44px); line-height: 1.08; letter-spacing: -.01em;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; text-shadow: 0 2px 20px #0008; }
    .sub { font-size: clamp(15px, 1.8cqw, 19px); color: var(--_muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: -4px; }
    .prog { display: grid; grid-template-columns: 52px minmax(0, 1fr) 52px; align-items: center; gap: 10px; font-size: 12px; color: var(--_muted); font-variant-numeric: tabular-nums; }
    .prog .tr { text-align: right; }
    /* live labels: text comes from data-v so drag handlers can update it without touching Lit-owned text nodes */
    .tl::after, .vv::after { content: attr(data-v); }
    .ps { --jb-slider-h: 4px; --jb-slider-knob: 14px; --jb-slider-hit: 34px; }
    .vs { --jb-slider-h: 7px; --jb-slider-knob: 22px; --jb-slider-hit: 40px; }
    .prog.nodur .ps { opacity: .5; }
    .tp { display: grid; grid-template-columns: repeat(6, 1fr); align-items: center; justify-items: center; margin: 2px 0; }
    .tp:has(.tb:nth-child(5):last-child) { grid-template-columns: repeat(5, 1fr); }
    .tb { position: relative; width: 56px; height: 56px; border-radius: 50%; display: grid; place-items: center; color: var(--_active); }
    .tb .i { width: 30px; height: 30px; }
    .tb.sh, .tb.rp { color: var(--_inactive); } .tb.sh .i, .tb.rp .i { width: 24px; height: 24px; }
    .tb.sh.on, .tb.rp.on, .tb.fv.on { color: var(--_active); }
    .tb.fv { color: var(--_inactive); } .tb.fv .i { width: 26px; height: 26px; }
    .tb .dot { position: absolute; left: 50%; bottom: 6px; width: 5px; height: 5px; margin-left: -2.5px; border-radius: 50%; background: currentColor; }
    .tb.pp { width: 80px; height: 80px; background: var(--_active); color: var(--_on-accent); box-shadow: 0 10px 30px #0009; }
    .tb.pp .i { width: 36px; height: 36px; }
    .tb:active { transform: scale(.94); }
    .tb:disabled { opacity: .3; }
    .upn { display: flex; align-items: center; gap: 10px; height: 44px; padding: 0 14px; text-align: left; min-width: 0; width: 100%; }
    .upn .eyebrow { font-size: 10px; flex: none; }
    .upn b { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .upn .pv { flex: none; }
    .upn .more { margin-left: auto; font-size: 12px; color: var(--_muted); flex: none; }
    .vol { container: vol / inline-size; padding: 6px 14px; display: flex; flex-direction: column; }
    .rooms { display: flex; flex-direction: column; border-top: 1px solid var(--_divider); }
    .vr { display: grid; grid-template-columns: 30px minmax(80px, 30%) minmax(0, 1fr) 34px; align-items: center; gap: 8px; min-height: 46px; }
    .vm { width: 34px; height: 34px; display: grid; place-items: center; color: var(--_active); margin-left: -6px; border-radius: 50%; }
    .vm .i { width: 20px; height: 20px; }
    .vr.room .vm { color: var(--_inactive); } .vr.room .vm .i { width: 18px; height: 18px; }
    .vr.muted .vm { color: var(--_active); }
    .vn { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .vr.main .vn { font-weight: 700; }
    .vn i { font-style: normal; font-size: 11px; color: var(--_inactive); }
    .vv { font-size: 12px; color: var(--_muted); text-align: right; font-variant-numeric: tabular-nums; }
    .vr.off { opacity: .5; }
    .vn .else { display: block; font-size: 11px; font-weight: 500; color: var(--_muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    /* large_buttons */
    :host([large]) .tb { width: 68px; height: 68px; } :host([large]) .tb .i { width: 34px; height: 34px; }
    :host([large]) .tb.pp { width: 96px; height: 96px; } :host([large]) .tb.pp .i { width: 44px; height: 44px; }
    :host([large]) .vr { min-height: 60px; } :host([large]) .vm { width: 48px; height: 48px; } :host([large]) .vm .i { width: 26px; height: 26px; }
    :host([large]) .vn { font-size: 17px; } :host([large]) .vs { --jb-slider-h: 10px; --jb-slider-knob: 30px; --jb-slider-hit: 52px; }
    :host([large]) .ab { width: 52px; height: 52px; } :host([large]) .upn { height: 56px; } :host([large]) .upn b { font-size: 16px; }
    .vr.muted .vs { opacity: .45; }
    @container vol (min-width: 600px) {
      .rooms { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); column-gap: 20px; padding-top: 8px; }
      .rooms .vr { grid-template-columns: 30px minmax(0, 1fr) 30px; grid-template-areas: "m n n" "s s v"; row-gap: 0; min-height: 0; padding-bottom: 4px; }
      .rooms .vm { grid-area: m; } .rooms .vn { grid-area: n; } .rooms .vs { grid-area: s; } .rooms .vv { grid-area: v; }
    }
    @container np (orientation: portrait) and (min-width: 521px) { .nw { align-content: center; } }
    /* landscape: art left, info right */
    @container np (orientation: landscape) and (min-width: 700px) {
      .nw { grid-template-columns: auto minmax(0, 1fr); align-items: center; justify-items: stretch; column-gap: clamp(24px, 3.5cqw, 48px); overflow: hidden; padding-top: 20px; padding-bottom: 20px; }
      .art { width: min(calc(100cqh - 40px), 46cqw); align-self: center; }
      .info { max-width: none; gap: 9px; }
      .ti { font-size: clamp(28px, 3.4cqw, 40px); }
      .vs { --jb-slider-h: 6px; --jb-slider-knob: 20px; --jb-slider-hit: 36px; }
      .tb.pp { width: 74px; height: 74px; }
    }
    @container np (orientation: landscape) and (max-height: 560px) {
      .upn { display: none; } .vr { min-height: 38px; } .tb.pp { width: 62px; height: 62px; } .tb { width: 48px; height: 48px; }
    }
    /* phone */
    @container np (max-width: 520px) {
      .nw { gap: 14px; padding: 12px 14px 14px; }
      .art { width: min(calc(100cqw - 140px), 30cqh); }
      .vs { --jb-slider-knob: 24px; }
      .info { gap: 8px; }
      .ti { font-size: 26px; -webkit-line-clamp: 1; display: block; white-space: nowrap; text-overflow: ellipsis; }
      .sub { font-size: 16px; }
      .prog { grid-template-columns: 40px minmax(0, 1fr) 40px; }
      .tb { width: 48px; height: 48px; } .tb.pp { width: 70px; height: 70px; }
      .upn { display: none; }
      .vol { padding: 4px 12px; }
      .vr { grid-template-columns: 28px 86px minmax(0, 1fr) 30px; min-height: 48px; }
      .vn { font-size: 14px; }
    }
  `];
}
if (!customElements.get('jb-now')) customElements.define('jb-now', JbNow);

const OVERLAY_KEY = 'jukebox-card:lyrics-overlay:v1';
function readOverlay() { try { return localStorage.getItem(OVERLAY_KEY) === '1'; } catch { return false; } }
function writeOverlay(on: boolean) { try { localStorage.setItem(OVERLAY_KEY, on ? '1' : '0'); } catch { /* private mode */ } }
