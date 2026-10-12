/**
 * Developer probe for the adaptive transition: drives `demo/transition.html` in headless Chrome
 * (real MapLibre, WebGL through SwiftShader) with real wheel events, 12 steps in and 12 out.
 * Not part of `npm run verify`: it needs Node >= 22 (global `WebSocket`), local Chrome, the
 * network and a running dev server (`npm run build:js && npm run dev`).
 *
 *   node scripts/probe-transition.mjs [--city "San Francisco"] [--steps 9] [--anchor 300,0]
 *       [--url URL] [--chrome PATH] [--port 9339] [--timeout 900]
 *
 * `--anchor dx,dy` (default `0,0`) is where the wheel goes, in px from the canvas centre. At the
 * centre the probe checks that the place under it stays put (drift); off-centre it reports, per
 * step, how far the place under the pointer moved: the snap the camera cannot absorb.
 *
 * Empty cells: a 4×3 grid of `queryRenderedFeatures` over the shown band's non-symbol layers.
 * A rough hole detector. It is blind to opacity (a fading band counts as drawn), a cell
 * partly drawn counts as full, and a land cell with no landuse, roads or boundaries counts as
 * empty although Liberty draws land as background. Skipped when no band is shown (Mercator).
 *
 * SwiftShader renders a band in seconds, so `waited` values say nothing about real latency.
 * Exit 1: centre drift above 0.001° (centre anchor only), a map `error`, or an uncaught page
 * exception after the page was ready. Exit 2: the probe could not run (setup, timeout, bug).
 *
 * **First paint** (spec §1 criterion 4, `npm run probe:first-paint`):
 *
 *   node scripts/probe-transition.mjs --first-paint [--style URL] [--zoom-offset=-1] [--url URL]
 *
 * loads the demo at its default world view (1280×800) at 50 Mbit/s with 20 ms latency in one
 * fresh profile: **cold** with the HTTP cache disabled and the origin's Cache Storage cleared,
 * then **warm**, the HTTP cache enabled again and the page reloaded (the persistent tile cache
 * the cold run filled now serves the world), then **cold, code cached**: the browser cache
 * cleared, primed with the page's code alone (an empty style), Cache Storage cleared, loaded
 * again (see the comment at that run for why). It prints `window.__eqe.firstPaintMs` of each
 * against the spec's budgets (4000 ms cold, 1500 ms warm); that measure starts at the demo
 * module (`eqe:start`), so the first idle's time after navigation start, which includes the HTML
 * and the page's own code, is printed beside it. Also printed: the place labels MapLibre
 * placed (`queryRenderedFeatures` on the shown band's symbol layers whose `source-layer` is
 * `place`, after collision) and the bytes the page and its workers received. The page's
 * throttling also governs its workers' fetches (the install, which waits for the workers'
 * scripts, takes as long as their bytes at 50 Mbit/s); the workers are auto-attached for the
 * cache setting and their byte count.
 * Exit 0 whatever the budgets say: SwiftShader is no user's GPU, the numbers are indicative.
 * Exit 2 on a map `error`, a page exception or a timeout.
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
    anchor: { type: 'string', default: '0,0' },
    url: { type: 'string', default: 'http://localhost:5173/demo/transition.html' },
    chrome: { type: 'string' },
    port: { type: 'string', default: '9339' },
    timeout: { type: 'string', default: '900' },
    'first-paint': { type: 'boolean', default: false },
    style: { type: 'string' },
    'zoom-offset': { type: 'string' },
  },
});
const MAX_DRIFT_DEG = 1e-3;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
class ProbeFailure extends Error {}
/** A URL as echoed: decoded, with the values of key-like query parameters elided (a `--style` key). */
const shown = (href) => decodeURIComponent(href)
  .replace(/([?&](?:key|apikey|api_key|access_token|token)=)[^&#\s'"()]*/gi, '$1…');
const fail = (message) => {
  throw new ProbeFailure(message);
};

let chrome;
let profile;
let ws;
const cleanup = () => {
  ws?.close();
  chrome?.kill();
  if (profile) {
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch { /* locked */ }
  }
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

/**
 * Chrome on a fresh profile, and a DevTools connection to its page. `send` takes an optional
 * `sessionId` for a target attached in flat mode (the page's workers); `on` registers a handler
 * for every event of that name, whichever session sent it.
 */
async function connect() {
  if (typeof WebSocket !== 'function') {
    fail(`Node >= 22 required (global WebSocket); found ${process.version}.`);
  }
  const port = Number(args.port);
  const chromePath = findChrome();
  profile = mkdtempSync(join(tmpdir(), 'eqe-probe-'));
  chrome = spawn(chromePath, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1280,800',
    'about:blank',
  ], { stdio: 'ignore' });

  // --- Chrome DevTools Protocol ------------------------------------------------------------
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(200);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    } catch { /* not up yet */ }
  }
  if (!target) fail(`Chrome's DevTools endpoint did not come up on port ${port}`);
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('DevTools WebSocket failed to open')));
  });
  let nextId = 0;
  const pending = new Map();
  const exceptions = [];
  const handlers = new Map();
  const on = (method, handler) => {
    handlers.set(method, [...(handlers.get(method) ?? []), handler]);
  };
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    const call = msg.id && pending.get(msg.id);
    if (call) {
      pending.delete(msg.id);
      if (msg.error) call.reject(new Error(`${call.method}: ${msg.error.message}`));
      else call.resolve(msg.result);
    }
    if (msg.method === 'Runtime.exceptionThrown' && !msg.sessionId) {
      const details = msg.params.exceptionDetails;
      exceptions.push((details.exception?.description ?? details.text).slice(0, 400));
    }
    for (const handler of (msg.method && handlers.get(msg.method)) || []) {
      handler(msg.params, msg.sessionId);
    }
  });
  ws.addEventListener('close', () => {
    for (const call of pending.values()) call.reject(new Error('DevTools connection closed'));
    pending.clear();
  });
  const send = (method, params = {}, sessionId = undefined) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { method, resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 600));
    }
    return result.result?.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
  });
  return { send, evaluate, on, exceptions };
}

async function transitionProbe({ send, evaluate, exceptions }) {
  const anchor = args.anchor.split(',').map(Number);
  if (anchor.length !== 2 || !anchor.every(Number.isFinite)) {
    fail(`--anchor wants dx,dy; got "${args.anchor}"`);
  }
  const centred = anchor[0] === 0 && anchor[1] === 0;
  const url = new URL(args.url);
  if (args.steps) url.searchParams.set('steps', args.steps);
  await send('Page.navigate', { url: url.href });
  const loadStart = Date.now();
  // A failure before `ready` is mostly the network (a style or TileJSON fetch): reload twice.
  for (let attempt = 1; ; ) {
    const page = await evaluate(
      'JSON.stringify({ ready: !!window.__eqe?.ready, errors: window.__eqe?.errors ?? [] })',
    ).then(JSON.parse, () => ({ ready: false, errors: [] }));
    if (page.ready) break;
    if (page.errors.length || exceptions.length) {
      const reasons = [...page.errors, ...exceptions.splice(0)].join('\n  ');
      if (attempt++ >= 3) fail(`the page failed before it was ready:\n  ${reasons}`);
      console.log(`page failed before it was ready, reloading:\n  ${reasons}`);
      await send('Page.navigate', { url: url.href });
      await sleep(2000); // until the new document has replaced the failed one
      continue;
    }
    if (Date.now() - loadStart > 180_000) fail(`${shown(url.href)} not ready after 180 s`);
    await sleep(250);
  }
  console.log(`page ready after ${((Date.now() - loadStart) / 1000).toFixed(1)} s`);
  const ready = exceptions.length; // exceptions from here on fail the run

  // --- Page helpers --------------------------------------------------------------------------
  const idle = () => evaluate(`new Promise((r) => { const m = window.__eqe.map;
    if (!m.isMoving() && m.loaded()) setTimeout(r, 50);
    else m.once('idle', () => setTimeout(r, 50)); })`);
  const city = await evaluate(`window.__eqe.cities[${JSON.stringify(args.city)}] ?? null`);
  if (!city) fail(`unknown city "${args.city}"; see CITIES in demo/transition.ts`);

  /** Layer ids of band `b`'s non-symbol copies, computed once per band. */
  await evaluate(`window.__probeIds = (band) => {
    const cache = (window.__probeIdCache ??= {});
    if (cache[band]) return cache[band];
    const style = window.__eqe.map.getStyle(); const steps = window.__eqe.transition.steps;
    const ids = style.layers.filter((l) => l.source && l.type !== 'symbol' && (/__b\\d+$/.test(l.id)
      ? l.id.endsWith('__b' + band) : band === steps && (l.source + '__b0') in style.sources))
      .map((l) => l.id);
    return (cache[band] = ids);
  }; undefined`); // a function cannot be returned by value
  /** Shown band, geographic centre, where `ref` is drawn relative to the anchor, empty cells. */
  const sample = (ref) => evaluate(`(() => {
    const { map: m, shownBand } = window.__eqe; const band = shownBand();
    const canvas = m.getCanvas(), w = canvas.clientWidth, h = canvas.clientHeight;
    const ids = window.__probeIds(band); let empty = null;
    if (ids.length) {
      empty = 0;
      for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) {
        const box = [[i * w / 4 + 1, j * h / 3 + 1], [(i + 1) * w / 4 - 1, (j + 1) * h / 3 - 1]];
        if (m.queryRenderedFeatures(box, { layers: ids }).length === 0) empty++;
      }
    }
    const ctr = m.getCenter(); const geo = [ctr.lng, ctr.lat];
    const p = m.project(${JSON.stringify(ref)});
    const offset = Math.hypot(p.x - (w / 2 + ${anchor[0]}), p.y - (h / 2 + ${anchor[1]}));
    return { zoom: m.getZoom(), band, geo, offset, empty };
  })()`);
  /** The place under the anchor, geographically. */
  const underAnchor = () => evaluate(`(() => { const { map: m } = window.__eqe;
    const canvas = m.getCanvas(), x = canvas.clientWidth / 2, y = canvas.clientHeight / 2;
    const p = m.unproject([x + ${anchor[0]}, y + ${anchor[1]}]);
    return [p.lng, p.lat]; })()`);

  async function wheel(direction) {
    const [x, y, hit] = await evaluate(`(() => {
      const r = window.__eqe.map.getCanvas().getBoundingClientRect();
      const x = r.left + r.width / 2 + ${anchor[0]}, y = r.top + r.height / 2 + ${anchor[1]};
      return [x, y, document.elementFromPoint(x, y)?.tagName]; })()`);
    if (hit !== 'CANVAS') fail(`a ${hit} is under the anchor; the wheel would miss the map`);
    for (let i = 0; i < 2; i++) {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x, y, deltaX: 0, deltaY: -120 * direction,
      });
      await sleep(120);
    }
    await sleep(450); // a scroll zoom ends ~200 ms after the last wheel event
  }

  // --- Run ------------------------------------------------------------------------------------
  await evaluate(`void window.__eqe.map.jumpTo({ zoom: 3.5 })`);
  await idle();
  await evaluate(`[...document.querySelectorAll('button')]
    .find((b) => b.textContent === ${JSON.stringify(args.city)}).click()`);
  await idle();
  // The readout grows with every switch line and would end up under the wheel.
  await evaluate(`document.querySelector('.panel').style.visibility = 'hidden'`);
  console.log(`${args.city} [${city.join(', ')}], ${shown(url.search) || '(defaults)'}, anchor ` +
    `${anchor.join(',')} px: 12 wheel steps in, 12 out`);

  let maxDrift = 0;
  let maxOffset = 0;
  const snaps = [];
  for (const [label, direction] of [['in', 1], ['out', -1]]) {
    for (let step = 1; step <= 12; step++) {
      // Centred: the city must stay under the centre. Off-centre: re-pin the place under the
      // pointer before each step, so the step's offset is that step's snap alone.
      const ref = centred ? city : await underAnchor();
      const before = await sample(ref);
      await wheel(direction);
      const t0 = Date.now();
      let s;
      let worstEmpty = 0;
      let lastEmptyMs = null;
      let drift = 0;
      let offset = 0;
      while (Date.now() - t0 < 2500) {
        s = await sample(ref);
        if (s.empty) { worstEmpty = Math.max(worstEmpty, s.empty); lastEmptyMs = Date.now() - t0; }
        drift = Math.max(drift, Math.abs(s.geo[0] - city[0]), Math.abs(s.geo[1] - city[1]));
        offset = Math.max(offset, s.offset);
        await sleep(100);
      }
      maxDrift = Math.max(maxDrift, drift);
      maxOffset = Math.max(maxOffset, offset);
      const switched = s.band !== before.band ? ` b${before.band}→b${s.band}` : '';
      if (!centred) snaps.push(`${label}${step}${switched} ${offset.toFixed(1)}`);
      const holes = s.empty === null ? 'grid skipped (no band shown)'
        : lastEmptyMs === null ? 'no empty cells'
          : `${worstEmpty}/12 empty until ${lastEmptyMs} ms`;
      const where = `${label} ${String(step).padStart(2)}  z${s.zoom.toFixed(2)}  shown b${s.band}`;
      console.log(`  ${where}  ` +
        (centred ? `drift ${drift.toExponential(1)}°  offset ${offset.toFixed(2)} px  `
          : `pointer snap ${offset.toFixed(1)} px${switched}  `) + holes);
    }
  }

  const readout = await evaluate(`document.getElementById('readout').textContent`);
  const switches = readout.split('\n').filter((line) => line.startsWith('shown ')).reverse();
  const errors = await evaluate('window.__eqe.errors');
  const late = exceptions.slice(ready);
  console.log(`switches (${switches.length}):`);
  for (const line of switches) console.log(`  ${line}`);
  console.log(`map errors: ${errors.length}`);
  for (const error of errors.slice(0, 20)) console.log(`  ${error}`);
  if (late.length) {
    console.log(`uncaught page exceptions: ${late.length}\n  ${late.slice(0, 5).join('\n  ')}`);
  }
  if (!centred) console.log(`pointer snap per step, px: ${snaps.join(', ')}`);
  const ok = (!centred || maxDrift <= MAX_DRIFT_DEG) && errors.length === 0 && late.length === 0;
  console.log(`${ok ? 'OK' : 'FAIL'}: ` + (centred
    ? `max centre drift ${maxDrift.toExponential(2)}° (limit ${MAX_DRIFT_DEG}°), max offset of ` +
      `${args.city} from the centre ${maxOffset.toFixed(2)} px, `
    : `max pointer snap ${maxOffset.toFixed(1)} px at ${anchor.join(',')} px, `) +
    `${errors.length} map errors, ${late.length} page exceptions`);
  return ok ? 0 : 1;
}

/** Spec §1 criterion 4: the world view at 1280×800 and 50 Mbit/s. */
const BUDGET_MS = { cold: 4000, warm: 1500 };
const THROTTLE = {
  offline: false, latency: 20, downloadThroughput: 6_250_000, uploadThroughput: 1_250_000,
};

async function firstPaintProbe({ send, evaluate, on, exceptions }) {
  const url = new URL(args.url);
  if (args.style) url.searchParams.set('style', args.style);
  if (args['zoom-offset'] !== undefined) {
    const offset = Number(args['zoom-offset']);
    if (!Number.isInteger(offset)) fail(`--zoom-offset wants an integer; got "${args['zoom-offset']}"`);
    url.searchParams.set('zoomOffset', String(offset));
  }

  // The page's network conditions also govern its dedicated workers' fetches (a worker target
  // answers `emulateNetworkConditions` with "Not supported"); the workers are attached for their
  // traffic and their cache setting.
  let cacheDisabled = true;
  const workers = new Set();
  const configure = async (sessionId) => {
    await send('Network.enable', {}, sessionId);
    if (!sessionId) await send('Network.emulateNetworkConditions', THROTTLE);
    await send('Network.setCacheDisabled', { cacheDisabled }, sessionId);
  };
  /** What the page and its workers received in the current run, by kind of resource. */
  let traffic;
  const resetTraffic = () => {
    traffic = { bytes: 0, responses: 0, fromCache: 0, groups: new Map() };
  };
  resetTraffic();
  const urls = new Map();
  /** `host tiles z<z>` for a tile, else `host .<extension>`. */
  const groupOf = (href) => {
    try {
      const { host, pathname } = new URL(href);
      const tile = /\/(\d+)\/\d+\/\d+\.(?:pbf|mvt)$/.exec(pathname);
      return tile ? `${host} tiles z${tile[1]}` : `${host} .${/\.(\w+)$/.exec(pathname)?.[1] ?? '?'}`;
    } catch {
      return 'other';
    }
  };
  on('Network.requestWillBeSent', (params, sessionId) => {
    urls.set(`${sessionId}:${params.requestId}`, params.request.url);
  });
  on('Network.loadingFinished', (params, sessionId) => {
    const bytes = params.encodedDataLength ?? 0;
    const group = groupOf(urls.get(`${sessionId}:${params.requestId}`) ?? '');
    const entry = traffic.groups.get(group) ?? { bytes: 0, responses: 0 };
    entry.bytes += bytes;
    entry.responses++;
    traffic.groups.set(group, entry);
    traffic.bytes += bytes;
    traffic.responses++;
  });
  on('Network.requestServedFromCache', () => {
    traffic.fromCache++;
  });
  on('Network.responseReceived', (params) => {
    if (params.response.fromDiskCache) traffic.fromCache++;
  });
  on('Target.attachedToTarget', (params) => {
    const { sessionId, targetInfo } = params;
    const setUp = targetInfo.type === 'worker'
      ? configure(sessionId).then(() => workers.add(sessionId))
      : Promise.resolve();
    // A worker that cannot take the Network domain must still run.
    void setUp
      .catch((error) => console.log(`  (worker ${targetInfo.url}: ${error.message})`))
      .finally(() => send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {}));
  });
  on('Target.detachedFromTarget', (params) => workers.delete(params.sessionId));
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await configure(undefined);

  /** The traffic up to the first paint (read within 100 ms of it). */
  let atPaint;
  /** Waits for this document's first paint, then counts the labels it placed. */
  const measure = async (label) => {
    const t0 = Date.now();
    for (;;) {
      const page = await evaluate(`JSON.stringify({
        stale: !window.__eqe || !!window.__eqe.stale, ms: window.__eqe?.firstPaintMs ?? null,
        errors: window.__eqe?.errors ?? [] })`).then(JSON.parse, () => ({ stale: true }));
      if (!page.stale && page.errors.length) {
        fail(`${label}: the page reported errors:\n  ${page.errors.join('\n  ')}`);
      }
      if (exceptions.length) fail(`${label}: page exception:\n  ${exceptions.join('\n  ')}`);
      if (!page.stale && page.ms !== null) {
        atPaint = { ...traffic, groups: new Map(traffic.groups) };
        break;
      }
      if (Date.now() - t0 > 180_000) fail(`${label}: no first paint after 180 s`);
      await sleep(100);
    }
    await sleep(800); // until the labels' placement has settled
    return evaluate(`(() => {
      const { map: m, controller, shownBand, transition } = window.__eqe;
      const band = shownBand();
      const ofBand = (id) => !controller.active ? true
        : /__b\\d+$/.test(id) ? id.endsWith('__b' + band) : band === transition.steps;
      const symbols = m.getStyle().layers.filter((l) => l.type === 'symbol' && ofBand(l.id));
      const query = (layers) => layers.length
        ? m.queryRenderedFeatures({ layers: layers.map((l) => l.id) }) : [];
      const place = query(symbols.filter((l) => l['source-layer'] === 'place'));
      const names = new Set(place.map((f) => f.properties.name ?? f.properties['name:latin']));
      const marks = Object.fromEntries(performance.getEntriesByType('mark')
        .map((e) => [e.name.replace('eqe:', ''), e.startTime]));
      return { ms: window.__eqe.firstPaintMs, marks, zoom: m.getZoom(), band, place: place.length,
        distinct: names.size, symbols: query(symbols).length,
        workerPath: window.__eqe.install.workerPath };
    })()`);
  };
  const report = (label, result) => {
    const budget = BUDGET_MS[label.startsWith('cold') ? 'cold' : 'warm'];
    console.log(`${label} ${result.ms.toFixed(0)} (budget ${budget}) ` +
      `${result.ms <= budget ? 'PASS' : 'MISS'}`);
    const at = (name) => (result.marks[name] === undefined ? '–'
      : `${(result.marks[name] - result.marks.start).toFixed(0)} ms`);
    console.log(`  installed ${at('installed')}, active ${at('active')}, first idle ` +
      `${at('first-idle')} after the module started; the module started ` +
      `${result.marks.start.toFixed(0)} ms and the first idle came ` +
      `${result.marks['first-idle'].toFixed(0)} ms after navigation start`);
    console.log(`  z${result.zoom.toFixed(2)} b${result.band}, warped on: ${result.workerPath}; ` +
      `place labels placed ${result.place} ` +
      `(${result.distinct} distinct names), all symbols ${result.symbols}`);
    console.log(`  received by the first paint: ${(atPaint.bytes / 1024).toFixed(0)} kB in ` +
      `${atPaint.responses} responses (${atPaint.fromCache} from the HTTP cache), the largest:`);
    const largest = [...atPaint.groups].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 6);
    for (const [group, { bytes, responses }] of largest) {
      console.log(`    ${(bytes / 1024).toFixed(0).padStart(6)} kB  ${String(responses).padStart(3)}  ${group}`);
    }
  };

  /** Loads `href` (or reloads) with the HTTP cache on or off and measures its first paint. */
  const load = async (label, href, { disableCache, clearStorage }) => {
    cacheDisabled = disableCache;
    for (const sessionId of [undefined, ...workers]) {
      await send('Network.setCacheDisabled', { cacheDisabled }, sessionId).catch(() => {});
    }
    if (clearStorage) {
      await send('Storage.clearDataForOrigin', { origin: url.origin, storageTypes: 'cache_storage' });
    }
    await evaluate('void (window.__eqe && (window.__eqe.stale = true))');
    resetTraffic();
    if (href) await send('Page.navigate', { url: href });
    else await send('Page.reload', { ignoreCache: false });
    return measure(label);
  };

  console.log(`first paint: ${shown(url.href)}, 1280×800, 50 Mbit/s down, 20 ms latency`);
  report('cold', await load('cold', url.href, { disableCache: true, clearStorage: true }));
  report('warm', await load('warm', undefined, { disableCache: false, clearStorage: false }));

  // The cold run fetches the application's code as the dev server serves it: unminified, with
  // inline source maps, once per worker with the cache off (~23 MB for MapLibre's worker modules
  // alone). So once more with an empty HTTP cache that holds only that code: the map data (style,
  // TileJSON, glyphs, sprites, tiles) and the tile cache are cold, as on a first visit to an
  // application whose code is small and cached, or served from a CDN.
  await send('Network.clearBrowserCache');
  const codeOnly = new URL(url);
  codeOnly.searchParams.set('style', `data:application/json,${JSON.stringify(
    { version: 8, sources: {}, layers: [] })}`);
  codeOnly.searchParams.set('projection', 'mercator');
  await load('code', codeOnly.href, { disableCache: false, clearStorage: true });
  report('cold, code cached', await load('cold, code cached', url.href,
    { disableCache: false, clearStorage: true }));
  return 0;
}

async function main() {
  const cdp = await connect();
  return args['first-paint'] ? firstPaintProbe(cdp) : transitionProbe(cdp);
}

const watchdog = setTimeout(() => {
  console.error(`probe-transition: timed out after ${args.timeout} s`);
  cleanup();
  process.exit(2);
}, Number(args.timeout) * 1000);
let code = 2;
try {
  code = await main();
} catch (error) {
  const message = error instanceof ProbeFailure ? error.message : (error?.stack ?? error);
  console.error(`probe-transition: ${message}`);
} finally {
  clearTimeout(watchdog);
  cleanup();
}
process.exit(code);
