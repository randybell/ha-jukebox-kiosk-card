import { LitElement, html, css } from 'lit';
import type { HomeAssistant, JukeboxCardConfig, RoomConfig } from './types';

/**
 * Minimal visual editor built on HA's <ha-form>. YAML remains the reference (see README).
 * Rooms are edited as an entity multi-select; custom room names/icons set in YAML are preserved.
 */
const SCHEMA = [
  { name: 'entity', selector: { entity: { domain: 'media_player' } } },
  { name: 'config_entry_id', required: true, selector: { text: {} } },
  { name: 'rooms', selector: { entity: { domain: 'media_player', multiple: true } } },
  { name: 'favorite_entity', selector: { entity: { domain: ['button', 'input_button', 'script'] } } },
  { name: 'queue_config_entry_id', selector: { text: {} } },
  { name: 'screensaver_minutes', selector: { number: { min: 0, max: 240, mode: 'box', unit_of_measurement: 'min' } } },
  { name: 'limit', selector: { number: { min: 1, max: 25, mode: 'box' } } },
  { name: 'browse_limit', selector: { number: { min: 10, max: 500, mode: 'box' } } },
  { name: 'backdrop', selector: { select: { options: ['auto', 'full', 'light', 'static', 'off'], mode: 'dropdown' } } },
  { name: 'accent', selector: { select: { options: ['mono', 'fixed', 'art'], mode: 'dropdown' } } },
  { name: 'default_tab', selector: { select: { options: ['now', 'browse', 'search', 'queue'], mode: 'dropdown' } } },
];
const LABELS: Record<string, string> = {
  entity: 'Player (default media_player.everywhere)',
  config_entry_id: 'Music Assistant config entry id',
  rooms: 'Room players (volume sliders)',
  favorite_entity: 'Favorite button',
  queue_config_entry_id: 'mass_queue config entry id (Browse drill-down)',
  screensaver_minutes: 'Screensaver after (0 = off)',
  limit: 'Search results per type (1-letter queries use 5)',
  browse_limit: 'Browse page size',
  accent: 'Accent',
  backdrop: 'Backdrop (performance): auto, full blur, light, static, off',
  default_tab: 'Start tab',
};
const roomEntity = (r: RoomConfig | string) => (typeof r === 'string' ? r : r.entity);

export class JukeboxCardEditor extends LitElement {
  static properties = { hass: { attribute: false }, _config: { state: true } };
  hass?: HomeAssistant;
  private _config?: JukeboxCardConfig;
  setConfig(c: JukeboxCardConfig) { this._config = c; }
  private changed(e: CustomEvent) {
    const v = { ...e.detail.value } as JukeboxCardConfig;
    const prev = new Map((this._config?.rooms ?? []).map((r) => [roomEntity(r), r] as const));
    if (Array.isArray(v.rooms)) v.rooms = (v.rooms as Array<RoomConfig | string>).map((r) => {
      const id = roomEntity(r); const old = prev.get(id);
      return typeof old === 'object' ? old : { entity: id };
    });
    this.dispatchEvent(new CustomEvent('config-changed', { detail: { config: v }, bubbles: true, composed: true }));
  }
  render() {
    if (!this._config) return html``;
    if (!customElements.get('ha-form'))
      return html`<p>Edit this card in YAML. See the README for every option.</p>`;
    const data = { ...this._config, rooms: (this._config.rooms ?? []).map(roomEntity) };
    return html`<ha-form .hass=${this.hass} .data=${data} .schema=${SCHEMA}
      .computeLabel=${(s: any) => LABELS[s.name] ?? s.name} @value-changed=${this.changed}></ha-form>`;
  }
  static styles = css`p { padding: 8px 0; }`;
}
if (!customElements.get('jukebox-card-editor')) customElements.define('jukebox-card-editor', JukeboxCardEditor);
