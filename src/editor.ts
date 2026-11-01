import { LitElement, html, css } from 'lit';
import type { HomeAssistant, JukeboxCardConfig, RoomConfig } from './types';

/**
 * Visual editor built on HA's <ha-form>. YAML remains the reference (see README).
 * Rooms are edited as an entity multi-select; custom room names/icons set in YAML are preserved.
 * Sections are ha-form "expandable" groups with flatten: true, so the saved config stays flat (backward compatible).
 */
export const SAVER_PRESETS = [0, 1, 5, 10, 15, 30, 60];
export const SAVER_MAX = 1440;
const saverLabel = (m: number) => (m === 0 ? 'Off' : m === 60 ? '1 hour' : `${m} minute${m === 1 ? '' : 's'}`);

/** screensaver_minutes as an editor value: presets plus whatever (valid) custom value the config already has */
export function saverOptions(current?: number) {
  const opts = SAVER_PRESETS.map((m) => ({ value: String(m), label: saverLabel(m) }));
  if (typeof current === 'number' && Number.isFinite(current) && !SAVER_PRESETS.includes(current))
    opts.push({ value: String(current), label: `${current} minutes (custom)` });
  return opts;
}
/** select/custom text → whole minutes 0..1440; anything unusable falls back to the default 10 */
export function parseSaver(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim().replace(/\s*(min(utes?)?|m)$/i, ''));
  if (!Number.isFinite(n)) return 10;
  return Math.max(0, Math.min(SAVER_MAX, Math.round(n)));
}

export function editorSchema(c: Partial<JukeboxCardConfig> = {}) {
  return [
    { name: 'entity', selector: { entity: { domain: 'media_player' } } },
    { name: 'config_entry_id', required: true, selector: { text: {} } },
    { name: 'mass_queue_entry_id', selector: { text: {} } },
    { name: 'rooms', selector: { entity: { domain: 'media_player', multiple: true } } },
    { name: 'favorite_entity', selector: { entity: { domain: ['button', 'input_button', 'script'] } } },
    {
      type: 'expandable', name: 'display', title: 'Display', icon: 'mdi:monitor', flatten: true, expanded: true,
      schema: [
        { name: 'screensaver_minutes', selector: { select: { options: saverOptions(c.screensaver_minutes), mode: 'dropdown', custom_value: true } } },
        { name: 'screensaver_lyrics', selector: { boolean: {} } },
        { name: 'default_tab', selector: { select: { options: ['now', 'browse', 'search', 'queue', 'lyrics'], mode: 'dropdown' } } },
        { name: 'backdrop', selector: { select: { options: ['auto', 'full', 'light', 'static', 'off'], mode: 'dropdown' } } },
        { name: 'accent', selector: { select: { options: ['mono', 'fixed', 'art'], mode: 'dropdown' } } },
      ],
    },
    {
      type: 'expandable', name: 'lyrics', title: 'Lyrics', icon: 'mdi:text-box-outline', flatten: true,
      schema: [
        { name: 'show_lyrics', selector: { boolean: {} } },
        { name: 'lyrics_tab', selector: { boolean: {} } },
        { name: 'lyrics_seek', selector: { boolean: {} } },
        { name: 'lyrics_offset_ms', selector: { number: { min: -5000, max: 5000, step: 100, mode: 'box', unit_of_measurement: 'ms' } } },
      ],
    },
    {
      type: 'expandable', name: 'advanced', title: 'Search & Browse', icon: 'mdi:magnify', flatten: true,
      schema: [
        { name: 'limit', selector: { number: { min: 1, max: 25, mode: 'box' } } },
        { name: 'browse_limit', selector: { number: { min: 10, max: 500, mode: 'box' } } },
      ],
    },
  ];
}
export const LABELS: Record<string, string> = {
  entity: 'Player (default media_player.everywhere)',
  config_entry_id: 'Music Assistant config entry id',
  rooms: 'Room players (volume sliders)',
  favorite_entity: 'Favorite button',
  mass_queue_entry_id: 'mass_queue config entry id (Browse drill-down and lyrics; not the Music Assistant one)',
  screensaver_minutes: 'Screensaver after (pick or type minutes, 0-1440)',
  screensaver_lyrics: 'Lyrics on the screensaver',
  limit: 'Search results per type (1-letter queries use 5)',
  browse_limit: 'Browse page size',
  accent: 'Accent',
  backdrop: 'Backdrop (performance): auto, full blur, light, static, off',
  default_tab: 'Start tab',
  show_lyrics: 'Lyrics (art overlay, Stage, tab, screensaver)',
  lyrics_tab: 'Lyrics tab',
  lyrics_seek: 'Long-press a synced line to jump there',
  lyrics_offset_ms: 'Synced lyrics offset (+ shows lines sooner)',
};
/** defaults shown for unset options, never written back unless the user changes them */
const SHOWN_DEFAULTS = { show_lyrics: true, lyrics_tab: true, screensaver_lyrics: true, lyrics_seek: true };
const roomEntity = (r: RoomConfig | string) => (typeof r === 'string' ? r : r.entity);

export class JukeboxCardEditor extends LitElement {
  static properties = { hass: { attribute: false }, _config: { state: true } };
  hass?: HomeAssistant;
  private _config?: JukeboxCardConfig;
  setConfig(c: JukeboxCardConfig) {
    // show the 0.3.0 key under its new name; saving writes mass_queue_entry_id
    if (c && c.queue_config_entry_id && !c.mass_queue_entry_id) { const { queue_config_entry_id, ...rest } = c; c = { ...rest, mass_queue_entry_id: queue_config_entry_id } as JukeboxCardConfig; }
    this._config = c;
  }
  /** form data → config: rooms keep their YAML names/icons, minutes become a number, untouched shown defaults are not written */
  toConfig(value: Record<string, unknown>): JukeboxCardConfig {
    const v = { ...value } as any;
    const prev = new Map((this._config?.rooms ?? []).map((r) => [roomEntity(r), r] as const));
    if (Array.isArray(v.rooms)) v.rooms = (v.rooms as Array<RoomConfig | string>).map((r) => {
      const id = roomEntity(r); const old = prev.get(id);
      return typeof old === 'object' ? old : { entity: id };
    });
    if (v.screensaver_minutes === undefined || v.screensaver_minutes === '') delete v.screensaver_minutes;
    else v.screensaver_minutes = parseSaver(v.screensaver_minutes);
    if (Array.isArray(v.rooms) && !v.rooms.length && this._config?.rooms === undefined) delete v.rooms;
    if (v.screensaver_minutes === 10 && this._config?.screensaver_minutes === undefined) delete v.screensaver_minutes;
    for (const [k, d] of Object.entries(SHOWN_DEFAULTS)) if (v[k] === d && (this._config as any)?.[k] === undefined) delete v[k];
    if (v.lyrics_offset_ms !== undefined) {
      const n = Math.round(Number(v.lyrics_offset_ms));
      if (Number.isFinite(n)) v.lyrics_offset_ms = Math.max(-5000, Math.min(5000, n)); else delete v.lyrics_offset_ms;
    }
    return v as JukeboxCardConfig;
  }
  private changed(e: CustomEvent) {
    const config = this.toConfig(e.detail.value);
    this._config = config;
    this.dispatchEvent(new CustomEvent('config-changed', { detail: { config }, bubbles: true, composed: true }));
  }
  /** what ha-form displays */
  formData() {
    const c = this._config ?? ({} as JukeboxCardConfig);
    const m = c.screensaver_minutes;
    return { ...SHOWN_DEFAULTS, ...c, rooms: (c.rooms ?? []).map(roomEntity), screensaver_minutes: String(typeof m === 'number' ? m : 10) };
  }
  render() {
    if (!this._config) return html``;
    if (!customElements.get('ha-form'))
      return html`<p>Edit this card in YAML. See the README for every option.</p>`;
    return html`<ha-form .hass=${this.hass} .data=${this.formData()} .schema=${editorSchema(this._config)}
      .computeLabel=${(s: any) => LABELS[s.name] ?? s.title ?? s.name} @value-changed=${this.changed}></ha-form>`;
  }
  static styles = css`p { padding: 8px 0; }`;
}
if (!customElements.get('jukebox-card-editor')) customElements.define('jukebox-card-editor', JukeboxCardEditor);
