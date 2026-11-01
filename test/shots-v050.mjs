// v0.5.0 screenshots (speakers + queue row icons). Usage: (serve the project root) JB_ROOT=http://127.0.0.1:8765/dev/ node test/shots-v050.mjs
// Output: test/shots/v050/*.png (git-ignored). Every player / queue id in the mock is a placeholder.
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { hermetic } from './intercept.mjs';

const ROOT = process.env.JB_ROOT ?? 'http://127.0.0.1:8765/dev/';
const OUT = new URL('./shots/v050/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const VPS = [{ width: 390, height: 844, isMobile: true, hasTouch: true }, { width: 1280, height: 800 }, { width: 1920, height: 1080 }];
const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--font-render-hinting=none'] });
const errors = [], files = [];
const IN = 'media_player.indoor';
const SPK = `__card.shadowRoot.querySelector('jb-speakers')`, SR = `${SPK}.shadowRoot`;
const QV = `__card.shadowRoot.querySelector('jb-queue').shadowRoot`;
const ev = (pg, e) => pg.evaluate((e) => eval(e), e);
const wait = (pg, fn, timeout = 6000) => pg.waitForFunction(fn, { timeout, polling: 50 }).then(() => true, () => false);
async function tap(pg, expr) {
  const r = await pg.evaluate((e) => { const el = eval(e); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }, expr);
  if (!r) throw new Error('nothing to tap: ' + expr);
  await pg.mouse.click(r.x, r.y); await sleep(80);
}
async function open(pg, q, vp) {
  await pg.setViewport({ deviceScaleFactor: 1, ...vp });
  await pg.goto(`${ROOT}index.html?fresh=1&latency=30${q.includes('tab=') ? '' : '&tab=now'}${q}`);
  await pg.waitForFunction('window.__ready === true');
  await sleep(300);
}
async function panel(pg) {
  await tap(pg, `__card.shadowRoot.querySelector('.pill')`);
  await wait(pg, `${SPK}.open && !!${SR}.querySelector('section.sheet')`);
  await wait(pg, `${SPK}.store?.loaded && !!${SR}.querySelector('[data-room] .where')`);
  await sleep(500);
}
async function shot(pg, name, vp) { const f = `${OUT}${name}-${vp.width}x${vp.height}.png`; await pg.screenshot({ path: f }); files.push(f); }
const cfg = (o) => `&cfg=${encodeURIComponent(J(o))}`;

for (const vp of VPS) {
  const pg = await browser.newPage();
  await hermetic(pg);
  await pg.evaluateOnNewDocument(() => { window.__jbUndoMs = 60000; window.__jbQueueUndoMs = 60000; });
  pg.on('pageerror', (e) => errors.push(e.message));
  // fixed (default): header status + mixer-only panel
  await open(pg, '&admin=1', vp); await shot(pg, 'now-header-status', vp);
  await panel(pg); await shot(pg, 'speakers-fixed', vp);
  // dynamic: Play-on chips, presets, per-room now-playing
  await open(pg, '&spk=dyn&admin=1', vp); await panel(pg); await shot(pg, 'speakers-dynamic', vp);
  await open(pg, `&spk=dyn&admin=1&target=${IN}`, vp); await panel(pg); await shot(pg, 'speakers-per-room-now-playing', vp);
  // move flow: tap Indoor → the warning, then confirmed
  await open(pg, '&spk=dyn&admin=1', vp); await panel(pg);
  await tap(pg, `${SR}.querySelector('[data-target="${IN}"]')`); await wait(pg, `!!${SR}.querySelector('.sp-ask')`); await sleep(300);
  await shot(pg, 'move-warning', vp);
  await tap(pg, `${SR}.querySelector('.sp-ask [data-action="confirm"]')`);
  await wait(pg, `/Moved to/.test(${SR}.querySelector('.toast')?.textContent ?? '')`); await sleep(200);
  await shot(pg, 'move-done', vp);
  // presets
  await open(pg, `&spk=dyn&admin=1&target=${IN}`, vp); await panel(pg);
  await tap(pg, `${SR}.querySelector('[data-preset="Dinner"]')`); await sleep(1200);
  await shot(pg, 'preset-applied', vp);
  // guest (volume only) + quiet hours cap
  await open(pg, `&spk=dyn&target=${IN}`, vp); await panel(pg); await shot(pg, 'guest-view', vp);
  await open(pg, `&spk=dyn&target=${IN}${cfg({ quiet_hours: { start: '00:00', end: '00:00', max_volume: 30 } })}`, vp); await panel(pg); await shot(pg, 'guest-quiet-hours', vp);
  // large buttons
  await open(pg, `&spk=dyn&admin=1${cfg({ large_buttons: true })}`, vp); await shot(pg, 'large-buttons-now', vp);
  await panel(pg); await shot(pg, 'large-buttons-speakers', vp);
  // queue rows: icons, Play now confirm, Remove + Undo bar, narrow ⋯ action sheet
  await open(pg, '&admin=1&tab=queue', vp); await wait(pg, `${QV}.querySelectorAll('.qr.next').length > 3`); await sleep(400);
  await shot(pg, 'queue-row-icons', vp);
  const ids = await ev(pg, `[...${QV}.querySelectorAll('.qr.next')].map((r) => r.dataset.id)`);
  if (vp.width > 520) await tap(pg, `${QV}.querySelector('.qr[data-id="${ids[2]}"] .qa[data-action="playnow"]')`);
  else { await tap(pg, `${QV}.querySelector('.qr[data-id="${ids[2]}"] .qa.mo')`); await sleep(300); await shot(pg, 'queue-action-sheet', vp); await tap(pg, `${QV}.querySelector('.menu .mi[data-action="play"]')`); }
  await wait(pg, `!!${QV}.querySelector('.confirm')`); await sleep(300);
  await shot(pg, 'queue-play-now-confirm', vp);
  await tap(pg, `${QV}.querySelector('.confirm .cbtn[data-action="cancel"]')`); await sleep(300);
  await tap(pg, `${QV}.querySelector('.qr[data-id="${ids[3]}"] .qa[data-action="remove"]')`);
  await wait(pg, `!!${QV}.querySelector('.undo')`); await sleep(500);
  await shot(pg, 'queue-removed-undo', vp);
  await tap(pg, `${QV}.querySelector('.undo .ub')`);
  await wait(pg, `/is back/.test(${QV}.querySelector('.toast')?.textContent ?? '')`); await sleep(400);
  await shot(pg, 'queue-undo-done', vp);
  // guest queue: 0.4 rows (no jump / remove icons)
  await open(pg, '&tab=queue', vp); await wait(pg, `${QV}.querySelectorAll('.qr.next').length > 3`); await sleep(400);
  await shot(pg, 'queue-guest', vp);
  await pg.close();
}
// 0.4.2 fit height: a 1024x666 window below the HA toolbar (data-fit=short); the tab bar stays visible with the panel open
{
  const vp = { width: 1024, height: 666 }, ha = '&ha=toolbar&sidebar=narrow';
  const pg = await browser.newPage();
  await hermetic(pg);
  await pg.evaluateOnNewDocument(() => { window.__jbUndoMs = 60000; window.__jbQueueUndoMs = 60000; });
  pg.on('pageerror', (e) => errors.push(e.message));
  await open(pg, `${ha}&admin=1`, vp); await panel(pg); await shot(pg, 'speakers-fixed-toolbar', vp);
  await open(pg, `${ha}&spk=dyn&admin=1`, vp); await panel(pg); await shot(pg, 'speakers-dynamic-toolbar', vp);
  await open(pg, `${ha}&spk=dyn&admin=1${cfg({ large_buttons: true })}`, vp); await panel(pg); await shot(pg, 'large-buttons-speakers-toolbar', vp);
  await open(pg, `${ha}&admin=1&tab=queue`, vp); await wait(pg, `${QV}.querySelectorAll('.qr.next').length > 3`); await sleep(400);
  const ids = await ev(pg, `[...${QV}.querySelectorAll('.qr.next')].map((r) => r.dataset.id)`);
  await tap(pg, `${QV}.querySelector('.qr[data-id="${ids[3]}"] .qa[data-action="remove"]')`);
  await wait(pg, `!!${QV}.querySelector('.undo')`); await sleep(500);
  await shot(pg, 'queue-removed-undo-toolbar', vp);
  await pg.close();
}
// 0.5.0 segmented tab bar (variant B): whole card + a crop of the bar; 1024x666 / 1024x600 below the HA toolbar, 1280x800, 390x844
{
  const pg = await browser.newPage();
  await hermetic(pg);
  pg.on('pageerror', (e) => errors.push(e.message));
  const bar = async (name, vp) => {
    const c = await ev(pg, `(() => { const r = __card.shadowRoot.querySelector('.tabs').getBoundingClientRect(); return { x: 0, y: Math.max(0, r.top - 12), width: innerWidth, height: Math.min(innerHeight, r.bottom) - Math.max(0, r.top - 12) }; })()`);
    const f = `${OUT}${name}-bar-${vp.width}x${vp.height}.png`; await pg.screenshot({ path: f, clip: c }); files.push(f);
  };
  const runs = [
    [{ width: 1024, height: 666 }, '&ha=toolbar&sidebar=narrow', 'tabs-b-toolbar'],
    [{ width: 1024, height: 666 }, `&ha=toolbar&sidebar=narrow${cfg({ large_buttons: true })}`, 'tabs-b-large-toolbar'],
    [{ width: 1024, height: 600 }, '&ha=toolbar&sidebar=narrow', 'tabs-b-tiny-toolbar'],
    [{ width: 1280, height: 800 }, '', 'tabs-b'],
    [{ width: 390, height: 844, isMobile: true, hasTouch: true }, '', 'tabs-b'],
  ];
  for (const [vp, q, name] of runs) {
    await open(pg, `${q}&tab=queue`, vp); await wait(pg, `${QV}.querySelectorAll('.qr.next').length > 3`); await sleep(400);
    await shot(pg, name, vp); await bar(name, vp);
  }
  // keyboard: Tab to the active tab stop, → moves to Lyrics with the focus ring
  const vp = { width: 1024, height: 666 };
  await open(pg, '&ha=toolbar&sidebar=narrow&tab=queue', vp);
  await ev(pg, `__card.shadowRoot.querySelector('.tab.active').focus({ focusVisible: true })`);
  await pg.keyboard.press('ArrowRight'); await sleep(300);
  await bar('tabs-b-keyboard-toolbar', vp);
  await pg.close();
}
await browser.close();
console.log(files.map((f) => f.replace(/^.*\/test\//, 'test/')).join('\n'));
console.log(`${files.length} shots, ${errors.length} page errors${errors.length ? ': ' + J(errors) : ''}`);
process.exit(errors.length ? 1 : 0);
