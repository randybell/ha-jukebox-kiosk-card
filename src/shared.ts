import { html, css, nothing, type ReactiveController, type ReactiveControllerHost } from 'lit';
import { icon } from './icons';
import { providerLabel } from './providers';
import type { Enqueue, HomeAssistant, JukeboxCardConfig, MaItem, RoomConfig } from './types';

/* ---------------- small helpers shared by every view ---------------- */
export const ART = [
  'linear-gradient(135deg,#ff2e7e,#ff9a3d)', 'linear-gradient(135deg,#3b2cff,#00d4c4)', 'linear-gradient(135deg,#ffd23f,#ff4f8b)',
  'linear-gradient(135deg,#00b37e,#1e3cff)', 'linear-gradient(135deg,#c42fd8,#ffd23f)', 'linear-gradient(135deg,#ff7a3d,#7a2cff)',
];
export const hash = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); };
export const noFocus = (e: PointerEvent) => e.preventDefault();

/** Image URLs the card will load: https, data:image and same-origin relative paths. Plain http (mixed content on an
 *  https dashboard, and usually a LAN address) and protocol-relative URLs are dropped. */
export function safeImage(u: unknown): string {
  if (typeof u !== 'string') return '';
  const s = u.trim();
  if (/^https:\/\//i.test(s) || /^data:image\//i.test(s)) return s;
  if (s.startsWith('/') && !s.startsWith('//')) return s;
  return '';
}
/** Fallback art for radio stations without a logo (Radio Browser often has image: null). */
export const RADIO_ART = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
  + '<stop offset="0" stop-color="#1d2b4f"/><stop offset="1" stop-color="#0b0f1c"/></linearGradient></defs><rect width="200" height="200" fill="url(#g)"/>'
  + '<g fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" opacity=".92">'
  + '<path d="M100 92 72 170M100 92l28 78M82 142h36"/><circle cx="100" cy="84" r="9" fill="#fff"/>'
  + '<path d="M76 60a34 34 0 0 0 0 48M124 60a34 34 0 0 1 0 48" opacity=".8"/><path d="M60 44a58 58 0 0 0 0 80M140 44a58 58 0 0 1 0 80" opacity=".55"/></g></svg>');
export const isRadio = (it: Partial<MaItem> | undefined) => !!it && (it.media_type === 'radio' || /^[a-z0-9_\-]+:\/\/radio\//i.test(it.uri ?? ''));

export function imageOf(it: MaItem): string {
  const img: any = it.image ?? it.image_url ?? it.media_image ?? it.metadata?.images?.[0];
  const src = !img ? '' : typeof img === 'string' ? safeImage(img) : safeImage(img.url ?? img.path);
  return src || (isRadio(it) ? RADIO_ART : '');
}
/** Clean an MA item: Radio Browser names come with leading/trailing tabs and spaces ("\tArrow Classic Rock"). */
export const cleanName = (s: unknown) => (typeof s === 'string' ? s.replace(/[\s\u00a0]+/g, ' ').trim() : '');
export function normItem<T extends MaItem>(it: T): T {
  if (!it || typeof it !== 'object') return it;
  const name = cleanName(it.name);
  return name === it.name ? it : { ...it, name };
}

/**
 * Art for the now-playing player (Now Playing, backdrop, screensaver).
 * 1. entity_picture_local (HA's relative /api/media_player_proxy/... path, works through Nabu Casa / https)
 * 2. entity_picture only when it is relative; an absolute URL (MA's http://<lan-ip>:8095/imageproxy...) is never used
 * 3. the current queue item's image when it is https
 * 4. '' (the caller shows its placeholder)
 */
export function playerArt(attrs: Record<string, any> | undefined, cur?: { media_image?: string; media_content_id?: string } | null): string {
  const a = attrs ?? {};
  const rel = (u: unknown) => (typeof u === 'string' && u.startsWith('/') && !u.startsWith('//') ? u : '');
  const local = rel(a.entity_picture_local) || rel(a.entity_picture);
  if (local) return local;
  if (cur && (!cur.media_content_id || !a.media_content_id || cur.media_content_id === a.media_content_id)) {
    const q = safeImage(cur.media_image);
    if (q && !q.startsWith('/')) return q;
  }
  return '';
}
export const artistNames = (it: MaItem) =>
  it.artists?.length ? it.artists.map((a: any) => (typeof a === 'string' ? a : a.name)).join(', ')
    : typeof it.artist === 'string' ? it.artist : it.artist?.name ?? '';
export const fmtDur = (s?: number) => {
  if (!s || !(s > 0)) return '';
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
};
export const fmtTime = (s: number) => fmtDur(s) || '0:00';

export function artTpl(it: { name: string } & Partial<MaItem>, cls: string) {
  const src = imageOf(it as MaItem);
  return html`<span class="ar ${cls}" style="background:${ART[hash(it.name || '?') % ART.length]}">${src
    ? html`<img src=${src} alt="" loading="lazy" draggable="false" @error=${(e: Event) => {
        // a dead station logo falls back to the radio tower; anything else to the coloured tile
        const img = e.target as HTMLImageElement;
        if (isRadio(it as MaItem) && img.src !== RADIO_ART) img.src = RADIO_ART; else img.style.display = 'none';
      }} />`
    : nothing}</span>`;
}
export function provTpl(uri?: string, provider?: string, mediaType?: string) {
  const p = mediaType === 'radio' ? 'Radio' : providerLabel(uri ?? '', provider);
  return p ? html`<span class="pv">${p}</span>` : nothing;
}

/** HA returns entity-service responses keyed by entity_id. Unwrap {response:{<entity>: X}} / {<entity>: X} / X. */
export function unwrap(r: any, entity?: string): any {
  const d = r?.response ?? r;
  if (d && entity && typeof d === 'object' && entity in d) return d[entity];
  return d;
}

export function roomsOf(c: JukeboxCardConfig, hass?: HomeAssistant): Array<Required<Pick<RoomConfig, 'entity' | 'name'>> & RoomConfig> {
  return (c.rooms ?? []).map((r) => {
    const o: RoomConfig = typeof r === 'string' ? { entity: r } : r;
    const fn = hass?.states[o.entity]?.attributes?.friendly_name as string | undefined;
    return { ...o, entity: o.entity, name: o.name || fn || o.entity.replace(/^media_player\./, '').replace(/_/g, ' ') };
  }).filter((r) => !!r.entity);
}

export function fire(el: HTMLElement, type: string, detail: any = {}) {
  el.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
}

/** Calls in flight, keyed by player|uri|enqueue|radio: a second tap while the first is still on its way is dropped
 *  (no double plays from a double tap or a bouncing touchscreen). */
const inflight = new Set<string>();
export const isInflight = (k: string) => inflight.has(k);
/** music_assistant.play_media on the configured player (shared by Search, Browse and the detail view).
 *  Returns null when the same call is already in flight. `mediaType` '' omits media_type (MA infers it from the URI). */
export async function playMedia(hass: HomeAssistant, config: JukeboxCardConfig, it: MaItem, mediaType: string, enqueue: Enqueue = 'play', radio = false) {
  const entity_id = config.entity || 'media_player.everywhere';
  const data: Record<string, any> = { media_id: it.uri, ...(mediaType ? { media_type: mediaType } : {}), enqueue };
  if (radio && mediaType !== 'radio' && !isRadio(it)) data.radio_mode = true;
  const key = `${entity_id}|${it.uri}|${enqueue}|${radio ? 1 : 0}`;
  if (inflight.has(key)) return null;
  inflight.add(key);
  try {
    // dynamic speakers only (fixed mode has no guard): starting an idle group can take speakers from other groups, ask first
    if (config._guard && (enqueue === 'play' || enqueue === 'replace') && !(await config._guard(entity_id))) return null;
    await hass.callService('music_assistant', 'play_media', data, { entity_id });
  }
  finally { inflight.delete(key); }
  return { data, entity_id };
}
/**
 * Shuffle a whole album / playlist / artist: media_player.shuffle_set {shuffle: true} on the MA player, awaited, then
 * play_media enqueue "replace" (the header buttons replace the queue, behind a confirmation). MA applies the queue's shuffle flag when it loads the new items, so the list starts in
 * random order (supported, documented services only; no client-side reordering of hundreds of URIs).
 */
export async function shufflePlay(hass: HomeAssistant, config: JukeboxCardConfig, it: MaItem, mediaType: string, enqueue: Enqueue = 'replace') {
  const entity_id = config.entity || 'media_player.everywhere';
  const key = `${entity_id}|${it.uri}|shuffle`;
  if (inflight.has(key)) return null;
  inflight.add(key);
  try {
    if (config._guard && !(await config._guard(entity_id))) return null;
    await hass.callService('media_player', 'shuffle_set', { shuffle: true }, { entity_id });
    const data = { media_id: it.uri, media_type: mediaType, enqueue };
    await hass.callService('music_assistant', 'play_media', data, { entity_id });
    return { data, entity_id };
  } finally { inflight.delete(key); }
}
/** "Play" from a detail view means in order: if the player is shuffling, turn shuffle off first (awaited). */
export async function playInOrder(hass: HomeAssistant, config: JukeboxCardConfig, it: MaItem, mediaType: string, enqueue: Enqueue = 'replace') {
  const entity_id = config.entity || 'media_player.everywhere';
  if (config._guard) { if (!(await config._guard(entity_id))) return null; config = { ...config, _guard: undefined }; }
  if (hass.states[entity_id]?.attributes?.shuffle === true && !isInflight(`${entity_id}|${it.uri}|${enqueue}|0`))
    await hass.callService('media_player', 'shuffle_set', { shuffle: false }, { entity_id });
  return playMedia(hass, config, it, mediaType, enqueue);
}
export function playMessage(hass: HomeAssistant | undefined, config: JukeboxCardConfig, it: MaItem, enqueue: Enqueue, radio: boolean, shuffle = false) {
  const name = hass?.states[config.entity || 'media_player.everywhere']?.attributes?.friendly_name ?? 'Everywhere';
  return shuffle ? `Shuffling ${it.name} on ${name}` : radio ? `Starting radio from ${it.name}` : enqueue === 'next' ? `${it.name} plays next`
    : enqueue === 'add' ? `Added ${it.name} to the queue` : enqueue === 'replace' ? `Queue replaced with ${it.name}` : `Playing ${it.name} on ${name}`;
}

/* ---------------- long-press controller: tap = onTap, hold 500 ms = onLong ---------------- */
export class PressController<T> implements ReactiveController {
  held = '';
  private p?: { key: string; x: number; y: number; timer: number; fired: boolean; item: T; el: HTMLElement; sc: [HTMLElement, number, number][] };
  constructor(private host: ReactiveControllerHost, private onTap: (it: T, el: HTMLElement) => void,
    private onLong: (it: T, el: HTMLElement) => void, private ms = 500) { host.addController(this); }
  hostDisconnected() { this.cancel(); }
  handlers(key: string, item: T) {
    return {
      down: (e: PointerEvent) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if ((e.target as HTMLElement).closest('.mo, .qa, .ra')) return;
        e.preventDefault();
        const el = e.currentTarget as HTMLElement;
        this.cancel();
        const timer = window.setTimeout(() => { if (!this.p) return; this.p.fired = true; this.onLong(item, el); }, this.ms);
        const sc: [HTMLElement, number, number][] = [];
        for (let a = el.parentElement; a; a = a.parentElement) if (a.matches('.scroll, .hs')) sc.push([a, a.scrollTop, a.scrollLeft]);
        this.p = { key, x: e.clientX, y: e.clientY, timer, fired: false, item, el, sc };
        this.held = key; this.host.requestUpdate();
      },
      move: (e: PointerEvent) => { const p = this.p; if (p && !p.fired && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) this.cancel(); },
      up: (e: PointerEvent) => {
        const p = this.p; if (!p) return;
        window.clearTimeout(p.timer); this.p = undefined;
        if (!p.fired) { this.held = ''; this.host.requestUpdate(); this.onTap(p.item, p.el); }
        e.preventDefault();
      },
      cancel: () => this.cancel(),
    };
  }
  /** Scroll handler: cancel the press only if a scroller under it really moved (a late, no-op scroll event is ignored). */
  scrolled() {
    if (this.p && this.p.sc.some(([a, t, l]) => Math.abs(a.scrollTop - t) > 2 || Math.abs(a.scrollLeft - l) > 2)) this.cancel();
  }
  cancel() {
    if (this.p) { window.clearTimeout(this.p.timer); if (!this.p.fired) { this.held = ''; this.host.requestUpdate(); } }
    this.p = undefined;
  }
  release() { this.held = ''; this.host.requestUpdate(); }
}

/* ---------------- shared item menu (popover in landscape/tablet, bottom sheet on phones) ---------------- */
export interface MenuAction { id: string; icon: string; label: string; run: () => void }
export interface MenuPos { sheet: boolean; top: number; right: number }
/** getBoundingClientRect in the element's own CSS px (undoes the card's large-screen `zoom`, see --jb-scale). */
export function localRect(el: Element) {
  const z = ((el as any).currentCSSZoom as number) || 1;
  const r = el.getBoundingClientRect();
  return { left: r.left / z, right: r.right / z, top: r.top / z, bottom: r.bottom / z, width: r.width / z, height: r.height / z };
}
/** `rows` = action buttons; the Cancel row that menuTpl always adds is counted here. */
export function menuPos(root: HTMLElement, anchor: HTMLElement | null, rows: number): MenuPos {
  const rr = localRect(root);
  const ar = anchor ? localRect(anchor) : { top: rr.top + rr.height / 3, bottom: rr.top + rr.height / 3, right: rr.right - rr.width / 3 };
  const sheet = rr.width <= 520 || !anchor;
  const menuH = (rows + 1) * 46 + 46;
  const below = ar.bottom - rr.top - 6;
  const up = below + menuH > rr.height - 8;
  const top = up ? Math.max(8, ar.top - rr.top - menuH + 6) : below;
  const right = Math.max(8, Math.min(rr.right - ar.right + 44, rr.width - 228));
  return { sheet, top, right };
}
export function menuTpl(pos: MenuPos, head: { item: { name: string } & Partial<MaItem>; sub: string }, actions: MenuAction[], close: () => void) {
  const btn = (a: MenuAction) =>
    html`<button class="mi" data-action=${a.id} tabindex="-1" role="menuitem" @pointerdown=${noFocus} @click=${a.run}>${icon(a.icon)}${a.label}</button>`;
  return html`<div class="scrim ${pos.sheet ? 'dim' : ''}" @pointerdown=${(e: PointerEvent) => { e.preventDefault(); close(); }}></div>
    <div class="menu ${pos.sheet ? 'sheet' : ''}" role="menu" aria-label="${head.item.name} options" style=${pos.sheet ? '' : `top:${pos.top}px;right:${pos.right}px`}>
      <div class="mh">${pos.sheet ? html`${artTpl(head.item, 'th')}<span><b>${head.item.name}</b><small>${head.sub}</small></span>` : head.item.name}</div>
      ${actions.map(btn)}
      <button class="mi cancel" data-action="cancel" tabindex="-1" role="menuitem" @pointerdown=${noFocus} @click=${close}>${icon('close')}Cancel</button>
    </div>`;
}

/** Long-press / ⋮ menu: every action. Play now is first; a tap never plays, so it has to be here. */
export function mediaActions(play: (enq: Enqueue) => void, open: (() => void) | undefined, ask: (kind: 'replace' | 'radio') => void, radio: boolean): MenuAction[] {
  return [
    ...(open ? [{ id: 'open', icon: 'open', label: 'Open', run: open }] : []),
    { id: 'play', icon: 'play', label: 'Play now', run: () => play('play') },
    { id: 'next', icon: 'qnext', label: 'Play next', run: () => play('next') },
    { id: 'add', icon: 'qadd', label: 'Add to queue', run: () => play('add') },
    // these two replace what everyone is hearing: the caller shows a confirmation first
    { id: 'replace', icon: 'replace', label: 'Replace queue…', run: () => ask('replace') },
    // Start radio only where MA can seed it (track / artist / album; never a station, podcast, audiobook or playlist)
    ...(radio ? [{ id: 'radio', icon: 'tower', label: 'Start radio…', run: () => ask('radio') }] : []),
  ];
}
/** Tap on a playable item (track, station, episode, audiobook): a small sheet, nothing plays until a choice is made. */
export function tapActions(play: (enq: Enqueue) => void, radioStation = false): MenuAction[] {
  return [
    { id: 'play', icon: 'play', label: 'Play now', run: () => play('play') },
    ...(radioStation ? [] : [
      { id: 'next', icon: 'qnext', label: 'Play next', run: () => play('next') },
      { id: 'add', icon: 'qadd', label: 'Add to queue', run: () => play('add') },
    ]),
  ];
}
/* ---------------- row actions: Add to queue / Play next / Replace queue / Start radio ---------------- */
export type RowAct = 'add' | 'next' | 'replace' | 'radio';
/**
 * Can MA radio mode be seeded from this item? Only track / artist / album: those are the documented seeds and the only
 * ones confirmed from the exports (play_media has a plain `radio_mode` boolean, nothing per type). Radio stations are
 * already streams, podcasts / audiobooks / episodes have no "similar tracks"; playlists are left out until confirmed.
 */
export const canRadio = (type: string, it: Partial<MaItem>) =>
  ['track', 'artist', 'album'].includes(type) && !isRadio(it) && !/^(podcast|audiobook)/.test(String(it.media_type ?? ''));
const RA: Record<RowAct, { icon: string; title: string; label: (n: string) => string }> = {
  add: { icon: 'qadd', title: 'Add to queue', label: (n) => `Add ${n} to the queue` },
  next: { icon: 'qnext', title: 'Play next', label: (n) => `Play ${n} next` },
  replace: { icon: 'replace', title: 'Replace queue', label: (n) => `Replace the queue with ${n}` },
  radio: { icon: 'tower', title: 'Start radio', label: (n) => `Start radio from ${n}` },
};
/**
 * The row's icon buttons (48 px targets, 44 px on phones). On a very narrow row (< 330 px, e.g. a 320 px phone) Replace
 * and Start radio fold into a ⋯ button so the targets keep their size and the title still gets room.
 */
export function rowActsTpl(it: MaItem, radio: boolean, run: (a: RowAct | 'more', el: HTMLElement) => void) {
  const acts: RowAct[] = radio ? ['add', 'next', 'replace', 'radio'] : ['add', 'next', 'replace'];
  const b = (a: RowAct) => html`<button class="ra-b ${a === 'replace' || a === 'radio' ? 'x2' : ''}" data-act=${a} tabindex="-1" title=${RA[a].title}
    aria-label=${RA[a].label(it.name)} @pointerdown=${noFocus} @click=${(e: MouseEvent) => { e.stopPropagation(); run(a, e.currentTarget as HTMLElement); }}>${icon(RA[a].icon)}</button>`;
  return html`<div class="ra" data-n=${acts.length}>${acts.map(b)}<button class="ra-b ra-more" data-act="more" tabindex="-1" title="More"
    aria-label="More actions for ${it.name}" @pointerdown=${noFocus} @click=${(e: MouseEvent) => { e.stopPropagation(); run('more', e.currentTarget as HTMLElement); }}>${icon('more')}</button></div>`;
}
/** ⋯ (narrow rows only): the folded actions. Each still goes through the confirmation. */
export function foldedActions(radio: boolean, ask: (a: RowAct) => void): MenuAction[] {
  return [
    { id: 'replace', icon: 'replace', label: 'Replace queue…', run: () => ask('replace') },
    ...(radio ? [{ id: 'radio', icon: 'tower', label: 'Start radio…', run: () => ask('radio') }] : []),
  ];
}

/* ---------------- confirmation before anything that clears the shared queue ---------------- */
export type ConfirmKind = 'replace' | 'radio' | 'play' | 'shuffle' | 'jump';
export interface ConfirmState { kind: ConfirmKind; item: MaItem; run: () => void }
const CONFIRM: Record<ConfirmKind, { q: (n: string) => string; body: string; ok: string; icon: string }> = {
  replace: { q: () => 'Replace the current queue?', body: 'This clears what\'s playing for everyone.', ok: 'Replace', icon: 'replace' },
  radio: { q: (n) => `Start radio from “${n}”?`, body: 'This replaces the current queue for everyone.', ok: 'Start radio', icon: 'tower' },
  play: { q: (n) => `Play “${n}” now?`, body: 'This replaces the current queue for everyone.', ok: 'Play', icon: 'play' },
  shuffle: { q: (n) => `Shuffle “${n}” now?`, body: 'This replaces the current queue for everyone.', ok: 'Shuffle', icon: 'shuffle' },
  // queue-row Play now (0.5.0): jumps the shared queue, so it asks like Replace does
  jump: { q: () => 'Play this now?', body: 'The current song will stop.', ok: 'Play now', icon: 'play' },
};
export function confirmTpl(c: ConfirmState | null, close: () => void) {
  if (!c) return nothing;
  const t = CONFIRM[c.kind];
  return html`<div class="scrim dim" @pointerdown=${(e: PointerEvent) => { e.preventDefault(); close(); }}></div>
    <div class="confirm" role="alertdialog" aria-modal="true" aria-labelledby="cf-q" aria-describedby="cf-b" data-kind=${c.kind}>
      <div class="cf-h">${artTpl(c.item, 'th')}<span><b id="cf-q">${t.q(c.item.name)}</b><small>${c.kind === 'replace' || c.kind === 'jump' ? c.item.name : ''}</small></span></div>
      <p id="cf-b">${t.body}</p>
      <div class="cf-a">
        <button class="cbtn" data-action="cancel" tabindex="-1" @pointerdown=${noFocus} @click=${close}>Cancel</button>
        <button class="cbtn ok" data-action="confirm" tabindex="-1" @pointerdown=${noFocus} @click=${() => { close(); c.run(); }}>${icon(t.icon)}${t.ok}</button>
      </div>
    </div>`;
}

/** Types that open a detail view on tap (podcasts only with mass_queue, which lists episodes). */
export const drillable = (type: string, config: JukeboxCardConfig) =>
  type === 'artist' || type === 'album' || type === 'playlist' || (type === 'podcast' && !!(config.mass_queue_entry_id || config.queue_config_entry_id));

/* ---------------- shared CSS for art, tiles, rows, badges, menus, toasts ---------------- */
export const mediaStyles = css`
  .ar { position: relative; display: block; flex: none; overflow: hidden; box-shadow: 0 0 0 1px #ffffff1a; }
  .ar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .circ { width: 64px; height: 64px; border-radius: 50%; }
  .sq { width: 100px; height: 100px; border-radius: 10px; }
  .th { width: 44px; height: 44px; border-radius: 8px; }
  .pv { display: inline-block; width: max-content; max-width: 100%; overflow: hidden; text-overflow: ellipsis; font-size: 10px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
    padding: 2px 7px; border-radius: 999px; color: var(--_prov-fg); border: 1px solid var(--_prov-border); background: var(--_prov-bg); white-space: nowrap; }
  .toast { position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%); max-width: calc(100% - 24px); padding: 10px 16px; border-radius: 999px;
    background: var(--_active); color: var(--_on-accent); font-size: 14px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-shadow: 0 10px 30px #000a; z-index: 8; pointer-events: none; }
  .scrim { position: absolute; inset: -200px; z-index: 6; }
  .scrim.dim { background: #000000a0; }
  .menu { position: absolute; z-index: 7; width: 220px; padding: 6px; border-radius: 14px; background: #0a0a0af5; border: 1px solid #ffffff33; box-shadow: 0 20px 50px #000c; }
  .mh { font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--_inactive); padding: 6px 10px 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mi { display: flex; align-items: center; gap: 12px; width: 100%; height: 46px; padding: 0 10px; border-radius: 9px; font-size: 15px; font-weight: 600; color: #fff; text-align: left; }
  .mi:active { background: #ffffff1f; }
  .mi .i { width: 22px; height: 22px; }
  .mi.cancel { color: var(--_inactive); border-top: 1px solid var(--_divider); border-radius: 0 0 9px 9px; margin-top: 4px; }
  .menu.sheet { left: 0; right: 0; bottom: 0; width: auto; border-radius: 20px 20px 0 0; padding: 10px 12px calc(14px + env(safe-area-inset-bottom)); max-height: 100%; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: none; }
  .menu.sheet .mh { display: flex; align-items: center; gap: 12px; text-transform: none; letter-spacing: 0; padding: 6px 6px 12px; border-bottom: 1px solid var(--_divider); margin-bottom: 6px; }
  .menu.sheet .mh span { display: flex; flex-direction: column; min-width: 0; }
  .menu.sheet .mh b { color: #fff; font-size: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .menu.sheet .mh small { font-size: 13px; font-weight: 500; color: var(--_muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .menu.sheet .mi { height: 52px; font-size: 16px; }
  /* list rows: art | title + subtitle | duration | icon buttons */
  .list { position: relative; display: flex; flex-direction: column; container: rows / inline-size; }
  .row { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto auto; align-items: center; column-gap: 12px; min-height: 60px; padding: 4px 0 4px 4px;
    border-radius: 10px; user-select: none; -webkit-user-select: none; -webkit-tap-highlight-color: transparent; }
  .row.drill { cursor: pointer; }
  .row + .row { border-top: 1px solid var(--_divider); }
  .row.held, .row.sel { background: #ffffff1f; box-shadow: inset 0 0 0 1.5px #fff; }
  .row .n { text-align: center; color: var(--_inactive); font-size: 14px; font-variant-numeric: tabular-nums; }
  .ar.th.circ { border-radius: 50%; }
  .rt { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .rt b { font-size: 15px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rt .ver { font-style: normal; font-weight: 500; color: var(--_muted); }
  .rt small { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 13px; color: var(--_muted); white-space: nowrap; overflow: hidden; }
  .rt small .st { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .rt small .pv { flex: 0 1 auto; min-width: 0; }
  .du { font-size: 13px; color: var(--_muted); text-align: right; font-variant-numeric: tabular-nums; }
  .du:empty { display: none; }
  .rt small .du2 { display: none; flex: none; font-variant-numeric: tabular-nums; }
  .ra { display: flex; flex: none; }
  .ra-b { width: 48px; height: 48px; display: grid; place-items: center; border-radius: 50%; color: #fff; }
  .ra-b:active { background: #ffffff26; }
  .ra-b .i { width: 24px; height: 24px; }
  .ra-more { display: none; }
  @container np (max-width: 520px) {
    .row { grid-template-columns: 40px minmax(0, 1fr) auto; column-gap: 8px; }
    .row .du { display: none; }
    .rt small .du2 { display: inline; }
    .ar.th { width: 40px; height: 40px; }
    .ra-b { width: 44px; height: 44px; }
    .ra-b .i { width: 22px; height: 22px; }
  }
  @container rows (max-width: 330px) {
    .ra-b.x2 { display: none; }
    .ra-more { display: grid; }
  }
  .confirm { position: absolute; z-index: 9; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(420px, calc(100% - 24px)); padding: 18px;
    border-radius: 18px; background: #0a0a0af7; border: 1px solid #ffffffd9; box-shadow: 0 24px 60px #000d; display: flex; flex-direction: column; gap: 12px; }
  .cf-h { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .cf-h span { display: flex; flex-direction: column; min-width: 0; }
  .cf-h b { font-size: 18px; font-weight: 800; color: #fff; }
  .cf-h small { font-size: 13px; color: var(--_muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .confirm p { font-size: 15px; color: var(--_muted); }
  .cf-a { display: flex; gap: 10px; justify-content: flex-end; }
  .cbtn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-width: 112px; height: 48px; padding: 0 18px; border-radius: 999px;
    font-size: 15px; font-weight: 700; color: #fff; border: 1px solid #ffffff59; }
  .cbtn.ok { background: #fff; color: #000; border-color: #fff; }
  .cbtn .i { width: 22px; height: 22px; }
  .panel { border-radius: var(--_radius); background: var(--_surface); border: 1px solid var(--_surface-border); -webkit-backdrop-filter: var(--jb-panel-filter, blur(14px)); backdrop-filter: var(--jb-panel-filter, blur(14px)); }
  .eyebrow { font-size: 12px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
  .empty { margin: auto; display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center; color: var(--_muted); font-size: 14px; padding: 24px; }
  .empty b { color: var(--_fg); font-family: var(--_font-display); font-size: 18px; }
  /* large_buttons: the card sets the large attribute on every view */
  :host([large]) .row { min-height: 72px; }
  :host([large]) .rt b { font-size: 17px; } :host([large]) .rt small { font-size: 14px; }
  :host([large]) .ra-b { width: 52px; height: 52px; } :host([large]) .ra-b .i { width: 28px; height: 28px; }
  :host([large]) .cbtn { height: 60px; font-size: 17px; min-width: 128px; }
  :host([large]) .mi, :host([large]) .menu.sheet .mi { height: 60px; font-size: 17px; }
  :host([large]) .toast { font-size: 16px; padding: 14px 20px; }
`;
