// v0.4.2 fit-to-panel checks: the card fills the space really left below it (HA toolbar, sidebar, kiosk, full screen,
// a regular masonry card), the header and tab bar are always fully visible and the page never scrolls.
// The HA frontend is emulated by dev/index.html?ha=toolbar|kiosk|masonry&sidebar=open|narrow|closed|none
// (fixed app toolbar of HA's --header-height: 56px, sidebar drawer 256/56 px, window-scrolling view).
// Usage: (serve the project root on :8765, or set JB_ROOT) node test/fit.e2e.mjs   Screenshots: test/shots/v042/ (git-ignored)
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { hermetic } from './intercept.mjs';

const ROOT = process.env.JB_ROOT ?? 'http://127.0.0.1:8765/dev/';
const OUT = new URL('./shots/v042/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let failures = 0;
function check(name, ok, info = '') { results.push({ name, ok, info }); if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info && !ok ? '  — ' + info : ''}`); }
const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--font-render-hinting=none'] });
const pageErrors = [];

const SIZES = [[1024, 666], [1280, 720], [1366, 768], [1440, 900], [1280, 800], [1920, 1080], [390, 844, 1], [844, 390, 1], [820, 1180, 1], [1180, 820, 1], [1024, 600, 1]];
const KEY = new Set(['1024x666', '1280x720', '1366x768', '1920x1080', '1024x600', '390x844', '844x390', '820x1180']);
const TABS = ['now', 'browse', 'search', 'queue', 'lyrics'];
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/** geometry of everything that must be fully visible, plus page-scroll state */
const geom = (pg) => pg.evaluate(() => {
  const sr = __card.shadowRoot, vw = innerWidth, vh = innerHeight;
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { t: b.top, b: b.bottom, l: b.left, r: b.right, h: b.height, w: b.width }; };
  const tb = document.getElementById('ha-toolbar');
  const tbB = tb && getComputedStyle(tb).display !== 'none' ? tb.getBoundingClientRect().bottom : 0;
  const tabs = [...sr.querySelectorAll('.tab')].map((t) => {
    const b = r(t); const hit = sr.elementFromPoint(b.l + b.w / 2, b.t + b.h / 2);
    return { ...b, id: t.dataset.tab, hit: hit?.closest?.('.tab') === t };
  });
  const before = scrollY; scrollTo(0, 1e5); const could = scrollY; scrollTo(0, before);
  const kb = sr.querySelector('jb-search')?.shadowRoot.querySelector('jb-keyboard');
  const nw = sr.querySelector('jb-now')?.shadowRoot.querySelector('.nw');
  const pp = sr.querySelector('jb-now')?.shadowRoot.querySelector('.tb.pp');
  return { vw, vh, tbB, nav: r(sr.querySelector('.tabs')), top: r(sr.querySelector('.top')), tabs, could, docH: document.documentElement.scrollHeight,
    kb: kb && kb.getBoundingClientRect().height ? r(kb) : null, nw: nw ? { sh: nw.scrollHeight, ch: nw.clientHeight } : null, pp: r(pp),
    fit: __card.dataset.fitH, size: __card.dataset.fit ?? '' };
});
const within = (b, g, top = 0) => b && b.t >= top - 0.5 && b.b <= g.vh + 0.5 && b.l >= -0.5 && b.r <= g.vw + 0.5 && b.h > 0;
function verify(label, g, { fill = true, tab } = {}) {
  const tabsOk = g.tabs.length === 5 && g.tabs.every((t) => within(t, g) && t.hit);
  check(`${label}: tab bar fully visible (bottom ${Math.round(g.nav.b)} ≤ ${g.vh}), every tab hit-testable`, within(g.nav, g) && tabsOk,
    JSON.stringify({ nav: g.nav, bad: g.tabs.filter((t) => !within(t, g) || !t.hit).map((t) => t.id) }));
  check(`${label}: header fully visible below the HA toolbar`, within(g.top, g, g.tbB), JSON.stringify({ top: g.top, tbB: g.tbB }));
  check(`${label}: no page scroll`, g.could === 0 && g.docH <= g.vh, `could=${g.could} docH=${g.docH} vh=${g.vh}`);
  if (fill) check(`${label}: card fills to the bottom (no gap)`, g.nav.b >= g.vh - 1.5, `nav.b=${g.nav.b} vh=${g.vh}`);
  if (tab === 'search') check(`${label}: on-screen keyboard open and fully visible above the tabs`, !!g.kb && within(g.kb, g, g.top.b) && g.kb.b <= g.nav.t + 0.5, JSON.stringify(g.kb));
  if (tab === 'now') check(`${label}: Now Playing transport reachable (visible, or the middle scrolls)`, (g.pp && g.pp.t >= g.top.b && g.pp.b <= g.nav.t) || (g.nw && g.nw.sh > g.nw.ch), JSON.stringify({ pp: g.pp, nw: g.nw }));
}
async function newPage(vp, ua) {
  const pg = await browser.newPage();
  await hermetic(pg);
  if (ua) await pg.setUserAgent(ua);
  pg.on('pageerror', (e) => pageErrors.push(e.message));
  await pg.setViewport({ deviceScaleFactor: 1, ...vp });
  return pg;
}
async function open(pg, q) {
  await pg.goto(`${ROOT}index.html?fresh=1&latency=40&tab=now&overlay=1${q}`);
  await pg.waitForFunction('window.__ready === true');
  await sleep(350);
}
async function tapTab(pg, id, touch) {
  const b = await pg.evaluate((id) => { const t = __card.shadowRoot.querySelector(`.tab[data-tab="${id}"]`).getBoundingClientRect(); return { x: t.left + t.width / 2, y: t.top + t.height / 2 }; }, id);
  if (touch) await pg.touchscreen.tap(b.x, b.y); else await pg.mouse.click(b.x, b.y);
  await sleep(id === 'lyrics' || id === 'search' ? 350 : 250);
  const sel = await pg.evaluate(() => __card.shadowRoot.querySelector('.tab.active')?.dataset.tab);
  if (sel !== id) throw new Error(`tab ${id} did not open (active=${sel})`);
}
// HA: sidebar is a modal drawer (hidden) below 870 px wide, the narrow icon rail otherwise
const sidebarFor = (w) => (w < 870 ? 'none' : 'narrow');

// ---------- 1. every size × {HA toolbar, kiosk (toolbar hidden), full screen / Fully Kiosk (no HA chrome)} × every tab ----------
for (const [w, h, touch] of SIZES) {
  const vp = { width: w, height: h, ...(touch ? { isMobile: true, hasTouch: true } : {}) };
  for (const [mode, q] of [['toolbar', `&ha=toolbar&sidebar=${sidebarFor(w)}`], ['kiosk', `&ha=kiosk&sidebar=${sidebarFor(w)}`], ['fullscreen', '']]) {
    if (mode === 'fullscreen' && !touch && w !== 1920) continue; // the plain harness is already covered by the other suites
    const pg = await newPage(vp);
    await open(pg, q);
    for (const tab of TABS) {
      await tapTab(pg, tab, touch);
      const g = await geom(pg);
      verify(`F1 ${w}x${h} ${mode} ${tab}`, g, { tab });
      if (mode === 'toolbar' && (tab === 'now' || (KEY.has(`${w}x${h}`) && (w === 1024 && h === 666 || tab === 'search'))))
        await pg.screenshot({ path: `${OUT}${tab}-${w}x${h}-toolbar.png` });
    }
    await pg.close();
  }
}

// ---------- 2. sidebar open / closed and a regular masonry card ----------
for (const [w, h] of [[1440, 900], [1280, 800], [1024, 666]]) {
  for (const sb of ['open', 'closed']) {
    const pg = await newPage({ width: w, height: h });
    await open(pg, `&ha=toolbar&sidebar=${sb}`);
    for (const tab of ['now', 'search']) { await tapTab(pg, tab); verify(`F2 ${w}x${h} toolbar sidebar=${sb} ${tab}`, await geom(pg), { tab }); }
    await pg.close();
  }
}
{
  const pg = await newPage({ width: 1280, height: 800 });
  await open(pg, '&ha=masonry&sidebar=narrow');
  for (const tab of ['now', 'queue']) {
    const g = await geom(pg);
    await tapTab(pg, tab); verify(`F2 1280x800 masonry card below another card ${tab}`, await geom(pg), { tab, fill: false });
    check(`F2 1280x800 masonry ${tab}: card fills down to the view's own bottom padding`, g.nav.b >= g.vh - 12 && g.nav.b <= g.vh, `nav.b=${g.nav.b}`);
  }
  await pg.screenshot({ path: `${OUT}masonry-1280x800.png` });
  await pg.close();
}

// ---------- 3. resize while open: window resize, toolbar hidden/shown, sidebar toggled, rotation ----------
{
  const pg = await newPage({ width: 1920, height: 1080 });
  await open(pg, '&ha=toolbar&sidebar=narrow');
  verify('F3 resize: start 1920x1080 toolbar', await geom(pg), { tab: 'now' });
  for (const [w, h] of [[1024, 666], [1366, 768], [1024, 600], [1440, 900]]) {
    await pg.setViewport({ width: w, height: h, deviceScaleFactor: 1 }); await sleep(300);
    verify(`F3 resize → ${w}x${h}`, await geom(pg), { tab: 'now' });
  }
  await pg.setViewport({ width: 1024, height: 666, deviceScaleFactor: 1 }); await sleep(300);
  await tapTab(pg, 'search');
  await pg.evaluate(() => __haToolbar(false)); await sleep(400);
  verify('F3 toolbar hidden while open (kiosk-mode toggled) 1024x666 search', await geom(pg), { tab: 'search' });
  await pg.evaluate(() => __haToolbar(true)); await sleep(400);
  verify('F3 toolbar shown again 1024x666 search', await geom(pg), { tab: 'search' });
  await pg.evaluate(() => __haSidebar('256px')); await sleep(400);
  verify('F3 sidebar opened while open 1024x666', await geom(pg), { tab: 'search' });
  await pg.close();
  const ph = await newPage({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await open(ph, '&ha=toolbar&sidebar=none');
  await tapTab(ph, 'queue', true);
  await ph.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 1 }); await sleep(400);
  verify('F3 rotate 390x844 → 844x390 (queue)', await geom(ph), { tab: 'queue' });
  await ph.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 }); await sleep(400);
  verify('F3 rotate back → 390x844 (queue)', await geom(ph), { tab: 'queue' });
  await ph.close();
}

// ---------- 4. emulated Mac Chrome: 1024x666 window, Retina (DPR 2), browser zoom 100 / 80 / 67 % ----------
// Browser zoom = a larger CSS viewport at a lower device pixel ratio (what Chrome does for Cmd −); the card must still fit.
for (const z of [1, 0.8, 0.67]) {
  const vp = { width: Math.round(1024 / z), height: Math.round(666 / z), deviceScaleFactor: 2 * z };
  const pg = await newPage(vp, MAC_UA);
  await open(pg, '&ha=toolbar&sidebar=narrow');
  for (const tab of TABS) { await tapTab(pg, tab); verify(`F4 Mac Chrome (emulated) 1024x666 @2x zoom ${Math.round(z * 100)}% ${tab}`, await geom(pg), { tab }); }
  await tapTab(pg, 'now');
  await pg.screenshot({ path: `${OUT}mac-zoom${Math.round(z * 100)}-1024x666-toolbar.png` });
  await pg.close();
}

// ---------- 5. compact layout on short panels; untouched at 1920x1080 ----------
{
  const sizes = {};
  for (const [w, h, q] of [[1024, 600, '&ha=toolbar&sidebar=narrow'], [1024, 666, '&ha=toolbar&sidebar=narrow'], [1920, 1080, ''], [1280, 800, '']]) {
    const pg = await newPage({ width: w, height: h });
    await open(pg, q);
    sizes[`${w}x${h}${q ? '-tb' : ''}`] = await pg.evaluate(() => ({ fit: __card.dataset.fit ?? '', fitH: Number(__card.dataset.fitH), tab: __card.shadowRoot.querySelector('.tab').getBoundingClientRect().height, z: __card.dataset.scale }));
    await pg.close();
  }
  check('F5 short panels compact (data-fit tiny < 560, short < 700), tall ones untouched', sizes['1024x600-tb'].fit === 'tiny' && sizes['1024x666-tb'].fit === 'short' && sizes['1920x1080'].fit === '' && sizes['1280x800'].fit === '', JSON.stringify(sizes));
  check('F5 1920x1080 full screen keeps the large-screen scale and full height', sizes['1920x1080'].fitH === 1080 && Number(sizes['1920x1080'].z) > 1, JSON.stringify(sizes['1920x1080']));
}

check('F9 no page errors', pageErrors.length === 0, pageErrors.join(' | '));
await browser.close();
writeFileSync(OUT + 'results.json', JSON.stringify({ at: new Date().toString(), results }, null, 2));
console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures ? 1 : 0);
