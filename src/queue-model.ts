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
  loading: boolean;
  error: string;
  at: number;
}

/**
 * Shared queue state for Now Playing (Up next strip), the Queue tab and the tab badge.
 * Reads:  mass_queue.get_queue_items {entity, limit_before, limit_after}  (response only)
 *         music_assistant.get_queue  target entity                         (response only, keyed by entity_id)
 * Writes: mass_queue.play_queue_item / move_queue_item_up / _down / _next / remove_queue_item {entity, queue_item_id}
 */
export class QueueModel {
  snap: QueueSnapshot = { items: [], current: -1, loading: false, error: '', at: 0 };
  hass?: HomeAssistant;
  entity = 'media_player.everywhere';
  limitAfter = 200;
  private subs = new Set<(s: QueueSnapshot) => void>();
  private seq = 0;
  private timer?: number;

  subscribe(fn: (s: QueueSnapshot) => void) { this.subs.add(fn); fn(this.snap); return () => this.subs.delete(fn); }
  private set(p: Partial<QueueSnapshot>) { this.snap = { ...this.snap, ...p }; this.subs.forEach((f) => f(this.snap)); }

  /** Upcoming items after the current one. */
  get upNext() { const s = this.snap; return s.current >= 0 ? s.items.slice(s.current + 1) : s.items; }
  get currentItem() { const s = this.snap; return s.current >= 0 ? s.items[s.current] : undefined; }
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
      this.set({
        items, current, loading: false, error: '', at: Date.now(),
        total: typeof q?.items === 'number' ? q.items : undefined,
        currentIndex: typeof q?.current_index === 'number' ? q.current_index : undefined,
      });
    } catch (err) {
      if (seq !== this.seq) return;
      console.warn('[jukebox-card] queue refresh failed', err);
      this.set({ loading: false, error: 'Queue unavailable. Is mass_queue installed?' });
    }
  }

  private async act(service: string, id: string, optimistic: (items: QueueItem[], i: number) => { items: QueueItem[]; current: number } | void) {
    const hass = this.hass; if (!hass) return;
    const i = this.snap.items.findIndex((x) => x.queue_item_id === id);
    if (i >= 0) {
      const copy = this.snap.items.slice();
      const r = optimistic(copy, i);
      if (r) this.set({ items: r.items, current: r.current });
    }
    try { await hass.callService('mass_queue', service, { entity: this.entity, queue_item_id: id }); }
    catch (err) { console.warn(`[jukebox-card] mass_queue.${service} failed`, err); throw err; }
    finally { this.refreshSoon(600); }
  }
  private moveTo(items: QueueItem[], from: number, to: number) {
    const cur = this.snap.current;
    const curId = cur >= 0 ? items[cur]?.queue_item_id : undefined;
    to = Math.max(this.snap.current + 1, Math.min(items.length - 1, to));
    const [it] = items.splice(from, 1); items.splice(to, 0, it);
    return { items, current: curId ? items.findIndex((x) => x.queue_item_id === curId) : cur };
  }
  play(id: string) { return this.act('play_queue_item', id, (items, i) => ({ items, current: i })); }
  up(id: string) { return this.act('move_queue_item_up', id, (items, i) => this.moveTo(items, i, i - 1)); }
  down(id: string) { return this.act('move_queue_item_down', id, (items, i) => this.moveTo(items, i, i + 1)); }
  next(id: string) { return this.act('move_queue_item_next', id, (items, i) => this.moveTo(items, i, this.snap.current + 1)); }
  remove(id: string) {
    return this.act('remove_queue_item', id, (items, i) => {
      const cur = this.snap.current; items.splice(i, 1);
      return { items, current: i < cur ? cur - 1 : cur };
    });
  }
}
