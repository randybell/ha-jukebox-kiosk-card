// Screenshots: every tab at 1920x1080, 1280x800, 820x1180, 390x844 (JB_SIZES=1920x1080,... to pick) → test/shots/m2/<tab>-<WxH>-<tag>.png
// Usage: node test/shots-m2.mjs [tag] [extra-query]
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { hermetic } from './intercept.mjs';
const [tag = 'r1', extra = ''] = process.argv.slice(2);
const OUT = new URL('./shots/m2/', import.meta.url).pathname; mkdirSync(OUT, { recursive: true });
const BASE = process.env.JB_URL ?? 'http://127.0.0.1:8765/dev/index.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'] });
const sizes = (process.env.JB_SIZES ?? '1920x1080,1280x800,820x1180,390x844').split(',').map((s) => s.split('x').map(Number));
const errs = [];
for (const [w, hgt] of sizes) {
  const p = await b.newPage();
  await hermetic(p);
  p.on('console', (m) => m.type() === 'error' && errs.push(`${w}: ${m.text()}`));
  p.on('pageerror', (e) => errs.push(`${w}: ${e.message}`));
  await p.setViewport({ width: w, height: hgt, deviceScaleFactor: 1, isMobile: w < 500, hasTouch: w < 500 });
  for (const tab of ['now', 'browse', 'search', 'queue']) {
    await p.goto(`${BASE}?latency=40&recents=1&tab=${tab}${extra}`); await p.waitForFunction('window.__ready'); await sleep(200);
    if (tab === 'search') await p.evaluate(async () => { for (const c of 'EAGLES') { window.dispatchEvent(new KeyboardEvent('keydown', { key: c })); await new Promise((r) => setTimeout(r, 70)); } });
    await sleep(900);
    await p.screenshot({ path: `${OUT}${tab}-${w}x${hgt}-${tag}.png` });
  }
  // browse detail (album) via Open button on first tile
  await p.goto(`${BASE}?latency=40&tab=browse&${extra}`); await p.waitForFunction('window.__ready'); await sleep(500);
  await p.evaluate(() => { const br = __card.shadowRoot.querySelector('jb-browse'); br.shadowRoot.querySelector('[data-cat="album"]').click(); });
  await sleep(500);
  await p.evaluate(() => { const br = __card.shadowRoot.querySelector('jb-browse'); const it = [...br.shadowRoot.querySelectorAll('.tile')].find((t) => t.querySelector('b').textContent === 'Kind of Blue'); it.querySelector('.open').click(); });
  await sleep(700);
  await p.screenshot({ path: `${OUT}browse-detail-${w}x${hgt}-${tag}.png` });
  // album detail with real mass_queue durations (Hotel California)
  await p.goto(`${BASE}?latency=40&tab=browse&${extra}`); await p.waitForFunction('window.__ready'); await sleep(500);
  await p.evaluate(() => __card.shadowRoot.querySelector('jb-browse').shadowRoot.querySelector('[data-cat="album"]').click());
  await sleep(500);
  await p.evaluate(() => { const br = __card.shadowRoot.querySelector('jb-browse'); [...br.shadowRoot.querySelectorAll('.tile')].find((t) => t.querySelector('b').textContent === 'Hotel California').querySelector('.open').click(); });
  await sleep(800);
  await p.screenshot({ path: `${OUT}browse-album-durations-${w}x${hgt}-${tag}.png` });
  // Browse > Radio (Radio Browser stations; library empty -> search fallback)
  await p.goto(`${BASE}?latency=40&tab=browse&radio=1${extra}`); await p.waitForFunction('window.__ready'); await sleep(600);
  await p.evaluate(() => __card.shadowRoot.querySelector('jb-browse').shadowRoot.querySelector('[data-cat="radio"]')?.click());
  await sleep(1000);
  await p.screenshot({ path: `${OUT}browse-radio-${w}x${hgt}-${tag}.png` });
  // screensaver
  await p.goto(`${BASE}?latency=40&tab=now&saver=0.02${extra}`); await p.waitForFunction('window.__ready'); await sleep(3000);
  await p.screenshot({ path: `${OUT}screensaver-${w}x${hgt}-${tag}.png` });
  await p.close();
}
console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') : 'no console errors');
await b.close();
