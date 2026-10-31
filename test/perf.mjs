// Frame-time benchmark: 1920x1080, 4x CPU throttle (CDP Emulation.setCPUThrottlingRate), backdrop full vs light.
// Scenarios: dragging the "Everywhere" volume slider on Now Playing; typing on the on-screen keyboard in Search.
// Metrics: rAF frame deltas (avg / p95 / max / % over 33 ms), long tasks (PerformanceObserver 'longtask'),
// and from a CDP trace: renderer main-thread busy ms and raster/GPU ms (where the live blur is paid).
// Usage: node test/perf.mjs [runs=3]   (dev server on 127.0.0.1:8765) → test/shots/perf.json
import puppeteer from 'puppeteer-core';
import { writeFileSync, mkdirSync } from 'node:fs';
const RUNS = Number(process.argv[2] ?? 3);
const BASE = process.env.JB_URL ?? 'http://127.0.0.1:8765/dev/index.html';
const OUT = new URL('./shots/', import.meta.url).pathname; mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--hide-scrollbars', '--enable-gpu-rasterization'] });

const RECORDER = () => {
  window.__frames = []; window.__long = []; let last = performance.now(), on = true;
  const tick = (t) => { window.__frames.push(t - last); last = t; if (on) requestAnimationFrame(tick); };
  requestAnimationFrame((t) => { last = t; requestAnimationFrame(tick); });
  const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(e.duration); });
  po.observe({ type: 'longtask', buffered: false });
  window.__stopRec = () => { on = false; po.disconnect(); return { frames: window.__frames, long: window.__long }; };
};
const rect = (p, expr) => p.evaluate((e) => { const el = eval(e); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; }, expr);

async function dragSlider(p) {
  const r = await rect(p, `__card.shadowRoot.querySelector('jb-now').shadowRoot.querySelector('jb-slider')`);
  const x0 = r.x - r.w * 0.4, x1 = r.x + r.w * 0.4;
  await p.mouse.move(x0, r.y); await p.mouse.down();
  for (let k = 0; k < 3; k++) for (let i = 0; i <= 60; i++) { // 3 sweeps, ~60 moves each, one per ~16 ms
    const f = k % 2 ? 1 - i / 60 : i / 60;
    await p.mouse.move(x0 + (x1 - x0) * f, r.y); await sleep(16);
  }
  await p.mouse.up();
}
async function typeKeys(p) {
  const kb = `__card.shadowRoot.querySelector('jb-search').shadowRoot.querySelector('jb-keyboard').shadowRoot`;
  const rects = {};
  for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') rects[c] = await rect(p, `[...${kb}.querySelectorAll('[data-key="k-${c}"]')].find((k) => k.getBoundingClientRect().width > 0)`);
  rects[' '] = await rect(p, `${kb}.querySelector('[data-key="k-space"]')`);
  const clear = await rect(p, `[...${kb}.querySelectorAll('[data-key]')].find((k) => /clear/i.test(k.dataset.key) && k.getBoundingClientRect().width > 0)`).catch(() => null);
  for (const word of ['HOTEL CALIFORNIA', 'MILES DAVIS', 'EAGLES']) {
    for (const c of word) { const r = rects[c]; await p.mouse.move(r.x, r.y); await p.mouse.down(); await sleep(40); await p.mouse.up(); await sleep(110); }
    if (clear) { await p.mouse.click(clear.x, clear.y); await sleep(150); }
  }
}
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
function traceStats(events) {
  const main = new Set(), rast = new Set();
  for (const e of events) if (e.ph === 'M' && e.name === 'thread_name') {
    if (e.args.name === 'CrRendererMain') main.add(`${e.pid}:${e.tid}`);
    if (/Compositor|Raster|VizCompositor|CrGpuMain|GpuMain/.test(e.args.name)) rast.add(`${e.pid}:${e.tid}`);
  }
  let mainMs = 0, rastMs = 0, paints = 0;
  for (const e of events) {
    if (e.ph !== 'X' || !e.dur) continue;
    const k = `${e.pid}:${e.tid}`;
    if (main.has(k) && e.name === 'ThreadControllerImpl::RunTask') mainMs += e.dur / 1000;
    if (rast.has(k) && e.name === 'ThreadControllerImpl::RunTask') rastMs += e.dur / 1000;
    if (e.name === 'Paint') paints++;
  }
  return { mainMs: Math.round(mainMs), rasterGpuMs: Math.round(rastMs), paints };
}

const results = [];
for (const scen of ['slider-drag', 'keyboard-typing']) for (const mode of ['full', 'light']) for (let run = 0; run < RUNS; run++) {
  const p = await b.newPage();
  await p.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  await p.goto(`${BASE}?latency=40&fresh=1&tab=${scen === 'slider-drag' ? 'now' : 'search'}&backdrop=${mode}`);
  await p.waitForFunction('window.__ready'); await sleep(1200);
  const cdp = await p.createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await p.evaluate(RECORDER); await sleep(300);
  await p.tracing.start({ categories: ['toplevel', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'cc', 'gpu', 'viz'] });
  const t0 = Date.now();
  if (scen === 'slider-drag') await dragSlider(p); else await typeKeys(p);
  await sleep(300);
  const dur = Date.now() - t0;
  const raw = await p.tracing.stop();
  const rec = await p.evaluate(() => window.__stopRec());
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const ts = traceStats(JSON.parse(Buffer.from(raw).toString('utf8')).traceEvents);
  const f = rec.frames.filter((x) => x > 0 && x < 2000);
  results.push({ scen, mode, run, durMs: dur, frames: f.length, avg: f.reduce((a, x) => a + x, 0) / f.length, p95: pct(f, 0.95), max: Math.max(...f), over33: f.filter((x) => x > 33.4).length / f.length,
    longTasks: rec.long.length, longMs: rec.long.reduce((a, x) => a + x, 0), ...ts });
  await p.close();
}
await b.close();
const agg = {};
for (const r of results) { const k = `${r.scen} / ${r.mode}`; (agg[k] ??= []).push(r); }
const mean = (a, f) => a.reduce((s, x) => s + f(x), 0) / a.length;
const summary = Object.entries(agg).map(([k, a]) => ({ case: k, runs: a.length,
  avgFrameMs: +mean(a, (x) => x.avg).toFixed(1), p95FrameMs: +mean(a, (x) => x.p95).toFixed(1), maxFrameMs: +mean(a, (x) => x.max).toFixed(1),
  pctFramesOver33ms: +(100 * mean(a, (x) => x.over33)).toFixed(1), longTasks: +mean(a, (x) => x.longTasks).toFixed(1), longTaskMs: Math.round(mean(a, (x) => x.longMs)),
  mainThreadMs: Math.round(mean(a, (x) => x.mainMs)), rasterGpuMs: Math.round(mean(a, (x) => x.rasterGpuMs)), durMs: Math.round(mean(a, (x) => x.durMs)) }));
console.table(summary);
writeFileSync(OUT + 'perf.json', JSON.stringify({ at: new Date().toString(), viewport: '1920x1080', cpuThrottle: 4, ua: 'headless chrome', summary, results }, null, 2));
