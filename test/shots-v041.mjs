// v0.4.1 screenshots: the screensaver's lyrics status line (none / unavailable / loading).
// Usage: (serve the project root on :8765) node test/shots-v041.mjs   Output: test/shots/v041/*.png (git-ignored).
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { hermetic } from './intercept.mjs';

const ROOT = process.env.JB_ROOT ?? 'http://127.0.0.1:8765/dev/';
const OUT = new URL('./shots/v041/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VPS = [{ width: 1280, height: 800 }, { width: 1920, height: 1080 }, { width: 390, height: 844, isMobile: true, hasTouch: true }];
const STATES = [['none', '&lyrics=none'], ['unavailable', '&lyrfail=err'], ['loading', '&lyrlat=60000']];
const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--font-render-hinting=none'] });
const errors = [], files = [];
for (const vp of VPS) {
  const pg = await browser.newPage();
  await hermetic(pg);
  pg.on('pageerror', (e) => errors.push(e.message));
  await pg.setViewport({ deviceScaleFactor: 1, ...vp });
  for (const [name, q] of STATES) {
    await pg.goto(`${ROOT}index.html?fresh=1&latency=40&tab=now&saver=0.02${q}`);
    await pg.waitForFunction('window.__ready === true');
    await pg.waitForFunction(() => !!__card.shadowRoot.querySelector('.saver .sv-lys'), { timeout: 10000 });
    await sleep(1400); // let the 900 ms fade-in finish
    const f = `${OUT}saver-lyrics-${name}-${vp.width}x${vp.height}.png`;
    await pg.screenshot({ path: f }); files.push(f);
  }
  await pg.close();
}
await browser.close();
console.log(files.join('\n'));
if (errors.length) { console.error('page errors:', errors); process.exit(1); }
