import { LitElement, html, css } from 'lit';

/**
 * Touch slider without any <input>, so nothing can take focus or raise the OS keyboard.
 * Emits `jb-input` (every move, detail.value 0..1) and `jb-change` (release, final value).
 * The visual value follows the finger immediately (optimistic); consumers throttle service calls.
 */
export class JbSlider extends LitElement {
  static properties = { value: { type: Number }, disabled: { type: Boolean, reflect: true }, label: {}, _drag: { state: true }, _v: { state: true } };
  value = 0;
  disabled = false;
  label = '';
  private _drag = false;
  private _v = 0;
  private _rect?: DOMRect;
  private _pid?: number;

  get dragging() { return this._drag; }
  private shown() { return Math.max(0, Math.min(1, this._drag ? this._v : this.value || 0)); }

  private at(e: PointerEvent) {
    const r = this._rect ?? this.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
  }
  private emit(type: string) { this.dispatchEvent(new CustomEvent(type, { detail: { value: Math.round(this._v * 100) / 100 }, bubbles: true, composed: true })); }
  private down = (e: PointerEvent) => {
    if (this.disabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    this._rect = this.getBoundingClientRect();
    this._pid = e.pointerId;
    try { this.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    this._drag = true; this._v = this.at(e); this.emit('jb-input');
  };
  private move = (e: PointerEvent) => { if (!this._drag || e.pointerId !== this._pid) return; e.preventDefault(); this._v = this.at(e); this.emit('jb-input'); };
  private up = (e: PointerEvent) => {
    if (!this._drag || e.pointerId !== this._pid) return;
    this._v = this.at(e); this._drag = false; this._rect = undefined;
    this.value = this._v; this.emit('jb-change');
  };
  private cancel = () => { if (!this._drag) return; this._drag = false; this.value = this._v; this.emit('jb-change'); };

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener('pointerdown', this.down);
    this.addEventListener('pointermove', this.move);
    this.addEventListener('pointerup', this.up);
    this.addEventListener('pointercancel', this.cancel);
    this.addEventListener('lostpointercapture', this.cancel);
    this.setAttribute('role', 'slider');
  }
  updated() {
    this.setAttribute('aria-valuenow', String(Math.round(this.shown() * 100)));
    this.setAttribute('aria-label', this.label);
  }
  render() {
    const p = this.shown() * 100;
    return html`<div class="t"><div class="f" style="width:${p}%"></div></div><div class="k ${this._drag ? 'on' : ''}" style="left:${p}%"></div>`;
  }
  static styles = css`
    :host { position: relative; display: block; height: var(--jb-slider-hit, 36px); touch-action: none; cursor: pointer; -webkit-tap-highlight-color: transparent; }
    :host([disabled]) { opacity: .35; cursor: default; }
    .t { position: absolute; left: 0; right: 0; top: 50%; height: var(--jb-slider-h, 6px); transform: translateY(-50%); border-radius: 99px; background: var(--_track, #ffffff33); overflow: hidden; }
    .f { position: absolute; inset: 0 auto 0 0; background: var(--_active, #fff); border-radius: 99px; }
    .k { position: absolute; top: 50%; width: var(--jb-slider-knob, 18px); height: var(--jb-slider-knob, 18px); border-radius: 50%; background: var(--_active, #fff);
      transform: translate(-50%, -50%); box-shadow: 0 2px 8px #0008; transition: box-shadow .12s; }
    .k.on { box-shadow: var(--_thumb-ring, 0 0 0 4px #ffffff2e), 0 2px 8px #0008; }
  `;
}
if (!customElements.get('jb-slider')) customElements.define('jb-slider', JbSlider);

/** Leading + trailing throttle. `flush` sends the pending value now (used on release). */
export function throttle<A extends any[]>(fn: (...a: A) => void, ms: number) {
  let last = 0, timer: number | undefined, pending: A | undefined;
  const run = () => { last = Date.now(); timer = undefined; const a = pending!; pending = undefined; fn(...a); };
  const t = (...a: A) => {
    pending = a;
    const wait = ms - (Date.now() - last);
    if (wait <= 0) { window.clearTimeout(timer); run(); }
    else if (!timer) timer = window.setTimeout(run, wait);
  };
  t.flush = (...a: A) => { window.clearTimeout(timer); timer = undefined; pending = a; run(); };
  t.cancel = () => { window.clearTimeout(timer); timer = undefined; pending = undefined; };
  return t;
}
