/**
 * Backdrop performance modes.
 *  full   – live CSS blur (38px) of the full-size art + backdrop-filter on panels (today's look).
 *  light  – one pre-blurred 64px canvas per track change, stretched by the compositor; panels are solid rgba(0,0,0,.6), no backdrop-filter.
 *  static – dark gradient, no art, no filters.
 *  off    – pure black.
 *  auto   – light on low-end devices (hardwareConcurrency <= 4 or deviceMemory <= 2) or prefers-reduced-motion, else full.
 */
export type BackdropMode = 'full' | 'light' | 'static' | 'off';
export type BackdropSetting = BackdropMode | 'auto';
export const BACKDROPS: BackdropSetting[] = ['auto', 'full', 'light', 'static', 'off'];

export function deviceIsLowEnd(nav: Navigator = navigator): { low: boolean; why: string } {
  const cores = nav.hardwareConcurrency;
  const mem = (nav as any).deviceMemory as number | undefined;
  if (typeof cores === 'number' && cores > 0 && cores <= 4) return { low: true, why: `hardwareConcurrency=${cores}` };
  if (typeof mem === 'number' && mem > 0 && mem <= 2) return { low: true, why: `deviceMemory=${mem}` };
  return { low: false, why: `cores=${cores ?? '?'} mem=${mem ?? '?'}` };
}
export const prefersReducedMotion = () => !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function resolveBackdrop(setting: BackdropSetting | undefined): { mode: BackdropMode; why: string } {
  const s = setting ?? 'auto';
  if (s !== 'auto') return { mode: s, why: 'config' };
  if (prefersReducedMotion()) return { mode: 'light', why: 'prefers-reduced-motion' };
  const d = deviceIsLowEnd();
  return d.low ? { mode: 'light', why: d.why } : { mode: 'full', why: d.why };
}

const W = 64;
/**
 * Draw `src` into `canvas` as a soft, cover-cropped, pre-blurred thumbnail (64px wide, height follows the box aspect).
 * Drawing a cross-origin image into a canvas is allowed (we never read pixels back), so no CORS is needed.
 * Blur = downscale to ~10px then smooth upscale (works everywhere) + ctx.filter blur/saturate where supported.
 * Resolves true when drawn.
 */
export async function drawPreblurred(canvas: HTMLCanvasElement, src: string, boxW: number, boxH: number): Promise<boolean> {
  const img = new Image();
  img.decoding = 'async';
  img.src = src;
  try { await img.decode(); } catch { return false; }
  const h = Math.max(8, Math.round((W * boxH) / Math.max(1, boxW)));
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  // Rasterise once at <=256px first: source-rect crops straight from SVG images are unreliable in Chrome,
  // and a two-step downscale gives a cleaner average than one big jump.
  const nw = img.naturalWidth || 256, nh = img.naturalHeight || 256;
  const k = Math.min(1, 256 / Math.max(nw, nh));
  const mid = document.createElement('canvas');
  mid.width = Math.max(1, Math.round(nw * k)); mid.height = Math.max(1, Math.round(nh * k));
  const m = mid.getContext('2d')!;
  m.imageSmoothingEnabled = true; m.imageSmoothingQuality = 'high';
  m.drawImage(img, 0, 0, mid.width, mid.height);
  // cover crop into the target aspect
  const ia = mid.width / mid.height, ta = W / h;
  let sw = mid.width, sh = mid.height, sx = 0, sy = 0;
  if (ia > ta) { sw = sh * ta; sx = (mid.width - sw) / 2; } else { sh = sw / ta; sy = (mid.height - sh) / 2; }
  const tiny = document.createElement('canvas');
  tiny.width = 10; tiny.height = Math.max(2, Math.round(10 / ta));
  const t = tiny.getContext('2d')!;
  t.imageSmoothingEnabled = true; t.imageSmoothingQuality = 'high';
  t.drawImage(mid, sx, sy, sw, sh, 0, 0, tiny.width, tiny.height);
  ctx.clearRect(0, 0, W, h);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  if ('filter' in ctx) ctx.filter = 'blur(3px) saturate(1.15)';
  ctx.drawImage(tiny, -6, -6, W + 12, h + 12); // overscan so the blur has no dark edge
  if ('filter' in ctx) ctx.filter = 'none';
  return true;
}
