/**
 * LRC / plain lyrics parsing. Pure functions, no DOM.
 *
 * LRC handled here:
 *  - line stamps [mm:ss], [mm:ss.x], [mm:ss.xx], [mm:ss.xxx] and [mm:ss:xx]; several stamps in front of one line
 *    ("[00:12.00][01:30.50]chorus") give one entry per stamp
 *  - ID tags ([ar:...], [ti:...], [al:...], [by:...], [length:...], [re:...], [ve:...], [#:...]) are dropped
 *  - [offset:+/-ms]: positive shows lyrics sooner (subtracted from every stamp)
 *  - enhanced/word stamps <mm:ss.xx> inside a line are stripped
 *  - blank stamped lines are kept as instrumental breaks (text ''), runs of blanks collapse into one
 *  - lines are sorted by time (stable)
 */
export interface LyricLine { t: number; text: string }
export interface Lyrics {
  /** 'synced': every line has a time; 'plain': t is the line index and means nothing */
  kind: 'synced' | 'plain';
  lines: LyricLine[];
}

const LEAD = /^\s*\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/;
const ID_TAG = /^\s*\[([a-z#]+)\s*:(.*)\]\s*$/i;
const WORD = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g;

const clean = (s: string) => s.replace(WORD, '').replace(/[\s\u00a0]+/g, ' ').trim();

export function parseLrc(src: string | null | undefined): LyricLine[] {
  if (!src || typeof src !== 'string') return [];
  let offsetMs = 0;
  const out: LyricLine[] = [];
  for (const raw of src.replace(/\r\n?/g, '\n').split('\n')) {
    let rest = raw;
    const stamps: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = LEAD.exec(rest))) {
      const frac = m[3] ? Number('0.' + m[3]) : 0;
      stamps.push(Number(m[1]) * 60 + Number(m[2]) + frac);
      rest = rest.slice(m[0].length);
    }
    if (!stamps.length) {
      const id = ID_TAG.exec(raw);
      if (id && id[1].toLowerCase() === 'offset') { const v = Number(id[2].trim()); if (Number.isFinite(v)) offsetMs = v; }
      continue; // ID tags and unstamped junk
    }
    const text = clean(rest);
    for (const t of stamps) out.push({ t, text });
  }
  const shift = offsetMs / 1000;
  const sorted = out.map((l, i) => ({ ...l, t: Math.max(0, l.t - shift), i }))
    .sort((a, b) => a.t - b.t || a.i - b.i);
  // collapse runs of blank lines (instrumental breaks); trailing blanks go
  const res: LyricLine[] = [];
  for (const l of sorted) {
    if (!l.text && res.length && !res[res.length - 1].text) continue;
    res.push({ t: Math.round(l.t * 1000) / 1000, text: l.text });
  }
  while (res.length && !res[res.length - 1].text) res.pop();
  return res;
}

export const looksLikeLrc = (s: unknown): s is string => typeof s === 'string' && /^\s*\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/m.test(s);

export function parsePlain(src: string | null | undefined): LyricLine[] {
  if (!src || typeof src !== 'string') return [];
  const lines = src.replace(/\r\n?/g, '\n').split('\n').map((s) => s.replace(/[\s\u00a0]+/g, ' ').trim());
  const res: string[] = [];
  for (const l of lines) { if (!l && (!res.length || !res[res.length - 1])) continue; res.push(l); }
  while (res.length && !res[res.length - 1]) res.pop();
  return res.map((text, i) => ({ t: i, text }));
}

/** Pick the best of what a provider returned: synced LRC first (also when it arrives in the plain field), then plain. */
export function toLyrics(plain: unknown, lrc: unknown): Lyrics | null {
  for (const s of [lrc, plain]) {
    if (looksLikeLrc(s)) { const lines = parseLrc(s); if (lines.some((l) => l.text)) return { kind: 'synced', lines }; }
  }
  for (const s of [plain, lrc]) {
    if (typeof s === 'string' && !looksLikeLrc(s)) { const lines = parsePlain(s); if (lines.some((l) => l.text)) return { kind: 'plain', lines }; }
  }
  return null;
}

/** Index of the line being sung at time t (seconds): the last line with line.t <= t; -1 before the first line. Binary search. */
export function indexAt(lines: LyricLine[], t: number): number {
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** Interpolated media position (s) of a HA media_player, like the Now Playing progress bar. */
export function positionOf(attrs: Record<string, any> | undefined, state: string | undefined, now = Date.now()): number {
  const a = attrs ?? {};
  let pos = Number(a.media_position) || 0;
  const upd = a.media_position_updated_at as string | undefined;
  if (state === 'playing' && upd) { const d = (now - Date.parse(upd)) / 1000; if (Number.isFinite(d) && d > 0) pos += d; }
  const dur = Number(a.media_duration) || 0;
  return dur ? Math.max(0, Math.min(dur, pos)) : Math.max(0, pos);
}
