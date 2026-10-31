import type { SearchResults } from './types';

/**
 * Per-keystroke search with:
 *  - sequence numbers: only a reply newer than what is on screen is rendered (stale replies are dropped,
 *    but still cached);
 *  - a 5-minute in-memory LRU cache keyed by the normalised query (instant backspace / recent chips);
 *  - adaptive in-flight limiting: when MA replies take longer than `slowMs`, at most one request is in
 *    flight plus the latest pending query (newer keystrokes replace the pending one). Normal
 *    every-keystroke mode resumes once a reply comes back under `slowMs`.
 */
export interface EngineOptions {
  fetch: (query: string, limit: number) => Promise<SearchResults>;
  onResults: (query: string, results: SearchResults | null, info: { seq: number; cached: boolean }) => void;
  onLoading?: (loading: boolean) => void;
  onError?: (query: string, err: unknown) => void;
  limit?: number;
  shortLimit?: number;
  slowMs?: number;
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

interface Pending { query: string; key: string; seq: number }

export const normaliseQuery = (q: string) => q.trim().replace(/\s+/g, ' ').toLowerCase();

export class SearchEngine {
  private o: Required<Omit<EngineOptions, 'onLoading' | 'onError'>> & Pick<EngineOptions, 'onLoading' | 'onError'>;
  private cache = new Map<string, { at: number; results: SearchResults }>();
  private reqSeq = 0;
  private shownSeq = 0;
  private inFlight = 0;
  private pending: Pending | null = null;
  slowMode = false;
  /** Counters for diagnostics/tests. */
  stats = { requests: 0, cacheHits: 0, staleDropped: 0, coalesced: 0, lastMs: 0 };

  constructor(opts: EngineOptions) {
    this.o = {
      limit: 8,
      shortLimit: 5,
      slowMs: 800,
      ttlMs: 5 * 60 * 1000,
      maxEntries: 100,
      now: () => Date.now(),
      ...opts,
    } as any;
  }

  setLimit(limit: number) { if (limit && limit !== this.o.limit) { this.o.limit = limit; this.cache.clear(); } }
  setSlowMs(ms: number) { if (ms) this.o.slowMs = ms; }
  get loading() { return this.inFlight > 0 || this.pending !== null; }

  /** Call on every keystroke with the full current query. */
  query(raw: string): void {
    const key = normaliseQuery(raw);
    const seq = ++this.reqSeq;
    if (!key) {
      // Clear: invalidate anything in flight and drop the pending query.
      this.pending = null;
      this.shownSeq = seq;
      this.o.onResults(raw, null, { seq, cached: false });
      this.emitLoading();
      return;
    }
    const hit = this.getCached(key);
    if (hit) {
      this.stats.cacheHits++;
      this.pending = null; // newer than anything pending
      this.shownSeq = seq;
      this.o.onResults(raw, hit, { seq, cached: true });
      this.emitLoading();
      return;
    }
    const p: Pending = { query: raw, key, seq };
    if (this.slowMode && this.inFlight > 0) {
      if (this.pending) this.stats.coalesced++;
      this.pending = p;
      this.emitLoading();
      return;
    }
    this.send(p);
  }

  private limitFor(key: string) { return key.length <= 1 ? Math.min(this.o.shortLimit, this.o.limit) : this.o.limit; }
  private cacheKey(key: string) { return `${this.limitFor(key)}|${key}`; }

  private getCached(key: string): SearchResults | null {
    const k = this.cacheKey(key);
    const e = this.cache.get(k);
    if (!e) return null;
    if (this.o.now() - e.at > this.o.ttlMs) { this.cache.delete(k); return null; }
    // LRU refresh
    this.cache.delete(k); this.cache.set(k, e);
    return e.results;
  }

  private putCache(key: string, results: SearchResults) {
    const k = this.cacheKey(key);
    this.cache.delete(k);
    this.cache.set(k, { at: this.o.now(), results });
    while (this.cache.size > this.o.maxEntries) this.cache.delete(this.cache.keys().next().value as string);
  }

  private async send(p: Pending) {
    this.inFlight++;
    this.stats.requests++;
    this.emitLoading();
    const t0 = this.o.now();
    try {
      const res = await this.o.fetch(p.query.trim(), this.limitFor(p.key));
      this.putCache(p.key, res);
      if (p.seq > this.shownSeq) {
        this.shownSeq = p.seq;
        this.o.onResults(p.query, res, { seq: p.seq, cached: false });
      } else {
        this.stats.staleDropped++;
      }
    } catch (err) {
      if (p.seq === this.reqSeq) this.o.onError?.(p.query, err);
    } finally {
      const ms = this.o.now() - t0;
      this.stats.lastMs = ms;
      this.slowMode = ms > this.o.slowMs;
      this.inFlight--;
      const next = this.pending;
      if (next && (!this.slowMode || this.inFlight === 0)) {
        this.pending = null;
        if (next.seq > this.shownSeq) {
          const hit = this.getCached(next.key);
          if (hit) { this.shownSeq = next.seq; this.o.onResults(next.query, hit, { seq: next.seq, cached: true }); }
          else this.send(next);
        }
      }
      this.emitLoading();
    }
  }

  private emitLoading() { this.o.onLoading?.(this.loading); }
}
