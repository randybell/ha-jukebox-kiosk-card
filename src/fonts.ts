/**
 * @font-face rules must live in the document (they do not apply from inside a shadow root),
 * so the card injects one <style> into <head> once. Fonts are self-hosted (OFL) in a `fonts/` folder next to the
 * bundle (resolved from import.meta.url, so /local/jukebox/jukebox-card.js → /local/jukebox/fonts/). If they fail to load
 * (e.g. a HACS install, which only downloads the .js), the system-ui fallback in the font stacks applies.
 */
const ID = 'jukebox-card-fonts';

export function ensureFonts(base: string | false | undefined) {
  if (base === false || typeof document === 'undefined' || document.getElementById(ID)) return;
  let def = '/local/jukebox/fonts';
  try { def = new URL('./fonts/', import.meta.url).pathname; } catch { /* non-module context: keep the default */ }
  const b = (base || def).replace(/\/$/, '');
  const face = (family: string, weight: number, file: string) =>
    `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:swap;src:url('${b}/${file}') format('woff2');}`;
  const style = document.createElement('style');
  style.id = ID;
  style.textContent = [
    face('Inter', 400, 'inter-400.woff2'),
    face('Inter', 600, 'inter-600.woff2'),
    face('Inter', 700, 'inter-700.woff2'),
    face('Inter', 800, 'inter-800.woff2'),
    face('Plus Jakarta Sans', 700, 'plus-jakarta-sans-700.woff2'),
    face('Plus Jakarta Sans', 800, 'plus-jakarta-sans-800.woff2'),
  ].join('\n');
  document.head.appendChild(style);
}
