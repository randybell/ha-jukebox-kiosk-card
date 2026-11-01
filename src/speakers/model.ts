/**
 * Speakers (0.5.0): pure helpers, no DOM, no hass calls. Unit-tested in test/unit/speakers.unit.mjs.
 *
 * Music Assistant facts this relies on (MA 2.10, players/all):
 *  - group players (provider sync_group, type 'group'): static groups have static_group_members and no 'set_members'
 *    feature; dynamic groups support 'set_members' and have static_group_members = [] (their configured members are
 *    only a starting list, applied when the group powers on).
 *  - speakers (type 'player'): the native leader has synced_to null and group_members = [itself, ...]; members have
 *    synced_to = leader and empty group_members / can_group_with. active_group = the group that holds them.
 *  - a group can't contain a group. Groups may overlap; the last one to start takes the speakers.
 * Live MA 2.10.9 (0.5.0 test run): config/players/get → values.group_members.value is a dynamic group's default list
 * (dynamic_members true); players/get group_members is the current list, also while idle; static_group_members is [] on
 * dynamic groups. set_members on an idle dynamic group answers 200 and the speaker stays idle. Dropping a non-leader takes
 * ~1 s with no gap; dropping the leader re-forms on the next member after ~5.9 s of silence; transfer is ~4.7 s of silence
 * and the source stops by itself. mass_player_id is null on HA's group and WiiM entities.
 */
import type { HomeAssistant, JukeboxCardConfig, PresetConfig, QuietHours, RoomConfig, TargetConfig } from '../types';

export interface MaPlayer {
  player_id: string;
  provider: string;
  type: string;
  name: string;
  available: boolean;
  powered: boolean | null;
  playback_state: string;
  group_members: string[];
  static_group_members: string[];
  can_group_with: string[];
  synced_to: string | null;
  active_group: string | null;
  supported_features: string[];
  volume_level: number | null;
  current_media?: { title?: string; artist?: string; uri?: string } | null;
}
export type Players = Map<string, MaPlayer>;
export type Kind = 'static' | 'dynamic' | 'player';

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
/** players/all → Map by player_id. Accepts a list or {items}. Unknown shapes give an empty map. Nothing is filtered on hide_in_ui. */
export function parsePlayers(raw: unknown): Players {
  const list: any[] = Array.isArray(raw) ? raw : Array.isArray((raw as any)?.items) ? (raw as any).items : [];
  const m: Players = new Map();
  for (const p of list) {
    if (!p || typeof p.player_id !== 'string') continue;
    const st = String(p.playback_state ?? p.state ?? 'idle');
    m.set(p.player_id, {
      player_id: p.player_id, provider: String(p.provider ?? ''), type: String(p.type ?? 'player'),
      name: String(p.display_name || p.name || p.player_id), available: p.available !== false, powered: p.powered ?? null,
      playback_state: st, group_members: arr(p.group_members), static_group_members: arr(p.static_group_members),
      can_group_with: arr(p.can_group_with), synced_to: typeof p.synced_to === 'string' ? p.synced_to : null,
      active_group: typeof p.active_group === 'string' ? p.active_group : null,
      supported_features: arr(p.supported_features), volume_level: typeof p.volume_level === 'number' ? p.volume_level : null,
      current_media: p.current_media && typeof p.current_media === 'object' ? p.current_media : null,
    });
  }
  return m;
}

/** static / dynamic group or a plain player. A config that says dynamic_members false wins (live: set_members on a static
 *  group answers 500 "Player X does not support group commands", so the card never sends it there). */
export function kindOf(p?: MaPlayer, cfg?: GroupConfig): Kind {
  if (!p || p.type !== 'group') return 'player';
  if (cfg?.dynamic === false) return 'static';
  return p.supported_features.includes('set_members') && !p.static_group_members.length ? 'dynamic' : 'static';
}
export const isPlaying = (p?: MaPlayer | null) => !!p && p.playback_state === 'playing';
/** playing, paused or re-forming: the group holds its speakers */
export const isActive = (p?: MaPlayer | null) => !!p && ['playing', 'paused', 'buffering'].includes(p.playback_state);
/** Speakers a group is playing on now (static groups that are off: their fixed list). */
export function membersOf(g: MaPlayer | undefined, players: Players): string[] {
  if (!g) return [];
  if (g.type !== 'group') return [g.player_id];
  const live = g.group_members.filter((id) => players.get(id)?.type !== 'group');
  return live.length ? live : kindOf(g) === 'static' ? g.static_group_members : [];
}
/** The sync leader among a group's speakers (live: the first configured member leads; after it is removed the next one does). */
export function leaderOf(g: MaPlayer | undefined, players: Players): string | undefined {
  const ms = membersOf(g, players);
  if (!ms.length) return undefined;
  const lead = ms.find((id) => { const p = players.get(id); return !!p && !p.synced_to && p.group_members.length > 1; });
  if (lead) return lead;
  const to = ms.map((id) => players.get(id)?.synced_to).find((x) => !!x && ms.includes(x!));
  return to ?? ms[0];
}
/** The group currently holding a speaker (active and playing), other than `except`. */
export function holderOf(speaker: string, players: Players, except?: string): MaPlayer | undefined {
  const s = players.get(speaker);
  const cand = [s?.active_group, ...[...players.values()].filter((g) => g.type === 'group' && g.group_members.includes(speaker)).map((g) => g.player_id)];
  for (const id of cand) {
    if (!id || id === except) continue;
    const g = players.get(id);
    if (g && g.type === 'group' && isActive(g) && membersOf(g, players).includes(speaker)) return g;
  }
  return undefined;
}

/* ---------------- HA ↔ MA mapping ---------------- */
const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/\bspeaker\b/g, '').replace(/[^a-z0-9]+/g, '');
export interface Room { entity: string; name: string; ma?: string }
/** rooms → MA player ids: `ma_player` first, then MA name = room name or the entity's friendly name (minus "Speaker"). */
export function mapRooms(rooms: Array<RoomConfig & { name: string }>, hass: HomeAssistant | undefined, players: Players): Room[] {
  const speakers = [...players.values()].filter((p) => p.type !== 'group');
  return rooms.map((r) => {
    if (r.ma_player) return { entity: r.entity, name: r.name, ma: r.ma_player };
    const keys = [r.name, hass?.states[r.entity]?.attributes?.friendly_name, r.entity.replace(/^media_player\./, '')].map(norm).filter(Boolean);
    const hit = speakers.find((p) => keys.includes(norm(p.name)));
    return { entity: r.entity, name: r.name, ma: hit?.player_id };
  });
}
/**
 * HA target entity → MA player id. Live MA 2.10.9: mass_player_id is null on group and WiiM entities, and an idle group's
 * active_queue points at whatever queue its speakers are in (e.g. Everywhere's), so it can't be trusted alone. Order:
 * mass_player_id (when set and known) → an MA group whose name is the entity's friendly name → active_queue, only while the
 * entity itself plays → any MA player with that name. Unknown → undefined (callers degrade to the HA-only mixer).
 */
export function targetMa(entity: string, hass: HomeAssistant | undefined, players: Players): string | undefined {
  const s = hass?.states[entity], a = s?.attributes ?? {};
  if (typeof a.mass_player_id === 'string' && players.has(a.mass_player_id)) return a.mass_player_id;
  const n = norm(a.friendly_name ?? entity.replace(/^media_player\./, ''));
  const all = [...players.values()];
  const grp = all.find((p) => p.type === 'group' && norm(p.name) === n);
  if (grp) return grp.player_id;
  if (typeof a.active_queue === 'string' && players.has(a.active_queue) && ['playing', 'paused', 'buffering'].includes(s?.state ?? '')) return a.active_queue;
  return all.find((p) => norm(p.name) === n)?.player_id;
}
/** config/players/get → a group's configured members and dynamic_members flag (values.<key>.value); undefined when unreadable */
export interface GroupConfig { members: string[]; dynamic?: boolean }
export function parseGroupConfig(raw: unknown): GroupConfig | undefined {
  const v = (raw as any)?.values;
  if (!v || typeof v !== 'object') return undefined;
  const val = (k: string) => { const e = v[k]; return e && typeof e === 'object' && 'value' in e ? e.value : e; };
  const dm = val('dynamic_members');
  return { members: arr(val('group_members')), dynamic: typeof dm === 'boolean' ? dm : undefined };
}
export interface Target { entity: string; name: string; members?: string[] }
/** dynamic-mode targets: config `targets`, else every HA media_player that is an MA group/player with a queue, groups first */
export function targetsOf(c: JukeboxCardConfig, hass?: HomeAssistant): Target[] {
  const nameOf = (e: string) => hass?.states[e]?.attributes?.friendly_name ?? e.replace(/^media_player\./, '').replace(/_/g, ' ');
  if (Array.isArray(c.targets) && c.targets.length)
    return c.targets.map((t) => { const o: TargetConfig = typeof t === 'string' ? { entity: t } : t; return { entity: o.entity, name: o.name || nameOf(o.entity), members: o.members }; });
  const out = Object.values(hass?.states ?? {}).filter((s) => s.entity_id.startsWith('media_player.') && s.attributes?.mass_player_type === 'group')
    .map((s) => ({ entity: s.entity_id, name: nameOf(s.entity_id) }));
  const base = c.entity || 'media_player.everywhere';
  if (!out.some((t) => t.entity === base)) out.unshift({ entity: base, name: nameOf(base) });
  return out;
}

/* ---------------- permissions ---------------- */
type User = HomeAssistant['user'];
/** Grouping, moving and picking the target (dynamic mode only). A UI lock, not security: HA lets any user call these services. */
export function canGroup(c: JukeboxCardConfig, user: User): boolean {
  if (c.speaker_mode !== 'dynamic') return false;
  const g = c.grouping ?? 'admins';
  if (g === 'nobody') return false;
  if (g === 'everyone') return true;
  const list = (c.grouping_users ?? []).map((x) => String(x).toLowerCase());
  if (user && list.some((x) => x === String(user.id ?? '').toLowerCase() || x === String(user.name ?? '').toLowerCase())) return true;
  return !!user?.is_admin;
}
/** Volume and mute: everyone unless guest_access is 'none' (then only users who may group). */
export const canVolume = (c: JukeboxCardConfig, user: User) => (c.guest_access ?? 'volume') !== 'none' || canGroupAny(c, user);
/**
 * Queue-row Play now / Play next icons: whoever may group (admins, grouping_users, everyone when grouping is everyone),
 * in either speaker mode. Guests (volume only / read only) don't see them. A UI lock, not security.
 */
export const canJumpQueue = (c: JukeboxCardConfig, user: User) => canGroupAny(c, user);
/** like canGroup, but ignoring the mode (fixed-mode admins keep volume when guests are read-only) */
function canGroupAny(c: JukeboxCardConfig, user: User) { return canGroup({ ...c, speaker_mode: 'dynamic' }, user); }

/* ---------------- quiet hours ---------------- */
const mins = (s: string) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim()); return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : NaN; };
export function validQuiet(q: unknown): q is QuietHours {
  const o = q as QuietHours;
  return !!o && typeof o === 'object' && Number.isFinite(mins(o.start)) && Number.isFinite(mins(o.end))
    && typeof o.max_volume === 'number' && o.max_volume >= 0 && o.max_volume <= 100 && (o.applies === undefined || o.applies === 'guests' || o.applies === 'everyone');
}
/** true when `now` is inside [start, end) (wraps midnight; start === end = all day) */
export function inQuiet(q: QuietHours, now = new Date()): boolean {
  const s = mins(q.start), e = mins(q.end), t = now.getHours() * 60 + now.getMinutes();
  if (!Number.isFinite(s) || !Number.isFinite(e)) return false;
  if (s === e) return true;
  return s < e ? t >= s && t < e : t >= s || t < e;
}
/** The volume cap (0..1) for this user right now, or undefined. */
export function volumeCap(c: JukeboxCardConfig, user: User, now = new Date()): number | undefined {
  const q = c.quiet_hours;
  if (!q || !validQuiet(q) || !inQuiet(q, now)) return undefined;
  if ((q.applies ?? 'guests') === 'guests' && canGroupAny(c, user)) return undefined;
  return Math.max(0, Math.min(1, q.max_volume / 100));
}
export const capVol = (v: number, cap?: number) => (cap === undefined ? v : Math.min(v, cap));

/* ---------------- grouping plans ---------------- */
export interface Takeover {
  speaker: string;
  /** static: a fixed group stops entirely. dynamic: the speaker leaves (last → the group stops, leader → it restarts after a gap).
   *  solo: the speaker stops what it plays alone. hijack: the would-be leader leads another group, which is taken over whole. */
  kind: 'static' | 'dynamic' | 'solo' | 'hijack';
  group?: string;
  last?: boolean;
  leader?: boolean;
}
/**
 * What starting/joining `speakers` into `target` takes from other groups.
 * start = the target powers on with these speakers (speakers[0] becomes the leader): when that leader already leads a
 * playing group, MA keeps the whole native group, so the other group is hijacked (all its speakers switch over).
 */
export function takeovers(target: string | undefined, speakers: string[], players: Players, start = false): Takeover[] {
  const out: Takeover[] = [];
  const t = target ? players.get(target) : undefined;
  const inT = new Set(isActive(t) ? membersOf(t, players) : []);
  const taken = new Map<string, string[]>();
  for (const s of speakers) {
    if (inT.has(s)) continue;
    const h = holderOf(s, players, target);
    if (h) {
      const k = kindOf(h);
      const ms = membersOf(h, players);
      const took = [...(taken.get(h.player_id) ?? []), s]; taken.set(h.player_id, took);
      const lead = leaderOf(h, players) === s;
      if (start && lead && s === speakers[0]) { out.push({ speaker: s, kind: 'hijack', group: h.player_id, leader: true }); continue; }
      out.push({ speaker: s, kind: k === 'static' ? 'static' : 'dynamic', group: h.player_id,
        last: k !== 'static' && ms.every((m) => took.includes(m)), leader: lead });
      continue;
    }
    const p = players.get(s);
    if (p && isPlaying(p) && !p.synced_to) out.push({ speaker: s, kind: p.group_members.length > 1 ? 'hijack' : 'solo' });
  }
  return out;
}
/** Diff the current members into `want`. The leader is never removed unless allowed; the last speaker never. */
export function planMembers(cur: string[], want: string[], leader: string | undefined, allowLeaderDrop: boolean) {
  const add = want.filter((x) => !cur.includes(x));
  let remove = cur.filter((x) => !want.includes(x));
  const kept: string[] = [];
  if (!allowLeaderDrop && leader && remove.includes(leader)) { remove = remove.filter((x) => x !== leader); kept.push(leader); }
  if (!add.length && remove.length && remove.length >= cur.length) { const k = remove.pop()!; kept.push(k); }
  return { add, remove, kept };
}
/** Why a Drop is not offered, or '' when it is. */
export function dropBlock(target: MaPlayer | undefined, speaker: string, players: Players, allowLeaderDrop: boolean): '' | 'last' | 'leader' {
  const ms = membersOf(target, players);
  if (ms.length <= 1) return 'last';
  if (!allowLeaderDrop && isActive(target) && leaderOf(target, players) === speaker) return 'leader';
  return '';
}
/**
 * Presets shown in the panel: card-config presets, then one per dynamic group whose default members MA reported
 * (config/players/get). When MA config can't be read (cfgs empty) the card-config presets are all there is.
 * A config preset with the same target and members hides the MA one.
 */
export function maPresets(cfgs: Map<string, GroupConfig>, players: Players, rooms: Room[], targets: Target[], hass: HomeAssistant | undefined, own: PresetConfig[] = []): PresetConfig[] {
  const out: PresetConfig[] = [];
  const key = (t: string | undefined, ms: string[]) => `${t ?? ''}|${[...ms].sort().join(',')}`;
  const seen = new Set(own.map((p) => key(p.target, p.members)));
  for (const t of targets) {
    const id = targetMa(t.entity, hass, players);
    const g = id ? players.get(id) : undefined, cfg = id ? cfgs.get(id) : undefined;
    if (!g || !cfg || kindOf(g, cfg) !== 'dynamic' || !cfg.members.length) continue;
    const members = cfg.members.map((m) => rooms.find((r) => r.ma === m)?.entity).filter((x): x is string => !!x);
    if (members.length !== cfg.members.length || seen.has(key(t.entity, members))) continue;
    seen.add(key(t.entity, members));
    out.push({ name: `${t.name} default`, members, target: t.entity });
  }
  return [...own, ...out];
}
/** config preset → MA ids (rooms without a mapping are skipped) */
export function presetSpeakers(p: PresetConfig, rooms: Room[]): string[] {
  return p.members.map((e) => rooms.find((r) => r.entity === e)?.ma).filter((x): x is string => !!x);
}
export function validPreset(p: unknown): p is PresetConfig {
  const o = p as PresetConfig;
  return !!o && typeof o === 'object' && typeof o.name === 'string' && !!o.name && Array.isArray(o.members) && o.members.every((m) => typeof m === 'string' && m.startsWith('media_player.'))
    && (o.volumes === undefined || (typeof o.volumes === 'object' && Object.values(o.volumes).every((v) => typeof v === 'number' && v >= 0 && v <= 100)))
    && (o.target === undefined || (typeof o.target === 'string' && o.target.startsWith('media_player.')));
}

/** One line per takeover for confirm dialogs. nameOf maps an MA id to a display name. */
export function takeoverText(t: Takeover, nameOf: (id: string) => string): string {
  const s = nameOf(t.speaker), g = t.group ? nameOf(t.group) : '';
  switch (t.kind) {
    case 'static': return `${g} stops: it is a fixed group, taking ${s} stops all of it.`;
    case 'hijack': return `${g} is taken over: ${s} leads it, so all of ${g} switches.`;
    case 'solo': return `${s} stops what it is playing.`;
    default:
      if (t.last) return `${g} stops: ${s} is its last speaker.`;
      if (t.leader) return `${g} pauses briefly and restarts: ${s} leads it.`;
      return `${s} leaves ${g}; ${g} keeps playing.`;
  }
}
