// Keeps browser tests hermetic: HA's /api/media_player_proxy/ (entity_picture_local) and every non-local image host
// (station logos, mzstatic album art) are answered with a generated SVG; requests are logged on page.__img.
const h = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7) >>> 0;
const PAL = [['#ff2e7e', '#ff9a3d'], ['#3b2cff', '#00d4c4'], ['#ffd23f', '#ff4f8b'], ['#00b37e', '#1e3cff'], ['#c42fd8', '#ffd23f'], ['#0fd1ff', '#ff2e7e']];
export function svgFor(key, label = '') {
  const [a, b] = PAL[h(key) % PAL.length];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="400" height="400" fill="url(#g)"/><circle cx="${100 + (h(key) % 200)}" cy="${120 + (h(key + 'y') % 160)}" r="90" fill="#fff" opacity=".22"/>${label ? `<text x="200" y="230" text-anchor="middle" font-family="Helvetica,Arial" font-weight="800" font-size="64" fill="#fff" opacity=".92">${label}</text>` : ''}</svg>`;
}
export async function hermetic(page, { dead = [] } = {}) {
  page.__img = [];
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.isInterceptResolutionHandled?.()) return;
    const u = new URL(req.url());
    const local = (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && !u.pathname.startsWith('/api/');
    if (local || u.protocol === 'data:') return req.continue();
    page.__img.push(req.url());
    if (u.protocol === 'http:' && u.hostname !== '127.0.0.1') return req.respond({ status: 503, body: 'blocked: plain http (absolute entity_picture)' });
    if (dead.some((d) => u.hostname.includes(d))) return req.respond({ status: 404, body: 'gone' });
    if (u.pathname.startsWith('/api/media_player_proxy/'))
      return req.respond({ status: 200, contentType: 'image/svg+xml', body: svgFor(u.searchParams.get('cache') ?? 'np', '♪') });
    const label = /logo|radio|icon|png$/i.test(u.href) && !/mzstatic/.test(u.hostname) ? u.hostname.split('.').slice(-2, -1)[0].slice(0, 6).toUpperCase() : '';
    return req.respond({ status: 200, contentType: 'image/svg+xml', body: svgFor(u.href, label) });
  });
}
