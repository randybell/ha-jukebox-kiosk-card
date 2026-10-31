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

/** music_assistant.play_media on the configured player (shared by Search and Browse). */
export async function playMedia(hass: HomeAssistant, config: JukeboxCardConfig, it: MaItem, mediaType: string, enqueue: Enqueue = 'play', radio = false) {
  const entity_id = config.entity || 'media_player.everywhere';
  const data: Record<string, any> = { media_id: it.uri, media_type: mediaType, enqueue };
  if (radio && mediaType !== 'radio') data.radio_mode = true;
  await hass.callService('music_assistant', 'play_media', data, { entity_id });
  return { data, entity_id };
}
export function playMessage(hass: HomeAssistant | undefined, config: JukeboxCardConfig, it: MaItem, enqueue: Enqueue, radio: boolean) {
  const name = hass?.states[config.entity || 'media_player.everywhere']?.attributes?.friendly_name ?? 'Everywhere';
  return radio ? `Starting radio from ${it.name}` : enqueue === 'next' ? `${it.name} plays next`
    : enqueue === 'add' ? `Added ${it.name} to the queue` : enqueue === 'replace' ? `Queue replaced with ${it.name}` : `Playing ${it.name} on ${name}`;
}

/* ---------------- long-press controller: tap = onTap, hold 500 ms = onLong ---------------- */
export class PressController<T> implements ReactiveController {
  held = '';
  private p?: { key: string; x: number; y: number; timer: number; fired: boolean; item: T; el: HTMLElement };
  constructor(private host: ReactiveControllerHost, private onTap: (it: T, el: HTMLElement) => void,
    private onLong: (it: T, el: HTMLElement) => void, private ms = 500) { host.addController(this); }
  hostDisconnected() { this.cancel(); }
  handlers(key: string, item: T) {
    return {
      down: (e: PointerEvent) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if ((e.target as HTMLElement).closest('.mo, .qa')) return;
        e.preventDefault();
        const el = e.currentTarget as HTMLElement;
        this.cancel();
        const timer = window.setTimeout(() => { if (!this.p) return; this.p.fired = true; this.onLong(item, el); }, this.ms);
        this.p = { key, x: e.clientX, y: e.clientY, timer, fired: false, item, el };
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
  cancel() {
    if (this.p) { window.clearTimeout(this.p.timer); if (!this.p.fired) { this.held = ''; this.host.requestUpdate(); } }
    this.p = undefined;
  }
  release() { this.held = ''; this.host.requestUpdate(); }
}

/* ---------------- shared item menu (popover in landscape/tablet, bottom sheet on phones) ---------------- */
export interface MenuAction { id: string; icon: string; label: string; run: () => void; sheetOnly?: boolean }
export interface MenuPos { sheet: boolean; top: number; right: number }
/** getBoundingClientRect in the element's own CSS px (undoes the card's large-screen `zoom`, see --jb-scale). */
export function localRect(el: Element) {
  const z = ((el as any).currentCSSZoom as number) || 1;
  const r = el.getBoundingClientRect();
  return { left: r.left / z, right: r.right / z, top: r.top / z, bottom: r.bottom / z, width: r.width / z, height: r.height / z };
}
export function menuPos(root: HTMLElement, anchor: HTMLElement, rows: number): MenuPos {
  const rr = localRect(root), ar = localRect(anchor);
  const sheet = rr.width <= 520;
  const menuH = rows * 46 + 46;
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
      <div class="mh">${pos.sheet ? html`${artTpl(head.item, 'th')}<span><b>${head.item.name}</b><small>${head.sub}</small></span>` : html`Long-press · ${head.item.name}`}</div>
      ${actions.filter((a) => pos.sheet || !a.sheetOnly).map(btn)}
    </div>`;
}

/** Media item standard actions (same as Search). */
export function mediaActions(play: (enq: Enqueue, radio?: boolean) => void, open?: () => void, radioStation = false): MenuAction[] {
  const acts: MenuAction[] = [
    { id: 'play', icon: 'play', label: 'Play now', run: () => play('play'), sheetOnly: true },
    ...(open ? [{ id: 'open', icon: 'open', label: 'Open', run: open }] : []),
    { id: 'next', icon: 'qnext', label: 'Play next', run: () => play('next') },
    { id: 'add', icon: 'qadd', label: 'Add to queue', run: () => play('add') },
    { id: 'replace', icon: 'swap', label: 'Replace queue', run: () => play('replace') },
    { id: 'radio', icon: 'radio', label: 'Start radio', run: () => play('play', true) },
  ];
  // a radio station is already a stream: "Start radio" (radio_mode) makes no sense there
  return radioStation ? acts.filter((a) => a.id !== 'radio') : acts;
}

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
    background: var(--_active); color: var(--_on-accent); font-size: 14px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-shadow: 0 10px 30px #000a; z-index: 8; }
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
  .panel { border-radius: var(--_radius); background: var(--_surface); border: 1px solid var(--_surface-border); -webkit-backdrop-filter: var(--jb-panel-filter, blur(14px)); backdrop-filter: var(--jb-panel-filter, blur(14px)); }
  .eyebrow { font-size: 12px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
  .empty { margin: auto; display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center; color: var(--_muted); font-size: 14px; padding: 24px; }
  .empty b { color: var(--_fg); font-family: var(--_font-display); font-size: 18px; }
`;
