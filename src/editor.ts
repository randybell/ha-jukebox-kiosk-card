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
        { name: 'large_buttons', selector: { boolean: {} } },
      ],
    },
    {
      type: 'expandable', name: 'speakers', title: 'Speakers', icon: 'mdi:speaker-multiple', flatten: true,
      schema: [
        { name: 'speaker_mode', selector: { select: { options: [{ value: 'fixed', label: 'Fixed: always the player above (0.4 behaviour)' }, { value: 'dynamic', label: 'Dynamic: move between groups, join and drop speakers' }], mode: 'dropdown' } } },
        { name: 'targets', selector: { entity: { domain: 'media_player', multiple: true } } },
        { name: 'grouping', selector: { select: { options: [{ value: 'admins', label: 'Admins' }, { value: 'everyone', label: 'Everyone' }, { value: 'nobody', label: 'Nobody' }], mode: 'dropdown' } } },
        { name: 'grouping_users', selector: { text: {} } },
        { name: 'guest_access', selector: { select: { options: [{ value: 'volume', label: 'Volume and mute' }, { value: 'none', label: 'Read only' }], mode: 'dropdown' } } },
        { name: 'leader_drop', selector: { select: { options: [{ value: 'block', label: 'Block (hand off with Move)' }, { value: 'allow', label: 'Allow (the group restarts after a gap)' }], mode: 'dropdown' } } },
        { name: 'presets', selector: { object: {} } },
        { name: 'quiet_start', selector: { time: {} } },
        { name: 'quiet_end', selector: { time: {} } },
        { name: 'quiet_max', selector: { number: { min: 0, max: 100, step: 5, mode: 'slider', unit_of_measurement: '%' } } },
        { name: 'quiet_applies', selector: { select: { options: [{ value: 'guests', label: 'Guests' }, { value: 'everyone', label: 'Everyone' }], mode: 'dropdown' } } },
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
  large_buttons: 'Large buttons (bigger touch targets and text)',
  speaker_mode: 'Speaker mode',
  targets: 'Groups to play on (dynamic; empty = every Music Assistant group)',
  grouping: 'Who may change speakers (a UI lock, not security)',
  grouping_users: 'Also allow these users (names or ids, comma separated)',
  guest_access: 'Everyone else',
  leader_drop: 'Dropping the speaker that leads a group',
  presets: 'Room presets (YAML list: name, members, volumes, target)',
  quiet_start: 'Quiet hours from',
  quiet_end: 'Quiet hours until (same as from = all day)',
  quiet_max: 'Quiet hours: max volume',
  quiet_applies: 'Quiet hours apply to',
};
const QUIET_KEYS = ['quiet_start', 'quiet_end', 'quiet_max', 'quiet_applies'] as const;
const hhmm = (t: unknown) => (typeof t === 'string' ? t.slice(0, 5) : undefined);
/** defaults shown for unset options, never written back unless the user changes them */
const SHOWN_DEFAULTS = {
  show_lyrics: true, lyrics_tab: true, screensaver_lyrics: true, lyrics_seek: true,
  large_buttons: false, speaker_mode: 'fixed', grouping: 'admins', guest_access: 'volume', leader_drop: 'block',
};
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
    // targets keep their YAML names/members, like rooms
    const prevT = new Map((this._config?.targets ?? []).map((t) => [typeof t === 'string' ? t : t.entity, t] as const));
    if (Array.isArray(v.targets)) v.targets = (v.targets as any[]).map((t) => { const id = typeof t === 'string' ? t : t.entity; const old = prevT.get(id); return typeof old === 'object' ? old : id; });
    if (Array.isArray(v.targets) && !v.targets.length && this._config?.targets === undefined) delete v.targets;
    if (typeof v.grouping_users === 'string') {
      const list = v.grouping_users.split(',').map((x: string) => x.trim()).filter(Boolean);
      if (list.length) v.grouping_users = list; else delete v.grouping_users;
    }
    // quiet hours: four flat fields ↔ quiet_hours {start, end, max_volume, applies}
    if (QUIET_KEYS.some((k) => k in v)) {
      const q = { ...(this._config?.quiet_hours ?? {}) } as any;
      if (v.quiet_start !== undefined) q.start = hhmm(v.quiet_start);
      if (v.quiet_end !== undefined) q.end = hhmm(v.quiet_end);
      if (v.quiet_max !== undefined && v.quiet_max !== '') q.max_volume = Math.max(0, Math.min(100, Math.round(Number(v.quiet_max))));
      if (v.quiet_applies) q.applies = v.quiet_applies;
      if (q.applies === 'guests') delete q.applies;
      for (const k of QUIET_KEYS) delete v[k];
      if (q.start && q.end && typeof q.max_volume === 'number' && Number.isFinite(q.max_volume)) v.quiet_hours = q;
      else if (q.start || q.end || q.max_volume !== undefined) v.quiet_hours = { start: q.start ?? '22:00', end: q.end ?? '07:00', max_volume: Number.isFinite(q.max_volume) ? q.max_volume : 30, ...(q.applies ? { applies: q.applies } : {}) };
    }
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
    const q = c.quiet_hours;
    const out: Record<string, unknown> = { ...SHOWN_DEFAULTS, ...c, rooms: (c.rooms ?? []).map(roomEntity), screensaver_minutes: String(typeof m === 'number' ? m : 10) };
    if (c.targets) out.targets = c.targets.map((t) => (typeof t === 'string' ? t : t.entity));
    if (c.grouping_users) out.grouping_users = c.grouping_users.join(', ');
    if (q) { out.quiet_start = q.start; out.quiet_end = q.end; out.quiet_max = q.max_volume; out.quiet_applies = q.applies ?? 'guests'; }
    delete out.quiet_hours;
    return out;
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
