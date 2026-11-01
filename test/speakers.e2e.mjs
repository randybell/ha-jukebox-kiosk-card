// 0.5.0 Speakers panel e2e (mock Music Assistant in dev/mock-ma.js; every id is a placeholder).
// Usage: (serve the project root on :8765) node test/speakers.e2e.mjs
import puppeteer from 'puppeteer-core';
import { hermetic } from './intercept.mjs';

const BASE = process.env.JB_URL ?? 'http://127.0.0.1:8765/dev/index.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
let failures = 0, total = 0;
function check(name, ok, info = '') {
  total++; if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`);
}
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--font-render-hinting=none'],
});

const IN = 'media_player.indoor', OUT = 'media_player.outdoor', EVERY = 'media_player.everywhere';
const LIV = 'media_player.living_room', KIT = 'media_player.kitchen', GAR = 'media_player.garage';
const SPK = `__card.shadowRoot.querySelector('jb-speakers')`;
const SR = `${SPK}.shadowRoot`;
const NOW = `__card.shadowRoot.querySelector('jb-now')`;
const row = (e) => `${SR}.querySelector('[data-room="${e}"]')`;
const act = (e) => `${row(e)}?.querySelector('.act')`;
const FAST = { call: 2500, join: 2500, move: 3000, poll: 250, fast: 120 };

async function open(query = '', vp = { width: 1280, height: 800 }, timeouts = FAST) {
  const page = await browser.newPage();
  await hermetic(page);
  await page.setViewport({ deviceScaleFactor: 1, ...vp });
  await page.evaluateOnNewDocument((t) => { window.__jbSpeakerTimeouts = t; window.__jbUndoMs = 8000; }, timeouts);
  await page.goto(`${BASE}?fresh=1&latency=30${/[?&]gap=/.test(query) ? '' : '&gap=500'}${query.includes('tab=') ? '' : '&tab=now'}${query}`);
  await page.waitForFunction('window.__ready === true');
  await sleep(150);
  return page;
}
async function rectOf(page, expr) {
  return page.evaluate((expr) => {
    const el = eval(expr);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, l: r.left, t: r.top, r: r.right, b: r.bottom };
  }, expr);
}
async function tap(page, expr) {
  const r = await rectOf(page, expr);
  if (!r || !r.w) throw new Error('no element to tap: ' + expr);
  await page.mouse.click(r.x, r.y);
  await sleep(60);
}
const wait = (page, fn, timeout = 5000) => page.waitForFunction(fn, { timeout, polling: 40 }).then(() => true, () => false);
const ev = (page, expr) => page.evaluate((e) => eval(e), expr);
const calls = (page) => page.evaluate(() => window.__calls.map(({ t, ...c }) => c));
const ma = (page, cmd) => page.evaluate((cmd) => window.__maLog.filter((x) => !cmd || x.command === cmd), cmd);
// reads (players/all, config/players/get, player_queues/get) are left out: only commands that change something
const maCmds = (page) => page.evaluate(() => window.__maLog.map((x) => x.command).filter((c) => !['players/all', 'config/players/get', 'player_queues/get'].includes(c)));
const events = (page) => page.evaluate(() => window.__maEvents.map((e) => e.type ?? e[0] ?? e));
const toast = (page) => ev(page, `${SR}.querySelector('.toast')?.textContent?.trim() ?? ''`);
const askLines = (page) => ev(page, `[...${SR}.querySelectorAll('.sp-ask .tk')].map((x) => x.textContent.trim())`);
const askTitle = (page) => ev(page, `${SR}.querySelector('.sp-ask h3, .sp-ask .t, .sp-ask b')?.textContent?.trim() ?? ''`);
const hasAsk = (page) => ev(page, `!!${SR}.querySelector('.sp-ask')`);
const target = (page) => ev(page, `${NOW}.config.entity`);
const maMembers = (page, g) => page.evaluate((g) => window.__ma.G[g].members.slice(), g);
const st = (page, e) => page.evaluate((e) => window.__hass.states[e]?.state, e);
const joins = (page) => page.evaluate(() => window.__calls.filter((c) => c.domain === 'media_player' && /^(join|unjoin)$/.test(c.service)));
async function openPanel(page) {
  await tap(page, `__card.shadowRoot.querySelector('.pill')`);
  await wait(page, `${SPK}.open && !!${SR}.querySelector('section.sheet')`);
  await sleep(250);
}
async function waitLoaded(page) { return wait(page, `${SPK}.store?.loaded && !!${SR}.querySelector('[data-room] .where')`); }
async function confirm(page, yes = true) {
  await wait(page, `!!${SR}.querySelector('.sp-ask')`);
  await tap(page, `${SR}.querySelector('.sp-ask [data-action="${yes ? 'confirm' : 'cancel'}"]')`);
}
async function sliderTo(page, sliderExpr, frac) {
  const r = await rectOf(page, sliderExpr);
  const x = r.l + r.w * frac;
  await page.mouse.move(x, r.y); await page.mouse.down(); await sleep(30); await page.mouse.up(); await sleep(150);
}
const allJoins = [];

// ───────────── 0.4 regression (fixed is the default) ─────────────
{
  const seq = async (cfg) => {
    const p = await open(cfg ? `&cfg=${encodeURIComponent(J(cfg))}` : '');
    await tap(p, `${NOW}.shadowRoot.querySelector('.pp')`); await sleep(300);
    await tap(p, `${NOW}.shadowRoot.querySelector('.pp')`); await sleep(300);
    await sliderTo(p, `${NOW}.shadowRoot.querySelector('[data-room="${KIT}"] jb-slider, .vr [data-room="${KIT}"] jb-slider') ?? ${NOW}.shadowRoot.querySelectorAll('jb-slider')[1]`, 0.25);
    const c = await calls(p);
    const m = await page_ma(p);
    allJoins.push(...(await joins(p)));
    return { p, c, m };
  };
  // the queue tab's buffer read (player_queues/get, admins only: it gates the row actions) and the dynamic panel's
  // group-config read (config/players/get) are not counted here
  const page_ma = (p) => p.evaluate(() => window.__maLog.map((x) => x.command).filter((c) => c !== 'player_queues/get' && c !== 'config/players/get'));
  const a = await seq(null);
  const b = await seq({ speaker_mode: 'fixed', grouping: 'admins', guest_access: 'volume', leader_drop: 'block', large_buttons: false });
  check('R1 default config = fixed mode: no Music Assistant players/* calls at all (not even players/all)', a.m.length === 0, J(a.m));
  const writes = (c) => c.filter((x) => !/^get_/.test(x.service));
  check('R2 default config makes the same (write) calls as an explicit fixed config', J(writes(a.c)) === J(writes(b.c)) && writes(a.c).length >= 3, J(writes(a.c).map((x) => x.service)) + ' vs ' + J(writes(b.c).map((x) => x.service)));
  check('R3 fixed mode plays on the configured entity (media_player.everywhere)', a.c.filter((x) => x.domain === 'media_player' && x.service !== 'volume_set').every((x) => x.target?.entity_id === EVERY), J(a.c.map((x) => x.target)));
  const p = a.p;
  const pill = await ev(p, `__card.shadowRoot.querySelector('.pill')?.textContent.replace(/\\s+/g,' ').trim()`);
  check('R4 header status keeps "N rooms synced" in fixed mode', /rooms synced/.test(pill), pill);
  await openPanel(p);
  const fx = await ev(p, `(() => { const r = ${SR}; return { mode: r.querySelector('.sheet').dataset.mode, banner: r.querySelector('.banner')?.dataset.kind, chips: r.querySelectorAll('[data-target]').length, presets: r.querySelectorAll('[data-preset]').length, acts: r.querySelectorAll('.act').length, sliders: r.querySelectorAll('jb-slider').length }; })()`);
  check('R5 tapping the header status opens the Speakers panel; fixed = mixer only (no chips, presets or join/drop)', fx.mode === 'fixed' && fx.banner === 'fixed' && fx.chips === 0 && fx.presets === 0 && fx.acts === 0 && fx.sliders === 4, J(fx));
  const n0 = (await calls(p)).length;
  await sliderTo(p, `${row(GAR)}.querySelector('jb-slider')`, 0.5);
  const vs = (await calls(p)).slice(n0).filter((x) => x.service === 'volume_set');
  check('R6 fixed panel room slider → media_player.volume_set on that room (HA only)', vs.length >= 1 && vs.at(-1).target.entity_id === GAR && Math.abs(vs.at(-1).data.volume_level - 0.5) < 0.08, J(vs.at(-1)));
  check('R7 fixed panel makes no Music Assistant players/* calls', (await page_ma(p)).length === 0, J(await page_ma(p)));
  await tap(p, `${SR}.querySelector('.x')`); await sleep(300);
  check('R8 close button closes the panel', !(await ev(p, `${SPK}.open`)));
  await a.p.close(); await b.p.close();
}

// ───────────── guest lock ─────────────
{
  const p = await open('&spk=dyn&target=' + IN);
  await openPanel(p); await waitLoaded(p);
  const g = await ev(p, `(() => { const r = ${SR}; return { guest: r.querySelector('.sheet').dataset.guest, banner: r.querySelector('.banner')?.textContent, chips: r.querySelectorAll('[data-target]').length, presets: r.querySelectorAll('[data-preset]').length, acts: r.querySelectorAll('.act').length, dis: [...r.querySelectorAll('jb-slider')].some((s) => s.disabled) }; })()`);
  check('G1 guest (non-admin, not listed): volume only — no Play-on chips, presets or join/drop buttons', g.guest === 'yes' && g.chips === 0 && g.presets === 0 && g.acts === 0 && !g.dis && /Volume only/.test(g.banner), J(g));
  await ev(p, `${SPK}.dispatchEvent(new CustomEvent('jukebox-target', { detail: { entity: '${OUT}' }, bubbles: true, composed: true }))`); await sleep(200);
  check('G2 a guest cannot retarget the card (jukebox-target ignored)', (await target(p)) === IN);
  const w = (await maCmds(p)).filter((c) => c !== 'players/all');
  check('G3 guest panel makes no MA write calls', w.length === 0, J(w));
  await p.close();
  const p2 = await open(`&spk=dyn&ma=split&target=${IN}&user=Kitchen%20Tablet&cfg=${encodeURIComponent(J({ grouping_users: ['Kitchen Tablet'] }))}`);
  await openPanel(p2); await waitLoaded(p2);
  const g2 = await ev(p2, `({ chips: ${SR}.querySelectorAll('[data-target]').length, acts: ${SR}.querySelectorAll('.act').length })`);
  check('G4 grouping_users lists this (non-admin) user → grouping allowed', g2.chips === 3 && g2.acts === 3, J(g2));
  await p2.close();
  const p3 = await open(`&spk=dyn&target=${IN}&cfg=${encodeURIComponent(J({ guest_access: 'none' }))}`);
  await openPanel(p3); await waitLoaded(p3);
  const g3 = await ev(p3, `({ panel: [...${SR}.querySelectorAll('jb-slider')].every((s) => s.disabled), now: [...${NOW}.shadowRoot.querySelectorAll('jb-slider')].filter((s) => !s.classList.contains('seek') && s.closest?.('.vr, .vol, .vrow') ).every((s) => s.disabled), banner: ${SR}.querySelector('.banner')?.textContent })`);
  check('G5 guest_access: none → panel volume sliders disabled', g3.panel && /Ask an admin/.test(g3.banner), J(g3));
  const n0 = (await calls(p3)).length;
  await sliderTo(p3, `${row(KIT)}.querySelector('jb-slider')`, 0.9);
  check('G6 guest_access: none → no volume_set from a locked slider', (await calls(p3)).slice(n0).filter((x) => x.service === 'volume_set').length === 0);
  await p3.close();
  const p4 = await open(`&spk=dyn&ma=split&target=${IN}&admin=1&cfg=${encodeURIComponent(J({ guest_access: 'none' }))}`);
  await openPanel(p4); await waitLoaded(p4);
  check('G7 admins keep everything with guest_access: none', await ev(p4, `${SR}.querySelectorAll('.act').length === 3 && ![...${SR}.querySelectorAll('jb-slider')].some((s) => s.disabled)`));
  await p4.close();
}

// ───────────── quiet hours ─────────────
{
  const q = { quiet_hours: { start: '00:00', end: '00:00', max_volume: 30 } }; // start === end = all day
  const p = await open(`&spk=dyn&target=${IN}&cfg=${encodeURIComponent(J(q))}`);
  await openPanel(p); await waitLoaded(p);
  const note = await ev(p, `${SR}.querySelector('.quiet')?.textContent.trim()`);
  check('Q1 quiet hours (start === end = all day) shows the cap note to guests', /up to 30%/.test(note ?? ''), note);
  const mx = await ev(p, `${row(KIT)}.querySelector('jb-slider').max`);
  check('Q2 panel sliders carry max = cap (with a cap tick)', Math.abs(mx - 0.3) < 1e-9 && (await ev(p, `!!${row(KIT)}.querySelector('jb-slider').shadowRoot.querySelector('.cap')`)), String(mx));
  const n0 = (await calls(p)).length;
  await sliderTo(p, `${row(KIT)}.querySelector('jb-slider')`, 0.95);
  const vs = (await calls(p)).slice(n0).filter((x) => x.service === 'volume_set');
  check('Q3 guest dragging to 95% sends at most the cap (0.30)', vs.length >= 1 && vs.every((x) => x.data.volume_level <= 0.3 + 1e-9), J(vs.map((x) => x.data.volume_level)));
  await tap(p, `${SR}.querySelector('.x')`); await sleep(300);
  const ns = await ev(p, `[...${NOW}.shadowRoot.querySelectorAll('jb-slider')].filter((s) => s.max !== undefined && s.max < 1).length`);
  check('Q4 Now Playing volume sliders are capped too', ns >= 1, String(ns));
  await p.close();
  const p2 = await open(`&spk=dyn&target=${IN}&admin=1&cfg=${encodeURIComponent(J(q))}`);
  await openPanel(p2); await waitLoaded(p2);
  const n1 = (await calls(p2)).length;
  await sliderTo(p2, `${row(KIT)}.querySelector('jb-slider')`, 0.9);
  const v2 = (await calls(p2)).slice(n1).filter((x) => x.service === 'volume_set');
  check('Q5 quiet hours apply to guests only by default (admin reaches 90%)', !(await ev(p2, `!!${SR}.querySelector('.quiet')`)) && v2.at(-1)?.data.volume_level > 0.8, J(v2.map((x) => x.data.volume_level)));
  await p2.close();
  const h = new Date().getHours();
  const off = { quiet_hours: { start: `${String((h + 2) % 24).padStart(2, '0')}:00`, end: `${String((h + 3) % 24).padStart(2, '0')}:00`, max_volume: 30 } };
  const p3 = await open(`&spk=dyn&target=${IN}&cfg=${encodeURIComponent(J(off))}`);
  await openPanel(p3); await waitLoaded(p3);
  check('Q6 outside the quiet window there is no cap', !(await ev(p3, `!!${SR}.querySelector('.quiet')`)) && (await ev(p3, `${row(KIT)}.querySelector('jb-slider').max`)) === undefined);
  await p3.close();
}

// ───────────── dynamic: move / start warning / presets (Everywhere playing = default mock) ─────────────
{
  const p = await open('&spk=dyn&admin=1');
  const pill = await ev(p, `__card.shadowRoot.querySelector('.pill')?.textContent.replace(/\\s+/g,' ').trim()`);
  check('M0 dynamic header status counts speakers', /3 speakers/.test(pill), pill);
  await openPanel(p); await waitLoaded(p);
  const d = await ev(p, `(() => { const r = ${SR}; return { mode: r.querySelector('.sheet').dataset.mode, chips: [...r.querySelectorAll('[data-target]')].map((c) => c.dataset.target + ':' + c.getAttribute('aria-checked')), presets: [...r.querySelectorAll('[data-preset]')].map((c) => c.dataset.preset), banner: r.querySelector('.banner')?.dataset.kind, acts: r.querySelectorAll('.act').length }; })()`);
  check('M1 dynamic panel: Play-on chips (Everywhere on), card presets + the MA default "Outdoor default" (config/players/get; the Indoor default equals Dinner, so no duplicate), static Everywhere shown as fixed (no join/drop)',
    d.mode === 'dynamic' && d.chips.length === 3 && d.chips[0] === `${EVERY}:true` && J(d.presets) === J(['Dinner', 'Whole house', 'Outdoor default']) && d.banner === 'static' && d.acts === 0, J(d));
  await tap(p, `${SR}.querySelector('[data-target="${OUT}"]')`);
  await wait(p, `!!${SR}.querySelector('.sp-ask')`);
  // Outdoor idle → just retarget (no transfer needed for an idle target? no: Everywhere active → transfer offers takeovers)
  const lines = await askLines(p);
  check('M2 move to Outdoor warns first: its would-be leader Garage leads Everywhere (static) → takeover line', lines.some((l) => /Everywhere/.test(l)), J(lines));
  await confirm(p, false); await sleep(200);
  check('M3 Cancel → no transfer, still on Everywhere', (await ma(p, 'player_queues/transfer')).length === 0 && (await target(p)) === EVERY);
  await tap(p, `${SR}.querySelector('[data-target="${IN}"]')`);
  const l2 = await askLines(p);
  check('M4 move to Indoor warns that the fixed group Everywhere stops', l2.some((l) => /Everywhere stops: it is a fixed group/.test(l)), J(l2));
  await confirm(p);
  check('M5 optimistic: the chip / card target switch at once', (await target(p)) === IN);
  await wait(p, `window.__hass.states['${IN}'].state === 'playing'`);
  const tr = await ma(p, 'player_queues/transfer');
  check('M6 transfer = mass_queue.send_command player_queues/transfer Everywhere → Indoor (auto_play)',
    tr.length === 1 && tr[0].data.source_queue_id === 'syncgroup_everywhere' && tr[0].data.target_queue_id === 'syncgroup_mock_indoor', J(tr));
  await wait(p, `/Moved to Indoor/.test(${SR}.querySelector('.toast')?.textContent ?? '')`);
  check('M7 toast "Moved to Indoor"; no Undo (Everywhere was stopped)', /Moved to Indoor/.test(await toast(p)) && !(await ev(p, `!!${SR}.querySelector('.ub')`)), await toast(p));
  check('M8 Everywhere stopped, Indoor plays living+kitchen', (await st(p, EVERY)) !== 'playing' && J(await maMembers(p, 'syncgroup_mock_indoor')) === J(['wiim_mock_living', 'wiim_mock_kitchen']));
  check('M9 target persisted per device', (await p.evaluate(() => localStorage.getItem('jukebox-card:target:v1'))) === IN);
  await wait(p, `${SPK}.store.players.get('syncgroup_mock_indoor')?.playback_state === 'playing' && ${row(GAR)}?.querySelector('.act')?.dataset.act === 'join'`);
  // join + undo
  await tap(p, act(GAR));
  await wait(p, `!!${SR}.querySelector('.sp-ask')`, 1500) && (await confirm(p));
  await wait(p, `${row(GAR)}.classList.contains('in')`);
  const sm = await ma(p, 'players/cmd/set_members');
  check('M10 Join Garage → players/cmd/set_members(Indoor, add Garage)', sm.length === 1 && sm[0].data.target_player === 'syncgroup_mock_indoor' && J(sm[0].data.player_ids_to_add) === J(['wiim_mock_garage']), J(sm));
  await wait(p, `!!${SR}.querySelector('.ub')`);
  check('M11 toast "Garage joined Indoor" with Undo', /joined Indoor/.test(await toast(p)) && (await ev(p, `!!${SR}.querySelector('.ub')`)), await toast(p));
  await tap(p, `${SR}.querySelector('.ub')`);
  await wait(p, `${row(GAR)}.classList.contains('out') && !window.__ma.G.syncgroup_mock_indoor.members.includes('wiim_mock_garage')`);
  const sm2 = (await ma(p, 'players/cmd/set_members')).at(-1);
  check('M12 Undo → set_members(Indoor, remove Garage)', J(sm2?.data.player_ids_to_remove) === J(['wiim_mock_garage']), J(sm2));
  // leader drop is blocked by default
  await wait(p, `${act(LIV)}?.dataset.act === 'blocked'`);
  const nSm = (await ma(p, 'players/cmd/set_members')).length;
  check('M13 leader (Living Room) shows "Leader" (blocked) by default', (await ev(p, `${act(LIV)}.textContent.trim()`)) === 'Leader');
  await tap(p, act(LIV));
  check('M14 tapping it explains (Move to hand off) and sends nothing', /leads Indoor/.test(await toast(p)) && (await ma(p, 'players/cmd/set_members')).length === nSm, await toast(p));
  // drop kitchen, then living is the last speaker
  await tap(p, act(KIT));
  await wait(p, `!!${SR}.querySelector('.sp-ask')`, 800) && (await confirm(p));
  await wait(p, `${row(KIT)}.classList.contains('out') && ${act(LIV)}?.textContent.trim() === 'Last'`);
  const sm3 = (await ma(p, 'players/cmd/set_members')).at(-1);
  check('M15 Drop Kitchen → set_members(Indoor, remove Kitchen)', J(sm3?.data.player_ids_to_remove) === J(['wiim_mock_kitchen']), J(sm3));
  await tap(p, act(LIV));
  check('M16 the last speaker cannot be dropped (toast says pause instead)', /last speaker/.test(await toast(p)), await toast(p));
  // preset: Dinner (same target) → re-adds Kitchen and sets capped volumes
  const v0 = (await calls(p)).length;
  await tap(p, `${SR}.querySelector('[data-preset="Dinner"]')`);
  await wait(p, `!!${SR}.querySelector('.sp-ask')`, 800) && (await confirm(p));
  await wait(p, `window.__ma.G.syncgroup_mock_indoor.members.includes('wiim_mock_kitchen')`);
  await wait(p, `/Dinner/.test(${SR}.querySelector('.toast')?.textContent ?? '')`);
  const vols = (await calls(p)).slice(v0).filter((x) => x.service === 'volume_set').map((x) => `${x.target.entity_id}=${x.data.volume_level}`);
  check('M17 preset Dinner → set_members adds Kitchen back, sets 35 % / 30 %', vols.includes(`${LIV}=0.35`) && vols.includes(`${KIT}=0.3`), J(vols));
  check('M18 preset toast names it', /Dinner/.test(await toast(p)), await toast(p));
  allJoins.push(...(await joins(p)));
  await p.close();
}

// ───────────── leader drop allowed (re-form gap) ─────────────
{
  const p = await open(`&spk=dyn&admin=1&ma=split&target=${IN}&cfg=${encodeURIComponent(J({ leader_drop: 'allow' }))}`);
  await openPanel(p); await waitLoaded(p);
  const lead = await p.evaluate(() => window.__ma.G.syncgroup_mock_indoor.members[0]);
  const leadRoom = lead === 'wiim_mock_kitchen' ? KIT : LIV;
  await wait(p, `${act(leadRoom)}?.dataset.act === 'drop'`);
  check('L1 leader_drop: allow → the leader row offers Drop', (await ev(p, `${act(leadRoom)}.dataset.act`)) === 'drop');
  await tap(p, act(leadRoom));
  await wait(p, `!!${SR}.querySelector('.sp-ask')`);
  const t = await ev(p, `${SR}.querySelector('.sp-ask').textContent`);
  check('L2 dropping the leader asks first (the group restarts)', /restart|pause|leads/i.test(t), t.replace(/\s+/g, ' ').slice(0, 160));
  await confirm(p);
  const sawBuf = await wait(p, `window.__hass.states['${IN}'].state === 'buffering'`, 2000);
  const rg = await wait(p, `${SR}.querySelector('.stl')?.textContent.includes('Regrouping…')`, 1500);
  await wait(p, `window.__hass.states['${IN}'].state === 'playing' && !window.__ma.G.syncgroup_mock_indoor.members.includes('${lead}')`, 4000);
  const evs = await events(p);
  check('L3 MA re-forms the group after a gap (buffering → playing, reform event)', sawBuf && evs.some((e) => /reform/.test(J(e))), J(evs));
  const rg2 = await wait(p, `!${SR}.querySelector('.stl')?.textContent.includes('Regrouping…')`, 2000);
  check('L3b the status says "Regrouping…" during the re-form and stops once the new leader plays', rg && rg2, J({ rg, rg2, now: await ev(p, `${SR}.querySelector('.stl')?.textContent`) }));
  await wait(p, `!!${SR}.querySelector('.ub')`, 3000);
  check('L4 toast + Undo after dropping the leader', !!(await ev(p, `${SR}.querySelector('.ub')`)), await toast(p));
  await p.close();
}

// ───────────── take between dynamic groups / start warning / hijack / dissolve ─────────────
{
  const p = await open(`&spk=dyn&admin=1&ma=split&target=${OUT}`);
  await openPanel(p); await waitLoaded(p);
  const w = await ev(p, `${row(GAR)}.querySelector('.where').textContent`);
  check('S1 per-room status: Garage "Playing alone · <station>"', /Playing alone · Mock Radio/.test(w), w);
  const wk = await ev(p, `${row(KIT)}.querySelector('.where').textContent`);
  check('S2 per-room status: Kitchen "In Indoor · <title>"', /^In Indoor · \S/.test(wk), wk);
  await tap(p, `${SR}.querySelector('.x')`); await sleep(250);
  const els = await ev(p, `[...${NOW}.shadowRoot.querySelectorAll('.vn .else')].map((x) => x.textContent.trim())`);
  check('S3 Now Playing per-room rows show what an ungrouped room plays', els.some((x) => /Mock Radio/.test(x)), J(els));
  // start warning via the play guard
  const n0 = (await calls(p)).length;
  await tap(p, `${NOW}.shadowRoot.querySelector('.pp')`);
  await wait(p, `!!${SR}.querySelector('.sp-ask')`);
  const sl = await askLines(p);
  check('S4 pressing Play on idle Outdoor warns first: Garage stops what it is playing', sl.some((l) => /Garage stops what it is playing/.test(l)), J(sl));
  await confirm(p, false); await sleep(200);
  check('S5 Cancel → nothing played', (await calls(p)).slice(n0).filter((x) => /media_play|play_media|media_play_pause/.test(x.service)).length === 0, J((await calls(p)).slice(n0)));
  await tap(p, `${NOW}.shadowRoot.querySelector('.pp')`);
  await confirm(p);
  await wait(p, `window.__hass.states['${OUT}'].state === 'playing'`);
  check('S6 Start → Outdoor powers on and takes the solo Garage (solo-stop)', (await events(p)).some((e) => /solo/.test(J(e))) && J(await maMembers(p, 'syncgroup_mock_outdoor')) === J(['wiim_mock_garage']), J(await events(p)));
  await openPanel(p);
  await wait(p, `${act(KIT)}?.dataset.act === 'take'`);
  const lbl = await ev(p, `${act(KIT)}.textContent.trim()`);
  check('S7 a speaker held by another group shows "Take from Indoor"', lbl === 'Take from Indoor', lbl);
  const qBefore = await p.evaluate(() => J(window.__queues['media_player.indoor']?.items?.map((i) => i.media_title ?? i.title ?? i.name)), null).catch(() => null);
  await tap(p, act(KIT));
  await wait(p, `!!${SR}.querySelector('.sp-ask')`);
  const kl = await askLines(p);
  const kitLeads = (await maMembers(p, 'syncgroup_mock_indoor'))[0] === 'wiim_mock_kitchen';
  check('S8 confirm explains the cost (leader → Indoor restarts; member → keeps playing)', kl.some((l) => (kitLeads ? /Indoor pauses briefly and restarts/ : /Kitchen leaves Indoor; Indoor keeps playing/).test(l)), J(kl));
  await confirm(p);
  await wait(p, `${row(KIT)}.classList.contains('in') && window.__ma.G.syncgroup_mock_outdoor.members.includes('wiim_mock_kitchen')`);
  await wait(p, `window.__hass.states['${IN}'].state === 'playing'`, 4000);
  const sm = (await ma(p, 'players/cmd/set_members')).at(-1);
  check('S9 take = set_members(Outdoor, add Kitchen) — a move between playing dynamic groups', sm?.data.target_player === 'syncgroup_mock_outdoor' && J(sm.data.player_ids_to_add) === J(['wiim_mock_kitchen']), J(sm));
  const qAfter = await p.evaluate(() => JSON.stringify(window.__queues['media_player.indoor']?.items?.map((i) => i.media_title ?? i.title ?? i.name))).catch(() => null);
  check('S10 Indoor keeps playing its own queue (Living Room only)', (await st(p, IN)) === 'playing' && J(await maMembers(p, 'syncgroup_mock_indoor')) === J(['wiim_mock_living']) && (qBefore == null || qAfter === JSON.parse(J(qBefore))), J(await maMembers(p, 'syncgroup_mock_indoor')));
  await wait(p, `!!${SR}.querySelector('.ub')`);
  await tap(p, `${SR}.querySelector('.ub')`);
  await wait(p, `window.__ma.G.syncgroup_mock_indoor.members.includes('wiim_mock_kitchen')`);
  const u = (await ma(p, 'players/cmd/set_members')).at(-1);
  check('S11 Undo gives Kitchen back to Indoor (set_members(Indoor, add Kitchen))', u?.data.target_player === 'syncgroup_mock_indoor' && J(u.data.player_ids_to_add) === J(['wiim_mock_kitchen']), J(u));
  // dissolve: take Indoor's speakers one by one; the last one stops Indoor
  await wait(p, `${act(KIT)}?.dataset.act === 'take'`);
  await tap(p, act(KIT)); await confirm(p);
  await wait(p, `window.__ma.G.syncgroup_mock_outdoor.members.includes('wiim_mock_kitchen') && ${act(LIV)}?.dataset.act === 'take'`, 5000);
  await wait(p, `window.__hass.states['${IN}'].state === 'playing'`, 4000);
  await wait(p, `${SPK}.store.players.get('syncgroup_mock_indoor')?.group_members?.length === 1`, 3000);
  await tap(p, act(LIV));
  await wait(p, `!!${SR}.querySelector('.sp-ask')`);
  const ll = await askLines(p);
  check('S12 taking Indoor\'s last speaker warns "Indoor stops: Living Room is its last speaker."', ll.some((l) => /Indoor stops: Living Room is its last speaker/.test(l)), J(ll));
  await confirm(p);
  await wait(p, `window.__hass.states['${IN}'].state !== 'playing' && window.__ma.G.syncgroup_mock_outdoor.members.length === 3`, 4000);
  check('S13 moving the last speaker dissolves Indoor (dissolve event)', (await events(p)).some((e) => /dissolve/.test(J(e))) && (await st(p, IN)) !== 'playing', J(await events(p)));
  allJoins.push(...(await joins(p)));
  await p.close();
}
{
  // hijack: start Outdoor while Everywhere plays (Garage leads Everywhere)
  const p = await open(`&spk=dyn&admin=1&target=${OUT}`);
  await tap(p, `${NOW}.shadowRoot.querySelector('.pp')`);
  await wait(p, `!!${SR}.querySelector('.sp-ask')`);
  const t = await ev(p, `${SR}.querySelector('.sp-ask').textContent.replace(/\\s+/g,' ')`);
  check('H1 "Start Outdoor?" warns that Everywhere is taken over (Garage leads it)', /Start Outdoor/.test(t) && /Everywhere is taken over: Garage leads it/.test(t), t.slice(0, 200));
  await confirm(p);
  await wait(p, `window.__hass.states['${OUT}'].state === 'playing'`);
  check('H2 hijack: all of Everywhere switches to Outdoor', (await events(p)).some((e) => /hijack/.test(J(e))) && (await maMembers(p, 'syncgroup_mock_outdoor')).length === 3 && (await st(p, EVERY)) !== 'playing', J(await maMembers(p, 'syncgroup_mock_outdoor')));
  await p.close();
}

// ───────────── MA rules: nesting, static target, native-leader refusal, take from a static group ─────────────
{
  const p = await open(`&spk=dyn&admin=1&target=${IN}`);
  const err = (f) => p.evaluate(f).then(() => 'ok', (e) => String(e?.message ?? e));
  const nest = await err(() => window.__card.speakers.setMembers('syncgroup_mock_indoor', ['syncgroup_mock_outdoor'], []));
  check('N1 groups cannot nest (set_members with a group id is refused)', nest !== 'ok', nest);
  const stat = await err(() => window.__card.speakers.setMembers('syncgroup_everywhere', [], ['wiim_mock_kitchen']));
  check('N2 a static group cannot be changed with set_members (live: 500 "Player X does not support group commands")', /does not support group commands/.test(stat), stat);
  // overlap MA can reach: Everywhere playing and Indoor playing with Living only (forced)
  await p.evaluate(() => window.__ma.force('syncgroup_mock_indoor', 'playing', ['wiim_mock_living']));
  const lead = await err(() => window.__card.speakers.setMembers('syncgroup_mock_indoor', ['wiim_mock_garage'], []));
  check('N3 a speaker leading a playing native group is refused by set_members', lead !== 'ok' && /lead/i.test(lead), lead);
  const nMa = (await maCmds(p)).length;
  await openPanel(p); await waitLoaded(p);
  await wait(p, `${act(GAR)}?.dataset.act === 'take'`);
  check('N4 Garage (in the fixed group Everywhere) shows "Take from Everywhere"', (await ev(p, `${act(GAR)}.textContent.trim()`)) === 'Take from Everywhere');
  await tap(p, act(GAR));
  await wait(p, `!!${SR}.querySelector('.sp-ask')`);
  const tl = await askLines(p);
  check('N5 the confirm warns that taking it stops all of Everywhere', tl.some((l) => /Everywhere stops: it is a fixed group/.test(l)), J(tl));
  await confirm(p);
  await wait(p, `window.__ma.G.syncgroup_mock_indoor.members.includes('wiim_mock_garage')`, 5000);
  const cmds = (await maCmds(p)).slice(nMa);
  check('N6 the card stops Everywhere first (players/cmd/stop), then set_members — no refusal', cmds.indexOf('players/cmd/stop') > -1 && cmds.indexOf('players/cmd/stop') < cmds.lastIndexOf('players/cmd/set_members') && (await st(p, EVERY)) !== 'playing', J(cmds));
  await wait(p, `/joined Indoor/.test(${SR}.querySelector('.toast')?.textContent ?? '')`, 3000);
  check('N7 no Undo after stopping a fixed group', !(await ev(p, `!!${SR}.querySelector('.ub')`)), await toast(p));
  allJoins.push(...(await joins(p)));
  await p.close();
}

// ───────────── failures: optimistic UI reverts with a toast ─────────────
{
  const p = await open(`&spk=dyn&admin=1&ma=split&target=${IN}&grp=fail`);
  await openPanel(p); await waitLoaded(p);
  await wait(p, `${act(GAR)}?.dataset.act === 'take'`);
  await tap(p, act(GAR)); await confirm(p);
  await wait(p, `/Couldn't add Garage/.test(${SR}.querySelector('.toast')?.textContent ?? '')`);
  check('F1 set_members fails → toast "Couldn\'t add Garage …" and the row reverts', /Couldn't add Garage/.test(await toast(p)) && (await ev(p, `${row(GAR)}.classList.contains('out')`)), await toast(p));
  await p.close();
  const p2 = await open(`&spk=dyn&admin=1&ma=split&target=${IN}&grp=timeout`, undefined, { ...FAST, join: 900, call: 900 });
  await openPanel(p2); await waitLoaded(p2);
  await wait(p2, `${act(GAR)}?.dataset.act === 'take'`);
  await tap(p2, act(GAR)); await confirm(p2);
  const pending = await wait(p2, `${row(GAR)}.classList.contains('pending')`, 600);
  await wait(p2, `/Couldn't add/.test(${SR}.querySelector('.toast')?.textContent ?? '')`, 4000);
  check('F2 set_members never answers → pending row, then timeout toast "no answer in time" and revert', pending && /no answer in time/.test(await toast(p2)) && (await ev(p2, `${row(GAR)}.classList.contains('out')`)), await toast(p2));
  await p2.close();
  const p3 = await open(`&spk=dyn&admin=1&ma=split&target=${IN}&xfer=timeout`, undefined, { ...FAST, move: 900, call: 900 });
  await openPanel(p3); await waitLoaded(p3);
  await tap(p3, `${SR}.querySelector('[data-target="${OUT}"]')`);
  if (await wait(p3, `!!${SR}.querySelector('.sp-ask')`, 800)) await confirm(p3);
  const opt = (await target(p3)) === OUT;
  await wait(p3, `/Couldn't move to Outdoor/.test(${SR}.querySelector('.toast')?.textContent ?? '')`, 4000);
  check('F3 transfer times out → optimistic switch reverts to Indoor with "Couldn\'t move to Outdoor … Still on Indoor."', opt && (await target(p3)) === IN && /Still on Indoor/.test(await toast(p3)), await toast(p3));
  await p3.close();
  const p4 = await open(`&spk=dyn&admin=1&ma=split&target=${IN}&xfer=fail`);
  await openPanel(p4); await waitLoaded(p4);
  await tap(p4, `${SR}.querySelector('[data-target="${OUT}"]')`);
  if (await wait(p4, `!!${SR}.querySelector('.sp-ask')`, 800)) await confirm(p4);
  await wait(p4, `/Couldn't move/.test(${SR}.querySelector('.toast')?.textContent ?? '')`, 4000);
  check('F4 transfer fails → revert + toast', (await target(p4)) === IN && /Couldn't move to Outdoor/.test(await toast(p4)), await toast(p4));
  await p4.close();
}

// ───────────── large buttons, phone, short card ─────────────
{
  const sizes = async (p) => ev(p, `(() => { const n = ${NOW}.shadowRoot; const pp = n.querySelector('.pp').getBoundingClientRect(); const tab = __card.shadowRoot.querySelector('.tab')?.getBoundingClientRect(); return { pp: Math.round(pp.height), tab: Math.round(tab?.height ?? 0), lg: __card.shadowRoot.querySelector('ha-card').classList.contains('lg'), large: n.host.hasAttribute('large') }; })()`);
  const a = await open('&spk=dyn&admin=1');
  const b = await open(`&spk=dyn&admin=1&cfg=${encodeURIComponent(J({ large_buttons: true }))}`);
  const sa = await sizes(a), sb = await sizes(b);
  check('B1 large_buttons: card gets .lg and children [large]', sb.lg && sb.large && !sa.lg && !sa.large, J({ sa, sb }));
  check('B2 large_buttons: bigger play button and tabs', sb.pp > sa.pp && sb.tab >= sa.tab, J({ sa, sb }));
  await openPanel(a); await waitLoaded(a); await openPanel(b); await waitLoaded(b);
  const ha = await rectOf(a, `${SR}.querySelector('[data-target]')`), hb = await rectOf(b, `${SR}.querySelector('[data-target]')`);
  check('B3 large_buttons: bigger panel chips', hb.h > ha.h && hb.h >= 52, `${ha.h} → ${hb.h}`);
  await a.close(); await b.close();
  const c = await open('&spk=dyn&admin=1', { width: 390, height: 844, isMobile: true, hasTouch: true });
  const pr = await rectOf(c, `__card.shadowRoot.querySelector('.pill')`);
  check('B4 phone: header status is an icon button ≥ 44 px', pr && pr.w >= 44 && pr.h >= 44, J(pr));
  await c.close();
  for (const vp of [{ width: 1280, height: 600 }, { width: 390, height: 600 }, { width: 1280, height: 420 }]) {
    const p = await open(`&spk=dyn&admin=1&ma=split&target=${IN}`, vp);
    await openPanel(p); await waitLoaded(p); await sleep(300);
    const r = await ev(p, `(() => { const host = ${SPK}.getBoundingClientRect(); const sh = ${SR}.querySelector('.sheet').getBoundingClientRect(); const b = ${SR}.querySelector('.body'); return { host: [host.top, host.bottom].map(Math.round), sheet: [sh.top, sh.bottom].map(Math.round), sh: b.scrollHeight, ch: b.clientHeight, ov: getComputedStyle(b).overflowY }; })()`);
    const inside = r.sheet[0] >= r.host[0] - 1 && r.sheet[1] <= r.host[1] + 1;
    let scrolls = true;
    if (r.sh > r.ch + 2) { await ev(p, `${SR}.querySelector('.body').scrollTop = 9999`); scrolls = (await ev(p, `${SR}.querySelector('.body').scrollTop`)) > 0; }
    check(`B5 ${vp.width}x${vp.height}: the panel stays inside the card height and its body scrolls`, inside && r.ov === 'auto' && scrolls, J(r));
    await p.close();
  }
}

// ---------- J. Queue rows: Play now (confirm → play_index) / Play next (move_item, no confirm) ----------
{
  const QV = `__card.shadowRoot.querySelector('jb-queue').shadowRoot`;
  const qrow = (id) => `${QV}.querySelector('.qr[data-id="${id}"]')`;
  const qbtn = (id, a) => `${qrow(id)}?.querySelector('.qa[data-action="${a}"]')`;
  const rows = (p) => ev(p, `[...${QV}.querySelectorAll('.qr')].map((r) => ({ id: r.dataset.id, k: ['now', 'next', 'past'].find((k) => r.classList.contains(k)),
    pn: !!r.querySelector('.qa[data-action="playnow"]'), nx: r.querySelector('.qa[data-action="playnext"]') ? (r.querySelector('.qa[data-action="playnext"]').disabled ? 'dis' : 'on') : '',
    up: !!r.querySelector('.qa[data-action="up"]'), rm: !!r.querySelector('.qa[data-action="remove"]') }))`);
  const sends = (p) => ev(p, `window.__calls.filter((c) => c.service === 'send_command' && ['player_queues/play_index', 'player_queues/move_item'].includes(c.data?.command)).map(({ t, ...c }) => c)`);
  const mass = (p, svc) => ev(p, `window.__calls.filter((c) => c.domain === 'mass_queue' && c.service === '${svc}').length`);
  const openQ = async (q, vp) => { const p = await open(`&tab=queue${q}`, vp); await wait(p, `${QV}.querySelectorAll('.qr.next').length > 3`); await sleep(150); return p; };
  const dlg = (p) => ev(p, `(() => { const c = ${QV}.querySelector('.confirm'); return c ? { q: c.querySelector('#cf-q')?.textContent.trim(), b: c.querySelector('#cf-b')?.textContent.trim(), btn: [...c.querySelectorAll('.cbtn')].map((x) => x.textContent.trim()), kind: c.dataset.kind } : null; })()`);

  const p = await openQ('&admin=1');
  let r = await rows(p);
  const nx = r.filter((x) => x.k === 'next'), nowR = r.find((x) => x.k === 'now');
  check('J1 admin: Play now + Play next + Remove on Up next rows; Play now and Remove hidden on the playing row; Play next disabled on the row already next',
    nx.every((x) => x.pn && x.rm) && nx[0].nx === 'dis' && nx.slice(1).every((x) => x.nx === 'on') && nowR && !nowR.pn && !nowR.rm && nowR.nx === '' && nx.every((x) => x.up), J(r.slice(0, 5)));
  // Play now → confirm (nothing sent yet)
  const target = nx[2].id;
  await tap(p, qbtn(target, 'playnow'));
  const d = await dlg(p);
  check('J2 Play now asks first: "Play this now? The current song will stop." with Cancel / Play now; nothing sent yet',
    d && d.kind === 'jump' && d.q === 'Play this now?' && d.b === 'The current song will stop.' && d.btn[0] === 'Cancel' && d.btn[1] === 'Play now' && (await sends(p)).length === 0, J(d));
  await tap(p, `${QV}.querySelector('.confirm .cbtn[data-action="cancel"]')`); await sleep(300);
  check('J3 Cancel closes the dialog and sends nothing', !(await dlg(p)) && (await sends(p)).length === 0 && (await mass(p, 'play_queue_item')) === 0);
  await tap(p, qbtn(target, 'playnow'));
  await tap(p, `${QV}.querySelector('.confirm .cbtn[data-action="confirm"]')`);
  await wait(p, `${QV}.querySelector('.qr.now')?.dataset.id === '${target}'`, 4000);
  let sc = await sends(p);
  const nowId = await ev(p, `${QV}.querySelector('.qr.now')?.dataset.id`);
  check('J4 confirm → one mass_queue.send_command player_queues/play_index {queue_id, index: queue_item_id}; the row becomes Now playing (the mock rejects a wrong config_entry_id)',
    sc.length === 1 && sc[0].data.command === 'player_queues/play_index' && J(sc[0].data.data) === J({ queue_id: 'syncgroup_everywhere', index: target })
      && (await mass(p, 'play_queue_item')) === 0 && nowId === target, J(sc) + ' now=' + nowId);
  await sleep(900);
  // Play next on the 4th Up next row: pos_shift = (current + 1) - index = -3, no dialog
  r = await rows(p);
  let up = r.filter((x) => x.k === 'next');
  const mv = up[3].id;
  await tap(p, qbtn(mv, 'playnext')); await sleep(80);
  const d2 = await dlg(p);
  await wait(p, `${QV}.querySelector('.qr.next')?.dataset.id === '${mv}'`, 3000); await sleep(900);
  sc = (await sends(p)).slice(1);
  const first = await ev(p, `${QV}.querySelector('.qr.next')?.dataset.id`);
  const maQ = await ev(p, `(() => { const Q = window.__queues['media_player.everywhere']; return Q.items[Q.index + 1].queue_item_id; })()`);
  check('J5 Play next: no dialog; player_queues/move_item {queue_id, queue_item_id, pos_shift: -3}; it is next in the card and in MA',
    !d2 && sc.length === 1 && sc[0].data.command === 'player_queues/move_item' && J(sc[0].data.data) === J({ queue_id: 'syncgroup_everywhere', queue_item_id: mv, pos_shift: -3 })
      && first === mv && maQ === mv, J(sc) + ` first=${first} ma=${maQ}`);
  r = await rows(p);
  check('J6 after the move the new next row has Play next disabled and the old one is enabled', r.find((x) => x.id === mv).nx === 'dis' && r.filter((x) => x.k === 'next')[1].nx === 'on', J(r.slice(0, 4)));
  const pastR = r.filter((x) => x.k === 'past');
  check('J7 played rows: Play now only (MA refuses to move or delete played items)', pastR.length > 0 && pastR.every((x) => x.pn && x.nx === '' && !x.rm), J(pastR));
  const u0 = await mass(p, 'move_queue_item_up');
  await tap(p, qbtn(r.filter((x) => x.k === 'next')[2].id, 'up')); await sleep(300);
  check('J8 Move up still acts at once (no dialog, mass_queue.move_queue_item_up)', !(await dlg(p)) && (await mass(p, 'move_queue_item_up')) === u0 + 1);
  await p.close();
}
{
  const QV = `__card.shadowRoot.querySelector('jb-queue').shadowRoot`;
  const openQ = async (q, vp) => { const p = await open(`&tab=queue${q}`, vp); await wait(p, `${QV}.querySelectorAll('.qr.next').length > 3`); await sleep(150); return p; };
  const icons = (p) => ev(p, `({ pn: ${QV}.querySelectorAll('.qa[data-action="playnow"]').length, nx: ${QV}.querySelectorAll('.qa[data-action="playnext"]').length, rm: ${QV}.querySelectorAll('.qa[data-action="remove"]').length, up: ${QV}.querySelectorAll('.qr.next .qa[data-action="up"]').length })`);
  let p = await openQ('');
  let c = await icons(p);
  check('J9 guest (volume only, not admin): no Play now / Play next / Remove icons; Move up / down unchanged from 0.4', c.pn === 0 && c.nx === 0 && c.rm === 0 && c.up > 3, J(c));
  await p.close();
  p = await openQ(`&user=Kitchen%20Tablet&cfg=${encodeURIComponent(J({ grouping_users: ['Kitchen Tablet'] }))}`);
  c = await icons(p);
  check('J10 grouping_users lists this non-admin user → icons shown', c.pn > 3 && c.nx > 3 && c.rm > 3, J(c));
  await p.close();
  p = await openQ(`&admin=1&cfg=${encodeURIComponent(J({ grouping: 'nobody' }))}`);
  c = await icons(p);
  check('J11 grouping: nobody → icons hidden even for admins (same lock as grouping)', c.pn === 0 && c.nx === 0 && c.rm === 0, J(c));
  await p.close();
  // wide: all five icons inline; phone: Play next + Remove inline, the rest behind ⋯ (an action sheet)
  for (const vp of [{ width: 390, height: 844, isMobile: true, hasTouch: true }, { width: 1920, height: 1080 }, { width: 1280, height: 800 }]) {
    p = await openQ('&admin=1', vp);
    const m = await ev(p, `(() => { const r = [...${QV}.querySelectorAll('.qr.next')][2]; const rr = r.getBoundingClientRect(); const t = r.querySelector('.rt b').getBoundingClientRect();
      const bs = [...r.querySelectorAll('.qa')].filter((b) => getComputedStyle(b).display !== 'none').map((b) => { const x = b.getBoundingClientRect(); return { a: b.dataset.action || 'more', w: Math.round(x.width), h: Math.round(x.height), l: x.left, r: x.right, t: x.top, b: x.bottom }; });
      return { row: [rr.left, rr.right].map(Math.round), title: { w: Math.round(t.width), r: Math.round(t.right), t: Math.round(t.top), b: Math.round(t.bottom) }, bs }; })()`);
    const narrow = vp.width <= 520;
    const want = narrow ? ['playnext', 'remove', 'more'] : ['playnow', 'playnext', 'up', 'down', 'remove'];
    const set = J(m.bs.map((b) => b.a).sort()) === J([...want].sort());
    const big = m.bs.every((b) => b.w >= 44 && b.h >= 44);
    const inside = m.bs.every((b) => b.l >= m.row[0] - 1 && b.r <= m.row[1] + 1);
    const oneLine = m.bs.every((b) => b.l >= m.title.r - 1 && b.t < m.title.b && b.b > m.title.t);
    const right = Math.abs(Math.max(...m.bs.map((b) => b.r)) - m.row[1]) < 24;
    const titleW = narrow ? m.title.w >= 120 : m.title.w >= 300;
    check(`J12 ${vp.width}x${vp.height}: ${narrow ? 'Play next + Remove inline, ⋯ for the rest' : 'Play now, Play next, Move up, Move down, Remove inline'}; ≥ 44 px, right-aligned, one line beside the title (title ${m.title.w}px)`,
      set && big && inside && oneLine && right && titleW, J(m));
    await p.close();
  }
  // live MA 2.10.9: the buffered track is index_in_buffer (player_queues/get), not current + 1; Play next lands after it
  p = await openQ('&admin=1&qbuf=1');
  await wait(p, `${QV}.querySelector('.qr.next.buf')`, 3000);
  const ids = await ev(p, `[...${QV}.querySelectorAll('.qr.next')].map((r) => r.dataset.id)`);
  await tap(p, `${QV}.querySelector('.qr[data-id="${ids[3]}"] .qa[data-action="playnext"]')`);
  await sleep(1600);
  const after = await ev(p, `[...${QV}.querySelectorAll('.qr.next')].map((r) => r.dataset.id)`);
  const mv = await ev(p, `window.__calls.filter((c) => c.data?.command === 'player_queues/move_item').map((c) => c.data.data.pos_shift)`);
  check('J13 next track already buffered (index_in_buffer = current + 1): Play next lands right after the buffered track, MA agrees after the refresh',
    J(after.slice(0, 2)) === J([ids[0], ids[3]]) && J(mv) === J([-2]) && J(await ev(p, `window.__queues['media_player.everywhere'].items.map((x) => x.queue_item_id)`)).includes(J([ids[0], ids[3]]).slice(1, -1)), J({ ids: ids.slice(0, 4), after: after.slice(0, 4), mv }));
  await p.close();
  // no mass_queue entry: the 0.4 services stand in
  p = await openQ(`&admin=1&cfg=${encodeURIComponent(J({ mass_queue_entry_id: '' }))}`);
  const ids2 = await ev(p, `[...${QV}.querySelectorAll('.qr.next')].map((r) => r.dataset.id)`);
  await tap(p, `${QV}.querySelector('.qr[data-id="${ids2[2]}"] .qa[data-action="playnext"]')`); await sleep(400);
  const fb = await ev(p, `window.__calls.filter((c) => c.domain === 'mass_queue' && c.service !== 'get_queue_items').map((c) => c.service + ':' + J(c.data))`.replace('J(', 'JSON.stringify('));
  check('J14 without mass_queue_entry_id Play next falls back to mass_queue.move_queue_item_next', fb.length === 1 && fb[0].startsWith('move_queue_item_next:'), J(fb));
  await p.close();
}

// ---------- P. Play now only jumps: never resorts, replaces or clears the queue (every Play now path) ----------
// User requirement: "play now not resort or clear the queue". Icon, ⋯ sheet entry, the 0.4 long-press menu entry and a
// row tap (0.4: no confirm) must only move playback to that item in place (play_index / play_queue_item). After each one
// MA's queue and the card's rows keep the same items in the same order, and no replace / clear / move / delete is sent.
{
  const QV = `__card.shadowRoot.querySelector('jb-queue').shadowRoot`;
  const openQ = async (q, vp) => { const p = await open(`&tab=queue${q}`, vp); await wait(p, `${QV}.querySelectorAll('.qr.next').length > 3`); await sleep(150); return p; };
  const maIds = (p) => ev(p, `window.__queues['media_player.everywhere'].items.map((x) => x.queue_item_id)`);
  const rowIds = (p) => ev(p, `[...${QV}.querySelectorAll('.qr')].map((r) => r.dataset.id)`);
  const nowId = (p) => ev(p, `${QV}.querySelector('.qr.now')?.dataset.id`);
  const mark = (p) => ev(p, `[window.__calls.length, (window.__maLog ?? []).length]`);
  const BAD = /play_media|replace|clear|shuffle|move|delete|remove|reorder|transfer/i;
  const sent = (p, m) => ev(p, `[...window.__calls.slice(${m[0]}).filter((c) => c.service !== 'get_queue_items').map((c) => c.domain + '.' + c.service + (c.data?.command ? ':' + c.data.command : '') + ' ' + JSON.stringify(c.data?.data ?? c.data ?? {})),
    ...(window.__maLog ?? []).slice(${m[1]}).map((x) => 'ma:' + x.command + ' ' + JSON.stringify(x.args ?? x.data ?? {}))]`);
  const jumpOnly = (list) => list.filter((x) => !/^ma:players\/all/.test(x)).every((x) => !BAD.test(x)) && list.some((x) => /play_index|play_queue_item/.test(x));
  async function playNowPath(name, p, fire, target) {
    const ma0 = await maIds(p), rows0 = await rowIds(p), m = await mark(p);
    await fire();
    const ok = await wait(p, `${QV}.querySelector('.qr.now')?.dataset.id === '${target}'`, 4000); await sleep(900);
    const ma1 = await maIds(p), rows1 = await rowIds(p), s = await sent(p, m);
    const maIdx = await ev(p, `(() => { const Q = window.__queues['media_player.everywhere']; return Q.items[Q.index]?.queue_item_id; })()`);
    check(`P ${name}: playback jumps to the item in place (now playing = it, in the card and in MA)`, ok && (await nowId(p)) === target && maIdx === target, J({ now: await nowId(p), maIdx, target }));
    check(`P ${name}: MA queue unchanged: same ${ma0.length} items in the same order`, J(ma1) === J(ma0), J({ ma0: ma0.length, ma1: ma1.length, firstDiff: ma0.findIndex((x, i) => x !== ma1[i]) }));
    // the card reads a window (get_queue_items limit_before: 1, as in 0.4): one played row, the playing row, then everything after it.
    // Its rows must be exactly MA's order from one before the playing item: nothing moved, dropped or duplicated.
    const i1 = ma1.indexOf(target), win1 = ma1.slice(Math.max(0, i1 - 1));
    check(`P ${name}: the card's rows are MA's unchanged order (window from one played row: ${rows1.length} rows, was ${rows0.length})`,
      J(rows1) === J(win1) && J(rows0) === J(ma0.slice(ma0.indexOf(rows0[0]))), J({ rows1, win1 }));
    check(`P ${name}: only a jump was sent (play_index / play_queue_item), no play_media / replace / clear / move / delete`, jumpOnly(s), J(s));
  }
  // 1. row icon (wide, admin) → confirm → play_index
  let p = await openQ('&admin=1');
  let t = (await ev(p, `[...${QV}.querySelectorAll('.qr.next')].map((r) => r.dataset.id)`))[3];
  await playNowPath('icon (admin, 1280x800)', p, async () => {
    await tap(p, `${QV}.querySelector('.qr[data-id="${t}"] .qa[data-action="playnow"]')`);
    await tap(p, `${QV}.querySelector('.confirm .cbtn[data-action="confirm"]')`);
  }, t);
  // 1b. a played row's Play now icon (jump back) is also in place
  t = (await ev(p, `[...${QV}.querySelectorAll('.qr.past')].map((r) => r.dataset.id)`))[0];
  await playNowPath('icon on a played row (jump back)', p, async () => {
    await tap(p, `${QV}.querySelector('.qr[data-id="${t}"] .qa[data-action="playnow"]')`);
    await tap(p, `${QV}.querySelector('.confirm .cbtn[data-action="confirm"]')`);
  }, t);
  await p.close();
  // 2. narrow ⋯ action sheet → Play now… → confirm → play_index
  p = await openQ('&admin=1', { width: 390, height: 844, isMobile: true, hasTouch: true });
  t = (await ev(p, `[...${QV}.querySelectorAll('.qr.next')].map((r) => r.dataset.id)`))[4];
  await playNowPath('⋯ sheet entry (admin, 390x844)', p, async () => {
    await ev(p, `${QV}.querySelector('.qr[data-id="${t}"]').scrollIntoView({ block: 'center' })`); await sleep(100);
    await tap(p, `${QV}.querySelector('.qr[data-id="${t}"] .qa.mo')`); await sleep(150);
    await tap(p, `${QV}.querySelector('.menu .mi[data-action="play"]')`); await sleep(100);
    await tap(p, `${QV}.querySelector('.confirm .cbtn[data-action="confirm"]')`);
  }, t);
  await p.close();
  // 3. guest 0.4 long-press menu → Play now (no confirm, 0.4) → mass_queue.play_queue_item
  p = await openQ('');
  t = (await ev(p, `[...${QV}.querySelectorAll('.qr.next')].map((r) => r.dataset.id)`))[3];
  await playNowPath('0.4 long-press menu entry (guest)', p, async () => {
    const r = await rectOf(p, `${QV}.querySelector('.qr[data-id="${t}"] .rt')`);
    await p.mouse.move(r.x, r.y); await p.mouse.down(); await sleep(700); await p.mouse.up(); await sleep(150);
    await tap(p, `${QV}.querySelector('.menu .mi[data-action="play"]')`);
  }, t);
  // 4. row tap (0.4: plays at once, no confirm) → mass_queue.play_queue_item
  t = (await ev(p, `[...${QV}.querySelectorAll('.qr.next')].map((r) => r.dataset.id)`))[2];
  await playNowPath('row tap (guest, 0.4 no confirm)', p, () => tap(p, `${QV}.querySelector('.qr[data-id="${t}"] .rt')`), t);
  await p.close();
  // 4b. row tap as admin, and the icon without a mass_queue entry id (0.4 service fallback)
  p = await openQ('&admin=1');
  t = (await ev(p, `[...${QV}.querySelectorAll('.qr.next')].map((r) => r.dataset.id)`))[5];
  await playNowPath('row tap (admin)', p, () => tap(p, `${QV}.querySelector('.qr[data-id="${t}"] .rt')`), t);
  await p.close();
  p = await openQ(`&admin=1&cfg=${encodeURIComponent(J({ mass_queue_entry_id: '' }))}`);
  t = (await ev(p, `[...${QV}.querySelectorAll('.qr.next')].map((r) => r.dataset.id)`))[3];
  await playNowPath('icon without mass_queue_entry_id (play_queue_item fallback)', p, async () => {
    await tap(p, `${QV}.querySelector('.qr[data-id="${t}"] .qa[data-action="playnow"]')`);
    await tap(p, `${QV}.querySelector('.confirm .cbtn[data-action="confirm"]')`);
  }, t);
  await p.close();
}

// ---------- D. Queue rows: Remove (delete_item, no dialog) + 'Removed <title>. Undo' ----------
{
  const QV = `__card.shadowRoot.querySelector('jb-queue').shadowRoot`;
  const openQ = async (q, vp) => { const p = await open(`&tab=queue${q}`, vp); await wait(p, `${QV}.querySelectorAll('.qr.next').length > 3`); await sleep(150); return p; };
  const ids = (p) => ev(p, `[...${QV}.querySelectorAll('.qr.next')].map((r) => r.dataset.id)`);
  const maIds = (p) => ev(p, `window.__queues['media_player.everywhere'].items.map((x) => x.queue_item_id)`);
  const maUris = (p) => ev(p, `window.__queues['media_player.everywhere'].items.map((x) => x._t.uri)`);
  const qcmds = (p) => ev(p, `window.__calls.filter((c) => c.service === 'send_command' && String(c.data?.command).startsWith('player_queues/')).map((c) => ({ command: c.data.command, data: c.data.data }))`);
  const bar = (p) => ev(p, `(() => { const u = ${QV}.querySelector('.undo'); return u ? { text: u.querySelector('span').textContent.trim(), btn: u.querySelector('.ub')?.textContent.trim() } : null; })()`);
  const toastT = (p) => ev(p, `${QV}.querySelector('.toast')?.textContent.trim() ?? ''`);
  const titleOf = (p, id) => ev(p, `${QV}.querySelector('.qr[data-id="${id}"] .rt b')?.textContent.trim()`);

  let p = await openQ('&admin=1');
  const before = await maUris(p), ids0 = await ids(p), victim = ids0[2], vTitle = await titleOf(p, victim);
  const vUri = before[(await maIds(p)).indexOf(victim)];
  await tap(p, `${QV}.querySelector('.qr[data-id="${victim}"] .qa[data-action="remove"]')`);
  await sleep(120);
  const dlg0 = await ev(p, `!!${QV}.querySelector('.confirm')`);
  let u = await bar(p);
  await sleep(700);
  let sc = await qcmds(p);
  check('D1 Remove: no dialog; player_queues/delete_item {queue_id, item_id_or_index: queue_item_id}; gone from the card and from MA; "Removed <title>. Undo" shows',
    !dlg0 && sc.length === 1 && J(sc[0]) === J({ command: 'player_queues/delete_item', data: { queue_id: 'syncgroup_everywhere', item_id_or_index: victim } })
      && !(await ids(p)).includes(victim) && !(await maIds(p)).includes(victim) && u && u.text === `Removed ${vTitle}.` && u.btn === 'Undo', J({ sc, u }));
  const nowId = await ev(p, `${QV}.querySelector('.qr.now')?.dataset.id`);
  check('D2 the playing row has no Remove icon (and played rows neither)', nowId && !(await ev(p, `!!${QV}.querySelector('.qr.now .qa[data-action="remove"], .qr.past .qa[data-action="remove"]')`)));
  await tap(p, `${QV}.querySelector('.undo .ub')`);
  await wait(p, `${QV}.querySelector('.toast')?.textContent.includes('is back')`, 4000); await sleep(900);
  sc = (await qcmds(p)).slice(1);
  const after = await maUris(p);
  const moved = sc.find((c) => c.command === 'player_queues/move_item');
  check('D3 Undo: play_media {queue_id, media: uri, option: add} → player_queues/items → move_item back; MA order is the original again (new queue_item_id)',
    sc[0]?.command === 'player_queues/play_media' && J(sc[0].data) === J({ queue_id: 'syncgroup_everywhere', media: vUri, option: 'add' })
      && sc[1]?.command === 'player_queues/items' && moved && moved.data.pos_shift < 0 && J(after) === J(before)
      && !(await maIds(p)).includes(victim) && (await toastT(p)) === `${vTitle} is back` && !(await bar(p)), J({ sc, before, after }));
  await p.close();

  // the bar leaves after about 5 s
  p = await openQ('&admin=1');
  const v2 = (await ids(p))[3];
  await tap(p, `${QV}.querySelector('.qr[data-id="${v2}"] .qa[data-action="remove"]')`);
  await sleep(4000); const at4 = !!(await bar(p));
  await sleep(1600); const at56 = !!(await bar(p));
  check('D4 the Undo bar stays about 5 s (there at 4 s, gone by 5.6 s)', at4 && !at56, J({ at4, at56 }));
  await p.close();

  // re-add fails → the toast says so
  p = await openQ('&admin=1&qadd=fail');
  const v3 = (await ids(p))[2], t3 = await titleOf(p, v3);
  await tap(p, `${QV}.querySelector('.qr[data-id="${v3}"] .qa[data-action="remove"]')`); await sleep(500);
  await tap(p, `${QV}.querySelector('.undo .ub')`);
  await wait(p, `${QV}.querySelector('.toast')?.textContent.includes('Couldn')`, 3000);
  check('D5 Undo when MA refuses the re-add: "Couldn\'t undo: <title> wasn\'t added back"', (await toastT(p)) === `Couldn't undo: ${t3} wasn't added back`, await toastT(p));
  await p.close();

  // re-added but the lookup fails → at the end, and the toast says it couldn't restore the place
  p = await openQ('&admin=1&qitems=fail');
  const b4 = await maUris(p), v4 = (await ids(p))[2], t4 = await titleOf(p, v4);
  const u4 = b4[(await maIds(p)).indexOf(v4)];
  await tap(p, `${QV}.querySelector('.qr[data-id="${v4}"] .qa[data-action="remove"]')`); await sleep(500);
  await tap(p, `${QV}.querySelector('.undo .ub')`);
  await wait(p, `${QV}.querySelector('.toast')?.textContent.includes('back')`, 3000); await sleep(500);
  const a4 = await maUris(p);
  check('D6 Undo that can\'t restore the place: the track is added at the end and the toast says so', a4[a4.length - 1] === u4 && (await toastT(p)) === `${t4} is back, at the end of the queue (couldn't restore its place)`, J({ t: await toastT(p), last: a4[a4.length - 1], u4 }));
  await p.close();

  // live MA 2.10.9: rows up to index_in_buffer can't move (500 "<n> is already played/buffered") or go (delete: 200, ignored)
  p = await openQ('&admin=1&qbuf=1');
  await wait(p, `${QV}.querySelector('.qr.next.buf')`, 3000);
  const v5 = (await ids(p))[0];
  const g5 = await ev(p, `(() => { const r = ${QV}.querySelector('.qr[data-id="${v5}"]'), n = r.nextElementSibling; const a = (el, k) => el.querySelector('.qa[data-action="' + k + '"]');
    return { buf: r.classList.contains('buf'), remove: !!a(r, 'remove'), next: !!a(r, 'playnext'), up: a(r, 'up')?.disabled, down: a(r, 'down')?.disabled,
      nUp: a(n, 'up')?.disabled, nNext: a(n, 'playnext')?.disabled, nRemove: !!a(n, 'remove'), bufs: ${QV}.querySelectorAll('.qr.buf').length }; })()`);
  check('D7 buffered row (index_in_buffer): no Remove / Play next, Move up + down disabled; the row after it is the first movable one',
    g5.buf && !g5.remove && !g5.next && g5.up && g5.down && g5.nUp && g5.nNext && g5.nRemove && g5.bufs === 1, J(g5));
  await p.close();
  // MA moved its buffer on after our read: a delete it ignores → toast + the row is back; a move it refuses → toast + reload
  p = await openQ('&admin=1');
  const v7 = (await ids(p))[0], v8 = (await ids(p))[3];
  await ev(p, `(() => { const Q = window.__queues['media_player.everywhere']; Q.buf = Q.index + 1; })()`);
  await tap(p, `${QV}.querySelector('.qr[data-id="${v7}"] .qa[data-action="remove"]')`);
  await wait(p, `${QV}.querySelector('.toast')?.textContent === 'That track is already loading'`, 3000);
  check('D7b delete ignored by MA (200, row still there): toast "That track is already loading", the row is back, no Undo bar',
    (await toastT(p)) === 'That track is already loading' && (await ids(p))[0] === v7 && !(await bar(p)), J({ t: await toastT(p), ids: (await ids(p)).slice(0, 2) }));
  await sleep(2300); // let the toast clear
  // MA buffers further on between the card's read and the tap (set right before it, so the card still offers Up)
  await ev(p, `(() => { const Q = window.__queues['media_player.everywhere']; Q.buf = Q.index + 4; })()`);
  await tap(p, `${QV}.querySelector('.qr[data-id="${v8}"] .qa[data-action="up"]')`);
  await wait(p, `${QV}.querySelector('.toast')?.textContent === 'That track is already loading'`, 3000);
  await wait(p, `${QV}.querySelectorAll('.qr.buf').length === 4`, 3000);
  check('D7c move refused by MA (500 "<n> is already played/buffered"): toast "That track is already loading" and the queue reloads (4 rows now locked)',
    (await toastT(p)) === 'That track is already loading' && (await ev(p, `${QV}.querySelectorAll('.qr.buf').length`)) === 4, J({ t: await toastT(p) }));
  await p.close();

  // phone: ⋯ opens an action sheet with the rest; Play now there still asks first; Remove there offers Undo
  p = await openQ('&admin=1', { width: 390, height: 844, isMobile: true, hasTouch: true });
  const v6 = (await ids(p))[3];
  await tap(p, `${QV}.querySelector('.qr[data-id="${v6}"] .qa.mo')`); await sleep(250);
  const sheet = await ev(p, `(() => { const m = ${QV}.querySelector('.menu'); return m ? { sheet: m.classList.contains('sheet'), items: [...m.querySelectorAll('[role=menuitem]')].map((b) => b.textContent.trim()) } : null; })()`);
  check('D8 phone ⋯ → action sheet: Play now…, Play next, Move up, Move down, Remove (+ Cancel)', sheet && sheet.sheet && J(sheet.items) === J(['Play now…', 'Play next', 'Move up', 'Move down', 'Remove', 'Cancel']), J(sheet));
  await tap(p, `[...${QV}.querySelectorAll('.menu .mi:not(.cancel)')][0]`); await sleep(200);
  const cf = await ev(p, `${QV}.querySelector('.confirm')?.dataset.kind ?? ''`);
  check('D9 Play now… from the sheet still asks first (nothing sent)', cf === 'jump' && (await qcmds(p)).length === 0, cf);
  await tap(p, `${QV}.querySelector('.confirm .cbtn[data-action="cancel"]')`); await sleep(200);
  await tap(p, `${QV}.querySelector('.qr[data-id="${v6}"] .qa.mo')`); await sleep(250);
  await tap(p, `[...${QV}.querySelectorAll('.menu .mi:not(.cancel)')].find((b) => b.textContent.trim() === 'Remove')`); await sleep(500);
  const sc6 = await qcmds(p);
  check('D10 Remove from the sheet: delete_item + the Undo bar', sc6.length === 1 && sc6[0].command === 'player_queues/delete_item' && !!(await bar(p)), J(sc6));
  await p.close();

  // guest: no Remove icon; the 0.4 menu is unchanged
  p = await openQ('', { width: 390, height: 844, isMobile: true, hasTouch: true });
  const g = (await ids(p))[3];
  const rmIcons = await ev(p, `${QV}.querySelectorAll('.qa[data-action="remove"]').length`);
  await tap(p, `${QV}.querySelector('.qr[data-id="${g}"] .qa.mo')`); await sleep(250);
  const gm = await ev(p, `[...${QV}.querySelectorAll('.menu .mi:not(.cancel)')].map((b) => b.textContent.trim())`);
  check('D11 guest: no Remove / Play now / Play next icons; ⋯ keeps the 0.4 menu', rmIcons === 0 && !gm.includes('Play now…') && gm.length > 0, J({ rmIcons, gm }));
  await p.close();
}

// ---------- E. editor: Speakers section + large_buttons ----------
{
  const pg = await browser.newPage();
  await hermetic(pg);
  const base = { type: 'custom:jukebox-card', entity: 'media_player.everywhere', config_entry_id: '01MUSICASSISTANT0000000000', mass_queue_entry_id: '01MASSQUEUE0000000000000000' };
  await pg.goto(`${BASE.replace('index.html', 'editor.html')}?fresh=1&cfg=${encodeURIComponent(J(base))}`);
  await pg.waitForFunction(() => window.__editor?.shadowRoot?.querySelector('ha-form'));
  await sleep(300);
  const F = `__editor.shadowRoot.querySelector('ha-form')`;
  const names = await ev(pg, `[...${F}.querySelectorAll('details[data-section=speakers] [data-name]')].map((e) => e.dataset.name)`);
  check('E1 editor: Speakers section with mode, targets, grouping, grouping_users, guest_access, leader_drop, presets, quiet hours',
    ['speaker_mode', 'targets', 'grouping', 'grouping_users', 'guest_access', 'leader_drop', 'presets', 'quiet_start', 'quiet_end', 'quiet_max', 'quiet_applies'].every((n) => names.includes(n)), J(names));
  check('E2 editor: large_buttons under Display', await ev(pg, `!!${F}.querySelector('details[data-section=display] [data-name=large_buttons]')`));
  const ch0 = await ev(pg, `window.__changes.length`);
  check('E3 a 0.4 config opens without the editor writing speaker keys', ch0 === 0 || !(await ev(pg, `JSON.stringify(window.__changes.at(-1))`)).includes('speaker_mode'), String(ch0));
  await ev(pg, `(() => { const s = ${F}.querySelector('[data-name=speaker_mode] select'); s.value = 'dynamic'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(200);
  const last = await ev(pg, `window.__changes.at(-1)`);
  check('E4 choosing Dynamic writes speaker_mode: dynamic and keeps the rest', last?.speaker_mode === 'dynamic' && last?.entity === base.entity && last?.mass_queue_entry_id === base.mass_queue_entry_id, J(last));
  await pg.close();
}

// ───────────── live MA 2.10.9 shapes and timings (plan §17) ─────────────
{
  // mass_player_id null on every HA entity + idle groups pointing active_queue at Everywhere's queue (live=1)
  const p = await open(`&spk=dyn&admin=1&live=1&gap=1500&xgap=1200&target=${IN}&cfg=${encodeURIComponent(J({ leader_drop: 'allow' }))}`);
  const ent = await ev(p, `[window.__hass.states['${IN}'].attributes.mass_player_id, window.__hass.states['${IN}'].attributes.active_queue, window.__hass.states['${EVERY}'].attributes.mass_player_id]`);
  await openPanel(p); await waitLoaded(p);
  const b = await ev(p, `(() => { const r = ${SR}; return { banner: r.querySelector('.banner')?.dataset.kind ?? '', chip: r.querySelector('[data-target="${IN}"]')?.getAttribute('aria-checked'), presets: [...r.querySelectorAll('[data-preset]')].map((c) => c.dataset.preset) }; })()`);
  check('LV1 live entities (mass_player_id null, idle Indoor reports Everywhere\'s active_queue): Indoor still maps to its own MA group (not shown as static)',
    ent[0] === null && ent[1] === 'syncgroup_everywhere' && ent[2] === null && b.chip === 'true' && b.banner !== 'static' && b.presets.includes('Outdoor default'), J({ ent, b }));
  const err = (f) => p.evaluate(f).then(() => 'ok', (e) => String(e?.message ?? e));
  const idle = await err(() => window.__card.speakers.setMembers('syncgroup_mock_outdoor', ['wiim_mock_kitchen'], []));
  const after = await ev(p, `[window.__hass.states['${OUT}'].state, window.__ma.players().find((x) => x.player_id === 'syncgroup_mock_outdoor').group_members]`);
  check('LV2 set_members on an idle dynamic group: 200, the group stays idle, players/all lists the new members', idle === 'ok' && after[0] === 'idle' && J(after[1]) === J(['wiim_mock_garage', 'wiim_mock_kitchen']), J({ idle, after }));
  await p.close();
}
{
  const p = await open(`&spk=dyn&admin=1&live=1&gap=1500&xgap=1200&target=${IN}&cfg=${encodeURIComponent(J({ leader_drop: 'allow' }))}`);
  // start Indoor (from Now Playing, before the panel covers it), then drop its leader: live keeps the group 'playing' while the next member is silent ~5.9 s (1.5 s here)
  await tap(p, `${NOW}.shadowRoot.querySelector('.pp')`);
  await wait(p, `!!${SR}.querySelector('.sp-ask')`, 1500) && (await confirm(p));
  await wait(p, `window.__hass.states['${IN}'].state === 'playing'`, 4000);
  const aqPlaying = await ev(p, `window.__hass.states['${IN}'].attributes.active_queue`);
  await openPanel(p); await waitLoaded(p);
  check('LV2b once Indoor plays, its entity reports its own queue again (active_queue)', aqPlaying === 'syncgroup_mock_indoor', aqPlaying);
  const lead = await p.evaluate(() => window.__ma.G.syncgroup_mock_indoor.members[0]);
  const leadRoom = lead === 'wiim_mock_kitchen' ? KIT : LIV;
  await wait(p, `${act(leadRoom)}?.dataset.act === 'drop'`, 4000);
  await tap(p, act(leadRoom));
  await wait(p, `!!${SR}.querySelector('.sp-ask')`) && (await confirm(p));
  const rg = await wait(p, `${SR}.querySelector('.stl')?.textContent.includes('Regrouping…')`, 1200);
  const stDuring = await st(p, IN);
  const back = await wait(p, `!${SR}.querySelector('.stl')?.textContent.includes('Regrouping…') && ${SR}.querySelector('.stl')?.textContent.includes('Playing')`, 5000);
  check('LV3 leader dropped (live: the group stays "playing", the new leader is silent): "Regrouping…" until the new leader plays, then "Playing"',
    rg && stDuring === 'playing' && back && (await events(p)).some((e) => e.ev === 'reformed'), J({ rg, stDuring, back }));
  await p.close();
}
{
  // live transfer: the source stops at once, the target is silent ~4.7 s (1.2 s here) and then plays
  const p = await open(`&spk=dyn&admin=1&ma=split&xgap=1200&target=${IN}`);
  await openPanel(p); await waitLoaded(p);
  await tap(p, `${SR}.querySelector('[data-target="${OUT}"]')`);
  await wait(p, `!!${SR}.querySelector('.sp-ask')`, 1500) && (await confirm(p));
  const srcStop = await wait(p, `window.__hass.states['${IN}'].state === 'idle' && window.__hass.states['${OUT}'].state === 'buffering'`, 3000);
  const play = await wait(p, `window.__hass.states['${OUT}'].state === 'playing'`, 4000);
  check('LV4 transfer: the source stops on its own (no stop call), the target is silent for the gap and then plays', srcStop && play && (await ma(p, 'players/cmd/stop')).length === 0 && (await target(p)) === OUT, J({ srcStop, play, t: await target(p) }));
  await p.close();
}
{
  // config/players/get refused (a token without the config read scope / older MA): card presets only
  const p = await open('&spk=dyn&admin=1&macfg=deny');
  await openPanel(p); await waitLoaded(p);
  const pr = await ev(p, `[...${SR}.querySelectorAll('[data-preset]')].map((c) => c.dataset.preset)`);
  check('LV5 MA group config unreadable → the card presets only (no "<Group> default" chips), panel otherwise works', J(pr) === J(['Dinner', 'Whole house']), J(pr));
  await p.close();
}

check('X1 Home Assistant media_player.join / unjoin never called (MA set_members only)', allJoins.length === 0, J(allJoins));

await browser.close();
console.log(`\n${total - failures}/${total} speakers checks passed`);
process.exit(failures ? 1 : 0);
