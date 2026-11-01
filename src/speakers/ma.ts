/**
 * Music Assistant player access through mass_queue.send_command (the same path as Browse and lyrics):
 * players/all, config/players/get (group defaults), players/cmd/set_members, player_queues/transfer, players/cmd/stop. HA's media_player.join/unjoin are
 * never used: their ids don't match MA's speaker ids. players/cmd/ungroup is never used either.
 * Calls are serialised (one grouping change at a time) and time out.
 */
import type { HomeAssistant } from '../types';
import { parsePlayers, parseGroupConfig, type GroupConfig, type Players } from './model';

export class SpeakerError extends Error {
  constructor(public code: 'timeout' | 'failed' | 'config', message: string) { super(message); }
}
const mq = (r: any): any => {
  let d = r && typeof r === 'object' && 'response' in r ? r.response : r;
  if (d && typeof d === 'object' && !Array.isArray(d) && Object.keys(d).length === 1 && 'response' in d) d = d.response;
  return d;
};
/** Timeouts (ms). Tests may shorten them through window.__jbSpeakerTimeouts. */
export function timeouts() {
  const o = (typeof window !== 'undefined' && (window as any).__jbSpeakerTimeouts) || {};
  return { call: o.call ?? 8000, join: o.join ?? 8000, move: o.move ?? 10000, poll: o.poll ?? 3000, fast: o.fast ?? 500 };
}
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new SpeakerError('timeout', `${what} timed out`)), ms); })])
    .finally(() => clearTimeout(t));
}

export class SpeakerStore {
  hass?: HomeAssistant;
  players: Players = new Map();
  /** config/players/get per group (MA 2.10.9 scope config.players.read: granted to guest, user and service roles, so not
   *  admin-only; via mass_queue it runs on the integration's token). Missing entries = unreadable: card presets only. */
  configs = new Map<string, GroupConfig>();
  configTried = new Set<string>();
  loaded = false;
  error = '';
  private chain: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private fastUntil = 0;
  private listeners = new Set<() => void>();
  constructor(public entryId?: string) {}
  onChange(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit() { for (const f of this.listeners) f(); }

  async send(command: string, data: Record<string, unknown>, ms = timeouts().call): Promise<any> {
    if (!this.hass || !this.entryId) throw new SpeakerError('config', 'mass_queue_entry_id is not set');
    try {
      return mq(await withTimeout(this.hass.callService('mass_queue', 'send_command', { config_entry_id: this.entryId, command, data }, undefined, false, true), ms, command));
    } catch (e: any) {
      if (e instanceof SpeakerError) throw e;
      throw new SpeakerError('failed', String(e?.message ?? e));
    }
  }
  async refresh(): Promise<Players> {
    try {
      this.players = parsePlayers(await this.send('players/all', {}));
      this.loaded = true; this.error = '';
      void this.loadConfigs();
    } catch (e: any) { this.error = String(e?.message ?? e); }
    this.emit();
    return this.players;
  }
  /** read each group's MA config once (failures are remembered and not retried until reset) */
  async loadConfigs(force = false): Promise<void> {
    if (force) { this.configs.clear(); this.configTried.clear(); }
    const groups = [...this.players.values()].filter((p) => p.type === 'group' && !this.configTried.has(p.player_id));
    if (!groups.length) return;
    groups.forEach((g) => this.configTried.add(g.player_id));
    await Promise.all(groups.map(async (g) => {
      try { const c = parseGroupConfig(await this.send('config/players/get', { player_id: g.player_id })); if (c) this.configs.set(g.player_id, c); }
      catch { /* non-admin / older MA: fall back to card-config presets */ }
    }));
    this.emit();
  }
  /** one write at a time */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }
  setMembers(target: string, add: string[], remove: string[] = []) {
    return this.run(() => this.send('players/cmd/set_members', { target_player: target, player_ids_to_add: add, player_ids_to_remove: remove }, timeouts().join))
      .finally(() => this.burst());
  }
  transfer(source: string, target: string, autoPlay = true) {
    return this.run(() => this.send('player_queues/transfer', { source_queue_id: source, target_queue_id: target, auto_play: autoPlay }, timeouts().move))
      .finally(() => this.burst());
  }
  stop(player: string) {
    return this.run(() => this.send('players/cmd/stop', { player_id: player })).finally(() => this.burst());
  }
  /** refresh until pred() holds or ms passes */
  async waitFor(pred: (p: Players) => boolean, ms: number): Promise<boolean> {
    const end = Date.now() + ms;
    for (;;) {
      if (pred(await this.refresh())) return true;
      if (Date.now() >= end) return false;
      await new Promise((r) => setTimeout(r, Math.min(timeouts().fast, Math.max(0, end - Date.now()))));
    }
  }
  /** poll faster for a few seconds after a change */
  private burst() { this.fastUntil = Date.now() + 6000; }
  start() {
    if (this.timer) return;
    void this.refresh();
    let last = Date.now();
    this.timer = setInterval(() => {
      const t = timeouts(); const now = Date.now();
      if (now - last >= (now < this.fastUntil ? t.fast : t.poll)) { last = now; void this.refresh(); }
    }, 250);
  }
  stopPolling() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}
