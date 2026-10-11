/**
 * Developer probe for the adaptive transition: drives `demo/transition.html` in headless Chrome
 * (real MapLibre, WebGL through SwiftShader) with real wheel events and checks that the place
 * under the centre stays put, that band switches hold rather than show holes, and that the map
 * reports no errors. Not part of `npm run verify`: it needs Chrome, the network and a running
 * dev server (`npm run build:js && npm run dev`).
 *
 *   node scripts/probe-transition.mjs [--city "San Francisco"] [--steps 9] [--url URL]
 *                                     [--chrome PATH] [--port 9339] [--timeout 900]
 *
 * SwiftShader renders a band in seconds, so `waited` values say nothing about real latency.
 * Exits 1 when the geographic centre drifts more than 0.001° or the map fires any `error`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    city: { type: 'string', default: 'San Francisco' },
    steps: { type: 'string' },
    url: { type: 'string', default: 'http://localhost:5173/demo/transition.html' },
    chrome: { type: 'string' },
    port: { type: 'string', default: '9339' },
    timeout: { type: 'string', default: '900' },
  },
});
const MAX_DRIFT_DEG = 1e-3;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (message) => {
  console.error(`probe-transition: ${message}`);
  process.exit(2);
};

function findChrome() {
  const explicit = args.chrome ?? process.env.CHROME_PATH ?? process.env.CHROME;
  if (explicit) return existsSync(explicit) ? explicit : fail(`Chrome not found at ${explicit}`);
  const local = process.env.LOCALAPPDATA;
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    ...(local ? [join(local, 'Google/Chrome/Application/chrome.exe')] : []),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  const found = candidates.find((path) => existsSync(path));
  if (found) return found;
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const result = spawnSync(lookup, [name], { encoding: 'utf8' });
    const path = result.status === 0 ? result.stdout.split(/\r?\n/)[0]?.trim() : '';
    if (path) return path;
  }
  return fail('no Chrome found; pass --chrome <path> or set CHROME_PATH.');
}

const url = new URL(args.url);
if (args.steps) url.searchParams.set('steps', args.steps);
const port = Number(args.port);
const profile = mkdtempSync(join(tmpdir(), 'eqe-probe-'));
const chrome = spawn(
  findChrome(),
  [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1280,800',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const cleanup = () => {
  chrome.kill();
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch { /* locked */ }
};
const watchdog = setTimeout(() => { cleanup(); fail(`timed out after ${args.timeout} s`); }, Number(args.timeout) * 1000);

// --- Chrome DevTools Protocol --------------------------------------------------------------
let target;
for (let i = 0; i < 100 && !target; i++) {
  await sleep(200);
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = list.find((t) => t.type === 'page');
  } catch { /* not up yet */ }
}
if (!target) { cleanup(); fail(`Chrome's DevTools endpoint did not come up on port ${port}`); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener('open', resolve));
let nextId = 0;
const pending = new Map();
const exceptions = [];
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === 'Runtime.exceptionThrown') {
    const details = msg.params.exceptionDetails;
    exceptions.push((details.exception?.description ?? details.text).slice(0, 400));
  }
});
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++nextId;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails).slice(0, 600));
  return res.result?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: url.href });
const loadStart = Date.now();
// A failure before `ready` is mostly the network (a style or TileJSON fetch): reload twice.
for (let attempt = 1; ; ) {
  const page = await evaluate('JSON.stringify({ ready: !!window.__eqe?.ready, errors: window.__eqe?.errors ?? [] })')
    .then(JSON.parse, () => ({ ready: false, errors: [] }));
  if (page.ready) break;
  if (page.errors.length || exceptions.length) {
    const reasons = [...page.errors, ...exceptions.splice(0)].join('\n  ');
    if (attempt++ >= 3) { cleanup(); fail(`the page failed before it was ready:\n  ${reasons}`); }
    console.log(`page failed before it was ready, reloading:\n  ${reasons}`);
    await send('Page.navigate', { url: url.href });
    await sleep(2000); // until the new document has replaced the failed one
    continue;
  }
  if (Date.now() - loadStart > 180_000) { cleanup(); fail(`${url.href} not ready after 180 s`); }
  await sleep(250);
}
console.log(`page ready after ${((Date.now() - loadStart) / 1000).toFixed(1)} s`);

// --- Page helpers ----------------------------------------------------------------------------
const idle = () => evaluate(`new Promise((r) => { const m = window.__eqe.map;
  if (!m.isMoving() && m.loaded()) setTimeout(r, 50); else m.once('idle', () => setTimeout(r, 50)); })`);
const city = await evaluate(`window.__eqe.cities[${JSON.stringify(args.city)}] ?? null`);
if (!city) { cleanup(); fail(`unknown city "${args.city}"; see CITIES in demo/transition.ts`); }

/** Geographic centre, the city's on-screen offset from the canvas centre, and the empty cells
 *  of a 4×3 grid queried against the shown band's non-symbol layers. */
const SAMPLE = `(() => {
  const { map: m, controller: c, shownBand } = window.__eqe; const city = ${JSON.stringify(city)};
  const band = shownBand(); const style = m.getStyle(); const ids = [];
  for (const l of style.layers) {
    if (!l.source || l.type === 'symbol') continue;
    const mine = /__b\\d+$/.test(l.id) ? l.id.endsWith('__b' + band)
      : band === window.__eqe.transition.steps && (l.source + '__b0') in style.sources;
    if (mine) ids.push(l.id);
  }
  const canvas = m.getCanvas(), w = canvas.clientWidth, h = canvas.clientHeight; let empty = 0;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) {
    const box = [[i * w / 4 + 1, j * h / 3 + 1], [(i + 1) * w / 4 - 1, (j + 1) * h / 3 - 1]];
    if (m.queryRenderedFeatures(box, { layers: ids }).length === 0) empty++;
  }
  const ctr = m.getCenter(); const geo = c.toGeographic([ctr.lng, ctr.lat]);
  const p = m.project(c.toMapSpace(city));
  return { zoom: m.getZoom(), band, geo, offset: Math.hypot(p.x - w / 2, p.y - h / 2), empty };
})()`;

async function wheel(direction) {
  const [x, y, hit] = await evaluate(`(() => { const r = window.__eqe.map.getCanvas().getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    return [x, y, document.elementFromPoint(x, y)?.tagName]; })()`);
  if (hit !== 'CANVAS') { cleanup(); fail(`a ${hit} covers the canvas centre; the wheel would miss the map`); }
  for (let i = 0; i < 2; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: -120 * direction });
    await sleep(120);
  }
  await sleep(450); // a scroll zoom ends ~200 ms after the last wheel event
}

// --- Run ------------------------------------------------------------------------------------
await evaluate(`window.__eqe.map.jumpTo({ zoom: 3.5 })`);
await idle();
await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent === ${JSON.stringify(args.city)}).click()`);
await idle();
// The readout grows with every switch line and would end up under the wheel at the centre.
await evaluate(`document.querySelector('.panel').style.visibility = 'hidden'`);
console.log(`${args.city} [${city.join(', ')}], ${url.search || '(defaults)'}: 12 wheel steps in, 12 out`);

let maxDrift = 0;
let maxOffset = 0;
for (const [label, direction] of [['in', 1], ['out', -1]]) {
  for (let step = 1; step <= 12; step++) {
    await wheel(direction);
    const t0 = Date.now();
    let s;
    let worstEmpty = 0;
    let lastEmptyMs = null;
    let drift = 0;
    let offset = 0;
    while (Date.now() - t0 < 2500) {
      s = await evaluate(SAMPLE);
      if (s.empty) { worstEmpty = Math.max(worstEmpty, s.empty); lastEmptyMs = Date.now() - t0; }
      drift = Math.max(drift, Math.abs(s.geo[0] - city[0]), Math.abs(s.geo[1] - city[1]));
      offset = Math.max(offset, s.offset);
      await sleep(100);
    }
    maxDrift = Math.max(maxDrift, drift);
    maxOffset = Math.max(maxOffset, offset);
    const holes = lastEmptyMs === null ? 'no empty cells' : `${worstEmpty}/12 empty until ${lastEmptyMs} ms`;
    console.log(`  ${label} ${String(step).padStart(2)}  z${s.zoom.toFixed(2)}  shown b${s.band}  ` +
      `drift ${drift.toExponential(1)}°  offset ${offset.toFixed(2)} px  ${holes}`);
  }
}

const readout = await evaluate(`document.getElementById('readout').textContent`);
const switches = readout.split('\n').filter((line) => line.startsWith('shown ')).reverse();
const errors = await evaluate('window.__eqe.errors');
console.log(`switches (${switches.length}):`);
for (const line of switches) console.log(`  ${line}`);
console.log(`map errors: ${errors.length}`);
for (const error of errors.slice(0, 20)) console.log(`  ${error}`);
if (exceptions.length) console.log(`uncaught page exceptions: ${exceptions.length}\n  ${exceptions.slice(0, 5).join('\n  ')}`);
const ok = maxDrift <= MAX_DRIFT_DEG && errors.length === 0;
console.log(`${ok ? 'OK' : 'FAIL'}: max centre drift ${maxDrift.toExponential(2)}° (limit ${MAX_DRIFT_DEG}°), ` +
  `max offset of ${args.city} from the canvas centre ${maxOffset.toFixed(2)} px, ${errors.length} map errors`);

clearTimeout(watchdog);
ws.close();
cleanup();
process.exit(ok ? 0 : 1);
