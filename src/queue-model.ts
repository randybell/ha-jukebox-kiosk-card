import type { HomeAssistant } from './types';
import { unwrap, cleanName, safeImage } from './shared';

/** One item from mass_queue.get_queue_items (v0.10.4: no duration). */
export interface QueueItem {
  queue_item_id: string;
  media_title: string;
  media_album_name?: string;
  media_artist?: string;
  media_content_id?: string;
  media_image?: string;
  favorite?: boolean;
}
export interface QueueSnapshot {
  items: QueueItem[];
  /** index in `items` of the playing item, -1 if unknown */
  current: number;
  /** total items in the MA queue (music_assistant.get_queue `items`), if known */
  total?: number;
  /** MA queue index of the playing item (music_assistant.get_queue `current_index`) */
  currentIndex?: number;
  /** MA queue id (music_assistant.get_queue `queue_id`, else the entity's `active_queue`) for player_queues/* commands */
  queueId?: string;
  /** MA index_in_buffer (player_queues/get through send_command). Live MA 2.10.9: it is set by MA, not current + 1: it can be
   *  current + 1 (next track handed to the player) or equal to current (right after play_index). */
  bufferIndex?: number;
  loading: boolean;
  error: string;
  at: number;
}

/**
 * pos_shift for player_queues/move_item that puts window row `i` right after the playing row `current`.
 * Relative, so the window offset (limit_before) cancels out. 0 = nothing to do (already next, playing, played or no
 * current row); 0 is never sent because MA reads pos_shift 0 as "move next" with its own buffer rules.
 */
export function nextShift(current: number, i: number): number {
  if (current < 0 || i <= current + 1) return 0;
  return current + 1 - i;
}
/**
 * Window row of the last item MA owns (the playing one and the one in the player's buffer): rows at or before it can't be
 * moved (MA: 500 "<n> is already played/buffered") or deleted (MA: 200 but ignored). current when the buffer is unknown.
 */
export function lockedRow(current: number, currentIndex?: number, bufferIndex?: number): number {
  if (current < 0) return current;
  if (typeof currentIndex !== 'number' || typeof bufferIndex !== 'number') return current;
  return current + Math.max(0, bufferIndex - currentIndex);
}
/** MA refused or ignored a change because the track is already played or loading in the player's buffer */
export class QueueBusy extends Error { constructor(m = 'That track is already loading') { super(m); } }
export const isBufferedError = (e: unknown) => /already (played|buffered|played\/buffered)|already loaded in (the )?buffer/i.test(String((e as any)?.message ?? e));
/**
 * Shared queue state for Now Playing (Up next strip), the Queue tab and the tab badge.
 * Reads:  mass_queue.get_queue_items {entity, limit_before, limit_after}  (response only)
 *         music_assistant.get_queue  target entity                         (response only, keyed by entity_id)
 * Writes: mass_queue.play_queue_item / move_queue_item_up / _down / _next / remove_queue_item {entity, queue_item_id}
 * Row Play now / Play next (0.5.0): mass_queue.send_command player_queues/play_index {queue_id, index: queue_item_id} and
 *   player_queues/move_item {queue_id, queue_item_id, pos_shift} (names checked against MA 2.10.9 and music-assistant-client 1.7.0);
 *   without mass_queue_entry_id or a queue id they fall back to play_queue_item / move_queue_item_next.
 */
export class QueueModel {
  snap: QueueSnapshot = { items: [], current: -1, loading: false, error: '', at: 0 };
  hass?: HomeAssistant;
  entity = 'media_player.everywhere';
  limitAfter = 200;
  /** mass_queue config entry for send_command (config mass_queue_entry_id) */
  entryId?: string;
  private subs = new Set<(s: QueueSnapshot) => void>();
  private seq = 0;
  private timer?: number;

  subscribe(fn: (s: QueueSnapshot) => void) { this.subs.add(fn); fn(this.snap); return () => this.subs.delete(fn); }
  private set(p: Partial<QueueSnapshot>) { this.snap = { ...this.snap, ...p }; this.subs.forEach((f) => f(this.snap)); }

  /** Upcoming items after the current one. */
  get upNext() { const s = this.snap; return s.current >= 0 ? s.items.slice(s.current + 1) : s.items; }
  get currentItem() { const s = this.snap; return s.current >= 0 ? s.items[s.current] : undefined; }
  /** window row of the last item MA owns (see lockedRow) */
  /** whether this viewer gets row actions (the buffer read only serves them); unset = yes */
  readsBuffer?: () => boolean;
  get locked() { const s = this.snap; return lockedRow(s.current, s.currentIndex, s.bufferIndex); }
  get remaining() {
    const s = this.snap;
    if (s.total !== undefined && s.currentIndex !== undefined && s.total > 0) return Math.max(0, s.total - s.currentIndex - 1);
    return this.upNext.length;
  }

  /** Debounced refresh (state changes arrive in bursts). */
  refreshSoon(ms = 350) { window.clearTimeout(this.timer); this.timer = window.setTimeout(() => this.refresh(), ms); }

  async refresh() {
    const hass = this.hass; if (!hass) return;
    const seq = ++this.seq;
    this.set({ loading: true });
    const entity = this.entity;
    const items$ = hass.callService('mass_queue', 'get_queue_items', { entity, limit_before: 1, limit_after: Number.isFinite(this.limitAfter) ? Math.max(1, Math.min(1000, Math.round(this.limitAfter))) : 200 }, undefined, false, true);
    const q$ = hass.callService('music_assistant', 'get_queue', {}, { entity_id: entity }, false, true).catch(() => undefined);
    try {
      const [ri, rq] = await Promise.all([items$, q$]);
      if (seq !== this.seq) return;
      const raw = unwrap(ri, entity);
      const items: QueueItem[] = (Array.isArray(raw) ? raw : []).filter((x: any) => x && x.queue_item_id != null)
        .map((x: any) => ({ ...x, queue_item_id: String(x.queue_item_id), media_title: cleanName(x.media_title ?? x.name ?? ''), media_image: safeImage(x.media_image) || undefined }));
      const q = unwrap(rq, entity) ?? {};
      const curId = q?.current_item?.queue_item_id != null ? String(q.current_item.queue_item_id) : undefined;
      let current = curId ? items.findIndex((i) => i.queue_item_id === curId) : -1;
      if (current < 0) {
        const cid = hass.states[entity]?.attributes?.media_content_id;
        if (cid) current = items.findIndex((i) => i.media_content_id === cid);
      }
      if (current < 0 && items.length && q?.current_index != null) current = Math.min(q.current_index === 0 ? 0 : 1, items.length - 1); // offset = idx - limit_before(1), clamped at 0
      const queueId = typeof q?.queue_id === 'string' && q.queue_id ? q.queue_id : (hass.states[entity]?.attributes?.active_queue as string | undefined) || undefined;
      // HA's get_queue has no index_in_buffer: read MA's queue (player_queues/get) when the send_command path exists
      let bufferIndex: number | undefined, currentIndex = typeof q?.current_index === 'number' ? q.current_index : undefined;
      if (this.entryId && queueId && (this.readsBuffer?.() ?? true)) {
        try {
          const mq = unmq(await hass.callService('mass_queue', 'send_command', { config_entry_id: this.entryId, command: 'player_queues/get', data: { queue_id: queueId } }, undefined, false, true));
          if (typeof mq?.index_in_buffer === 'number') bufferIndex = mq.index_in_buffer;
          if (typeof mq?.current_index === 'number') currentIndex = mq.current_index;
        } catch { /* older mass_queue / MA: rows before current + 1 stay the only lock */ }
        if (seq !== this.seq) return;
      }
      this.set({
        items, current, loading: false, error: '', at: Date.now(),
        total: typeof q?.items === 'number' ? q.items : undefined,
        currentIndex, queueId, bufferIndex,
      });
    } catch (err) {
      if (seq !== this.seq) return;
      console.warn('[jukebox-card] queue refresh failed', err);
      this.set({ loading: false, error: 'Queue unavailable. Is mass_queue installed?' });
    }
  }

  private async act(service: string, id: string, optimistic: (items: QueueItem[], i: number) => { items: QueueItem[]; current: number } | void,
    send?: () => Promise<unknown>) {
    const hass = this.hass; if (!hass) return;
    const i = this.snap.items.findIndex((x) => x.queue_item_id === id);
    if (i >= 0) {
      const copy = this.snap.items.slice();
      const r = optimistic(copy, i);
      if (r) this.set({ items: r.items, current: r.current });
    }
    try { await (send ? send() : hass.callService('mass_queue', service, { entity: this.entity, queue_item_id: id })); }
    catch (err) {
      console.warn(`[jukebox-card] mass_queue.${service} failed`, err);
      if (isBufferedError(err)) { void this.refresh(); throw new QueueBusy(); }
      throw err;
    }
    finally { this.refreshSoon(600); }
  }
  private moveTo(items: QueueItem[], from: number, to: number) {
    const cur = this.snap.current;
    const curId = cur >= 0 ? items[cur]?.queue_item_id : undefined;
    to = Math.max(this.locked + 1, Math.min(items.length - 1, to));
    const [it] = items.splice(from, 1); items.splice(to, 0, it);
    return { items, current: curId ? items.findIndex((x) => x.queue_item_id === curId) : cur };
  }
  play(id: string) { return this.act('play_queue_item', id, (items, i) => ({ items, current: i })); }
  up(id: string) { return this.act('move_queue_item_up', id, (items, i) => this.moveTo(items, i, i - 1)); }
  down(id: string) { return this.act('move_queue_item_down', id, (items, i) => this.moveTo(items, i, i + 1)); }
  next(id: string) { return this.act('move_queue_item_next', id, (items, i) => this.moveTo(items, i, this.locked + 1)); }
  /** true when MA owns this row (played, playing or in the player's buffer): no move / remove */
  isLocked(id: string) { const i = this.snap.items.findIndex((x) => x.queue_item_id === id); return i >= 0 && i <= this.locked; }
  /** player_queues/* through mass_queue.send_command, or undefined when that path is not configured */
  private ma(command: string, data: Record<string, unknown>) {
    const hass = this.hass, qid = this.snap.queueId;
    if (!hass || !this.entryId || !qid) return undefined;
    return () => hass.callService('mass_queue', 'send_command', { config_entry_id: this.entryId, command, data: { queue_id: qid, ...data } }, undefined, false, true);
  }
  /** Row Play now: jump playback to this item (MA play_index takes an index or a queue_item_id; the id is window-proof). */
  playNow(id: string) {
    const send = this.ma('player_queues/play_index', { index: id });
    return send ? this.act('player_queues/play_index', id, (items, i) => ({ items, current: i }), send) : this.play(id);
  }
  /** Row Play next: move this item right after the last one MA owns (the buffered track, else the playing one). */
  playNext(id: string) {
    const i = this.snap.items.findIndex((x) => x.queue_item_id === id);
    const lk = this.locked;
    const shift = nextShift(lk, i);
    if (!shift) return Promise.resolve();
    const send = this.ma('player_queues/move_item', { queue_item_id: id, pos_shift: shift });
    return send ? this.act('player_queues/move_item', id, (items, j) => this.moveTo(items, j, lk + 1), send) : this.next(id);
  }
  remove(id: string) {
    return this.act('remove_queue_item', id, (items, i) => {
      const cur = this.snap.current; items.splice(i, 1);
      return { items, current: i < cur ? cur - 1 : cur };
    });
  }
  /**
   * Row Remove (0.5.0): player_queues/delete_item {queue_id, item_id_or_index: queue_item_id} (0.4 service without the
   * send_command path). Never the playing row. Returns what Undo needs: the URI and the row it sat after.
   */
  removedInfo(id: string): RemovedRow | undefined {
    const s = this.snap, i = s.items.findIndex((x) => x.queue_item_id === id);
    if (i < 0 || i === s.current) return undefined;
    const it = s.items[i];
    return { id, title: it.media_title, uri: it.media_content_id, prevId: i > 0 ? s.items[i - 1].queue_item_id : undefined, before: i < s.current };
  }
  async removeRow(id: string): Promise<RemovedRow | undefined> {
    const info = this.removedInfo(id);
    if (!info) return undefined;
    if (this.isLocked(id)) throw new QueueBusy();
    const send = this.ma('player_queues/delete_item', { item_id_or_index: id });
    if (!send) { await this.remove(id); return info; }
    await this.act('player_queues/delete_item', id, (items, j) => {
      const cur = this.snap.current; items.splice(j, 1);
      return { items, current: j < cur ? cur - 1 : cur };
    }, send);
    // MA answers 200 but ignores a delete at or before its buffer (live 2.10.9): re-read and tell when the row is still there
    await this.refresh();
    if (this.snap.items.some((x) => x.queue_item_id === id)) throw new QueueBusy();
    return info;
  }
  /**
   * Undo a Remove: re-enqueue the URI with option add (MA appends it, or places it at random when shuffle is on), find the
   * new row with player_queues/items, then move_item it back after the row it used to follow. Resolves 'ok', or 'end' when
   * it was re-added but could not be put back in place; throws when it could not be re-added at all.
   */
  async undoRemove(r: RemovedRow): Promise<'ok' | 'end'> {
    const hass = this.hass, qid = this.snap.queueId;
    if (!hass || !this.entryId || !qid) throw new Error('Undo needs mass_queue_entry_id');
    if (!r.uri) throw new Error('No URI for this track');
    const send = async (command: string, data: Record<string, unknown>) =>
      unmq(await hass.callService('mass_queue', 'send_command', { config_entry_id: this.entryId, command, data: { queue_id: qid, ...data } }, undefined, false, true));
    const known = new Set(this.snap.items.map((x) => x.queue_item_id));
    try {
      await send('player_queues/play_media', { media: r.uri, option: 'add' }); // a failure here throws: not re-added
      if (r.before) return 'end'; // it had been played already: MA won't move items into the played part
      try {
        const offset = Math.max(0, (this.snap.currentIndex ?? 0) - 1);
        const list = await send('player_queues/items', { limit: 1000, offset });
        const rows: any[] = Array.isArray(list) ? list : [];
        const uriOf = (x: any) => x?.media_item?.uri ?? x?.uri ?? x?.media_content_id;
        const fresh = rows.map((x, k) => ({ x, k })).filter(({ x }) => uriOf(x) === r.uri && !known.has(String(x?.queue_item_id)));
        const hit = fresh[fresh.length - 1];
        const prev = r.prevId ? rows.findIndex((x) => String(x?.queue_item_id) === r.prevId) : -1;
        if (!hit || prev < 0) return 'end';
        const shift = hit.k > prev ? prev + 1 - hit.k : prev - hit.k; // shuffle may have placed it earlier
        if (shift) await send('player_queues/move_item', { queue_item_id: String(hit.x.queue_item_id), pos_shift: shift });
        return 'ok';
      } catch (e) { console.warn('[jukebox-card] undo: re-added but not moved back', e); return 'end'; }
    } finally { this.refreshSoon(300); }
  }
}
export interface RemovedRow { id: string; title: string; uri?: string; prevId?: string; before: boolean }
const unmq = (r: any): any => {
  let d = r && typeof r === 'object' && 'response' in r ? r.response : r;
  if (d && typeof d === 'object' && !Array.isArray(d) && Object.keys(d).length === 1 && 'response' in d) d = d.response;
  return d;
};
