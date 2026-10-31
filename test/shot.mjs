// quick screenshot helper: node test/shot.mjs W H out.png [query]
import puppeteer from 'puppeteer-core';
const [W, H, out, q = '', extra = ''] = process.argv.slice(2);
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'] });
const p = await b.newPage();
await p.setViewport({ width: +W, height: +H, deviceScaleFactor: 1 });
p.on('console', (m) => m.type() === 'error' && console.log('console:', m.text()));
p.on('pageerror', (e) => console.log('pageerror:', e.message));
await p.goto(`http://127.0.0.1:8765/dev/index.html?latency=60&recents=1${extra}`);
await p.waitForFunction('window.__ready');
await p.evaluate(async (q) => { for (const c of q) { window.dispatchEvent(new KeyboardEvent('keydown', { key: c })); await new Promise(r => setTimeout(r, 90)); } }, q);
await new Promise((r) => setTimeout(r, 600));
await p.screenshot({ path: out });
await b.close();
