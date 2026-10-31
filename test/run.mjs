// End-to-end checks for the jukebox-card Search tab against the mock hass (dev/index.html).
// Real pointer/mouse/touch input via Chrome DevTools Protocol (puppeteer-core + system Chrome).
// Usage: (serve the project root on :8765)  node test/run.mjs
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { hermetic } from './intercept.mjs';

const BASE = process.env.JB_URL ?? 'http://127.0.0.1:8765/dev/index.html';
const SHOTS = new URL('./shots/', import.meta.url).pathname;
mkdirSync(SHOTS + 'v032/', { recursive: true });
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

// ---------- 4. list rows + row icons (Add / Play next / Replace / Start radio) + play_media payloads (mouse, 1280x800) ----------
await open(page, '&latency=60');
for (const c of 'MOCK') await tapKey(page, keyIdFor(c));
await waitShown(page, 'MOCK');
await sleep(150);
const firstRow = `${H.sv}.shadowRoot.querySelector('.grp.tracks .row')`;
const trackUri = await page.evaluate((e) => eval(e).dataset.uri, firstRow);
const SVR = `${H.sv}.shadowRoot`;
const confirmOf = () => page.evaluate((r) => { const c = eval(r).querySelector('.confirm'); return c ? { kind: c.dataset.kind, text: c.textContent.replace(/\s+/g, ' ').trim(), role: c.getAttribute('role') } : null; }, SVR);
// bring a result into view (the results list scrolls under the black footer) before a real pointer tap
async function see(expr) { await page.evaluate((e) => eval(e)?.scrollIntoView({ block: 'center' }), expr); await sleep(120); }
async function clickEl0(expr) { await see(expr); const r = await rectOf(page, expr); if (!r || !r.w) throw new Error('not visible: ' + expr); await page.mouse.click(r.x, r.y); await sleep(150); }
const rowIcon = (row, act) => `${row}.querySelector('.ra-b[data-act="${act}"]')`;
// layout: every result group is a list of rows; 4 distinct icons, 48 px targets, rows ≥ 56 px
const lay = await page.evaluate((r) => {
  const root = eval(r);
  const rows = [...root.querySelectorAll('.grp .row')];
  const tr = root.querySelector('.grp.tracks .row');
  return {
    groups: [...root.querySelectorAll('.grp')].map((g) => [g.classList[1], g.querySelectorAll('.list > .row').length]),
    tiles: root.querySelectorAll('.tile, .ac, .al, .hs').length,
    minRow: Math.min(...rows.map((x) => x.getBoundingClientRect().height)),
    icons: [...tr.querySelectorAll('.ra-b')].filter((b) => b.getBoundingClientRect().width).map((b) => ({ act: b.dataset.act, w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height, label: b.getAttribute('aria-label'), title: b.title, d: b.querySelector('path')?.getAttribute('d') })),
  };
}, SVR);
check('4a every result group renders as a list of rows (no tiles)', lay.tiles === 0 && lay.groups.length >= 3 && lay.groups.every(([, n]) => n > 0), JSON.stringify(lay.groups));
check('4b track row: Add / Play next / Replace / Start radio icons, distinct, labelled, ≥ 48×48; rows ≥ 56 px',
  lay.icons.map((i) => i.act).join() === 'add,next,replace,radio' && lay.icons.every((i) => i.w >= 48 && i.h >= 48 && i.label && i.title) && new Set(lay.icons.map((i) => i.d)).size === 4 && lay.minRow >= 56,
  `minRow=${lay.minRow} ` + lay.icons.map((i) => `${i.act}:${i.w}x${i.h} "${i.label}"`).join(' | '));
// row tap on a track: highlight only, no play, no sheet
await see(firstRow);
let r = await rectOf(page, `${firstRow}.querySelector('.rt')`);
await page.mouse.click(r.x, r.y, { delay: 40 }); await sleep(120);
s = await state(page);
const selected = await page.evaluate((e) => eval(e).classList.contains('sel'), firstRow);
check('4c tapping a track row only highlights it (no play_media, no sheet)', selected && s.playCalls.length === 0 && !s.menu, `sel=${selected} plays=${s.playCalls.length} menu=${s.menu}`);
// long-press does not play either
r = await rectOf(page, `${firstRow}.querySelector('.rt')`);
await page.mouse.move(r.x, r.y); await page.mouse.down(); await sleep(650); await page.mouse.up(); await sleep(80);
check('4d long-press on a row does not play', (await state(page)).playCalls.length === 0);
await clickEl0(rowIcon(firstRow, 'add'));
await clickEl0(rowIcon(firstRow, 'next'));
s = await state(page);
check('4e Add / Play next send immediately (enqueue add, next)', s.playCalls.map((c) => c.data.enqueue).join() === 'add,next', s.playCalls.map((c) => c.data.enqueue).join());
await clickEl0(rowIcon(firstRow, 'replace'));
let cf = await confirmOf();
s = await state(page);
check('4f Replace queue opens a confirmation and sends nothing yet', cf?.kind === 'replace' && cf.role === 'alertdialog' && /Replace the current queue\?/.test(cf.text) && /clears what's playing for everyone/.test(cf.text) && s.playCalls.length === 2, JSON.stringify(cf));
await page.screenshot({ path: SHOTS + 'v032/replace-confirm-1280x800.png' });
await clickEl0(`${SVR}.querySelector('.confirm [data-action="cancel"]')`);
s = await state(page);
check('4g Cancel closes the confirmation and sends nothing', !(await confirmOf()) && s.playCalls.length === 2, `plays=${s.playCalls.length}`);
await clickEl0(rowIcon(firstRow, 'replace'));
await clickEl0(`${SVR}.querySelector('.confirm [data-action="confirm"]')`);
s = await state(page);
check('4h Replace → confirm sends enqueue replace', s.playCalls.length === 3 && s.playCalls[2].data.enqueue === 'replace' && !s.playCalls[2].data.radio_mode, JSON.stringify(s.playCalls[2]?.data));
await clickEl0(rowIcon(firstRow, 'radio'));
cf = await confirmOf();
const beforeRadio = (await state(page)).playCalls.length;
check('4i Start radio opens a radio-worded confirmation, nothing sent yet', cf?.kind === 'radio' && /Start radio from/.test(cf.text) && /replaces the current queue for everyone/.test(cf.text) && beforeRadio === 3, JSON.stringify(cf));
await clickEl0(`${SVR}.querySelector('.confirm [data-action="cancel"]')`);
check('4j Start radio → Cancel sends nothing', (await state(page)).playCalls.length === 3);
await clickEl0(rowIcon(firstRow, 'radio'));
await page.keyboard.press('Escape'); await sleep(80);
check('4k Escape closes the confirmation without sending', !(await confirmOf()) && (await state(page)).playCalls.length === 3 && (await state(page)).query === 'MOCK');
await clickEl0(rowIcon(firstRow, 'radio'));
await clickEl0(`${SVR}.querySelector('.confirm [data-action="confirm"]')`);
s = await state(page);
// tap an artist row → detail view, never play_media
const artistRow = `${H.sv}.shadowRoot.querySelector('.grp.artists .row')`;
const artistUri = await page.evaluate((e) => eval(e).dataset.uri, artistRow);
const before4 = (await state(page)).playCalls.length;
await see(artistRow);
r = await rectOf(page, `${artistRow}.querySelector('.rt')`);
await page.mouse.click(r.x, r.y, { delay: 40 }); await sleep(400);
const DET = `${H.sv}.shadowRoot.querySelector('jb-detail')`;
const det4 = await page.evaluate((d) => { const el = eval(d); const x = el?.shadowRoot.querySelector('.detail'); return x ? { uri: x.dataset.uri, type: x.dataset.type, rows: x.querySelectorAll('.list.tracks .row').length } : null; }, DET);
check('4l Search: tap artist does not call play_media', (await state(page)).playCalls.length === before4, `plays ${before4} → ${(await state(page)).playCalls.length}`);
check('4m Search: tap artist opens its detail (top tracks)', det4 && det4.uri === artistUri && det4.type === 'artist' && det4.rows > 0, JSON.stringify(det4));
await clickEl0(`${DET}.shadowRoot.querySelector('[data-action="back"]')`);
check('4n Back returns to the results', !(await page.evaluate((d) => !!eval(d), DET)) && (await state(page)).rows > 0);
// an artist row's own icons queue the artist without opening it
await clickEl0(rowIcon(artistRow, 'add'));
s = await state(page);
const T = { entity_id: 'media_player.everywhere' };
const expect = [
  { media_id: trackUri, media_type: 'track', enqueue: 'add' },
  { media_id: trackUri, media_type: 'track', enqueue: 'next' },
  { media_id: trackUri, media_type: 'track', enqueue: 'replace' },
  { media_id: trackUri, media_type: 'track', enqueue: 'replace', radio_mode: true },
  { media_id: artistUri, media_type: 'artist', enqueue: 'add' },
];
const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
check('4o play_media payloads (add, next, replace, radio_mode+replace, artist add); row taps add none', s.playCalls.length === 5 && s.playCalls.every((c, i) => same(c.data, expect[i]) && same(c.target, T)) && !(await page.evaluate((d) => !!eval(d), DET)),
  '\n      ' + s.playCalls.map((c) => `music_assistant.play_media ${JSON.stringify(c.data)} target=${JSON.stringify(c.target)}`).join('\n      '));
check('4p recents saved to localStorage after playing', s.recents[0] === 'MOCK', JSON.stringify(s.recents));
writeFileSync(SHOTS + 'play-media-log.json', JSON.stringify(s.playCalls, null, 2));

// ---------- 5. hardware keyboard ----------
await page.keyboard.press('Escape'); await sleep(50);
await page.keyboard.type('eag', { delay: 60 });
await waitShown(page, 'EAG');
s = await state(page);
check('5a hardware letters append (uppercased) and search', s.query === 'EAG' && s.searchCalls.at(-1).name === 'EAG');
await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
const plays5 = (await state(page)).playCalls.length;
await page.keyboard.press('Enter'); await sleep(300);
s = await state(page);
const enterDet = await page.evaluate((d) => eval(d)?.shadowRoot.querySelector('.detail')?.dataset.type ?? null, `${H.sv}.shadowRoot.querySelector('jb-detail')`);
check('5b Ctrl shortcuts ignored; Enter opens the top result (no playback)', s.query === 'EAG' && s.playCalls.length === plays5 && enterDet === 'artist', `detail=${enterDet} plays=${s.playCalls.length - plays5}`);
await page.keyboard.press('Escape'); await sleep(150);
check('5e Escape in a detail goes back to the results (query kept)', (await state(page)).query === 'EAG' && !(await page.evaluate((d) => !!eval(d), `${H.sv}.shadowRoot.querySelector('jb-detail')`)));
await page.keyboard.press('Backspace'); await sleep(40);
check('5c hardware Backspace', (await state(page)).query === 'EA');
await page.keyboard.press('Escape'); await sleep(40);
check('5d hardware Escape clears', (await state(page)).query === '');

// ---------- 6. focus: never an input/textarea ----------
s = await state(page);
check('6a no input/textarea/contenteditable anywhere in the card', s.editableCount === 0, `editable=${s.editableCount}`);
check('6b document.activeElement was never an input/textarea (sampled every 25ms + focusin)', s.focusViolations === 0, `focus history: ${s.focusLog.join(' → ')}`);

// ---------- 7. phone (touch): four row icons fit, the title truncates, confirm works by touch ----------
await open(page, '&latency=60&recents=1', { width: 390, height: 844, hasTouch: true, isMobile: true });
for (const c of 'MOCK') {
  const kr = await rectOf(page, keyExpr(keyIdFor(c)));
  await page.touchscreen.tap(kr.x, kr.y); await sleep(30);
}
await waitShown(page, 'MOCK');
await sleep(150);
await page.screenshot({ path: SHOTS + 'search-390x844.png' });
const ph = await page.evaluate((r) => {
  const root = eval(r);
  return [...root.querySelectorAll('.grp .row')].map((row) => {
    const rr = row.getBoundingClientRect();
    const bs = [...row.querySelectorAll('.ra-b')].filter((b) => b.getBoundingClientRect().width).map((b) => b.getBoundingClientRect());
    const t = row.querySelector('.rt b');
    return { h: rr.height, n: bs.length, min: Math.min(...bs.map((b) => Math.min(b.width, b.height))), inside: bs.every((b) => b.left >= rr.left - 0.5 && b.right <= rr.right + 0.5 && Math.abs(b.top - bs[0].top) < 1), right: rr.right, vw: innerWidth, trunc: t.scrollWidth > t.clientWidth, tw: t.clientWidth };
  });
}, `${H.sv}.shadowRoot`);
check('7a 390 px: every row keeps its icons ≥ 44 px on one line inside the row (no clipping / wrapping)', ph.length > 0 && ph.every((x) => x.n >= 3 && x.min >= 44 && x.inside && x.right <= x.vw && x.h >= 56), JSON.stringify(ph.slice(0, 3)));
check('7b 390 px: long titles truncate instead of pushing the icons', ph.some((x) => x.trunc) && ph.every((x) => x.tw > 60), ph.map((x) => x.tw).join(','));
await page.evaluate((e) => eval(e).scrollIntoView({ block: 'center' }), `${H.sv}.shadowRoot.querySelector('.grp.tracks .row')`); await sleep(150);
r = await rectOf(page, `${H.sv}.shadowRoot.querySelector('.grp.tracks .row .ra-b[data-act="replace"]')`);
await page.touchscreen.tap(r.x, r.y); await sleep(150);
await page.screenshot({ path: SHOTS + 'replace-confirm-390x844.png' });
s = await state(page);
const cf7 = await page.evaluate((r) => eval(r).querySelector('.confirm')?.dataset.kind, `${H.sv}.shadowRoot`);
r = await rectOf(page, `${H.sv}.shadowRoot.querySelector('.confirm [data-action="cancel"]')`);
check('7c touch: Replace shows the confirmation with ≥ 44 px buttons, nothing sent', cf7 === 'replace' && s.playCalls.length === 0 && r.h >= 44, `kind=${cf7} plays=${s.playCalls.length} h=${r.h}`);
await page.touchscreen.tap(r.x, r.y); await sleep(150);
s = await state(page);
check('7d touch input never focused an editable element; Cancel sent nothing', s.focusViolations === 0 && s.editableCount === 0 && s.playCalls.length === 0);

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
const BD = `${BV}.querySelector('jb-detail')?.shadowRoot`;
let b1 = await qcall(async () => { const r = await rectOf(page, `${tile0} .ta, ${tile0}`); await page.mouse.click(r.x - r.w / 4, r.y - r.h / 4); await sleep(250); });
const bdet = await page.evaluate((d) => { const x = eval(d)?.querySelector('.detail'); return x ? { uri: x.dataset.uri, type: x.dataset.type, rows: x.querySelectorAll('.list.tracks .row').length } : null; }, BD);
check('12d Browse: tap a playlist tile does not call play_media', !b1.some((c) => c.s === 'play_media'), b1.map((c) => `${c.d}.${c.s}`).join(','));
check('12i Browse: tap opens the playlist detail (mass_queue.get_playlist_tracks page 0)', bdet && bdet.uri === t0uri && bdet.type === 'playlist' && bdet.rows > 0 && b1.some((c) => c.s === 'get_playlist_tracks' && c.data.page === 0 && c.data.uri === t0uri), JSON.stringify(bdet));
await clickEl(page, `${BD}.querySelector('[data-action="back"]')`);
check('12j Browse: Back returns to the grid', !(await page.evaluate((b) => !!eval(b).querySelector('jb-detail'), BV)) && (await page.evaluate((b) => eval(b).querySelectorAll('.tile').length, BV)) > 0);
r = await rectOf(page, tile0);
await page.mouse.move(r.x - r.w / 4, r.y - r.h / 4); await page.mouse.down(); await sleep(650); await page.mouse.up(); await sleep(100);
s = await page.evaluate((b) => [...eval(b).querySelectorAll('.menu .mi')].map((e) => e.dataset.action), BV);
let b2 = await qcall(() => clickEl(page, `${BV}.querySelector('.menu .mi[data-action="next"]')`));
check('12e long-press a playlist → menu (Open/next/add/replace, no Start radio); Play next → enqueue next', ['open', 'next', 'add', 'replace'].every((a) => s.includes(a)) && !s.includes('radio') && b2.length === 1 && b2[0].data.enqueue === 'next' && tgt(b2[0]) === EV, `${s.join(',')} ${JSON.stringify(b2[0]?.data)}`);
{
  const lp = async () => { const rr = await rectOf(page, tile0); await page.mouse.move(rr.x - rr.w / 4, rr.y - rr.h / 4); await page.mouse.down(); await sleep(650); await page.mouse.up(); await sleep(100); };
  const bconf = () => page.evaluate((b) => eval(b).querySelector('.confirm')?.dataset.kind ?? null, BV);
  await lp();
  let b3 = await qcall(() => clickEl(page, `${BV}.querySelector('.menu .mi[data-action="replace"]')`));
  const k3 = await bconf();
  let b4 = await qcall(() => clickEl(page, `${BV}.querySelector('.confirm [data-action="cancel"]')`));
  check('12e2 Browse menu Replace queue… → confirmation, nothing sent; Cancel sends nothing', k3 === 'replace' && b3.length === 0 && b4.length === 0 && !(await bconf()), `${k3} ${b3.length} ${b4.length}`);
  await lp();
  await clickEl(page, `${BV}.querySelector('.menu .mi[data-action="replace"]')`);
  let b5 = await qcall(() => clickEl(page, `${BV}.querySelector('.confirm [data-action="confirm"]')`));
  check('12e3 …confirm → play_media playlist enqueue replace (no radio_mode)', b5.length === 1 && b5[0].data.enqueue === 'replace' && b5[0].data.media_id === t0uri && !('radio_mode' in b5[0].data), JSON.stringify(b5[0]?.data));
}
await clickEl(page, `${BV}.querySelector('[data-cat="album"]')`); await sleep(300);
n0 = await ncalls(page);
await page.evaluate((b) => [...eval(b).querySelectorAll('.tile')].find((t) => t.querySelector('b').textContent === 'Kind of Blue').querySelector('.open').click(), BV);
await page.waitForFunction((d) => eval(d)?.querySelectorAll('.list.tracks .row').length > 0, { timeout: 4000 }, BD);
await sleep(200);
cs = await calls(page, n0);
const at = cs.find((c) => c.s === 'get_album_tracks');
s = await page.evaluate((d) => [...eval(d).querySelectorAll('.row b')].map((e) => e.textContent), BD);
check('12f album drill-down → mass_queue.get_album_tracks {config_entry_id, uri} and lists tracks', at && at.d === 'mass_queue' && at.rr && at.data.config_entry_id === '01MASSQUEUE0000000000000000' && /^library:\/\/album\//.test(at.data.uri) && s.includes('So What') && s.length === 4, `${JSON.stringify(at?.data)} tracks=${s.join(',')}`);
let b3 = await qcall(() => clickEl(page, `${BD}.querySelector('.da [data-action="radio"]')`));
const cf12 = await page.evaluate((d) => eval(d).querySelector('.confirm')?.dataset.kind, BD);
let b3b = await qcall(() => clickEl(page, `${BD}.querySelector('.confirm [data-action="confirm"]')`));
check('12g detail Start radio → confirmation, then play_media enqueue replace + radio_mode true (boolean)', b3.length === 0 && cf12 === 'radio' && b3b.length === 1 && b3b[0].data.radio_mode === true && b3b[0].data.enqueue === 'replace' && b3b[0].data.media_type === 'album' && tgt(b3b[0]) === EV, JSON.stringify(b3b[0]?.data));
let b4 = await qcall(() => clickEl(page, `${BD}.querySelector('.list.tracks .row .rt')`));
const sel12 = await page.evaluate((d) => ({ menu: !!eval(d).querySelector('.menu'), sel: eval(d).querySelector('.list.tracks .row').classList.contains('sel') }), BD);
check('12h tap a track row in the detail → highlighted only: no sheet, nothing played', b4.length === 0 && !sel12.menu && sel12.sel, `${JSON.stringify(sel12)} calls=${b4.length}`);
b4 = await qcall(() => clickEl(page, `${BD}.querySelector('.list.tracks .row .ra-b[data-act="next"]')`));
check('12k detail row Play next icon → play_media track enqueue next', b4.length === 1 && b4[0].data.media_type === 'track' && b4[0].data.enqueue === 'next' && tgt(b4[0]) === EV, JSON.stringify(b4[0]?.data));

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
await see(firstRow);
r = await rectOf(page, `${firstRow}.querySelector('.ra-b[data-act="replace"]')`);
await page.mouse.click(r.x, r.y); await sleep(150);
const mr = await rectOf(page, `${H.sv}.shadowRoot.querySelector('.confirm')`);
const mb = await rectOf(page, `${H.sv}.shadowRoot.querySelector('.confirm [data-action="confirm"]')`);
check('15k 1920x1080: a zoomed row icon is hit by a real click; the confirmation is centred and on screen', r.w >= 60 && mr && Math.abs(mr.x - 960) < 4 && mr.y - mr.h / 2 > 0 && mr.y + mr.h / 2 < 1080 && Math.abs(mr.y - 540) < 60 && mb.h >= 60 && (await state(page)).playCalls.length === 0, `btn ${JSON.stringify(r)} confirm ${JSON.stringify(mr)}`);
await page.keyboard.press('Escape');

// =================== 0.3.1: live API shapes (mass_queue tracks + paging, player art, radio) ===================
{
  const pg = await browser.newPage();
  await hermetic(pg, { dead: ['rockantenne'] });
  pg.on('pageerror', (e) => pageErrors.push('[16] ' + e.message));
  const BR = `__card.shadowRoot.querySelector('jb-browse')`;
  const pcalls = (since = 0) => calls(pg, since);
  const pq = async (fn) => { const n = await ncalls(pg); await fn(); await sleep(300); return actions(await pcalls(n)); };
  const BDs = `${BR}.shadowRoot.querySelector('jb-detail')?.shadowRoot`;
  const rows = () => pg.evaluate((b) => [...(eval(b)?.querySelectorAll('.detail .list.tracks .row') ?? [])].map((r) => ({ name: r.querySelector('b')?.textContent, du: r.querySelector('.du')?.textContent?.trim() ?? '', img: r.querySelector('img')?.getAttribute('src') ?? '' })), BDs);
  const detail = (it, type) => pg.evaluate((b, it, type) => eval(b).openDetail(it, type), BR, it, type);
  const meta = () => pg.evaluate((b) => eval(b)?.querySelector('.detail .meta')?.textContent?.trim() ?? '', BDs);
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
  check('16b album header shows track count + total time; rows use the https media_image', (await meta()) === `9 tracks · ${tot} min` && (await pg.evaluate((b) => eval(b).detail.data.tracks.every((t) => /^https:\/\//.test(t.image)), BR)), await meta());
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
    for (let i = 0; i < 8; i++) { await pg.evaluate((b) => { const s = eval(b).querySelector('.scroll'); s.scrollTop = s.scrollHeight; s.dispatchEvent(new Event('scroll')); }, BDs); await sleep(250); }
    const r = await rows();
    const pages = (await pcalls(nn)).filter((c) => c.s === 'get_playlist_tracks').map((c) => c.data.page);
    const more = await pg.evaluate((b) => !!eval(b).querySelector('.more-t'), BDs);
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
  const stSheet = await pg.evaluate((b) => [...eval(b).shadowRoot.querySelectorAll('.menu .mi')].map((e) => e.dataset.action), BR);
  check('16zc tap a station → sheet with Play now + Cancel only, nothing played yet', pr.length === 0 && stSheet.join() === 'play,cancel', `${stSheet} calls=${pr.length}`);
  pr = await pq(() => clickEl(pg, `${BR}.shadowRoot.querySelector('.menu .mi[data-action="play"]')`));
  check('16u station Play now → play_media {radiobrowser://radio/<uuid>, media_type radio} on everywhere, no radio_mode', pr.length === 1 && pr[0].s === 'play_media' && tgt(pr[0]) === EV && /^radiobrowser:\/\/radio\/[0-9a-f-]{36}$/.test(pr[0].data.media_id) && pr[0].data.media_type === 'radio' && !('radio_mode' in pr[0].data), JSON.stringify(pr));
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

  // Phone: durations stay visible in rows (moved into the subtitle line so the four row icons fit)
  await open(pg, '&latency=20&tab=browse', { width: 390, height: 844, isMobile: true, hasTouch: true });
  await detail({ media_type: 'album', uri: 'library://album/1448', name: 'Hotel California' }, 'album'); await sleep(400);
  const ph = await pg.evaluate((b) => { const r = eval(b).querySelector('.detail .row'); const du = [...r.querySelectorAll('.du, .du2')].find((e) => getComputedStyle(e).display !== 'none'), pv = r.querySelector('.pv'); return { du: du && getComputedStyle(du).display !== 'none' && du.getBoundingClientRect().width > 0 ? du.textContent.trim() : '', pv: pv ? getComputedStyle(pv).display : 'none', over: r.scrollWidth - r.clientWidth }; }, BDs);
  check('16za 390px phone: track rows keep the duration (under the title; provider badge hidden), no overflow', ph.du === '6:31' && ph.pv === 'none' && ph.over <= 1, JSON.stringify(ph));

  // public-repo hygiene: fixtures are scrubbed
  const fxText = ['ma-search-sample.json', 'ma-search-sample-radio.json', 'ma-library-radio-sample.json', 'mass-queue-tracks-sample.json'].map((f) => readFileSync(new URL(`../dev/fixtures/${f}`, import.meta.url), 'utf8')).join('\n');
  check('16zb fixtures: provider instance ids scrubbed to --XXXXXXXX, no user_id / real context ids', /apple_music--XXXXXXXX/.test(fxText) && !/apple_music--(?!XXXXXXXX)[A-Za-z0-9]+/.test(fxText) && !/"user_id": "[0-9a-f]{32}"/.test(fxText) && (fxText.match(/\b01[0-9A-HJKMNP-TV-Z]{24}\b/g) || []).every((id) => /^01(MOCK|MASSQUEUE)/.test(id)));
  await pg.close();
}

// =================== 0.3.2: tap never plays — detail views, action sheets, back stack ===================
{
  const pg = await browser.newPage();
  await hermetic(pg);
  await pg.evaluateOnNewDocument(FOCUS_MONITOR);
  await pg.bringToFront();
  pg.on('pageerror', (e) => pageErrors.push('[17] ' + e.message));
  const V32 = SHOTS + 'v032/';
  mkdirSync(V32, { recursive: true });
  const SV = H.sv;
  const SD = `${SV}.shadowRoot.querySelector('jb-detail')?.shadowRoot`;
  const all = (since = 0) => calls(pg, since);
  const plays = (cs) => cs.filter((c) => c.s === 'play_media');
  const act = async (fn, wait = 300) => { const n = await ncalls(pg); await fn(); await sleep(wait); return actions(await all(n)); };
  const det = () => pg.evaluate((d) => { const r = eval(d); const x = r?.querySelector('.detail'); if (!x) return null;
    return { type: x.dataset.type, uri: x.dataset.uri, src: x.dataset.src, loading: x.hasAttribute('data-loading'), title: x.querySelector('h2')?.textContent.trim(),
      trail: r.querySelector('.trail')?.textContent.trim() ?? '', note: r.querySelector('.note.src')?.textContent.trim() ?? '', err: r.querySelector('.note.err')?.textContent.trim() ?? '',
      tracks: [...x.querySelectorAll('.list.tracks .row b')].map((b) => b.textContent), albums: [...x.querySelectorAll('.list.albums .row b')].map((b) => b.textContent),
      byline: x.querySelector('h3 em')?.textContent ?? '', menu: [...r.querySelectorAll('.menu .mi')].map((m) => m.dataset.action), sheet: !!r.querySelector('.menu.sheet'), confirm: r.querySelector('.confirm')?.dataset.kind ?? null }; }, SD);
  const waitDet = (pred = 'true') => pg.waitForFunction((d, p) => { const x = eval(d)?.querySelector('.detail'); return !!x && !x.hasAttribute('data-loading') && eval(p); }, { timeout: 5000 }, SD, pred).catch(() => {});
  const typeQ = async (q) => { for (const c of q) await tapKey(pg, keyIdFor(c)); await waitShown(pg, q); await sleep(150); };
  const tapEl = async (expr, touch = false) => { await pg.evaluate((e) => eval(e)?.scrollIntoView({ block: 'nearest' }), expr); await sleep(60); const r = await rectOf(pg, expr); if (!r || !r.w) throw new Error('not visible: ' + expr); if (touch) await pg.touchscreen.tap(r.x, r.y); else await pg.mouse.click(r.x, r.y, { delay: 40 }); await sleep(200); };
  const searchRow = (g, name) => `[...${SV}.shadowRoot.querySelectorAll('.grp.${g} .row')].find((e) => e.querySelector('b')?.textContent === ${JSON.stringify(name)})`;
  const searchTile = (g, name) => `${searchRow(g, name)}?.querySelector('.rt')`; // the row body (not its icons)
  const icon = (row, a) => `${row}?.querySelector('.ra-b[data-act="${a}"]')`;
  const confirmKind = (root) => pg.evaluate((r) => eval(r)?.querySelector('.confirm')?.dataset.kind ?? null, root);
  const SVR = `${SV}.shadowRoot`;
  const detBtn = (a) => `${SD}.querySelector('.da [data-action="${a}"]')`;
  const albumRow = (name) => `[...${SD}.querySelectorAll('.list.albums .row')].find((t) => t.querySelector('b').textContent === ${JSON.stringify(name)})`;
  const albumTile = (name) => `${albumRow(name)}?.querySelector('.rt')`;

  // 17a-f: the reported bug — search "chicago", tap the artist
  await open(pg, '&latency=40');
  await typeQ('CHICAGO');
  const artistUri = await pg.evaluate((e) => eval(e).dataset.uri, searchRow('artists', 'Chicago'));
  let cs = await act(() => tapEl(searchTile('artists', 'Chicago')), 500);
  await waitDet();
  let d = await det();
  check('17a "chicago": tap artist does not call play_media', plays(cs).length === 0, cs.map((c) => `${c.d}.${c.s}`).join(','));
  check('17b "chicago": tap opens the artist detail in place (Back + trail, keyboard tucked away)', d?.type === 'artist' && d.uri === artistUri && d.title === 'Chicago' && /Search “CHICAGO”/.test(d.trail)
    && (await pg.evaluate((sv) => eval(sv).shadowRoot.querySelector('.sx').classList.contains('kb-hidden'), SV)), JSON.stringify(d));
  check('17c artist: top tracks via mass_queue.get_artist_tracks {config_entry_id, uri}', d.src === 'mass_queue' && d.tracks.includes('25 or 6 to 4') && d.tracks.includes('If You Leave Me Now')
    && cs.some((c) => c.s === 'get_artist_tracks' && c.rr && c.data.uri === artistUri && c.data.config_entry_id === '01MASSQUEUE0000000000000000'), d.tracks.join(','));
  check('17d artist: albums by that artist only (no "Chicago" musical / CSO), same album on 2 providers shown once', d.albums.join() === 'Chicago Transit Authority,Chicago X,Chicago 17', d.albums.join(','));
  await pg.screenshot({ path: V32 + 'search-artist-detail-1280x800.png' });
  // scroll the artist detail, open an album, Back → artist restored at the same scroll position, no refetch
  await pg.evaluate((dd) => { const s = eval(dd).querySelector('.scroll'); s.scrollTop = 120; s.dispatchEvent(new Event('scroll')); }, SD);
  await pg.evaluate((e) => eval(e).scrollIntoView({ block: 'nearest' }), albumRow('Chicago Transit Authority')); await sleep(150);
  const scrolled = await pg.evaluate((dd) => eval(dd).querySelector('.scroll').scrollTop, SD);
  cs = await act(() => tapEl(albumTile('Chicago Transit Authority')), 400);
  await waitDet('eval(d).querySelector(".detail").dataset.type === "album"');
  d = await det();
  check('17e album row in the artist → album detail (get_album_tracks), never plays; trail shows the artist', plays(cs).length === 0 && d.type === 'album' && d.title === 'Chicago Transit Authority' && d.tracks.join() === '25 or 6 to 4,Beginnings,Questions 67 and 68'
    && /Chicago$/.test(d.trail) && cs.some((c) => c.s === 'get_album_tracks'), `${JSON.stringify(d)} ${cs.map((c) => c.s)}`);
  cs = await act(() => tapEl(`${SD}.querySelector('[data-action="back"]')`), 250);
  d = await det();
  const back = await pg.evaluate((dd) => eval(dd).querySelector('.scroll').scrollTop, SD);
  check('17f Back → artist detail again, scroll position restored, cached (no new calls)', d.type === 'artist' && d.albums.length === 3 && scrolled > 0 && Math.abs(back - scrolled) <= 1 && cs.length === 0, `scroll ${scrolled} → ${back}, calls=${cs.map((c) => c.s)}`);

  // 17g-l: detail header Play / Shuffle (replace the queue → confirm) / Add to queue / Start radio, and the track-row icons
  const confirm = async (yes = true) => tapEl(`${SD}.querySelector('.confirm [data-action="${yes ? 'confirm' : 'cancel'}"]')`);
  cs = await act(() => tapEl(detBtn('shuffle')), 300);
  const kSh = (await det()).confirm;
  const cs2 = await act(() => confirm(), 400);
  check('17g Shuffle → confirmation first (nothing sent), then shuffle_set {shuffle: true} on everywhere + play_media artist enqueue replace', cs.length === 0 && kSh === 'shuffle' && cs2.length === 2 && cs2[0].s === 'shuffle_set' && cs2[0].data.shuffle === true && tgt(cs2[0]) === EV
    && cs2[1].s === 'play_media' && cs2[1].data.media_id === artistUri && cs2[1].data.media_type === 'artist' && cs2[1].data.enqueue === 'replace' && tgt(cs2[1]) === EV, `pre=${cs.map((c) => c.s)} ${kSh} ` + cs2.map((c) => `${c.s} ${JSON.stringify(c.data)}`).join(' | '));
  cs = await act(async () => { await tapEl(detBtn('play')); await confirm(); }, 400);
  check('17h Play (player shuffle on) → confirm → shuffle_set false first, then play_media enqueue replace — plays in order', cs.length === 2 && cs[0].s === 'shuffle_set' && cs[0].data.shuffle === false && cs[1].s === 'play_media' && cs[1].data.enqueue === 'replace', cs.map((c) => `${c.s} ${JSON.stringify(c.data)}`).join(' | '));
  cs = await act(async () => { await tapEl(detBtn('play')); await confirm(); }, 400);
  check('17i Play (shuffle already off) → only play_media', cs.length === 1 && cs[0].s === 'play_media' && cs[0].data.enqueue === 'replace', cs.map((c) => c.s).join());
  cs = await act(() => tapEl(detBtn('add')), 400);
  check('17j Add to queue → play_media enqueue add at once (no confirmation needed)', cs.length === 1 && cs[0].s === 'play_media' && cs[0].data.enqueue === 'add' && cs[0].data.media_type === 'artist' && !(await det()).confirm, JSON.stringify(cs[0]?.data));
  cs = await act(async () => { await tapEl(detBtn('radio')); }, 200);
  const kR = (await det()).confirm;
  await pg.screenshot({ path: V32 + 'radio-confirm-1280x800.png' });
  const cs3 = await act(() => confirm(), 400);
  check('17j2 header Start radio (artist) → radio confirmation, then play_media artist radio_mode true + enqueue replace', cs.length === 0 && kR === 'radio' && cs3.length === 1 && cs3[0].data.radio_mode === true && cs3[0].data.enqueue === 'replace' && cs3[0].data.media_type === 'artist', JSON.stringify(cs3[0]?.data));
  const row0 = `${SD}.querySelector('.list.tracks .row')`;
  const row0uri = await pg.evaluate((e) => eval(e).dataset.uri, row0);
  cs = await act(() => tapEl(`${row0}.querySelector('.rt')`));
  d = await det();
  const sel0 = await pg.evaluate((e) => eval(e).classList.contains('sel'), row0);
  check('17k detail track row tap → highlighted only (no sheet, no call)', cs.length === 0 && d.menu.length === 0 && sel0, JSON.stringify({ calls: cs.map((c) => c.s), menu: d.menu, sel0 }));
  const seen = [];
  for (const a of ['add', 'next']) { cs = await act(() => tapEl(icon(row0, a))); seen.push(plays(cs).map((c) => `${c.data.media_type}:${c.data.enqueue}:${c.data.media_id === row0uri}`).join()); }
  cs = await act(() => tapEl(icon(row0, 'replace')));
  const kRep = (await det()).confirm; seen.push(`pre:${cs.length}`);
  await pg.screenshot({ path: V32 + 'detail-replace-confirm-1280x800.png' });
  cs = await act(() => confirm()); seen.push(plays(cs).map((c) => `${c.data.media_type}:${c.data.enqueue}:${!!c.data.radio_mode}`).join());
  cs = await act(() => tapEl(icon(row0, 'radio'))); seen.push(`pre:${cs.length}`);
  cs = await act(() => confirm()); seen.push(plays(cs).map((c) => `${c.data.media_type}:${c.data.enqueue}:${!!c.data.radio_mode}`).join());
  check('17l detail track icons → add / next at once; replace + radio only after confirm (radio_mode true, enqueue replace)', kRep === 'replace' && seen.join('|') === 'track:add:true|track:next:true|pre:0|track:replace:false|pre:0|track:replace:true', seen.join('|'));
  cs = await act(async () => { await tapEl(detBtn('play')); await confirm(false); });
  check('17l2 header Play → Cancel sends nothing', cs.length === 0 && !(await det()).confirm, cs.map((c) => c.s).join());
  // album row icons in an artist: queue the album without opening it
  cs = await act(() => tapEl(icon(albumRow('Chicago X'), 'next')));
  check('17l3 artist album row Play next → play_media album enqueue next, stays on the artist', plays(cs).length === 1 && plays(cs)[0].data.media_type === 'album' && plays(cs)[0].data.enqueue === 'next' && (await det()).type === 'artist', JSON.stringify(plays(cs)[0]?.data));
  await pg.screenshot({ path: V32 + 'artist-detail-rows-1280x800.png' });

  // 17m: back to the results restores their scroll; a playlist row opens its detail
  await tapEl(`${SD}.querySelector('[data-action="back"]')`);
  await pg.evaluate((sv) => { const s = eval(sv).shadowRoot.querySelector('.res .scroll'); s.scrollTop = s.scrollHeight; }, SV);
  const resTop = await pg.evaluate((sv) => eval(sv).shadowRoot.querySelector('.res .scroll').scrollTop, SV);
  cs = await act(() => tapEl(searchTile('playlists', 'Chicago Blues Classics')), 400);
  await waitDet();
  d = await det();
  check('17m tap a playlist → playlist detail (get_playlist_tracks page 0), no play', plays(cs).length === 0 && d.type === 'playlist' && cs.some((c) => c.s === 'get_playlist_tracks' && c.data.page === 0), `${JSON.stringify(d)} ${cs.map((c) => c.s)}`);
  await tapEl(`${SD}.querySelector('[data-action="back"]')`);
  const resBack = await pg.evaluate((sv) => ({ top: eval(sv).shadowRoot.querySelector('.res .scroll')?.scrollTop, kb: eval(sv).shadowRoot.querySelector('.sx').classList.contains('kb-hidden') }), SV);
  check('17n Back to the results: scroll position + keyboard restored', resTop > 0 && Math.abs(resBack.top - resTop) <= 1 && !resBack.kb, `${resTop} → ${JSON.stringify(resBack)}`);
  // typing while a detail is open starts a new search
  await tapEl(searchTile('artists', 'Chicago')); await waitDet();
  await pg.keyboard.press('S'); await sleep(250);
  check('17o typing (hardware) while a detail is open → new search, detail closed', (await state(pg)).query === 'CHICAGOS' && !(await det()), (await state(pg)).query);
  check('17p no input was ever focused during the detail flows', (await state(pg)).focusViolations === 0 && (await state(pg)).editableCount === 0);

  // 17q: double tap on a row icon → one play_media (in-flight guard)
  await open(pg, '&latency=400&playlat=400');
  await typeQ('CHICAGO');
  await tapEl(searchTile('albums', 'Chicago X')); await waitDet();
  cs = await act(async () => { const r = await rectOf(pg, icon(`${SD}.querySelector('.list.tracks .row')`, 'add')); await pg.mouse.click(r.x, r.y); await sleep(60); await pg.mouse.click(r.x, r.y); }, 900);
  check('17q double tap on a row Add icon (slow MA) → a single play_media', plays(cs).length === 1, plays(cs).map((c) => c.data.enqueue).join());

  // 17r: stale race — slow album, Back, other album: the slow reply must not land in the wrong view
  await open(pg, '&latency=40&mqslow=transit');
  await typeQ('CHICAGO');
  await tapEl(searchTile('artists', 'Chicago')); await waitDet();
  await tapEl(albumTile('Chicago Transit Authority'));
  await tapEl(`${SD}.querySelector('[data-action="back"]')`);
  await tapEl(albumTile('Chicago X'));
  await sleep(1300);
  d = await det();
  check('17r stale race: slow album reply ignored after Back → other album shows only its own tracks', d.title === 'Chicago X' && d.tracks.includes('If You Leave Me Now') && !d.tracks.includes('25 or 6 to 4'), JSON.stringify(d.tracks));
  await tapEl(`${SD}.querySelector('[data-action="back"]')`);
  d = await det();
  check('17s …and the artist view underneath is intact', d.type === 'artist' && d.albums.length === 3);

  // 17t-v: without mass_queue_entry_id
  await open(pg, '&latency=40&noqueue=1');
  await typeQ('CHICAGO');
  let n17 = await ncalls(pg); await tapEl(searchTile('albums', 'Chicago X')); await sleep(400); await waitDet(); cs = await all(n17);
  d = await det();
  check('17t no mass_queue: album detail via labelled search fallback (artist filter), no mass_queue calls', d.src === 'search' && /mass_queue is not set up/.test(d.note) && /search/.test(d.byline) && d.tracks.join() === 'If You Leave Me Now,Another Rainy Day in New York City'
    && !cs.some((c) => c.d === 'mass_queue') && cs.some((c) => c.s === 'search' && c.data.artist === 'Chicago'), `${JSON.stringify(d)} ${JSON.stringify(cs.filter((c) => c.s === 'search').map((c) => c.data))}`);
  await tapEl(`${SD}.querySelector('[data-action="back"]')`);
  await tapEl(searchTile('artists', 'Chicago')); await waitDet();
  d = await det();
  check('17u no mass_queue: artist detail still has tracks (labelled search) + albums', d.src === 'search' && d.note && d.tracks.length >= 5 && d.albums.length === 3, JSON.stringify(d));
  await tapEl(`${SD}.querySelector('[data-action="back"]')`);
  await tapEl(searchTile('playlists', 'Chicago Blues Classics')); await waitDet();
  d = await det();
  cs = await act(async () => { await tapEl(detBtn('play')); await confirm(); }, 400);
  const pRadio = await pg.evaluate((b) => !!eval(b).querySelector('.da [data-action="radio"]'), SD);
  check('17v2 playlist detail has no Start radio (seed support not confirmed)', !pRadio);
  check('17v no mass_queue: playlist detail explains why tracks are missing, Play still works', d.type === 'playlist' && /mass_queue/.test(d.note) && d.tracks.length === 0 && plays(cs).length === 1 && plays(cs)[0].data.media_type === 'playlist', JSON.stringify(d));

  // 17w-x: mass_queue failures
  await open(pg, '&latency=40&mqfail=get_album_tracks');
  await typeQ('CHICAGO');
  await tapEl(searchTile('albums', 'Chicago X')); await waitDet();
  d = await det();
  check('17w mass_queue error on an album → labelled search fallback', d.src === 'search' && /couldn.t list/.test(d.note) && d.tracks.length === 2, JSON.stringify(d));
  await open(pg, '&latency=40&mqfail=get_playlist_tracks');
  await typeQ('CHICAGO');
  await tapEl(searchTile('playlists', 'Chicago Blues Classics')); await waitDet();
  d = await det();
  const hasRetry = await pg.evaluate((dd) => !!eval(dd).querySelector('.note.err [data-action="retry"]'), SD);
  check('17x mass_queue error on a playlist → error note with Retry (no silent empty list)', !!d.err && hasRetry, d.err);

  // 17y: radio + podcasts in Search
  await open(pg, '&latency=40&radio=1&pods=1');
  await typeQ('CHICAGO');
  const stRow = searchRow('radio', 'WXRT Chicago 93.1 FM');
  cs = await act(() => tapEl(searchTile('radio', 'WXRT Chicago 93.1 FM')));
  let menu = await pg.evaluate((sv) => [...eval(sv).shadowRoot.querySelectorAll('.menu .mi')].map((m) => m.dataset.action), SV);
  const radioIcons = await pg.evaluate((sv) => Object.fromEntries([...eval(sv).shadowRoot.querySelectorAll('.grp')].map((g) => [g.classList[1], [...g.querySelectorAll('.row')].map((r) => [...r.querySelectorAll('.ra-b:not(.ra-more)')].map((b) => b.dataset.act).join('+'))])), SV);
  check('17y Search: tap a station row → nothing played, no sheet (name trimmed of tabs)', plays(cs).length === 0 && menu.length === 0, menu.join());
  check('17y2 Start radio icon hidden on stations, playlists and podcasts; shown on artists, albums and tracks',
    radioIcons.radio.every((x) => x === 'add+next+replace') && radioIcons.playlists.every((x) => x === 'add+next+replace') && radioIcons.podcasts.every((x) => x === 'add+next+replace')
    && ['artists', 'albums', 'tracks'].every((g) => radioIcons[g].length && radioIcons[g].every((x) => x === 'add+next+replace+radio')), JSON.stringify(radioIcons));
  cs = await act(() => tapEl(icon(stRow, 'replace')));
  const kSt = await confirmKind(SVR);
  const cs4 = await act(() => tapEl(`${SVR}.querySelector('.confirm [data-action="confirm"]')`));
  check('17z station Replace queue → confirm → play_media radio enqueue replace, no radio_mode', plays(cs).length === 0 && kSt === 'replace' && plays(cs4).length === 1 && plays(cs4)[0].data.media_type === 'radio' && plays(cs4)[0].data.enqueue === 'replace' && !('radio_mode' in plays(cs4)[0].data), JSON.stringify(plays(cs4)[0]?.data));
  cs = await act(() => tapEl(icon(stRow, 'add')));
  check('17z2 station Add to queue → play_media radio enqueue add', plays(cs).length === 1 && plays(cs)[0].data.media_type === 'radio' && plays(cs)[0].data.enqueue === 'add', JSON.stringify(plays(cs)[0]?.data));
  cs = await act(() => tapEl(searchTile('podcasts', 'Chicago Stories')), 400); await waitDet();
  d = await det();
  check('17za podcast → episodes detail via mass_queue.get_podcast_episodes, no play', plays(cs).length === 0 && d.type === 'podcast' && d.tracks.length === 3 && cs.some((c) => c.s === 'get_podcast_episodes'), JSON.stringify(d));
  const epIcons = await pg.evaluate((dd) => [...eval(dd).querySelectorAll('.list.tracks .row')].map((r) => [...r.querySelectorAll('.ra-b:not(.ra-more)')].map((b) => b.dataset.act).join('+')), SD);
  const podRadio = await pg.evaluate((dd) => !!eval(dd).querySelector('.da [data-action="radio"]'), SD);
  check('17za2 podcast detail: episodes have no Start radio icon, header has no Start radio', epIcons.length === 3 && epIcons.every((x) => x === 'add+next+replace') && !podRadio, JSON.stringify(epIcons));
  cs = await act(async () => { await tapEl(icon(`${SD}.querySelector('.list.tracks .row')`, 'replace')); await confirm(); });
  check('17zb episode Replace → confirm → play_media with the episode uri and no media_type (MA infers it)', plays(cs).length === 1 && /podcast_episode/.test(plays(cs)[0].data.media_id) && !('media_type' in plays(cs)[0].data), JSON.stringify(plays(cs)[0]?.data));

  // 17zc-ze: phone portrait, touch
  await open(pg, '&latency=40', { width: 390, height: 844, isMobile: true, hasTouch: true });
  for (const c of 'CHICAGO') { const kr = await rectOf(pg, keyExpr(keyIdFor(c))); await pg.touchscreen.tap(kr.x, kr.y); await sleep(30); }
  await waitShown(pg, 'CHICAGO'); await sleep(150);
  await pg.screenshot({ path: V32 + 'search-list-390x844.png' });
  cs = await act(() => tapEl(searchTile('artists', 'Chicago'), true), 500); await waitDet();
  d = await det();
  const fit = await pg.evaluate((dd) => { const r = eval(dd); const btns = [...r.querySelectorAll('.da button, .nav .back')].map((b) => b.getBoundingClientRect());
    return { minH: Math.min(...btns.map((b) => b.height)), inside: btns.every((b) => b.left >= 0 && b.right <= innerWidth + 0.5), over: r.querySelector('.scroll').scrollWidth - r.querySelector('.scroll').clientWidth }; }, SD);
  check('17zc 390x844 touch: artist tap opens the detail, no play; buttons ≥ 40px tall and on screen, no sideways scroll', plays(cs).length === 0 && d.type === 'artist' && fit.minH >= 40 && fit.inside && fit.over <= 1, JSON.stringify(fit));
  await pg.screenshot({ path: V32 + 'search-artist-detail-390x844.png' });
  const phRows = await pg.evaluate((dd) => [...eval(dd).querySelectorAll('.detail .row')].map((row) => { const rr = row.getBoundingClientRect(); const bs = [...row.querySelectorAll('.ra-b')].filter((b) => b.getBoundingClientRect().width).map((b) => b.getBoundingClientRect());
    return { n: bs.length, min: Math.min(...bs.map((b) => Math.min(b.width, b.height))), inside: bs.every((b) => b.right <= rr.right + 0.5 && b.right <= innerWidth && Math.abs(b.top - bs[0].top) < 1), h: rr.height }; }), SD);
  check('17zd 390x844 detail rows: 4 icons ≥ 44 px, one line, inside the screen; rows ≥ 56 px', phRows.length > 5 && phRows.every((x) => x.n === 4 && x.min >= 44 && x.inside && x.h >= 56), JSON.stringify(phRows.slice(0, 2)));
  cs = await act(async () => { await tapEl(`${SD}.querySelector('.list.tracks .row .rt')`, true); await tapEl(icon(`${SD}.querySelector('.list.tracks .row')`, 'radio'), true); });
  d = await det();
  await pg.screenshot({ path: V32 + 'radio-confirm-390x844.png' });
  check('17zd2 390x844 touch: track row tap highlights; Start radio → confirmation, nothing sent', cs.length === 0 && d.confirm === 'radio' && d.menu.length === 0, JSON.stringify({ cs: cs.map((c) => c.s), c: d.confirm }));
  cs = await act(() => tapEl(`${SD}.querySelector('.confirm [data-action="cancel"]')`, true));
  check('17zd3 390x844 touch: Cancel sends nothing', cs.length === 0 && !(await det()).confirm);
  await tapEl(`${SD}.querySelector('[data-action="back"]')`, true);
  await tapEl(icon(searchRow('tracks', '25 or 6 to 4'), 'replace'), true);
  await pg.screenshot({ path: V32 + 'replace-confirm-390x844.png' });
  await tapEl(`${SVR}.querySelector('.confirm [data-action="cancel"]')`, true);
  // Browse: album detail on the phone + 1280
  for (const vp of [{ width: 390, height: 844, isMobile: true, hasTouch: true }, { width: 1280, height: 800 }]) {
    await open(pg, '&latency=40&tab=browse', vp);
    await pg.waitForFunction((b) => eval(b).querySelectorAll('.tile').length > 0, {}, BV);
    await tapEl(`${BV}.querySelector('[data-cat="album"]')`, vp.hasTouch);
    await sleep(300);
    cs = await act(() => tapEl(`[...${BV}.querySelectorAll('.tile')].find((t) => t.querySelector('b').textContent === 'Kind of Blue')`, vp.hasTouch), 500);
    const bd = await pg.evaluate((b) => eval(b).querySelector('jb-detail')?.shadowRoot.querySelectorAll('.list.tracks .row').length ?? 0, BV);
    if (vp.width === 390) check('17ze Browse 390x844: tap album → detail with tracks, no play', plays(cs).length === 0 && bd === 4, `rows=${bd}`);
    await pg.screenshot({ path: V32 + `browse-album-detail-${vp.width}x${vp.height}.png` });
    await tapEl(`${BV}.querySelector('jb-detail').shadowRoot.querySelector('.list.tracks .row .ra-b[data-act="replace"]')`, vp.hasTouch);
    await pg.screenshot({ path: V32 + `browse-detail-replace-confirm-${vp.width}x${vp.height}.png` });
    await tapEl(`${BV}.querySelector('jb-detail').shadowRoot.querySelector('.confirm [data-action="cancel"]')`, vp.hasTouch);
  }
  // Search list screenshot at 1280 + very narrow rows (< 330 px): Replace / Start radio fold into ⋯, still behind the confirmation
  await open(pg, '&latency=40');
  await typeQ('CHICAGO');
  await pg.screenshot({ path: V32 + 'search-list-1280x800.png' });
  await open(pg, '&latency=40', { width: 320, height: 640, isMobile: true, hasTouch: true });
  for (const c of 'CHICAGO') { const kr = await rectOf(pg, keyExpr(keyIdFor(c))); await pg.touchscreen.tap(kr.x, kr.y); await sleep(30); }
  await waitShown(pg, 'CHICAGO'); await sleep(150);
  const tr = searchRow('tracks', '25 or 6 to 4');
  const narrow = await pg.evaluate((e) => { const row = eval(e); return [...row.querySelectorAll('.ra-b')].filter((b) => b.getBoundingClientRect().width).map((b) => `${b.dataset.act}:${Math.round(b.getBoundingClientRect().width)}`).join(); }, tr);
  await tapEl(icon(tr, 'more'), true);
  const nMenu = await pg.evaluate((sv) => [...eval(sv).shadowRoot.querySelectorAll('.menu .mi')].map((m) => m.dataset.action).join(), SV);
  await pg.screenshot({ path: V32 + 'narrow-more-320x640.png' });
  cs = await act(() => tapEl(`${SVR}.querySelector('.menu .mi[data-action="radio"]')`, true));
  const nKind = await confirmKind(SVR);
  const cs5 = await act(() => tapEl(`${SVR}.querySelector('.confirm [data-action="confirm"]')`, true));
  check('17zg 320 px: rows show Add / Play next / ⋯ (44 px); ⋯ → Replace queue… / Start radio… → confirmation → radio_mode + replace', narrow === 'add:44,next:44,more:44' && /replace/.test(nMenu) && /radio/.test(nMenu) && plays(cs).length === 0 && nKind === 'radio'
    && plays(cs5).length === 1 && plays(cs5)[0].data.radio_mode === true && plays(cs5)[0].data.enqueue === 'replace', `${narrow} menu=${nMenu} kind=${nKind} ${JSON.stringify(plays(cs5)[0]?.data)}`);
  // every play_media this run used a valid HA media_type (the mock rejects anything else)
  const bad = (await all()).filter((c) => c.s === 'play_media' && !['artist', 'album', 'audiobook', 'folder', 'playlist', 'podcast', 'track', 'radio', undefined].includes(c.data.media_type));
  check('17zf play_media media_type always valid (or omitted)', bad.length === 0, JSON.stringify(bad));
  await pg.close();
}

check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
await browser.close();
writeFileSync(SHOTS + 'results.json', JSON.stringify({ at: new Date().toString(), perKey, results }, null, 2));
console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures ? 1 : 0);
