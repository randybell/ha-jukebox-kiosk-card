/** Minimal slice of the Home Assistant frontend `hass` object used by the card. */
export interface HassEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, any>;
}
export interface ServiceCallResponse<T = any> {
  context?: { id: string };
  response?: T;
}
export interface HomeAssistant {
  states: Record<string, HassEntity>;
  user?: { id?: string; name?: string; is_admin?: boolean };
  locale?: { language?: string };
  language?: string;
  callService(
    domain: string,
    service: string,
    serviceData?: Record<string, any>,
    target?: Record<string, any>,
    notifyOnError?: boolean,
    returnResponse?: boolean,
  ): Promise<ServiceCallResponse | any>;
}

export interface RoomConfig {
  name?: string; entity: string; icon?: string;
  /** Music Assistant player id of this room's speaker (players/all `player_id`). Optional: matched by name when unset. */
  ma_player?: string;
}
/** A player the card can play on in `speaker_mode: dynamic` (an MA group or a single MA player). */
export interface TargetConfig {
  entity: string; name?: string;
  /** Room entities this group starts with (MA's own preset for a dynamic group is not readable). Used for takeover warnings. */
  members?: string[];
}
/** A named room preset: these rooms play together, optionally at these volumes (percent). */
export interface PresetConfig {
  name: string;
  /** Room entities (from `rooms`). */
  members: string[];
  /** Per-room volume in percent, keyed by room entity. */
  volumes?: Record<string, number>;
  /** Group to play on. Default: the current target. */
  target?: string;
}
export interface QuietHours {
  /** 'HH:MM' local time. start === end means all day. */
  start: string; end: string;
  /** Highest volume in percent while quiet hours are on. */
  max_volume: number;
  /** Who is capped. Default guests (everyone who may not group speakers). */
  applies?: 'guests' | 'everyone';
}
export type TabId = 'now' | 'browse' | 'search' | 'queue' | 'lyrics';
export type Enqueue = 'play' | 'next' | 'add' | 'replace' | 'replace_next';

export interface JukeboxCardConfig {
  type: string;
  /** Player that receives play_media. Default media_player.everywhere */
  entity?: string;
  /** Music Assistant config entry id. Required (non-admin users cannot list config entries). */
  config_entry_id: string;
  /** Room players for the per-room volume sliders. `{name, entity}`; a bare entity id string is also accepted. */
  rooms?: Array<RoomConfig | string>;
  /** Button that adds the current song to favorites. Default button.everywhere_favorite_current_song. Set to '' to hide. */
  favorite_entity?: string;
  /** mass_queue config entry id (a different entry from the Music Assistant one). Needed for Browse drill-down
   *  (album/artist/playlist tracks via mass_queue.get_*_tracks). Optional. */
  mass_queue_entry_id?: string;
  /** @deprecated 0.3.0 name of mass_queue_entry_id, still accepted. */
  queue_config_entry_id?: string;
  /** Minutes of no touches before the screensaver. Default 10. 0 disables. Any whole number 0-1440. */
  screensaver_minutes?: number;
  /** Lyrics (needs mass_queue_entry_id). Master switch for every lyrics surface and lookup. Default true. */
  show_lyrics?: boolean;
  /** The Lyrics tab. Default true (when show_lyrics is on). */
  lyrics_tab?: boolean;
  /** Lyrics lines on the screensaver. Default true (when show_lyrics is on). */
  screensaver_lyrics?: boolean;
  /** Long-press a synced line to seek there. Default true. */
  lyrics_seek?: boolean;
  /** Shift synced lyrics: positive shows lines sooner. Default 500 (HA reports whole seconds). -5000..5000. */
  lyrics_offset_ms?: number;
  /** Items fetched per Browse page. Default 60. */
  browse_limit?: number;
  /** Upcoming queue items fetched. Default 200. */
  queue_limit?: number;
  accent?: 'mono' | 'fixed' | 'art';
  /** Backdrop/blur performance mode. Default auto (light on low-end or reduced-motion devices, else full). */
  backdrop?: 'auto' | 'full' | 'light' | 'static' | 'off';
  /** Results per media type from 2 characters. 1-character queries always use 5. */
  limit?: number;
  default_tab?: TabId;
  /** Base URL for the bundled fonts, or false to use system fonts. */
  font_base?: string | false;
  /** Card height. Default 100dvh (panel view). */
  height?: string;
  /** UI scale. 'auto' (default) zooms the whole card up on big screens (1920x1080 → 1.35) so it isn't sparse; a number forces it; 1 disables. */
  scale?: 'auto' | number;
  /** Adaptive in-flight limiting threshold in ms. Default 800. */
  slow_ms?: number;
  /** Search library only. Default false (all providers). */
  library_only?: boolean;
  /** Clock and title */
  title?: string;
  /** fixed (default): always play on `entity`, the Speakers panel is a volume mixer. dynamic: pick the target, group and move. */
  speaker_mode?: 'fixed' | 'dynamic';
  /** dynamic mode targets. Default: every media_player with a Music Assistant player type. */
  targets?: Array<TargetConfig | string>;
  /** Who may group, move and pick the target. Default admins. A UI lock, not security. */
  grouping?: 'admins' | 'everyone' | 'nobody';
  /** Extra users (name or user id) who may group. */
  grouping_users?: string[];
  /** What everyone else may do in the Speakers panel: volume (default) or none (read only). */
  guest_access?: 'volume' | 'none';
  /** Dropping the leader of a playing group: block (default) or allow (MA hands off; WiiM restarts the group after a gap). */
  leader_drop?: 'block' | 'allow';
  presets?: PresetConfig[];
  quiet_hours?: QuietHours;
  /** Bigger touch targets and text. Default false. */
  large_buttons?: boolean;
  /** @internal set by the card in dynamic mode only: resolves false when the user cancels a start that would take speakers */
  _guard?: (entity: string) => Promise<boolean>;
}

/** One MA media item as returned by music_assistant.search (defensive: most fields optional). */
export interface MaItem {
  media_type?: string;
  uri: string;
  name: string;
  version?: string;
  image?: string | { path?: string; url?: string } | null;
  image_url?: string;
  metadata?: { images?: Array<{ path?: string; url?: string }> };
  favorite?: boolean;
  explicit?: boolean;
  artists?: Array<{ name: string; uri?: string }>;
  artist?: string | { name: string };
  album?: { name: string; uri?: string } | null;
  owner?: string;
  duration?: number;
  provider?: string;
  [k: string]: any;
}

export type GroupKey = 'artists' | 'albums' | 'tracks' | 'playlists' | 'radio' | 'podcasts' | 'audiobooks';
export type SearchResults = Partial<Record<GroupKey, MaItem[]>>;
