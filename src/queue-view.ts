import { LitElement, html, css, nothing, type PropertyValues } from 'lit';
import { tokens, base } from './styles';
import { icon } from './icons';
import { mediaStyles, noFocus, artTpl, provTpl, PressController, menuPos, menuTpl, type MenuAction, type MenuPos } from './shared';
import type { QueueItem, QueueModel, QueueSnapshot } from './queue-model';
import type { HomeAssistant, JukeboxCardConfig } from './types';

const asArt = (q: QueueItem) => ({ name: q.media_title || '?', image: q.media_image });

export class JbQueue extends LitElement {
  static properties = {
    hass: { attribute: false }, config: { attribute: false }, queue: { attribute: false }, active: { type: Boolean },
    _snap: { state: true }, _menu: { state: true }, _toast: { state: true },
  };
  hass?: HomeAssistant;
  config!: JukeboxCardConfig;
  queue?: QueueModel;
  active = false;
  private _snap?: QueueSnapshot;
  private _menu: { item: QueueItem; pos: MenuPos } | null = null;
  private _toast = '';
  private _toastTimer?: number;
  private _unsub?: () => void;
  private press = new PressController<QueueItem>(this, (it) => this.play(it), (it, el) => this.openMenu(it, el));

  protected shouldUpdate(ch: PropertyValues) { return !(ch.size === 1 && ch.has('hass')); }
  protected willUpdate(ch: PropertyValues) {
    if (ch.has('queue')) { this._unsub?.(); this._unsub = this.queue?.subscribe((s) => (this._snap = s)) as any; }
    if (ch.has('active') && this.active) this.queue?.refreshSoon(0);
  }
  disconnectedCallback() { super.disconnectedCallback(); this._unsub?.(); this._unsub = undefined; }

  private toast(t: string) { this._toast = t; window.clearTimeout(this._toastTimer); this._toastTimer = window.setTimeout(() => (this._toast = ''), 2200); }
  private async run(p: Promise<any> | undefined, ok: string) {
    this._menu = null; this.press.release();
    try { await p; if (ok) this.toast(ok); } catch { this.toast('Queue action failed'); }
  }
  private play(it: QueueItem) { this.run(this.queue?.play(it.queue_item_id), `Playing ${it.media_title}`); }
  private openMenu(it: QueueItem, el: HTMLElement) {
    const root = this.renderRoot.querySelector('.qx') as HTMLElement;
    this._menu = { item: it, pos: menuPos(root, el, 5) };
  }
  private actions(it: QueueItem): MenuAction[] {
    const q = this.queue!; const id = it.queue_item_id;
    return [
      { id: 'play', icon: 'play', label: 'Play now', run: () => this.play(it) },
      { id: 'next', icon: 'qnext', label: 'Play next', run: () => this.run(q.next(id), `${it.media_title} plays next`) },
      { id: 'up', icon: 'up', label: 'Move up', run: () => this.run(q.up(id), '') },
      { id: 'down', icon: 'down', label: 'Move down', run: () => this.run(q.down(id), '') },
      { id: 'remove', icon: 'trash', label: 'Remove', run: () => this.run(q.remove(id), `Removed ${it.media_title}`) },
    ];
  }

  private row(it: QueueItem, kind: 'now' | 'next' | 'past', n: number, isFirstNext: boolean, isLast: boolean) {
    const p = this.press.handlers(it.queue_item_id, it);
    const q = this.queue!;
    const qa = (ic: string, label: string, fn: () => Promise<any>, dis = false, act = '') => html`<button class="qa" tabindex="-1" data-action=${act} aria-label=${label} ?disabled=${dis}
      @pointerdown=${noFocus} @click=${(e: Event) => { e.stopPropagation(); this.run(fn(), ''); }}>${icon(ic)}</button>`;
    return html`<div class="qr ${kind} ${this.press.held === it.queue_item_id ? 'held' : ''}" data-id=${it.queue_item_id}
        @pointerdown=${p.down} @pointermove=${p.move} @pointerup=${p.up} @pointercancel=${p.cancel} @pointerleave=${p.cancel}
        @contextmenu=${(e: Event) => e.preventDefault()}>
      <span class="n">${kind === 'now' ? icon('eq', 'i eqi') : kind === 'past' ? '' : n}</span>
      ${artTpl(asArt(it), 'th')}
      <div class="rt"><b>${it.media_title}</b><small>${[it.media_artist, it.media_album_name].filter(Boolean).join(' · ')}</small></div>
      ${provTpl(it.media_content_id)}
      ${kind === 'next' ? html`<span class="acts">
        ${qa('up', 'Move up', () => q.up(it.queue_item_id), isFirstNext, 'up')}
        ${qa('down', 'Move down', () => q.down(it.queue_item_id), isLast, 'down')}
        <button class="qa mo" tabindex="-1" aria-label="More options" @pointerdown=${noFocus}
          @click=${(e: MouseEvent) => this.openMenu(it, (e.currentTarget as HTMLElement).closest('.qr') as HTMLElement)}>${icon('more')}</button>
      </span>` : html`<span class="acts"></span>`}
    </div>`;
  }

  render() {
    const s = this._snap;
    const items = s?.items ?? [];
    const cur = s?.current ?? -1;
    const now = cur >= 0 ? items[cur] : undefined;
    const next = cur >= 0 ? items.slice(cur + 1) : items;
    const past = cur > 0 ? items.slice(0, cur) : [];
    const remaining = this.queue?.remaining ?? next.length;
    return html`<div class="qx">
      <div class="head"><h2>Queue</h2><span class="cnt">${remaining ? `${remaining} up next` : ''}</span>
        ${s?.loading ? html`<span class="live busy"></span>` : nothing}</div>
      <div class="scroll panel" @scroll=${() => this.press.scrolled()}>
        ${s?.error ? html`<div class="empty"><b>Queue unavailable</b><span>${s.error}</span></div>`
          : !items.length ? html`<div class="empty"><b>${s?.loading || !s?.at ? 'Loading queue…' : 'The queue is empty'}</b><span>Add music from Search or Browse.</span></div>`
          : html`
            ${past.map((it) => this.row(it, 'past', 0, false, false))}
            ${now ? html`<h3 class="eyebrow">Now playing</h3>${this.row(now, 'now', 0, false, false)}` : nothing}
            ${next.length ? html`<h3 class="eyebrow">Up next</h3>${next.map((it, i) => this.row(it, 'next', i + 1, i === 0, i === next.length - 1))}` : html`<div class="end">End of queue</div>`}
            ${remaining > next.length ? html`<div class="end">+ ${remaining - next.length} more in Music Assistant</div>` : nothing}`}
      </div>
      ${this._menu ? menuTpl(this._menu.pos, { item: asArt(this._menu.item), sub: this._menu.item.media_artist ?? '' }, this.actions(this._menu.item),
        () => { this._menu = null; this.press.release(); }) : nothing}
      ${this._toast ? html`<div class="toast" role="status">${this._toast}</div>` : nothing}
    </div>`;
  }

  static styles = [tokens, base, mediaStyles, css`
    :host { display: block; height: 100%; min-height: 0; color: var(--_fg); font-family: var(--_font-body); }
    .qx { position: relative; height: 100%; display: flex; flex-direction: column; gap: 12px; padding: 16px var(--_pad) 14px; max-width: 1100px; margin: 0 auto; }
    .head { display: flex; align-items: baseline; gap: 12px; }
    h2 { font-family: var(--_font-display); font-size: 28px; font-weight: 800; }
    .cnt { font-size: 14px; color: var(--_muted); }
    .live { width: 7px; height: 7px; border-radius: 50%; background: #fff; align-self: center; animation: pulse 800ms ease-in-out infinite alternate; }
    @keyframes pulse { from { opacity: 1 } to { opacity: .35 } }
    .scroll { flex: 1; min-height: 0; overflow-y: auto; scrollbar-width: none; overscroll-behavior: contain; padding: 10px 12px 20px; display: flex; flex-direction: column; touch-action: pan-y; }
    .scroll::-webkit-scrollbar { display: none; }
    h3.eyebrow { font-size: 11px; color: var(--_inactive); margin: 12px 6px 6px; }
    h3.eyebrow:first-child { margin-top: 2px; }
    .qr { display: grid; grid-template-columns: 28px 48px minmax(0, 1fr) auto auto; align-items: center; gap: 12px; min-height: 64px; padding: 0 8px; border-radius: 12px; cursor: pointer; }
    .qr + .qr { border-top: 1px solid var(--_divider); }
    .qr .th { width: 48px; height: 48px; }
    .n { font-size: 13px; color: var(--_inactive); text-align: center; font-variant-numeric: tabular-nums; }
    .eqi { width: 20px; height: 20px; margin: auto; color: var(--_on-accent); }
    .rt { min-width: 0; display: flex; flex-direction: column; }
    .rt b { font-size: 16px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rt small { font-size: 13px; color: var(--_muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .qr.now { background: var(--_active); color: var(--_on-accent); border-top-color: transparent; }
    .qr.now + .qr, h3 + .qr { border-top-color: transparent; }
    .qr.now .rt small { color: #000000a8; }
    .qr.now .pv { color: #000; border-color: #0006; background: #0000000f; }
    .qr.past { opacity: .45; }
    .qr.held { background: #ffffff1f; box-shadow: inset 0 0 0 1.5px #fff; }
    .acts { display: flex; gap: 2px; }
    .qa { width: 44px; height: 44px; display: grid; place-items: center; border-radius: 50%; color: var(--_inactive); }
    .qa:active { background: #ffffff1f; color: #fff; }
    .qa:disabled { opacity: .25; }
    .qa .i { width: 22px; height: 22px; }
    .end { text-align: center; color: var(--_inactive); font-size: 13px; padding: 16px; }
    @container np (max-width: 520px) {
      .qx { padding: 12px 12px 10px; } h2 { font-size: 24px; }
      .scroll { padding: 8px 6px 16px; }
      .qr { grid-template-columns: 20px 42px minmax(0, 1fr) auto; gap: 9px; padding: 0 4px; }
      .qr .pv { display: none; } .qr .th { width: 42px; height: 42px; }
      .qa[data-action="up"], .qa[data-action="down"] { display: none; }
      .rt b { font-size: 15px; }
    }
  `];
}
if (!customElements.get('jb-queue')) customElements.define('jb-queue', JbQueue);
