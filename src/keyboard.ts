import { LitElement, html, css, nothing } from 'lit';
import { tokens, base } from './styles';
import { icon } from './icons';

export type KeyDetail =
  | { type: 'char'; value: string }
  | { type: 'backspace' }
  | { type: 'clear' }
  | { type: 'hide' };

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const DIGITS = '1234567890'.split('');
const SYMBOLS = ['&', '.', ',', '!', '?', '(', ')', '/', '+', '#', ':', '$', '%', '@', '"', ';', '=', '*'];
const HOLD_CLEAR_MS = 600;

interface KeyDef { id: string; label?: string; cls?: string; span?: number; aria?: string; icon?: string; act: () => KeyDetail | 'toggle' }

/**
 * On-screen alphabetical keyboard (TouchTunes / Android TV style).
 * Every key is a <button tabindex="-1">; pointerdown is preventDefault-ed so no key ever takes focus and
 * nothing editable exists, so the OS keyboard never opens.
 */
export class JbKeyboard extends LitElement {
  static properties = {
    collapsible: { type: Boolean },
    _sym: { state: true },
    _pressed: { state: true },
  };
  collapsible = true;
  private _sym = false;
  private _pressed = '';
  private _holdTimer?: number;
  private _holdFired = false;
  private _down?: { id: string; el: HTMLElement; pointerId: number };

  private emit(d: KeyDetail) {
    this.dispatchEvent(new CustomEvent<KeyDetail>('jb-key', { detail: d, bubbles: true, composed: true }));
  }

  private keys(): KeyDef[] {
    const ch = (c: string, cls = '', aria?: string): KeyDef => ({ id: `k-${c}`, label: c, cls, aria, act: () => ({ type: 'char', value: c }) });
    const out: KeyDef[] = DIGITS.map((d) => ch(d, 'num'));
    if (!this._sym) {
      out.push(...LETTERS.map((c) => ch(c)));
      out.push(ch("'", '', 'Apostrophe'), ch('-', '', 'Hyphen'), ch('&', 'wide-only'), ch('.', 'wide-only', 'Period'));
    } else {
      // narrow: digits shown inline (the num row is hidden), then symbols. wide: symbols only.
      out.push(...DIGITS.map((d) => ch(d, 'narrow-only')));
      out.push(...SYMBOLS.map((s, i) => ch(s, i >= SYMBOLS.length - 2 ? 'wide-only' : '')));
      out.push(ch("'", '', 'Apostrophe'), ch('-', '', 'Hyphen'));
    }
    out.push(
      { id: 'k-toggle-n', label: this._sym ? 'ABC' : '123', cls: 'sp narrow-only', aria: this._sym ? 'Letters' : 'Numbers and symbols', act: () => 'toggle' },
      { id: 'k-toggle-w', label: this._sym ? 'ABC' : '#+=', cls: 'sp wide-only', span: 2, aria: this._sym ? 'Letters' : 'Symbols', act: () => 'toggle' },
      { id: 'k-space', label: 'Space', cls: 'sp space', span: 3, aria: 'Space', act: () => ({ type: 'char', value: ' ' }) },
      { id: 'k-bksp', cls: 'sp bk', aria: 'Backspace (hold to clear)', icon: 'bksp', act: () => ({ type: 'backspace' }) },
      { id: 'k-clear', label: 'Clear', cls: 'sp clr', span: 2, aria: 'Clear search', act: () => ({ type: 'clear' }) },
    );
    return out;
  }

  private onDown(e: PointerEvent, k: KeyDef) {
    e.preventDefault(); // never take focus, never select text
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const el = e.currentTarget as HTMLElement;
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    this._down = { id: k.id, el, pointerId: e.pointerId };
    this._pressed = k.id;
    this._holdFired = false;
    if (k.id === 'k-bksp') {
      this._holdTimer = window.setTimeout(() => {
        this._holdFired = true;
        this.emit({ type: 'clear' });
      }, HOLD_CLEAR_MS);
    }
  }

  private onUp(e: PointerEvent, k: KeyDef) {
    e.preventDefault();
    window.clearTimeout(this._holdTimer);
    const d = this._down;
    this._down = undefined;
    this._pressed = '';
    if (!d || d.id !== k.id || this._holdFired) return;
    const r = d.el.getBoundingClientRect();
    const inside = e.clientX >= r.left - 4 && e.clientX <= r.right + 4 && e.clientY >= r.top - 4 && e.clientY <= r.bottom + 4;
    if (inside) this.fire(k);
  }

  private onCancel() {
    window.clearTimeout(this._holdTimer);
    this._down = undefined;
    this._pressed = '';
  }

  /** Assistive tech / synthetic clicks (detail 0) still work. */
  private onClick(e: MouseEvent, k: KeyDef) {
    if (e.detail === 0) this.fire(k);
  }

  private fire(k: KeyDef) {
    const a = k.act();
    if (a === 'toggle') { this._sym = !this._sym; return; }
    this.emit(a);
  }

  render() {
    return html`
      <section class="kb" aria-label="On-screen keyboard">
        ${this.collapsible
          ? html`<button class="kb-handle" tabindex="-1" aria-label="Hide keyboard"
              @pointerdown=${(e: PointerEvent) => e.preventDefault()}
              @click=${() => this.emit({ type: 'hide' })}><i></i><span>Hide keyboard</span>${icon('chev', 'i xs')}</button>`
          : nothing}
        <div class="keys" role="group">
          ${this.keys().map(
            (k) => html`<button
              class="k ${k.cls ?? ''} ${this._pressed === k.id ? 'pressed' : ''}"
              style=${k.span ? `grid-column:span ${k.span}` : ''}
              data-key=${k.id}
              tabindex="-1"
              aria-label=${k.aria ?? k.label ?? ''}
              @pointerdown=${(e: PointerEvent) => this.onDown(e, k)}
              @pointerup=${(e: PointerEvent) => this.onUp(e, k)}
              @pointercancel=${() => this.onCancel()}
              @lostpointercapture=${() => this.onCancel()}
              @click=${(e: MouseEvent) => this.onClick(e, k)}
              @contextmenu=${(e: Event) => e.preventDefault()}
            >${k.icon ? icon(k.icon) : k.label}</button>`,
          )}
        </div>
      </section>
    `;
  }

  static styles = [
    tokens,
    base,
    css`
      :host { display: block; min-width: 0; }
      .kb {
        container: kb / inline-size; min-width: 0; padding: 6px 10px 10px; border-radius: var(--_radius);
        background: #000000a6; border: 1px solid #ffffff24;
        -webkit-backdrop-filter: var(--jb-panel-filter, blur(18px)); backdrop-filter: var(--jb-panel-filter, blur(18px));
        user-select: none; -webkit-user-select: none; touch-action: manipulation;
      }
      .kb-handle {
        display: var(--jb-kb-handle-display, flex); align-items: center; justify-content: center; gap: 6px;
        width: 100%; height: var(--jb-kb-handle-h, 28px); font-size: 12px; font-weight: 600; color: var(--_inactive); position: relative;
      }
      .kb-handle i { position: absolute; top: 3px; left: 50%; width: 40px; height: 4px; margin-left: -20px; border-radius: 2px; background: #ffffff40; }
      .kb-handle span { display: var(--jb-kb-handle-label, inline); }
      .keys { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: var(--kgap, 8px); }
      .k {
        height: var(--kh, 60px); display: grid; place-items: center; border-radius: 12px;
        font-size: var(--kfs, 22px); font-weight: 700; color: #fff; background: #ffffff1a; border: 1px solid #ffffff1f;
        user-select: none; -webkit-user-select: none; transition: transform 60ms, background 60ms;
      }
      .k .i { width: 26px; height: 26px; }
      .k.sp { font-size: 15px; font-weight: 700; color: #ffffffd9; background: #ffffff0f; }
      .k.pressed { background: var(--_active); color: #000; border-color: #fff; transform: scale(0.96); }
      .k.num, .wide-only { display: none; }
      @container kb (min-width: 600px) {
        .keys { grid-template-columns: repeat(10, minmax(0, 1fr)); }
        .k { height: var(--kh-wide, 56px); }
        .k.num, .wide-only { display: grid; }
        .narrow-only { display: none !important; }
        .k.space { grid-column: span 4 !important; }
        .k.bk { grid-column: span 2 !important; }
      }
      @container kb (max-width: 380px) {
        .kb-handle span { display: none; }
      }
    `,
  ];
}
if (!customElements.get('jb-keyboard')) customElements.define('jb-keyboard', JbKeyboard);
