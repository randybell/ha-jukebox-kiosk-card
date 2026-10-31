// End-to-end checks for the jukebox-card Search tab against the mock hass (dev/index.html).
// Real pointer/mouse/touch input via Chrome DevTools Protocol (puppeteer-core + system Chrome).
// Usage: (serve the project root on :8765)  node test/run.mjs
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { hermetic } from './intercept.mjs';

const BASE = process.env.JB_URL ?? 'http://127.0.0.1:8765/dev/index.html';
const SHOTS = new URL('./shots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let failures = 0;
function check(name, ok, info = '') {
  results.push({ name, ok, info });
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`);
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--font-render-hinting=none'],
});

// Focus monitor injected before any page script: records every element that gains focus (deep, through shadow roots)
const FOCUS_MONITOR = () => {
  window.__focusLog = [];
  window.__focusViolations = [];
  const deepActive = () => { let a = document.activeElement; while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement; return a; };
  const isEditable = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  const sample = (why) => {
    const a = deepActive();
    const tag = a ? a.tagName : 'null';
    if (window.__focusLog[window.__focusLog.length - 1] !== tag) window.__focusLog.push(tag);
    if (isEditable(a)) window.__focusViolations.push({ why, tag, t: performance.now() });
  };
  document.addEventListener('focusin', () => sample('focusin'), true);
  setInterval(() => sample('poll'), 25);
  window.__deepActiveTag = () => { const a = deepActive(); return a ? a.tagName : 'null'; };
};

async function open(page, query = '', vp = { width: 1280, height: 800 }) {
  await page.setViewport({ deviceScaleFactor: 1, ...vp });
  await page.goto(`${BASE}?fresh=1${query.includes('tab=') ? '' : '&tab=search'}${query}`);
  await page.waitForFunction('window.__ready === true');
  await sleep(150);
}
const H = {
  sv: `__card.shadowRoot.querySelector('jb-search')`,
};
// rect of an element found by a JS expression returning an element
async function rectOf(page, expr) {
  return page.evaluate((expr) => {
    const el = eval(expr);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  }, expr);
}
// first *visible* key with that id (digits exist twice: the wide num row and inline in narrow 123 mode)
const keyExpr = (id) => `[...${H.sv}.shadowRoot.querySelector('jb-keyboard').shadowRoot.querySelectorAll('[data-key="${id}"]')].find((k) => k.getBoundingClientRect().width > 0)`;
async function tapKey(page, id, holdMs = 30) {
  const r = await rectOf(page, keyExpr(id));
  if (!r || !r.w) throw new Error('key not visible: ' + id);
  await page.mouse.move(r.x, r.y);
  await page.mouse.down();
  await sleep(holdMs);
  await page.mouse.up();
}
const keyIdFor = (c) => (c === ' ' ? 'k-space' : `k-${c}`);
const state = (page) => page.evaluate((sv) => {
  const s = eval(sv);
  const res = s.shadowRoot.querySelector('.res');
  return {
    query: s.shadowRoot.querySelector('.q').dataset.query,
    shown: res.dataset.shownQuery,
    status: s.shadowRoot.querySelector('.qmeta').textContent.trim(),
    loading: s.shadowRoot.querySelector('.qmeta').dataset.loading === '1',
    rows: s.shadowRoot.querySelectorAll('.row, .ac, .al').length,
    menu: !!s.shadowRoot.querySelector('.menu'),
    sheet: !!s.shadowRoot.querySelector('.menu.sheet'),
    menuItems: [...s.shadowRoot.querySelectorAll('.menu .mi')].map((b) => b.dataset.action),
    stats: { ...s.engine.stats, slowMode: s.engine.slowMode },
    renders: window.__renders.map((r) => ({ q: r.query, seq: r.seq, cached: r.cached })),
    searchCalls: window.__calls.filter((c) => c.service === 'search').map((c) => ({ name: c.data.name, limit: c.data.limit, rr: c.returnResponse, ce: c.data.config_entry_id, mt: c.data.media_type })),
    playCalls: window.__calls.filter((c) => c.service === 'play_media').map((c) => ({ data: c.data, target: c.target })),
    focusViolations: window.__focusViolations.length,
    focusLog: window.__focusLog.slice(),
    editableCount: (function count(root) { let n = root.querySelectorAll('input,textarea,select,[contenteditable]').length; root.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) n += count(e.shadowRoot); }); return n; })(document),
    recents: JSON.parse(localStorage.getItem('jukebox-card:recents:v1') || '[]'),
  };
}, H.sv);
const waitShown = (page, q, timeout = 4000) => page.waitForFunction((sv, q) => eval(sv).shadowRoot.querySelector('.res').dataset.shownQuery === q, { timeout }, H.sv, q);

const page = await browser.newPage();
await hermetic(page);
await page.evaluateOnNewDocument(FOCUS_MONITOR);
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

// ---------- 1. results update after every keystroke (on-screen keys) ----------
await open(page, '&latency=120');
const perKey = [];
let typed = '';
for (const c of 'MOCK') {
  await tapKey(page, keyIdFor(c));
  typed += c;
  const immediate = await state(page);
  await waitShown(page, typed);
  const s = await state(page);
  perKey.push({ typed, queryShownInBar: immediate.query, resultsFor: s.shown, items: s.rows, status: s.status });
}
let s = await state(page);
check('1a every keystroke fires a search (4 keys → 4 calls)', s.searchCalls.length === 4 && s.searchCalls.map((c) => c.name).join(',') === 'M,MO,MOC,MOCK', s.searchCalls.map((c) => c.name).join(','));
check('1b results re-render after every keystroke', perKey.every((p) => p.resultsFor === p.typed && p.items > 0), perKey.map((p) => `${p.typed}:${p.items}`).join(' '));
check('1c 1-character query uses limit 5, longer uses 8', s.searchCalls[0].limit === 5 && s.searchCalls.slice(1).every((c) => c.limit === 8), s.searchCalls.map((c) => c.limit).join(','));
check('1d search call shape: return_response + config_entry_id + media_type list', s.searchCalls.every((c) => c.rr && c.ce === '01MUSICASSISTANT0000000000' && Array.isArray(c.mt)), JSON.stringify(s.searchCalls[0]));
await tapKey(page, 'k-bksp');
await waitShown(page, 'MOC');
s = await state(page);
check('1e backspace re-renders from cache instantly (no new call)', s.searchCalls.length === 4 && s.renders.at(-1).cached === true && s.query === 'MOC', `calls=${s.searchCalls.length} last=${JSON.stringify(s.renders.at(-1))}`);
await tapKey(page, 'k-bksp', 900); // hold → clear
await sleep(100);
s = await state(page);
check('1f holding backspace clears the query', s.query === '' && s.shown === '', `query="${s.query}"`);
await tapKey(page, 'k-toggle-n'); await sleep(50);
await tapKey(page, 'k-1'); await tapKey(page, 'k-toggle-n'); await tapKey(page, 'k-A');
await sleep(80);
s = await state(page);
check('1g 123 toggle types digits then returns to letters', s.query === '1A', `query="${s.query}"`);
await tapKey(page, 'k-clear'); await sleep(50);

// ---------- 2. stale-drop: older (slower) replies never overwrite newer ones ----------
await open(page, '&latency=150&mode=inverse'); // M 750ms, MO 600, MOC 450, MOCK 300
for (const c of 'MOCK') { await tapKey(page, keyIdFor(c)); await sleep(40); }
const sawLoading = (await state(page)).loading;
await sleep(1200);
s = await state(page);
const seqs = s.renders.map((r) => r.seq);
check('2a out-of-order replies: final results are for the latest query', s.shown === 'MOCK', `renders=${s.renders.map((r) => r.q).join('→')}`);
check('2b rendered seq is strictly increasing (stale replies dropped)', seqs.every((v, i) => i === 0 || v > seqs[i - 1]) && s.stats.staleDropped >= 1, `seq=${seqs} staleDropped=${s.stats.staleDropped}`);
check('2c loading hairline shown while in flight, results kept (no blank flash)', sawLoading === true, `loading=${sawLoading}`);

// ---------- 3. adaptive in-flight limiting above 800 ms ----------
await open(page, '&latency=1000');
await tapKey(page, 'k-M');
await waitShown(page, 'M', 3000);
const before = (await state(page)).searchCalls.length;
for (const c of 'ADNE') { await tapKey(page, keyIdFor(c)); await sleep(70); }
await waitShown(page, 'MADNE', 5000);
s = await state(page);
const phase = s.searchCalls.slice(before).map((c) => c.name);
check('3a slow MA (>800ms): one in flight + latest pending only', phase.join(',') === 'MA,MADNE' && s.stats.coalesced >= 1, `calls after slow reply: ${phase.join(',')} coalesced=${s.stats.coalesced}`);
check('3b final results follow the last keystroke', s.shown === 'MADNE' && s.rows > 0, `shown=${s.shown} rows=${s.rows}`);

// ---------- 4. long-press menu + play_media payloads (mouse, 1280x800) ----------
await open(page, '&latency=60');
for (const c of 'MOCK') await tapKey(page, keyIdFor(c));
await waitShown(page, 'MOCK');
await sleep(150);
const firstRow = `${H.sv}.shadowRoot.querySelector('.grp.tracks .row')`;
const trackUri = await page.evaluate((e) => eval(e).dataset.uri, firstRow);
async function longPress(expr, ms = 650) {
  const r = await rectOf(page, expr);
  await page.mouse.move(r.x - r.w / 4, r.y); await page.mouse.down(); await sleep(ms);
  const st = await state(page);
  await page.mouse.up();
  await sleep(60);
  return st;
}
const lp = await longPress(firstRow);
s = await state(page);
check('4a long-press (500ms) opens the menu while still held', lp.menu && s.menu, `items=${s.menuItems.join(',')}`);
check('4b menu has Play next / Add / Replace / Radio', ['next', 'add', 'replace', 'radio'].every((a) => s.menuItems.includes(a)) && !s.sheet);
await page.screenshot({ path: SHOTS + 'menu-1280x800.png' });
check('4c long-press alone does not play', s.playCalls.length === 0, `play calls=${s.playCalls.length}`);
async function clickMenu(action) {
  const r = await rectOf(page, `${H.sv}.shadowRoot.querySelector('.menu .mi[data-action="${action}"]')`);
  await page.mouse.click(r.x, r.y); await sleep(120);
}
await clickMenu('next');
for (const a of ['add', 'replace', 'radio']) { await longPress(firstRow); await clickMenu(a); }
// short tap → play now
let r = await rectOf(page, firstRow);
await page.mouse.click(r.x - r.w / 4, r.y, { delay: 40 }); await sleep(120);
// tap on an artist tile
const artistTile = `${H.sv}.shadowRoot.querySelector('.grp.artists .ac')`;
const artistUri = await page.evaluate((e) => eval(e).dataset.uri, artistTile);
r = await rectOf(page, artistTile);
await page.mouse.click(r.x, r.y, { delay: 40 }); await sleep(120);
// ⋮ button opens the same menu
r = await rectOf(page, `${firstRow}.querySelector('.mo')`);
await page.mouse.click(r.x, r.y); await sleep(80);
const viaMore = (await state(page)).menu;
await page.keyboard.press('Escape'); await sleep(60);
s = await state(page);
const T = { entity_id: 'media_player.everywhere' };
const expect = [
  { media_id: trackUri, media_type: 'track', enqueue: 'next' },
  { media_id: trackUri, media_type: 'track', enqueue: 'add' },
  { media_id: trackUri, media_type: 'track', enqueue: 'replace' },
  { media_id: trackUri, media_type: 'track', enqueue: 'play', radio_mode: true },
  { media_id: trackUri, media_type: 'track', enqueue: 'play' },
  { media_id: artistUri, media_type: 'artist', enqueue: 'play' },
];
const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
check('4d play_media payloads (next, add, replace, radio, tap, artist tap)', s.playCalls.length === 6 && s.playCalls.every((c, i) => same(c.data, expect[i]) && same(c.target, T)),
  '\n      ' + s.playCalls.map((c) => `music_assistant.play_media ${JSON.stringify(c.data)} target=${JSON.stringify(c.target)}`).join('\n      '));
check('4e ⋮ button opens the menu; Escape closes it', viaMore && !s.menu);
check('4f recents saved to localStorage after playing', s.recents[0] === 'MOCK', JSON.stringify(s.recents));
writeFileSync(SHOTS + 'play-media-log.json', JSON.stringify(s.playCalls, null, 2));

// ---------- 5. hardware keyboard ----------
await page.keyboard.press('Escape'); await sleep(50);
await page.keyboard.type('eag', { delay: 60 });
await waitShown(page, 'EAG');
s = await state(page);
check('5a hardware letters append (uppercased) and search', s.query === 'EAG' && s.searchCalls.at(-1).name === 'EAG');
await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
await page.keyboard.press('Enter'); await sleep(150);
s = await state(page);
check('5b Ctrl shortcuts ignored; Enter plays the top track', s.query === 'EAG' && s.playCalls.at(-1)?.data.media_type === 'track' && s.playCalls.at(-1)?.data.enqueue === 'play', JSON.stringify(s.playCalls.at(-1)?.data));
await page.keyboard.press('Backspace'); await sleep(40);
check('5c hardware Backspace', (await state(page)).query === 'EA');
await page.keyboard.press('Escape'); await sleep(40);
check('5d hardware Escape clears', (await state(page)).query === '');

// ---------- 6. focus: never an input/textarea ----------
s = await state(page);
check('6a no input/textarea/contenteditable anywhere in the card', s.editableCount === 0, `editable=${s.editableCount}`);
check('6b document.activeElement was never an input/textarea (sampled every 25ms + focusin)', s.focusViolations === 0, `focus history: ${s.focusLog.join(' → ')}`);

// ---------- 7. phone (touch): long-press → bottom sheet ----------
await open(page, '&latency=60&recents=1', { width: 390, height: 844, hasTouch: true, isMobile: true });
for (const c of 'MOCK') {
  const kr = await rectOf(page, keyExpr(keyIdFor(c)));
  await page.touchscreen.tap(kr.x, kr.y); await sleep(30);
}
await waitShown(page, 'MOCK');
await sleep(150);
await page.screenshot({ path: SHOTS + 'search-390x844.png' });
r = await rectOf(page, `${H.sv}.shadowRoot.querySelector('.grp.artists .ac')`);
await page.touchscreen.touchStart(r.x, r.y); await sleep(650);
s = await state(page);
await page.touchscreen.touchEnd(); await sleep(80);
check('7a touch long-press on phone opens a bottom sheet (with Play now)', s.sheet && s.menuItems.includes('play') && s.playCalls.length === 0, `items=${s.menuItems.join(',')}`);
await page.screenshot({ path: SHOTS + 'sheet-390x844.png' });
s = await state(page);
check('7b touch input never focused an editable element', s.focusViolations === 0 && s.editableCount === 0);

// ---------- 8. screenshots ----------
for (const [w, h] of [[1280, 800], [820, 1180]]) {
  await open(page, '&latency=60&recents=1', { width: w, height: h });
  for (const c of 'MOCK') await tapKey(page, keyIdFor(c));
  await waitShown(page, 'MOCK'); await sleep(250);
  await page.screenshot({ path: SHOTS + `search-${w}x${h}.png` });
}
await open(page, '&latency=60&recents=1', { width: 820, height: 1180 });
await page.screenshot({ path: SHOTS + 'empty-820x1180.png' });
r = await rectOf(page, `__card.shadowRoot.querySelector('[data-tab="now"]')`);
await page.mouse.click(r.x, r.y); await sleep(300);
await page.screenshot({ path: SHOTS + 'now-820x1180.png' });

// =================== Milestone 2: Now Playing / Queue / Browse / Screensaver ===================
const NP = `__card.shadowRoot.querySelector('jb-now').shadowRoot`;
const QV = `__card.shadowRoot.querySelector('jb-queue').shadowRoot`;
const BV = `__card.shadowRoot.querySelector('jb-browse').shadowRoot`;
const calls = (page, since = 0) => page.evaluate((n) => window.__calls.slice(n).map((c) => ({ d: c.domain, s: c.service, data: c.data, target: c.target, rr: c.returnResponse })), since);
const ncalls = (page) => page.evaluate(() => window.__calls.length);
const passive = new Set(['search', 'get_library', 'get_queue', 'get_queue_items']);
const actions = (cs) => cs.filter((c) => !passive.has(c.s));
async function clickEl(page, expr) { const r = await rectOf(page, expr); if (!r || !r.w) throw new Error('not visible: ' + expr); await page.mouse.click(r.x, r.y); await sleep(120); }
const EV = 'media_player.everywhere';
const tgt = (c) => [c.target?.entity_id].flat().join(',');

// ---------- 9. transport payloads ----------
await open(page, '&latency=20&tab=now');
let n0 = await ncalls(page);
await clickEl(page, `${NP}.querySelector('.tb.pp')`);           // playing → pause
await sleep(250);
await clickEl(page, `${NP}.querySelector('.tb.pp')`);           // (optimistic paused) → play
await clickEl(page, `${NP}.querySelector('.tb.pr')`);
await clickEl(page, `${NP}.querySelector('.tb.nx')`);
await clickEl(page, `${NP}.querySelector('.tb.sh')`);
for (let i = 0; i < 3; i++) { await clickEl(page, `${NP}.querySelector('.tb.rp')`); await sleep(150); }
let cs = actions(await calls(page, n0));
const tp = cs.map((c) => `${c.s}${c.data.shuffle !== undefined ? ':' + c.data.shuffle : ''}${c.data.repeat ? ':' + c.data.repeat : ''}`);
check('9a transport: pause, play, prev, next, shuffle_set, repeat_set off→all→one→off', tp.join(',') === 'media_pause,media_play,media_previous_track,media_next_track,shuffle_set:true,repeat_set:all,repeat_set:one,repeat_set:off', tp.join(','));
check('9b every transport call targets media_player.everywhere only', cs.every((c) => tgt(c) === EV), [...new Set(cs.map(tgt))].join(' | '));
s = await page.evaluate((np) => { const r = eval(np); return { sh: r.querySelector('.tb.sh').classList.contains('on'), dot: !!r.querySelector('.tb.sh .dot'), rp: r.querySelector('.tb.rp').classList.contains('on') }; }, NP);
check('9c shuffle on shows white + dot; repeat off is inactive', s.sh && s.dot && !s.rp, JSON.stringify(s));
// seek: click at 50% of the seek bar
n0 = await ncalls(page);
r = await rectOf(page, `${NP}.querySelector('.ps')`);
await page.mouse.click(r.x - r.w / 2 + r.w * 0.5, r.y); await sleep(200);
cs = actions(await calls(page, n0));
const dur = await page.evaluate(() => __hass.states['media_player.everywhere'].attributes.media_duration);
check('9d seek bar → media_seek at ~50% of duration', cs.length === 1 && cs[0].s === 'media_seek' && Math.abs(cs[0].data.seek_position - dur / 2) <= dur * 0.03 && tgt(cs[0]) === EV, JSON.stringify(cs.map((c) => c.data)));
// favorite: the mock's current song (So What) starts as a favorite → first tap unfavorites (mass_queue), second tap favorites (button.press)
n0 = await ncalls(page);
await clickEl(page, `${NP}.querySelector('.tb.fv')`); await sleep(400);
await clickEl(page, `${NP}.querySelector('.tb.fv')`); await sleep(200);
cs = actions(await calls(page, n0));
check('9e heart: unfavorite → mass_queue.unfavorite_current_item; favorite → button.press on button.everywhere_favorite_current_song', cs.length === 2 && cs[0].s === 'unfavorite_current_item' && cs[0].data.entity === EV && cs[1].d === 'button' && cs[1].s === 'press' && tgt(cs[1]) === 'button.everywhere_favorite_current_song', cs.map((c) => `${c.d}.${c.s}→${tgt(c) || c.data.entity}`).join(' | '));

// ---------- 10. volume: room slider + mute ----------
n0 = await ncalls(page);
const row = (id) => `${NP}.querySelector('.vr[data-entity="${id}"]')`;
r = await rectOf(page, `${row('media_player.kitchen')}.querySelector('.vs')`);
const x0 = r.x - r.w / 2;
await page.mouse.move(x0 + r.w * 0.62, r.y); await page.mouse.down();
const steps = 30; const t0 = Date.now();
for (let i = 1; i <= steps; i++) { await page.mouse.move(x0 + r.w * (0.62 - 0.42 * i / steps), r.y); await sleep(25); }
const dragMs = Date.now() - t0;
const labelMid = await page.evaluate((e) => eval(e).querySelector('.vv').dataset.v, row('media_player.kitchen'));
await page.mouse.up(); await sleep(400);
cs = actions(await calls(page, n0));
const vols = cs.filter((c) => c.s === 'volume_set');
check('10a room slider calls volume_set on media_player.kitchen only', vols.length > 0 && vols.every((c) => tgt(c) === 'media_player.kitchen') && cs.every((c) => c.s === 'volume_set'), [...new Set(cs.map((c) => `${c.s}→${tgt(c)}`))].join(' | '));
check('10b throttled while dragging (≤ 1 call / 200 ms + final)', vols.length >= 2 && vols.length <= Math.ceil(dragMs / 200) + 2, `${vols.length} calls over ${dragMs} ms`);
const lastV = vols.at(-1)?.data.volume_level;
check('10c final value sent on release (~0.20)', Math.abs(lastV - 0.20) < 0.03, `last=${lastV}`);
const st10 = await page.evaluate(() => ({ k: __hass.states['media_player.kitchen'].attributes.volume_level, lr: __hass.states['media_player.living_room'].attributes.volume_level, g: __hass.states['media_player.garage'].attributes.volume_level, ev: __hass.states['media_player.everywhere'].attributes.volume_level }));
check('10d other rooms + Everywhere untouched; optimistic label followed the drag', st10.lr === 0.45 && st10.g === 0.30 && st10.ev === 0.55 && Number(labelMid) < 62, `${JSON.stringify(st10)} label-mid=${labelMid}`);
n0 = await ncalls(page);
await clickEl(page, `${row('media_player.garage')}.querySelector('.vm')`);
cs = actions(await calls(page, n0));
s = await page.evaluate((e) => eval(e).className, row('media_player.garage'));
check('10e tapping room icon → volume_mute(true) on media_player.garage only, row shows muted', cs.length === 1 && cs[0].s === 'volume_mute' && cs[0].data.is_volume_muted === true && tgt(cs[0]) === 'media_player.garage' && / muted /.test(s + ' '), `${JSON.stringify(cs)} class=${s}`);
n0 = await ncalls(page);
r = await rectOf(page, `${row(EV)}.querySelector('.vs')`);
await page.mouse.click(r.x - r.w / 2 + r.w * 0.8, r.y); await sleep(300);
cs = actions(await calls(page, n0));
check('10f Everywhere slider → volume_set on everywhere', cs.length >= 1 && cs.every((c) => c.s === 'volume_set' && tgt(c) === EV) && Math.abs(cs.at(-1).data.volume_level - 0.8) < 0.03, JSON.stringify(cs.map((c) => [tgt(c), c.data.volume_level])));
check('10g no join/unjoin calls ever', !(await calls(page)).some((c) => /join/.test(c.s)));

// ---------- 11. queue ----------
await open(page, '&latency=20&tab=queue');
await page.waitForFunction((q) => eval(q).querySelectorAll('.qr.next').length > 3, {}, QV);
s = await page.evaluate((q) => { const r = eval(q); return { now: r.querySelector('.qr.now b')?.textContent, next: [...r.querySelectorAll('.qr.next')].map((e) => e.dataset.id), nextT: r.querySelector('.qr.next b')?.textContent }; }, QV);
cs = await calls(page);
const gq = cs.find((c) => c.s === 'get_queue_items');
check('11a get_queue_items {entity: everywhere} with return_response; now playing highlighted', gq && gq.d === 'mass_queue' && gq.rr && gq.data.entity === EV && s.now === 'So What' && s.nextT === 'Teardrop', `${JSON.stringify(gq?.data)} now=${s.now} next=${s.nextT}`);
const [id1, id2, id3] = s.next;
const qcall = async (fn) => { const n = await ncalls(page); await fn(); await sleep(250); return actions(await calls(page, n)); };
const qrow = (id) => `${QV}.querySelector('.qr[data-id="${id}"]')`;
let a1 = await qcall(() => clickEl(page, `${qrow(id2)}.querySelector('.qa[data-action="up"]')`));
let a2 = await qcall(() => clickEl(page, `${qrow(id2)}.querySelector('.qa[data-action="down"]')`));
async function qmenu(id, action) { await clickEl(page, `${qrow(id)}.querySelector('.qa.mo')`); await sleep(100); await clickEl(page, `${QV}.querySelector('.menu .mi[data-action="${action}"]')`); }
let a3 = await qcall(() => qmenu(id3, 'next'));
let a4 = await qcall(() => qmenu(id3, 'remove'));
const qs = (a) => a.map((c) => `${c.d}.${c.s}`).join(',');
const ok11 = (a, svc, id) => a.length === 1 && a[0].d === 'mass_queue' && a[0].s === svc && a[0].data.entity === EV && a[0].data.queue_item_id === id && Object.keys(a[0].data).length === 2;
check('11b up / down / next / remove send {entity, queue_item_id}', ok11(a1, 'move_queue_item_up', id2) && ok11(a2, 'move_queue_item_down', id2) && ok11(a3, 'move_queue_item_next', id3) && ok11(a4, 'remove_queue_item', id3), [qs(a1), qs(a2), qs(a3), qs(a4)].join(' | '));
s = await page.evaluate((q) => [...eval(q).querySelectorAll('.qr.next')].map((e) => e.dataset.id), QV);
check('11c queue list reflects the moves (removed item gone)', !s.includes(id3) && s.length === 12, `${s.length} rows`);
let a5 = await qcall(() => clickEl(page, `${qrow(id1)}.querySelector('.rt')`));
check('11d tap a row → play_queue_item {entity, queue_item_id}', ok11(a5, 'play_queue_item', id1), qs(a5));
await sleep(900);
s = await page.evaluate((q) => eval(q).querySelector('.qr.now')?.dataset.id, QV);
check('11e after play, tapped item becomes now playing', s === id1, s);

// ---------- 12. browse ----------
await open(page, '&latency=20&tab=browse');
await page.waitForFunction((b) => eval(b).querySelectorAll('.tile').length > 0, {}, BV);
s = await page.evaluate((b) => ({ cats: [...eval(b).querySelectorAll('.cats [data-cat]')].map((e) => e.dataset.cat), badges: [...new Set([...eval(b).querySelectorAll('.tile .pv')].map((e) => e.textContent.trim()))] }), BV);
cs = await calls(page);
const gl = cs.filter((c) => c.s === 'get_library');
check('12a get_library calls: return_response + config_entry_id + media_type', gl.length > 0 && gl.every((c) => c.rr && c.data.config_entry_id === '01MUSICASSISTANT0000000000' && c.data.media_type && c.data.limit <= 500), JSON.stringify(gl[0]?.data));
check('12b empty Radio/Podcasts/Audiobooks hidden (default mock = no radio provider)', !s.cats.includes('radio') && !s.cats.includes('podcast') && !s.cats.includes('audiobook') && s.cats.includes('playlist'), s.cats.join(','));
check('12c provider badge from the URI scheme (library://)', s.badges.join(',') === 'Library', s.badges.join(','));
const tile0 = `${BV}.querySelector('.tile')`;
const t0uri = await page.evaluate((e) => eval(e).dataset.uri, tile0);
let b1 = await qcall(async () => { const r = await rectOf(page, `${tile0} .ta, ${tile0}`); await page.mouse.click(r.x - r.w / 4, r.y - r.h / 4); });
check('12d tap a tile → play_media {media_id, media_type, enqueue: play} on everywhere', b1.length === 1 && b1[0].s === 'play_media' && tgt(b1[0]) === EV && b1[0].data.media_id === t0uri && b1[0].data.media_type === 'playlist' && b1[0].data.enqueue === 'play', JSON.stringify(b1));
r = await rectOf(page, tile0);
await page.mouse.move(r.x - r.w / 4, r.y - r.h / 4); await page.mouse.down(); await sleep(650); await page.mouse.up(); await sleep(100);
s = await page.evaluate((b) => [...eval(b).querySelectorAll('.menu .mi')].map((e) => e.dataset.action), BV);
let b2 = await qcall(() => clickEl(page, `${BV}.querySelector('.menu .mi[data-action="next"]')`));
check('12e long-press → menu (Open/next/add/replace/radio); Play next → enqueue next', ['open', 'next', 'add', 'replace', 'radio'].every((a) => s.includes(a)) && b2.length === 1 && b2[0].data.enqueue === 'next' && tgt(b2[0]) === EV, `${s.join(',')} ${JSON.stringify(b2[0]?.data)}`);
await clickEl(page, `${BV}.querySelector('[data-cat="album"]')`); await sleep(300);
n0 = await ncalls(page);
await page.evaluate((b) => [...eval(b).querySelectorAll('.tile')].find((t) => t.querySelector('b').textContent === 'Kind of Blue').querySelector('.open').click(), BV);
await page.waitForFunction((b) => eval(b).querySelectorAll('.detail .row, .dt .row').length > 0 || eval(b).querySelectorAll('.row').length > 0, { timeout: 4000 }, BV);
await sleep(200);
cs = await calls(page, n0);
const at = cs.find((c) => c.s === 'get_album_tracks');
s = await page.evaluate((b) => [...eval(b).querySelectorAll('.row b')].map((e) => e.textContent), BV);
check('12f album drill-down → mass_queue.get_album_tracks {config_entry_id, uri} and lists tracks', at && at.d === 'mass_queue' && at.rr && at.data.config_entry_id === '01MASSQUEUE0000000000000000' && /^library:\/\/album\//.test(at.data.uri) && s.includes('So What') && s.length === 4, `${JSON.stringify(at?.data)} tracks=${s.join(',')}`);
let b3 = await qcall(() => clickEl(page, `${BV}.querySelector('[data-action="radio"]')`));
check('12g detail Radio → play_media enqueue play + radio_mode true (boolean)', b3.length === 1 && b3[0].data.radio_mode === true && b3[0].data.media_type === 'album' && tgt(b3[0]) === EV, JSON.stringify(b3[0]?.data));
let b4 = await qcall(() => clickEl(page, `${BV}.querySelector('.row')`));
check('12h tap a track in the detail → play_media track', b4.length === 1 && b4[0].data.media_type === 'track' && tgt(b4[0]) === EV, JSON.stringify(b4[0]?.data));

// ---------- 13. real sample + radio hidden in Search ----------
await open(page, '&latency=20&real=1');
for (const c of 'EAGLES') await tapKey(page, keyIdFor(c));
await waitShown(page, 'EAGLES'); await sleep(200);
s = await page.evaluate((sv) => { const r = eval(sv).shadowRoot; return { badges: [...new Set([...r.querySelectorAll('.pv')].map((e) => e.textContent.trim()))], chips: [...r.querySelectorAll('[data-type], .fc')].map((e) => (e.dataset.type || e.textContent).trim().toLowerCase()), groups: [...r.querySelectorAll('.grp')].map((g) => g.className) }; }, H.sv);
check('13a real=1 "eagles" export parses; Library + Apple Music badges from URI scheme', s.badges.includes('Library') && s.badges.includes('Apple Music'), s.badges.join(','));
check('13b empty Radio / Audiobooks / Podcasts hidden in Search', !s.chips.some((c) => /radio|podcast|audiobook/.test(c)) && !s.groups.some((g) => /radio|podcast|audiobook/.test(g)), `${s.chips.join(',')} | ${s.groups.join(',')}`);

// ---------- 14. screensaver ----------
await open(page, '&latency=20&tab=now&saver=0.02');
await page.waitForFunction(() => !!__card.shadowRoot.querySelector('.saver'), { timeout: 5000 }).catch(() => {});
s = await page.evaluate(() => ({ on: !!__card.shadowRoot.querySelector('.saver'), clock: __card.shadowRoot.querySelector('.saver .sv-clock, .saver .sv-drift')?.textContent.trim().slice(0, 12) }));
n0 = await ncalls(page);
await page.mouse.click(640, 420); await sleep(600);
const after = await page.evaluate(() => ({ on: !!__card.shadowRoot.querySelector('.saver') }));
cs = actions(await calls(page, n0));
check('14a screensaver appears after idle minutes (full-screen art + clock)', s.on && /\d:\d\d/.test(s.clock || ''), JSON.stringify(s));
check('14b tap wakes it and the tap is swallowed (no service calls)', !after.on && cs.length === 0, `${JSON.stringify(after)} calls=${cs.map((c) => c.s)}`);

// ---------- 15. backdrop modes + large-screen scale ----------
const bdState = () => page.evaluate(() => {
  const r = __card.shadowRoot, np = r.querySelector('main.np'), cv = r.querySelector('canvas.bdl');
  const before = getComputedStyle(np, '::before');
  const panel = r.querySelector('jb-now').shadowRoot.querySelector('.panel');
  return { mode: __card.dataset.backdrop, why: __card.dataset.backdropWhy, beforeFilter: before.filter, beforeBg: before.backgroundImage.slice(0, 40), beforeDisplay: before.display,
    npBg: getComputedStyle(np).backgroundColor, panelBF: getComputedStyle(panel).backdropFilter, panelBg: getComputedStyle(panel).backgroundColor,
    canvas: cv ? { ready: cv.classList.contains('ready'), draws: Number(cv.dataset.draws || 0) } : null };
});
await open(page, '&tab=now&backdrop=full'); s = await bdState();
check('15a backdrop=full: live blur on the backdrop and backdrop-filter on panels', s.mode === 'full' && /blur\(38px\)/.test(s.beforeFilter) && /blur/.test(s.panelBF) && /url/.test(s.beforeBg), JSON.stringify(s));
await open(page, '&tab=now&backdrop=light'); await sleep(500); s = await bdState();
check('15b backdrop=light: pre-blurred canvas drawn, no CSS filter, panels solid rgba(0,0,0,.6) without backdrop-filter', s.mode === 'light' && s.canvas?.ready && s.beforeFilter === 'none' && s.panelBF === 'none' && s.panelBg === 'rgba(0, 0, 0, 0.6)' && !/url/.test(s.beforeBg), JSON.stringify(s));
{ // volume drag must not redraw the canvas (only a track change does)
  const d0 = s.canvas.draws;
  r = await rectOf(page, `__card.shadowRoot.querySelector('jb-now').shadowRoot.querySelector('jb-slider')`);
  await page.mouse.move(r.x - r.w / 4, r.y); await page.mouse.down();
  for (let i = 0; i < 10; i++) { await page.mouse.move(r.x - r.w / 4 + i * 12, r.y); await sleep(16); }
  await page.mouse.up(); await sleep(300);
  const d1 = (await bdState()).canvas.draws;
  await page.evaluate(() => __card.hass.callService('media_player', 'media_next_track', {}, { entity_id: 'media_player.everywhere' }));
  await sleep(900);
  const d2 = (await bdState()).canvas.draws;
  check('15c light canvas redraws on track change only (not on slider drag)', d1 === d0 && d2 > d1, `draws ${d0} → drag ${d1} → next ${d2}`);
}
await open(page, '&tab=now&backdrop=static'); s = await bdState();
check('15d backdrop=static: dark gradient, no art, no filters', s.mode === 'static' && !s.canvas && s.beforeFilter === 'none' && !/url/.test(s.beforeBg) && /gradient/.test(s.beforeBg) && s.panelBF === 'none', JSON.stringify(s));
await open(page, '&tab=now&backdrop=off'); s = await bdState();
check('15e backdrop=off: pure black', s.mode === 'off' && s.beforeDisplay === 'none' && s.npBg === 'rgb(0, 0, 0)' && s.panelBF === 'none', JSON.stringify(s));
await open(page, '&tab=now'); s = await bdState();
const cores = await page.evaluate(() => [navigator.hardwareConcurrency, navigator.deviceMemory]);
check('15f backdrop=auto (default) resolves from hardwareConcurrency/deviceMemory', s.mode === ((cores[0] <= 4 || cores[1] <= 2) ? 'light' : 'full'), `${s.mode} (${s.why}) cores/mem=${cores}`);
await page.evaluateOnNewDocument(() => { Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => 4 }); });
await open(page, '&tab=now'); s = await bdState();
check('15g auto on a 4-core device → light', s.mode === 'light' && /hardwareConcurrency=4/.test(s.why), `${s.mode} (${s.why})`);
await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
await open(page, '&tab=now&saver=0.02');
await page.waitForFunction(() => !!__card.shadowRoot.querySelector('.saver .sv-drift'), { timeout: 5000 }).catch(() => {});
s = await page.evaluate(() => { const r = __card.shadowRoot; const d = r.querySelector('.sv-drift'), bg = r.querySelector('.sv-bg'); return { mode: __card.dataset.backdrop, why: __card.dataset.backdropWhy, drift: d && getComputedStyle(d).animationName, timing: d && getComputedStyle(d).animationTimingFunction, kb: bg ? getComputedStyle(bg).animationName : 'n/a' }; });
check('15h prefers-reduced-motion: auto → light; screensaver drift + Ken Burns off (discrete hop every 60s only)', s.mode === 'light' && s.why === 'prefers-reduced-motion' && s.drift === 'hop' && /steps|step-end/.test(s.timing) && (s.kb === 'none' || s.kb === 'n/a'), JSON.stringify(s));
await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
s = await page.evaluate(() => { try { document.createElement('jukebox-card').setConfig({ type: 'custom:jukebox-card', config_entry_id: 'x', backdrop: 'blurry' }); return 'no error'; } catch (e) { return e.message; } });
check('15i invalid backdrop value is rejected by setConfig', /backdrop must be one of/.test(s), s);
// 1920x1080: zoomed up, fits the screen exactly, popover menus still anchor to their button
await open(page, '&tab=search', { width: 1920, height: 1080 });
for (const c of 'EAGLES') await tapKey(page, keyIdFor(c));
await sleep(700);
s = await page.evaluate(() => { const a = __card.shadowRoot.querySelector('ha-card').getBoundingClientRect(); return { scale: __card.dataset.scale, h: a.height, w: a.width, bottom: a.bottom }; });
check('15j 1920x1080 → scale 1.35, card exactly fills the viewport', s.scale === '1.35' && Math.abs(s.h - 1080) < 2 && Math.abs(s.w - 1920) < 2, JSON.stringify(s));
r = await rectOf(page, `${firstRow}.querySelector('.mo')`);
await page.mouse.click(r.x, r.y); await sleep(150);
const mr = await rectOf(page, `${H.sv}.shadowRoot.querySelector('.menu')`);
check('15k 1920x1080 ⋮ menu opens next to its button (zoom-corrected position)', mr && Math.min(Math.abs((mr.y - mr.h / 2) - (r.y + r.h / 2)), Math.abs((mr.y + mr.h / 2) - (r.y - r.h / 2))) < 40 && Math.abs((mr.x + mr.w / 2) - r.x) < 80, `btn ${JSON.stringify(r)} menu ${JSON.stringify(mr)}`);
await page.keyboard.press('Escape');

// =================== 0.3.1: live API shapes (mass_queue tracks + paging, player art, radio) ===================
{
  const pg = await browser.newPage();
  await hermetic(pg, { dead: ['rockantenne'] });
  pg.on('pageerror', (e) => pageErrors.push('[16] ' + e.message));
  const BR = `__card.shadowRoot.querySelector('jb-browse')`;
  const pcalls = (since = 0) => calls(pg, since);
  const pq = async (fn) => { const n = await ncalls(pg); await fn(); await sleep(300); return actions(await pcalls(n)); };
  const rows = () => pg.evaluate((b) => [...eval(b).shadowRoot.querySelectorAll('.detail .row')].map((r) => ({ name: r.querySelector('b')?.textContent, du: r.querySelector('.du')?.textContent?.trim() ?? '', img: r.querySelector('img')?.getAttribute('src') ?? '' })), BR);
  const detail = (it, type) => pg.evaluate((b, it, type) => eval(b).openDetail(it, type), BR, it, type);
  const meta = () => pg.evaluate((b) => eval(b).shadowRoot.querySelector('.detail .meta')?.textContent?.trim() ?? '', BR);
  const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const fx = JSON.parse(readFileSync(new URL('../dev/fixtures/mass-queue-tracks-sample.json', import.meta.url)));
  const realAlbum = fx.get_album_tracks.raw.result.response.tracks;

  // 16a-c: real get_album_tracks / get_playlist_tracks shapes
  await open(pg, '&latency=20&tab=browse');
  let n = await ncalls(pg);
  await detail({ media_type: 'album', uri: 'library://album/1448', name: 'Hotel California', artists: [{ name: 'Eagles' }] }, 'album'); await sleep(300);
  let rs = await rows(); let cs = (await pcalls(n)).filter((c) => c.d === 'mass_queue');
  check('16a real get_album_tracks parses: 9 rows, names, durations m:ss per row', rs.length === realAlbum.length && rs.every((r, i) => r.name === realAlbum[i].media_title && r.du === fmt(realAlbum[i].duration)), JSON.stringify(rs.slice(0, 2)));
  const tot = Math.round(realAlbum.reduce((a, t) => a + t.duration, 0) / 60);
  check('16b album header shows track count + total time; rows use the https media_image', (await meta()) === `9 tracks · ${tot} min` && (await pg.evaluate((b) => eval(b)._detail.tracks.every((t) => /^https:\/\//.test(t.image)), BR)), await meta());
  check('16c get_album_tracks {config_entry_id: mass_queue_entry_id, uri}, return_response, no page', cs.length === 1 && cs[0].s === 'get_album_tracks' && cs[0].rr && cs[0].data.config_entry_id === '01MASSQUEUE0000000000000000' && cs[0].data.uri === 'library://album/1448' && !('page' in cs[0].data), JSON.stringify(cs[0]?.data));
  n = await ncalls(pg);
  await detail({ media_type: 'playlist', uri: 'library://playlist/158', name: 'Eagles' }, 'playlist'); await sleep(300);
  rs = await rows(); cs = (await pcalls(n)).filter((c) => c.d === 'mass_queue');
  check('16d real get_playlist_tracks (position: null) parses; page 0 sent; short list → no further page calls', rs.length === 2 && rs[0].name === 'Those Shoes' && rs[0].du === '4:54' && cs.length === 1 && cs[0].data.page === 0, `${JSON.stringify(rs)} ${JSON.stringify(cs.map((c) => c.data))}`);

  // 16e-g: playlist paging (Long Drive = 120 unique tracks) in the three server behaviours
  const longDrive = async (q) => {
    await open(pg, `&latency=20&tab=browse${q}`);
    await clickEl(pg, `${BR}.shadowRoot.querySelector('[data-cat="playlist"]')`); await sleep(300);
    const nn = await ncalls(pg);
    await pg.evaluate((b) => [...eval(b).shadowRoot.querySelectorAll('.tile')].find((t) => t.querySelector('b').textContent === 'Long Drive').querySelector('.open').click(), BR);
    await sleep(500);
    for (let i = 0; i < 8; i++) { await pg.evaluate((b) => { const s = eval(b).shadowRoot.querySelector('.scroll'); s.scrollTop = s.scrollHeight; s.dispatchEvent(new Event('scroll')); }, BR); await sleep(250); }
    const r = await rows();
    const pages = (await pcalls(nn)).filter((c) => c.s === 'get_playlist_tracks').map((c) => c.data.page);
    const more = await pg.evaluate((b) => !!eval(b).shadowRoot.querySelector('.more-t'), BR);
    return { n: r.length, uniq: new Set(r.map((x) => x.name)).size, pages, more, last: r.at(-1)?.name, meta: await meta() };
  };
  let ld = await longDrive('&mqpage=paged');
  check('16e paged server (50/page): scrolling loads pages 0,1,2 → all 120 tracks, then stops', ld.n === 120 && ld.uniq === 120 && ld.pages.join() === '0,1,2' && !ld.more && ld.last === 'Highway Song 120', JSON.stringify(ld));
  ld = await longDrive('&mqpage=all');
  check('16f mass_queue 0.10 (page 0 = everything, page 1 = MA page): 120 tracks once, repeat run detected, ≤2 calls', ld.n === 120 && ld.uniq === 120 && ld.pages.length <= 2 && ld.pages[0] === 0 && !ld.more, JSON.stringify(ld));
  ld = await longDrive('&mqpage=ignore');
  check('16g server ignoring page: no duplicate tracks appended, paging stops', ld.n === 120 && ld.uniq === 120 && ld.pages.length === 2 && !ld.more, JSON.stringify(ld));
  check('16h header for a 120-track playlist shows hours/minutes', /^120 tracks · (\d+ h )?\d+ min$/.test(ld.meta), ld.meta);

  // 16i: legacy queue_config_entry_id + editor rename
  await open(pg, '&latency=20&tab=browse&legacyq=1');
  n = await ncalls(pg);
  await detail({ media_type: 'album', uri: 'library://album/1448', name: 'Hotel California' }, 'album'); await sleep(300);
  cs = (await pcalls(n)).filter((c) => c.s === 'get_album_tracks');
  check('16i legacy queue_config_entry_id still drives mass_queue calls', cs.length === 1 && cs[0].data.config_entry_id === '01MASSQUEUE0000000000000000', JSON.stringify(cs[0]?.data));
  // 16j: get_queue_items limit_after clamped to 1..1000
  const gq = (await pcalls()).filter((c) => c.s === 'get_queue_items');
  const lim = await pg.evaluate(async () => { const q = __card.queue; q.limitAfter = 5000; await q.refresh(); q.limitAfter = 0.2; await q.refresh(); return window.__calls.filter((c) => c.service === 'get_queue_items').slice(-2).map((c) => c.data.limit_after); });
  check('16j get_queue_items {entity, limit_before:1, limit_after 1..1000}', gq.length > 0 && gq.every((c) => c.data.entity === EV && c.data.limit_before === 1 && c.data.limit_after >= 1 && c.data.limit_after <= 1000) && lim.join() === '1000,1', `${JSON.stringify(gq[0]?.data)} clamp=${lim}`);

  // 16k-o: player art never uses the absolute entity_picture
  const artState = () => pg.evaluate(() => {
    const r = __card.shadowRoot; const np = r.querySelector('jb-now').shadowRoot;
    const sv = r.querySelector('.saver');
    return { now: np.querySelector('.art img, img')?.getAttribute('src') ?? '', full: r.querySelector('main.np')?.getAttribute('style') ?? '',
      light: __card._lightKey ?? '', draws: r.querySelector('canvas.bdl')?.dataset.draws ?? '',
      svbg: sv?.querySelector('.sv-bg')?.getAttribute('style') ?? '', svimg: sv?.querySelector('.sv-np img')?.getAttribute('src') ?? '',
      abs: __hass.states['media_player.everywhere'].attributes.entity_picture };
  });
  pg.__img.length = 0;
  await open(pg, '&latency=20&tab=now&backdrop=full'); await sleep(400);
  let a = await artState();
  check('16k Now Playing art = relative entity_picture_local (/api/media_player_proxy/), not the absolute entity_picture', a.now.startsWith('/api/media_player_proxy/media_player.everywhere?') && /^http:\/\/192\.168\./.test(a.abs), JSON.stringify(a));
  check('16l full backdrop --_art uses the proxy path', /--_art:url\("\/api\/media_player_proxy\//.test(a.full), a.full);
  await open(pg, '&latency=20&tab=now&backdrop=light'); await sleep(600);
  a = await artState();
  check('16m light backdrop canvas drawn from the proxy path', a.light.startsWith('/api/media_player_proxy/') && Number(a.draws) >= 1, JSON.stringify({ light: a.light, draws: a.draws }));
  await open(pg, '&latency=20&tab=now&backdrop=full&saver=0.02');
  await pg.waitForFunction(() => !!__card.shadowRoot.querySelector('.saver .sv-np img'), { timeout: 5000 }).catch(() => {});
  a = await artState();
  check('16n screensaver background + thumbnail use the proxy path', /url\("\/api\/media_player_proxy\//.test(a.svbg) && a.svimg.startsWith('/api/media_player_proxy/'), JSON.stringify({ svbg: a.svbg.slice(0, 80), svimg: a.svimg }));
  await open(pg, '&latency=20&tab=now&backdrop=full&noart=1'); await sleep(700);
  a = await artState();
  const cur = await pg.evaluate(() => __card.queue.currentItem?.media_image ?? '');
  check('16o no entity_picture_local → current queue item image (https/data), never the absolute URL', a.now && a.now === cur && !/^http:/.test(a.now) && a.full.includes(cur.slice(0, 40)), `${a.now.slice(0, 50)} vs ${cur.slice(0, 50)}`);
  check('16p no request ever goes to the absolute LAN entity_picture host', !pg.__img.some((u) => u.includes('192.168.')), pg.__img.filter((u) => u.includes('192.168.')).join(','));

  // 16q-w: radio
  await open(pg, '&latency=20&tab=browse&radio=1');
  await pg.waitForFunction((b) => !!eval(b).shadowRoot.querySelector('[data-cat="radio"]'), { timeout: 4000 }, BR).catch(() => {});
  n = await ncalls(pg);
  await clickEl(pg, `${BR}.shadowRoot.querySelector('[data-cat="radio"]')`); await sleep(700);
  cs = await pcalls(n);
  let g = await pg.evaluate((b) => { const r = eval(b).shadowRoot; return { src: r.querySelector('.grid')?.dataset.src, note: !!r.querySelector('.note.src'), sort: r.querySelector('[data-action="sort"], .sort')?.textContent?.trim() ?? '',
    tiles: [...r.querySelectorAll('.tile')].map((t) => ({ name: t.querySelector('b').textContent, pv: t.querySelector('.pv')?.textContent.trim(), img: t.querySelector('img')?.getAttribute('src') ?? '', uri: t.dataset.uri })) }; }, BR);
  const libCalls = cs.filter((c) => c.s === 'get_library' && c.data.media_type === 'radio'), srch = cs.filter((c) => c.s === 'search');
  check('16q Browse > Radio shown when only search has stations (probe falls back to search)', g.tiles.length >= 10, `tiles=${g.tiles.length}`);
  check('16r empty library radio (Popular, then A–Z) → music_assistant.search media_type [radio] fallback', libCalls.length >= 1 && libCalls[0].data.order_by === 'play_count_desc' && srch.some((c) => [c.data.media_type].flat().join() === 'radio' && c.rr) && g.src === 'search' && g.note, `${libCalls.map((c) => c.data.order_by)} ${JSON.stringify(srch[0]?.data)} src=${g.src}`);
  check('16s station names trimmed (leading tabs/spaces), badged "Radio"', g.tiles.every((t) => t.name === t.name.trim() && !/\t/.test(t.name) && t.pv === 'Radio') && g.tiles.some((t) => t.name === 'Arrow Classic Rock') && g.tiles.some((t) => t.name === 'ROCKANTENNE Alternative (mp3)'), g.tiles.map((t) => JSON.stringify(t.name)).join(','));
  const hr = g.tiles.find((t) => t.name === 'Hard Rock Radio FM');
  await sleep(500);
  const deadImg = await pg.evaluate((b) => [...eval(b).shadowRoot.querySelectorAll('.tile')].find((t) => t.querySelector('b').textContent.startsWith('ROCKANTENNE'))?.querySelector('img')?.src.slice(0, 26), BR);
  check('16t null station image → radio-tower fallback; dead logo (404) swaps to it too', hr && hr.img.startsWith('data:image/svg+xml') && deadImg === 'data:image/svg+xml;charset', `${hr?.img.slice(0, 30)} dead=${deadImg}`);
  const st = g.tiles.find((t) => t.name === 'Arrow Classic Rock');
  const stEl = `[...${BR}.shadowRoot.querySelectorAll('.tile')].find((x) => x.dataset.uri === '${st?.uri}')`;
  let pr = await pq(async () => { const r = await rectOf(pg, stEl); await pg.mouse.click(r.x - r.w / 4, r.y - r.h / 4); });
  check('16u tap a station → play_media {radiobrowser://radio/<uuid>, media_type radio} on everywhere, no radio_mode', pr.length === 1 && pr[0].s === 'play_media' && tgt(pr[0]) === EV && /^radiobrowser:\/\/radio\/[0-9a-f-]{36}$/.test(pr[0].data.media_id) && pr[0].data.media_type === 'radio' && !('radio_mode' in pr[0].data), JSON.stringify(pr));
  await pg.evaluate(() => { __card.shadowRoot.querySelector('[data-tab="now"]').click(); }); await sleep(500);
  a = await artState();
  check('16v Now Playing shows the station (title trimmed) with its art', /Arrow Classic Rock/.test(await pg.evaluate(() => __card.shadowRoot.querySelector('jb-now').shadowRoot.textContent)) && !!a.now, a.now.slice(0, 40));
  await pg.evaluate(() => { __card.shadowRoot.querySelector('[data-tab="browse"]').click(); }); await sleep(300);
  let r0 = await rectOf(pg, `${BR}.shadowRoot.querySelector('.tile')`);
  await pg.mouse.move(r0.x - r0.w / 4, r0.y - r0.h / 4); await pg.mouse.down(); await sleep(650); await pg.mouse.up(); await sleep(150);
  let mi = await pg.evaluate((b) => [...eval(b).shadowRoot.querySelectorAll('.menu .mi')].map((e) => e.dataset.action), BR);
  check('16w station menu: next/add/replace, no "Start radio"', !mi.includes('radio') && ['next', 'add', 'replace'].every((x) => mi.includes(x)), mi.join(','));
  await pg.keyboard.press('Escape');
  await open(pg, '&latency=20&tab=browse&radio=lib');
  await pg.waitForFunction((b) => !!eval(b).shadowRoot.querySelector('[data-cat="radio"]'), { timeout: 4000 }, BR).catch(() => {});
  n = await ncalls(pg);
  await clickEl(pg, `${BR}.shadowRoot.querySelector('[data-cat="radio"]')`); await sleep(600);
  cs = (await pcalls(n)).filter((c) => c.s === 'get_library');
  g = await pg.evaluate((b) => ({ src: eval(b).shadowRoot.querySelector('.grid')?.dataset.src, first: eval(b).shadowRoot.querySelector('.tile b')?.textContent }), BR);
  check('16x stations in the library: get_library radio, Popular (play_count_desc) first, no search fallback', g.src === 'library' && cs[0]?.data.order_by === 'play_count_desc' && g.first === 'Radio Paradise - Main Mix', `${JSON.stringify(g)} ${cs.map((c) => c.data.order_by)}`);
  await clickEl(pg, `${BR}.shadowRoot.querySelector('[data-cat="album"]')`); await sleep(300);
  cs = (await pcalls(n)).filter((c) => c.s === 'get_library' && c.data.media_type === 'album');
  check('16y non-radio categories never get the radio-only sort', cs.length > 0 && cs.every((c) => c.data.order_by !== 'play_count_desc'), cs.map((c) => c.data.order_by).join());

  // Search: radio group
  await open(pg, '&latency=20&radio=1');
  for (const c of 'ROCK') await tapKey(pg, keyIdFor(c));
  await waitShown(pg, 'ROCK'); await sleep(300);
  g = await pg.evaluate((sv) => { const r = eval(sv).shadowRoot; const grp = [...r.querySelectorAll('.grp')].find((x) => /radio/.test(x.className)); return { names: grp ? [...grp.querySelectorAll('b')].map((b) => b.textContent) : [], pv: grp ? [...new Set([...grp.querySelectorAll('.pv')].map((p) => p.textContent.trim()))] : [] }; }, H.sv);
  check('16z Search radio results trimmed + badged Radio', g.names.length > 0 && g.names.every((x) => x === x.trim() && !/\t/.test(x)) && g.pv.join() === 'Radio', JSON.stringify(g));

  // Phone: durations stay visible in rows
  await open(pg, '&latency=20&tab=browse', { width: 390, height: 844, isMobile: true, hasTouch: true });
  await detail({ media_type: 'album', uri: 'library://album/1448', name: 'Hotel California' }, 'album'); await sleep(400);
  const ph = await pg.evaluate((b) => { const r = eval(b).shadowRoot.querySelector('.detail .row'); const du = r.querySelector('.du'), pv = r.querySelector('.pv'); return { du: du && getComputedStyle(du).display !== 'none' && du.getBoundingClientRect().width > 0 ? du.textContent.trim() : '', pv: pv ? getComputedStyle(pv).display : 'none', over: r.scrollWidth - r.clientWidth }; }, BR);
  check('16za 390px phone: track rows keep the duration (provider badge hidden instead), no overflow', ph.du === '6:31' && ph.pv === 'none' && ph.over <= 1, JSON.stringify(ph));

  // public-repo hygiene: fixtures are scrubbed
  const fxText = ['ma-search-sample.json', 'ma-search-sample-radio.json', 'ma-library-radio-sample.json', 'mass-queue-tracks-sample.json'].map((f) => readFileSync(new URL(`../dev/fixtures/${f}`, import.meta.url), 'utf8')).join('\n');
  check('16zb fixtures: provider instance ids scrubbed to --XXXXXXXX, no user_id / real context ids', /apple_music--XXXXXXXX/.test(fxText) && !/apple_music--(?!XXXXXXXX)[A-Za-z0-9]+/.test(fxText) && !/"user_id": "[0-9a-f]{32}"/.test(fxText) && (fxText.match(/\b01[0-9A-HJKMNP-TV-Z]{24}\b/g) || []).every((id) => /^01(MOCK|MASSQUEUE)/.test(id)));
  await pg.close();
}

check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
await browser.close();
writeFileSync(SHOTS + 'results.json', JSON.stringify({ at: new Date().toString(), perKey, results }, null, 2));
console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures ? 1 : 0);
