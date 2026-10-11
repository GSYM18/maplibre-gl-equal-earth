# Plan 3 — Cartographic finish, geo API, GeoJSON, persistent cache, browser tests, ship

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the Equal Earth polyfill to the spec's four success criteria: the cartographic finish (§5), `EqualEarthControl`, "data in, geo out" for the camera API, Marker, Popup, events and GeoJSON (§7), the persistent output-tile cache and `sourceZoomOffset` (§6), a Playwright browser test matrix on MapLibre 5.24 and 6.6 (§8), and a demo that measures first paint against any style, SmartMaps included.

**Architecture:** Everything stays a client-only polyfill. New pure modules (`map/cartography.ts`, `map/geo-api.ts`, `map/geojson.ts`, `tiles/persistent-cache.ts`) are wired through the existing seams: `rewriteStyle` gains generated cartography layers and banded GeoJSON sources; the controller installs per-instance geo wrappers and amends the rewrite in place when the application changes sources, layers or paint while active; the worker's protocol handler gains a Cache Storage tier keyed by plugin version and source config. Browser tests run real MapLibre (both majors) on locally generated fixture tiles in headless Chromium.

**Tech Stack:** TypeScript 5.9, Vite 8, Vitest 4, MapLibre GL JS 6.6 and 5.24 (`maplibre-gl-v5` alias), `@mapbox/vector-tile`/`pbf`/`vt-pbf`, geojson-vt (dev, fixture tiles), `@playwright/test` 1.62.1 (new dev dependency).

**Spec:** `docs/superpowers/specs/2026-09-28-equal-earth-v5-v6-state-of-the-art-design.md` (§1 criteria, §5, §6, §7, §8, §9 Plan 3). The geo API audit that §7 requires is done: `docs/superpowers/audits/2026-10-11-geo-api-audit.md` — Tasks 6 and 7 implement its recommendation.

## Global Constraints

- MapLibre **≥ 5.24 and 6.x**; `peerDependencies` stays `"maplibre-gl": ">=5.24 <7"`.
- **No new runtime dependencies.** `dependencies` stays `@mapbox/vector-tile`, `pbf`, `vt-pbf`.
- **Registry cutoff:** this environment's npm proxy refuses packages published after 2026-08-31. `@playwright/test` is pinned to exactly **`1.62.1`** (published 2026-07-30); its Chromium build (revision 1234, `chromium_headless_shell-1234`) is already in `%LOCALAPPDATA%\ms-playwright`, so the browser tests need no download. Any other new devDependency must be checked with `npm view <pkg> time` first.
- **Browser tests use no network**: fixture tiles are generated in memory by the test server; styles are inline objects; no glyphs, sprites or remote TileJSON.
- Worker bundles stay self-contained; `npm run check:exports` (exports diff + worker-bundle guard + literal worker URL guard) passes after every task.
- `src/map/*` and `src/install.ts` have **no runtime `maplibre-gl` import**; hosts are typed structurally, and `tests/host-types.test.ts` proves real v5 and v6 `Map`s satisfy every host interface.
- Non-goals (spec §1): no raster or hillshade warping, no terrain, no Equal Earth together with globe, `queryRenderedFeatures` geometry and deck.gl overlays are not converted.
- `npm run verify` green before every commit; from Task 2 on it includes `npm run test:browser`.
- Stage explicit paths and run `git diff --cached --name-only` before every commit. Never commit `dist/`, `docs/Screenshot*.png`, `test-results/`, `playwright-report/` or `.superpowers/**`. Never `git add -f`.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Carried from Plan 2, and where each went:** `LayerGate.symbol` rename, `dispose()` leftovers → Task 1. The 0.81-zoom wheel step → Task 2 (pinned, root-caused if it fails). `EqualEarthControl` → Task 5. Per-worker cache memory × pool size → documented in Task 11 (README, with the persistent cache). Not taken: the `decodedTiles` channel into the shipped worker (Task 10's persistent cache removes the repeated decodes that motivated it; `createEqualEarthProtocol` keeps the option), a committed real-OpenFreeMap MVT fixture for the clip comparison (ODbL attribution and ~1 MB per tile in the repo; Task 3's browser seam measurement on fixture tiles covers the visible risk), and the `native` option (nothing to delegate to until maplibre-gl-js#8330 lands).
- Test titles that contain an apostrophe use double quotes.

## Review Focus

1. **An application that adds sources or layers in a loop while Equal Earth is active** (`for (…) map.addLayer(…)`) — expected: one coalesced amend per tick, not one style rewrite and camera re-install per call; the map does not flicker or move. Pinned in Task 9 ("coalesces ten addLayer calls into one amend that neither re-installs nor moves the camera").
2. **A Marker or Popup near the antimeridian** while active — expected: it sits on its geographic position, not wrapped to the other side of the world by MapLibre's `smartWrap` comparing a geographic `lngLat` with a map-space centre. Pinned in Task 6 (browser check 4, "Marker near the antimeridian").
3. **A style without a `background` layer, or whose background is an expression or a pattern** — expected: the world polygon is omitted (no background) or carries the same expression/pattern as `fill-color`/`fill-pattern`, and the rewritten style validates. Pinned in Task 4.
4. **Cache Storage missing, throwing, or over quota** (insecure context, private mode, `put` rejects) — expected: the tile is still served from the network path and nothing is logged per tile. Pinned in Task 10 ("serves the tile when Cache Storage throws on put").
5. **The plugin installed but inactive** — expected: `mercator` and `globe` render pixel-identically to a page without the plugin, and every wrapped method returns exactly what MapLibre's own returns. Pinned in Task 2 (screenshots), Task 6 (pass-through unit test and browser check 8) and Task 7 (targets pass through while inactive).

## File Structure

| File | Task | Responsibility |
|---|---|---|
| `src/map/style-rewrite.ts` | 1, 3, 4, 8, 9, 10 | `hideByVisibility` rename; `fill-antialias`; cartography layers; banded GeoJSON sources; `initialBand`; cache/offset in source URLs |
| `src/map/switcher.ts` | 1, 9 | follows the rename; reads the current rewrite through a getter |
| `src/map/controller.ts` | 1, 3, 4, 6, 7, 8, 9, 10 | dispose cleanup; relief notice; cartography options; geo wrappers; GeoJSON fan-out; live style edits amended in place; cache options |
| `src/install.ts` | 1, 4, 5, 6, 10 | timeout doc; options; `projectiontransition`; geo wrappers per map |
| `tests/browser/**` | 2 (+3–10) | Playwright config, fixture-tile server, harness page, specs |
| `src/tiles/mvt.ts` | 3 | pole snapping in decode |
| `src/map/cartography.ts` | 4 | world polygon, outline, graticule geometry (pure) |
| `src/map/control.ts` | 5 | `EqualEarthControl` |
| `src/map/instance-wrap.ts` | 6 (used by 8, 9) | `wrapMethod`: install/restore one own-property wrapper on an instance |
| `src/map/geo-api.ts` | 6, 7 | per-instance wrappers ("data in, geo out"): reads (6), camera targets and `fitBounds` (7) |
| `src/map/geojson.ts` | 8 | warp GeoJSON per band |
| `src/tiles/persistent-cache.ts` | 10 | Cache Storage tier |
| `src/tiles/tile-cover.ts`, `src/tiles/protocol.ts` | 10 | `sourceZoomOffset`; cache tier wiring |
| `scripts/probe-openfreemap.ts`, `scripts/probe-transition.mjs` | 6, 10, 11 | world-view budget; throttled first paint |
| `demo/transition.*`, `README.md`, `CLAUDE.md` | 6, 7, 11 | demo for any style; docs |

---

### Task 1: Carried cleanups from Plan 2

**Files:**
- Modify: `src/map/style-rewrite.ts`, `src/map/switcher.ts`, `src/map/controller.ts`, `src/install.ts`, `CLAUDE.md`
- Test: `tests/style-rewrite.test.ts`, `tests/switcher.test.ts`, `tests/controller.test.ts`, `tests/install.test.ts`

**Interfaces:**
- Produces: `LayerGate.hideByVisibility: boolean` (replaces `LayerGate.symbol`; same meaning: hidden by `visibility: "none"`, true for symbol, hillshade and color-relief copies). Every later task uses `hideByVisibility`.

Five items the Plan 2 final review carried forward:

1. `LayerGate.symbol` no longer means "symbol layer" (hillshade and color-relief set it too). Rename it to `hideByVisibility` everywhere: the interface and its doc comment, `gateCopy`, `applyGate`, `BandSwitcher#switch` (which schedules the delayed hide for these gates), tests, README/CLAUDE.md mentions. A pure rename: no behaviour change, the snapshot `tests/__snapshots__/liberty-six-steps.txt` must not change.
2. `EqualEarthController.dispose()` (a removed map) destroys the switcher but leaves the installed `BandCamera` and constraint holding their map listeners. Also call `camera.destroy()` and `uninstallConstrain()` there (both only call `off`/restore hooks, which is harmless on a removed map) so the closures can be collected.
3. `InstallOptions.workerTimeoutMs`: document the edge values next to `Infinity`: `0` or a negative value falls back to the main thread at once, `NaN` waits without a bound (it fails `ms <= MAX_TIMEOUT_MS`). No behaviour change.
4. `tests/install.test.ts`: `getProjection()` after a **failed** activation returns MapLibre's own result (the polyfill's `pending` is cleared in the controller's `finally`). The behaviour exists; pin it.
5. `CLAUDE.md` "What this package is" says "Equal Earth projection support for MapLibre GL JS v6": make it "MapLibre GL JS v6, and v5 from 5.24".

- [ ] **Step 1: Write the failing tests**

In `tests/style-rewrite.test.ts`, change every `symbol:` expectation on a gate to `hideByVisibility:` and add:

```ts
it('marks symbol, hillshade and color-relief copies hideByVisibility, and no others', () => {
  const style = liberty();
  style.sources['dem'] = { type: 'raster-dem', url: 'https://example.invalid/dem.json' };
  style.layers.push(
    { id: 'shade', type: 'hillshade', source: 'dem' },
    { id: 'relief', type: 'color-relief', source: 'dem' },
  );
  const { gates } = rewrite(style, SIX, 4.4);
  const byType = new Map(style.layers.map((l) => [l.id, l.type]));
  for (const gate of gates) {
    const id = gate.layerId.replace(/__b\d+$/, '');
    const type = byType.get(id);
    expect(gate.hideByVisibility, `${gate.layerId} (${type})`).toBe(
      type === 'symbol' || type === 'hillshade' || type === 'color-relief',
    );
    expect('symbol' in gate).toBe(false);
  }
});
```

(`liberty()`, `rewrite()` and `SIX` are the existing helpers at the top of the file; if `rewrite` has another name there, use it.)

In `tests/controller.test.ts`, add:

```ts
it('dispose releases the camera hook and the constraint as well as the switcher', async () => {
  const { host, controller } = setup();
  await controller.activate('equal');
  expect(host._camera.transformCameraUpdate).not.toBeNull();
  expect(host.constrain).not.toBeNull();
  controller.dispose();
  expect(host._camera.transformCameraUpdate).toBeNull();
  expect(host.constrain).toBeNull();
});
```

In `tests/install.test.ts`, add (reuse the file's `fakeModule` and the fake controller host the polyfill tests already use; the TileJSON fetch rejects):

```ts
it('getProjection falls back to MapLibre after a failed activation', async () => {
  const { module, FakeMap } = fakeModule();
  const install = await installEqualEarth(module, { fetchJson: async () => { throw new Error('offline'); } });
  const map = new FakeMap();
  map.setProjection({ type: 'mercator' });
  map.setProjection({ type: 'equal' });
  await vi.waitFor(() => expect(map.getProjection()).toEqual({ type: 'mercator' }));
  install.uninstall();
});
```

If the existing polyfill tests use a richer fake map (a `FakeControllerHost` with a style), build this test on that one instead so `activate` really runs and fails on the fetch; the assertion stays the same.

- [ ] **Step 2: Run them to verify the first two fail**

Run: `npx vitest run tests/style-rewrite.test.ts tests/controller.test.ts tests/install.test.ts`
Expected: the `hideByVisibility` test and the dispose test FAIL; the `getProjection` test passes (it pins existing behaviour).

- [ ] **Step 3: Implement**

Rename the field (TypeScript will list every use: `npx tsc --noEmit`). In `dispose()`:

```ts
dispose(): void {
  this.#nextGeneration();
  this.#pending = undefined;
  this.#settle(superseded());
  const installed = this.#installed;
  this.#installed = undefined;
  if (installed) {
    installed.switcher.destroy();
    installed.camera.destroy();
    installed.uninstallConstrain();
  }
  this.#projection = undefined;
  this.#view = undefined;
  this.#unsubscribe(); // `off` only: the map's style is not touched
  this.#release();
}
```

Add the `workerTimeoutMs` doc lines and the CLAUDE.md wording.

- [ ] **Step 4: Verify**

Run: `npm run verify`
Expected: PASS; `git diff tests/__snapshots__` is empty.

- [ ] **Step 5: Commit**

```bash
git add src/map/style-rewrite.ts src/map/switcher.ts src/map/controller.ts src/install.ts CLAUDE.md README.md tests/style-rewrite.test.ts tests/switcher.test.ts tests/controller.test.ts tests/install.test.ts
git diff --cached --name-only
git commit -m "Rename LayerGate.symbol to hideByVisibility; dispose releases every hook" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Browser test harness (Playwright, MapLibre 5.24 and 6.6)

**Files:**
- Create: `tests/browser/playwright.config.ts`, `tests/browser/vite.config.ts`, `tests/browser/fixture-tiles.ts`, `tests/browser/harness.html`, `tests/browser/harness.ts`, `tests/browser/helpers.ts`, `tests/browser/baseline.spec.ts`
- Modify: `package.json` (`test:browser` script, `verify`, devDependency `@playwright/test` `1.62.1`), `.gitignore` (`test-results/`, `playwright-report/`), `vitest.config.ts` (exclude `tests/browser/**`), `CLAUDE.md` (Commands)

**Interfaces:**
- Produces, for every later browser spec:
  - the harness page `http://localhost:5179/tests/browser/harness.html?mlv=5|6[&plugin=0][&dpr=2][&compensation=none]`, which sets `window.__h = { ready: Promise<void>, maplibregl, map, install?, controller?, errors: string[] }`;
  - fixture tiles at `http://localhost:5179/fixture-tiles/{z}/{x}/{y}.pbf` (layers `land`, `lines`, `places`; z0–14);
  - `tests/browser/helpers.ts`: `openHarness(page, { mlv, plugin?, dpr?, projection?, compensation? }): Promise<void>`, `idle(page): Promise<void>` (waits for the map's `idle`), `canvasDataUrl(page): Promise<string>`, `geographicCentreOffsetPx(page, target: [number, number]): Promise<number>`, `pixelOf(page, lngLat: [number, number]): Promise<[number, number]>` (the canvas pixel of a geographic position), `centreOn(page, lngLat: [number, number], zoom: number): Promise<void>` (jump there and wait for `idle`). Every spec converts geographic positions only through these helpers, never with `controller.toMapSpace` inline: Task 6 makes `project`/`jumpTo` geographic and then changes only the helper bodies.
- Consumes: `installEqualEarth`, `controllerFor` (public API).

**Why a dev server and generated tiles.** MapLibre needs a real WebGL context, so the camera, style and Marker behaviour that unit fakes model must be pinned against the real thing (spec §8), on both majors. The page imports the plugin from `/src/index.ts` (Vite transforms it) and the built worker from `/dist/` (`npm run build` runs before `test:browser` in `verify`). Fixture tiles are generated in memory from synthetic GeoJSON with geojson-vt and vt-pbf (both already installed), so nothing binary is committed and nothing touches the network.

- [ ] **Step 1: Install Playwright at the pinned version**

Run: `npm install --save-dev --save-exact @playwright/test@1.62.1`
Then: `git diff --stat package-lock.json` — only Playwright's own packages may be added. Check the browser is present without downloading: `npx playwright install --dry-run chromium` lists `chromium_headless_shell-1234` under `%LOCALAPPDATA%\ms-playwright` (if the dry run reports a download, stop and report: the cached revision does not match).

- [ ] **Step 2: The fixture tile server**

Create `tests/browser/fixture-tiles.ts`:

```ts
/**
 * In-memory fixture tiles for the browser tests: synthetic GeoJSON, tiled with geojson-vt and
 * encoded with vt-pbf, served by a Vite middleware. Deterministic, offline, nothing committed.
 *
 * The data is shaped to exercise the warp, not to look like a map: land boxes that straddle
 * source-tile boundaries at z1–z4 (fill seams), one reaching Mercator's ±85.0511° edge (pole
 * snapping), lines along parallels and meridians, and points with numeric ids.
 */
import geojsonvt from 'geojson-vt';
import vtpbf from 'vt-pbf';
import type { Plugin } from 'vite';

const ring = (w: number, s: number, e: number, n: number, step = 1): number[][] => {
  const pts: number[][] = [];
  for (let x = w; x < e; x += step) pts.push([x, s]);
  for (let y = s; y < n; y += step) pts.push([e, y]);
  for (let x = e; x > w; x -= step) pts.push([x, n]);
  for (let y = n; y > s; y -= step) pts.push([w, y]);
  pts.push([w, s]);
  return pts;
};

const box = (id: number, w: number, s: number, e: number, n: number): GeoJSON.Feature => ({
  type: 'Feature', id, properties: { kind: 'land' },
  geometry: { type: 'Polygon', coordinates: [ring(w, s, e, n)] },
});

export const FIXTURE: Record<string, GeoJSON.FeatureCollection> = {
  land: { type: 'FeatureCollection', features: [
    box(1, -20, -35, 50, 35),     // straddles lng 0 and lat 0: four z1 source tiles
    box(2, -125, 25, -65, 60),
    box(3, 100, -45, 155, -10),
    box(4, -60, 70, 60, 85.0511287798066), // touches Mercator's northern edge
    box(5, 170, 50, 180, 70),     // touches the antimeridian
  ] },
  lines: { type: 'FeatureCollection', features: [
    ...[-60, -30, 0, 30, 60].map((lat, i): GeoJSON.Feature => ({
      type: 'Feature', id: 100 + i, properties: { kind: 'parallel' },
      geometry: { type: 'LineString', coordinates: Array.from({ length: 361 }, (_, k) => [-180 + k, lat]) },
    })),
  ] },
  places: { type: 'FeatureCollection', features: [
    [8.54, 47.37], [139.69, 35.69], [-122.42, 37.77], [-149.9, 61.22], [103.82, 1.35], [179.5, 0],
  ].map((c, i): GeoJSON.Feature => ({ type: 'Feature', id: 200 + i, properties: { kind: 'place' }, geometry: { type: 'Point', coordinates: c } })) },
};

const indexes = Object.fromEntries(
  Object.entries(FIXTURE).map(([name, data]) => [name, geojsonvt(data, { maxZoom: 14, indexMaxZoom: 4, tolerance: 0, buffer: 64, extent: 4096 })]),
);

/** One fixture tile as MVT bytes, or `null` when every layer is empty. */
export function fixtureTile(z: number, x: number, y: number): Uint8Array | null {
  const layers: Record<string, unknown> = {};
  for (const [name, index] of Object.entries(indexes)) {
    const tile = index.getTile(z, x, y);
    if (tile && tile.features.length > 0) layers[name] = tile;
  }
  if (Object.keys(layers).length === 0) return null;
  return vtpbf.fromGeojsonVt(layers as never, { version: 2, extent: 4096 });
}

/** Serves `/fixture-tiles/{z}/{x}/{y}.pbf` (204 when empty, as tile servers do). */
export function fixtureTilesPlugin(): Plugin {
  return {
    name: 'equal-earth:fixture-tiles',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const match = /^\/fixture-tiles\/(\d+)\/(\d+)\/(\d+)\.pbf$/.exec(req.url ?? '');
        if (!match) return next();
        const bytes = fixtureTile(Number(match[1]), Number(match[2]), Number(match[3]));
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (!bytes) { res.statusCode = 204; res.end(); return; }
        res.setHeader('Content-Type', 'application/x-protobuf');
        res.end(Buffer.from(bytes));
      });
    },
  };
}
```

Adjust only what the typings demand (`vendor.d.ts` declares geojson-vt/vt-pbf types; reuse them). Create `tests/browser/vite.config.ts` extending the root config's `optimizeDeps.exclude: ['maplibre-gl']`, adding `fixtureTilesPlugin()`, `server: { port: 5179, strictPort: true }`, and **not** the library `build.lib` section.

- [ ] **Step 3: The harness page**

`tests/browser/harness.html`: a 512×384 `#map` div (fixed size: screenshots must be comparable), white page background, `<script type="module" src="./harness.ts">`.

`tests/browser/harness.ts` reads `?mlv=5|6` (default 6), `?plugin=0|1` (default 1), `?dpr=`, `?projection=mercator|globe|equal|equal-earth` (default mercator) and `?compensation=` (passed to `installEqualEarth` when present):

- MapLibre 6: `const maplibregl = await import('maplibre-gl')`. MapLibre 5: inject `<script src="/node_modules/maplibre-gl-v5/dist/maplibre-gl.js">`, await its `load`, take `window.maplibregl`. Load the matching CSS the same way.
- With the plugin: `install = await installEqualEarth(maplibregl, { workerUrl: new URL(mlv === 6 ? '/dist/worker.mjs' : '/dist/worker.iife.js', location.href), workerTimeoutMs: 15000, ...(compensation ? { compensation } : {}) })`, before creating the map.
- Map options: `container: 'map'`, `style: FIXTURE_STYLE`, `center: [0, 20]`, `zoom: 1`, `fadeDuration: 0`, `pixelRatio: dpr`, `canvasContextAttributes: { preserveDrawingBuffer: true }` (v5: `preserveDrawingBuffer: true` at the top level — use whichever the loaded major accepts), `attributionControl: false`.
- `FIXTURE_STYLE`: `version: 8`, source `fixture` = `{ type: 'vector', tiles: [location.origin + '/fixture-tiles/{z}/{x}/{y}.pbf'], maxzoom: 14 }`, layers: `background` (`#f8f4f0`), `land` fill (`#9fd39f`), `lines` line (`#336699`, width 1), `places` circle (`#cc3333`, radius 4). No glyphs, no sprite.
- `map.on('error', e => __h.errors.push(String(e.error?.message ?? e.error)))`; collect `console.warn` lines starting with `[equal-earth]` into `__h.errors` too.
- After `load`: if `projection !== 'mercator'`, `map.setProjection({ type: projection })`; resolve `__h.ready` on the next `idle`. With the plugin, `__h.controller = install.controllerFor(map)`.

`tests/browser/helpers.ts`: `openHarness` navigates and awaits `window.__h.ready` (60 s timeout: SwiftShader is slow); `idle` awaits `map.once('idle')` after triggering a repaint check (`map.loaded() ? resolve : once('idle')`); `canvasDataUrl` returns `map.getCanvas().toDataURL('image/png')`; `pixelOf(page, c)` evaluates `map.project(controller?.active ? controller.toMapSpace(c) : c)` and returns `[x, y]`; `centreOn(page, c, z)` evaluates `map.jumpTo({ center: controller?.active ? controller.toMapSpace(c) : c, zoom: z })` and awaits `idle`; `geographicCentreOffsetPx(page, target)` returns the distance between the canvas centre (`clientWidth / 2`, `clientHeight / 2`) and `pixelOf(page, target)`.

`tests/browser/playwright.config.ts`: `testDir: '.'`, `testMatch: '*.spec.ts'`, `timeout: 120_000`, `workers: 1`, `retries: 0`, `webServer: { command: 'npx vite --config tests/browser/vite.config.ts', url: 'http://localhost:5179/tests/browser/harness.html', reuseExistingServer: true, timeout: 60_000 }`, `use: { baseURL: 'http://localhost:5179', launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } }`, two projects `{ name: 'v6', use: { mlv: 6 } }` and `{ name: 'v5', use: { mlv: 5 } }` (a typed fixture option `mlv` via `test.extend`, declared in `helpers.ts`).

- [ ] **Step 4: Write the baseline specs**

`tests/browser/baseline.spec.ts` (import `test`, `expect` from `./helpers.ts`, which re-exports them with the `mlv` option):

```ts
test('tiles are warped in the worker, not on the main thread', async ({ page, mlv }) => {
  await openHarness(page, { mlv, projection: 'equal' });
  const state = await page.evaluate(() => ({ path: window.__h.install!.workerPath, errors: window.__h.errors }));
  expect(state.path).toBe('worker');
  expect(state.errors).toEqual([]);
});

for (const projection of ['mercator', 'globe'] as const) {
  test(`${projection} renders pixel-identically with and without the plugin`, async ({ page, mlv }) => {
    await openHarness(page, { mlv, plugin: false, projection });
    const without = await canvasDataUrl(page);
    await openHarness(page, { mlv, plugin: true, projection });
    const withPlugin = await canvasDataUrl(page);
    expect(withPlugin).toBe(without);
  });
}

test('mercator → equal → mercator restores the original rendering', async ({ page, mlv }) => {
  await openHarness(page, { mlv });
  const before = await canvasDataUrl(page);
  await page.evaluate(() => window.__h.map.setProjection({ type: 'equal' }));
  await page.waitForFunction(() => window.__h.controller?.active === true);
  await idle(page);
  await page.evaluate(() => window.__h.map.setProjection({ type: 'mercator' }));
  await idle(page);
  expect(await canvasDataUrl(page)).toBe(before);
});

test('a setStyle round trip keeps Equal Earth active', async ({ page, mlv }) => {
  await openHarness(page, { mlv, projection: 'equal' });
  await page.evaluate(() => {
    const map = window.__h.map;
    const style = window.__h.fixtureStyle();
    style.layers.find((l) => l.id === 'land')!.paint = { 'fill-color': '#4477aa' };
    map.setStyle(style);
  });
  await idle(page);
  const state = await page.evaluate(() => ({
    active: window.__h.controller!.active,
    rewritten: Boolean((window.__h.map.getStyle().metadata as Record<string, unknown>)['equal-earth:rewritten']),
  }));
  expect(state).toEqual({ active: true, rewritten: true });
});

test('the geographic centre stays within 1 px across band crossings (flyTo, wheel)', async ({ page, mlv }) => {
  const zurich: [number, number] = [8.54, 47.37];
  await openHarness(page, { mlv, projection: 'equal' });
  await centreOn(page, zurich, 3.5);
  await page.evaluate(() => window.__h.map.flyTo({ zoom: 8.5, duration: 3000 }));
  await idle(page);
  expect(await geographicCentreOffsetPx(page, zurich)).toBeLessThanOrEqual(1);
  const box = (await page.locator('#map canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, 240); await page.waitForTimeout(150); }
  await idle(page);
  expect(await geographicCentreOffsetPx(page, zurich)).toBeLessThanOrEqual(1);
});

test('one wheel notch zooms as far as it does without the plugin', async ({ page, mlv }) => {
  const notch = async (plugin: boolean): Promise<number> => {
    // No compensation: getZoom() is then the requested zoom, with no band offset in it.
    await openHarness(page, { mlv, plugin, projection: plugin ? 'equal' : 'mercator', compensation: 'none' });
    await page.evaluate(() => window.__h.map.jumpTo({ zoom: 5 }));
    await idle(page);
    const box = (await page.locator('#map canvas').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -100);
    await idle(page);
    return page.evaluate(() => window.__h.map.getZoom());
  };
  const plain = await notch(false);
  const equal = await notch(true);
  expect(Math.abs((equal - 5) / (plain - 5) - 1)).toBeLessThan(0.05);
});
```

`window.__h.fixtureStyle()` returns a fresh copy of `FIXTURE_STYLE`; `controller.requestedZoom` — if the controller does not expose it, expose a read-only getter delegating to the installed camera's `requestedZoom` (falls back to `getZoom()`); add one unit test for it in `tests/controller.test.ts`. Declare `window.__h`'s type in `helpers.ts` (`declare global { interface Window { __h: Harness } }`).

The last test pins the Plan 2 ledger's open observation ("one zoom-out wheel step moved 0.81 zoom instead of ~0.37"). If it fails, that is a real defect: find the root cause (superpowers:systematic-debugging — likely the scroll handler reading the rendered zoom, which carries the compensation offset, instead of `R`'s) and fix it in this task, with the browser test as the regression test; record the root cause in the report.

- [ ] **Step 5: Wire the scripts**

`package.json`: `"test:browser": "playwright test --config tests/browser/playwright.config.ts"`, and `verify` becomes `npm run lint && npm run typecheck && npm test && npm run build && npm run check:exports && npm run test:browser`. `vitest.config.ts`: `exclude: ['tests/browser/**', 'node_modules/**']`. `.gitignore`: `test-results/`, `playwright-report/`. CLAUDE.md Commands: `npm run test:browser` (both majors, SwiftShader; ~1–3 min), single spec `npx playwright test --config tests/browser/playwright.config.ts baseline.spec.ts --project v6`, and the note that the Chromium revision must match the pinned Playwright (`npx playwright install chromium` needs network).

- [ ] **Step 6: Run and verify**

Run: `npm run build && npm run test:browser`
Expected: every test passes on both projects. Then `npm run verify`.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .gitignore vitest.config.ts CLAUDE.md tests/browser
git add src tests/controller.test.ts   # only if Step 4 exposed requestedZoom or fixed the wheel defect
git diff --cached --name-only
git commit -m "Add the Playwright browser matrix on MapLibre 5.24 and 6.6 with offline fixture tiles" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Poles, fill seams and the relief notice

**Files:**
- Modify: `src/tiles/mvt.ts` (`decodeToGeographic`), `src/map/style-rewrite.ts`, `src/map/controller.ts`
- Test: `tests/tiles.test.ts`, `tests/style-rewrite.test.ts`, `tests/controller.test.ts`, `tests/browser/cartography.spec.ts` (create)

**Interfaces:**
- Produces: `decodeToGeographic` snaps polygon vertices with |lat| ≥ `MERCATOR_MAX_LATITUDE − 1e-9` to ±90 (exported constant `POLE_SNAP_EPSILON = 1e-9` in `mvt.ts`); rewritten fill copies of bands with blend < 1 carry `fill-antialias: false` unless the layer sets `fill-antialias` itself — **only if Step 4's measurement shows seams** (see there).

Spec §5: Mercator data ends at ±85.0511°, Equal Earth shows ±90°; unfixed, the world polygon's land colour shows above the Arctic Ocean. Polygon vertices at or beyond the Mercator edge are snapped to the pole during decode; lines and points are not. The decode cache is shared by every band with blend < 1 (blend 1 passes bytes through and never decodes), so snapping there is correct for all of them.

- [ ] **Step 1: Failing tests (node)**

`tests/tiles.test.ts`:

```ts
describe('pole snapping', () => {
  it('snaps polygon vertices on the Mercator edge of a z0 tile to the pole, and leaves lines alone', () => {
    const top = MERCATOR_MAX_LATITUDE;
    const bytes = encodeTile({
      water: [{ type: 'Polygon', coordinates: [[[-180, 80], [180, 80], [180, top], [-180, top], [-180, 80]]] }],
      boundary: [{ type: 'LineString', coordinates: [[-10, top], [10, top]] }],
    }, { z: 0, x: 0, y: 0 });
    const layers = decodeToGeographic(bytes, { z: 0, x: 0, y: 0 });
    const ring = (layers.get('water')![0]!.geometry as GeoJSON.Polygon).coordinates[0]!;
    expect(Math.max(...ring.map((p) => p[1]!))).toBe(90);
    expect(ring.filter((p) => p[1] === 90)).toHaveLength(2);
    const line = (layers.get('boundary')![0]!.geometry as GeoJSON.LineString).coordinates;
    expect(line.every((p) => p[1]! < 90)).toBe(true);
  });

  it('warps a snapped polygon to the top of the Equal Earth world', () => {
    // End to end: buildTile of output tile 0/0/0 at blend 0 reaches the map-space pole line.
    // Assert the warped ring's minimum tile y is within 2 units of the pole line's tile y,
    // computed from worldYRange(0)[0] * 4096.
  });
});
```

`tests/tiles.test.ts` has no GeoJSON-to-MVT helper yet (it builds tiles with `fromGeojsonVt` inline). Add one at the top of the file, beside the existing `geojson-vt`/`vt-pbf` imports (both are devDependencies; `tests/clip.test.ts` uses the same pattern):

```ts
import geojsonvt from 'geojson-vt';

/** Encode geographic GeoJSON geometries, per layer, into the MVT of `tile` (extent 4096, buffer 64). */
function encodeTile(layers: Record<string, GeoJSON.Geometry[]>, tile: TileId): Uint8Array {
  const encoded: Record<string, unknown> = {};
  for (const [name, geometries] of Object.entries(layers)) {
    const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: geometries.map((geometry) => ({ type: 'Feature', properties: {}, geometry })) };
    const index = geojsonvt(fc, { maxZoom: Math.max(tile.z, 1), indexMaxZoom: 0, tolerance: 0, extent: 4096, buffer: 64, debug: 0 });
    const t = index.getTile(tile.z, tile.x, tile.y);
    if (t && t.features.length > 0) encoded[name] = t;
  }
  return fromGeojsonVt(encoded as Parameters<typeof fromGeojsonVt>[0], { version: 2, extent: 4096 });
}
```

geojson-vt clamps latitude to the Mercator range itself, so a vertex at `MERCATOR_MAX_LATITUDE` lands on tile y 0 (decoding returns it within ~1e-9° of the limit, which is what the snap epsilon is for). Write the second test's body with `encodeTile`, `buildTile` and `worldYRange` (`buildTile` from `src/tiles/mvt.ts`, `worldYRange` from `src/math/backproject.ts`).

`tests/controller.test.ts`: activating `equal` on Liberty (which has the `natural_earth` raster) logs exactly one `console.info` containing `"raster"`; activating a second controller on another map in the same test does not log again (`vi.spyOn(console, 'info')`). Activating on a style without raster/hillshade/color-relief logs nothing.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/tiles.test.ts tests/controller.test.ts`

- [ ] **Step 3: Implement**

In `decodeToGeographic`, after `toGeoJSON`, for `Polygon`/`MultiPolygon` geometries map every position with `lat >= MERCATOR_MAX_LATITUDE - POLE_SNAP_EPSILON` to `[lng, 90]` and `lat <= -(MERCATOR_MAX_LATITUDE - POLE_SNAP_EPSILON)` to `[lng, -90]`, in place on the freshly decoded arrays (they are not shared yet). Comment why lines and points are excluded (a road or label at 85° is real data; only area fills must close the gap). In the controller, after a successful `#applyNow`, if the original style has any `raster`, `hillshade` or `color-relief` layer and the transition is not pure Mercator, `console.info('[equal-earth] raster, hillshade and color-relief layers are not warped: they are shown only in the Mercator band (from z<floor>), and hidden under pure Equal Earth.')` once per page (module-level flag), `<floor>` being `parseRange(transition, steps)[0]` rounded to one decimal, or the sentence's second half only under `equal-earth`.

- [ ] **Step 4: Measure fill seams in the browser, then decide**

Create `tests/browser/cartography.spec.ts` with a seam test, run at `dpr` 1 and 2 on both majors: open the harness with `projection: 'equal'`, `jumpTo` to each of z2, z3, z4 centred on `[15, 0]` (the fixture box 1 straddles lng 0 and lat 0, i.e. four source tiles), wait for `idle`, read the canvas pixels inside the warped box (`pixelOf(page, [lng, lat])` for a 40×40 grid of points strictly inside box 1, sampled with a 2D canvas `drawImage` of the WebGL canvas + `getImageData`), and count pixels whose colour is within 8/255 of the background `#f8f4f0` instead of the land `#9fd39f`. Expected: 0 at every zoom and DPR.

Run it with the current code. **If it passes**, do not add `fill-antialias: false` (antialiased coastlines look better), and record the measurement (zero seam pixels, per zoom/DPR/major) in the task report and in CLAUDE.md's "Known artifact" paragraph. **If it fails**, add `fill-antialias: false` to fill copies of bands with blend < 1 in `rewriteStyle` (unless the layer sets `fill-antialias`), with a unit test in `tests/style-rewrite.test.ts` (`fill` copies of band 0 carry `fill-antialias: false`; the Mercator band's original does not; a layer's own `fill-antialias: true` is kept), re-run the seam test until it passes, and record before/after counts.

- [ ] **Step 5: Verify and commit**

Run: `npm run verify`

```bash
git add src/tiles/mvt.ts src/map/controller.ts tests/tiles.test.ts tests/controller.test.ts tests/browser/cartography.spec.ts
git add src/map/style-rewrite.ts tests/style-rewrite.test.ts tests/__snapshots__/liberty-six-steps.txt   # only if Step 4 needed the mitigation
git diff --cached --name-only
git commit -m "Snap polygon vertices on Mercator's edge to the poles; measure fill seams; announce unwarped relief once" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: World polygon, outside colour, outline and graticule

**Files:**
- Create: `src/map/cartography.ts`, `tests/cartography.test.ts`
- Modify: `src/map/style-rewrite.ts`, `src/map/controller.ts` (`ControllerOptions`), `src/install.ts` (`InstallOptions`), `src/index.ts`
- Test: `tests/style-rewrite.test.ts`, `tests/browser/cartography.spec.ts`

**Interfaces:**
- Consumes: `geographicToMap(lngLat, blend)` (`math/backproject.ts`), `LayerGate`/`hideByVisibility` (Task 1), `bandSourceId`, `bandIndexForZoom`.
- Produces:
  - `src/map/cartography.ts`:
    ```ts
    export interface OutlineOptions { color?: string /* '#9a9a9a' */; width?: number /* 1 */ }
    export interface GraticuleOptions { step?: number /* 30 */; color?: string /* 'rgba(0,0,0,0.2)' */; width?: number /* 0.75 */ }
    export interface CartographyOptions {
      /** Colour outside the Equal Earth world, in bands with blend < 1. @defaultValue 'transparent' */
      outsideColor?: string;
      /** The world's edge as a line, in bands with blend < 1. Off unless given. */
      outline?: OutlineOptions | boolean;
      /** Meridians and parallels in every band. Off unless given. */
      graticule?: GraticuleOptions | boolean;
    }
    /** The Equal Earth world at `blend`, in map space: ±180° meridians (sampled every `stepDeg`) closed by the pole lines. */
    export function worldPolygon(blend: number, stepDeg?: number /* 0.5 */): GeoJSON.Feature<GeoJSON.Polygon>;
    /** The same boundary as one closed LineString. */
    export function worldOutline(blend: number, stepDeg?: number): GeoJSON.Feature<GeoJSON.LineString>;
    /** Meridians every `step`° from −180 + step to 180 − step, parallels every `step`° strictly between the poles; sampled every 1°, in map space at `blend`. */
    export function graticule(blend: number, step: number): GeoJSON.FeatureCollection<GeoJSON.LineString>;
    export const CARTOGRAPHY_PREFIX = 'equal-earth:';
    ```
  - `RewriteOptions.cartography?: CartographyOptions`; `InstallOptions` and `ControllerOptions` gain `outsideColor?`, `outline?`, `graticule?` (spec §5 names), passed through as `cartography`.
  - Generated ids (band `k`; `__b<k>` suffix on every band, the Mercator band included, for generated layers): sources `equal-earth:world__b<k>`, `equal-earth:graticule__b<k>`; layers `background__b<k>` (copies of the style's background layer; the Mercator band keeps the original `background` id), `equal-earth:world__b<k>` (fill), `equal-earth:outline__b<k>` (line), `equal-earth:graticule__b<k>` (line).

**Spec §5.** In every band with blend < 1 the style's background copy is recoloured with `outsideColor` (default `transparent`, so the container's CSS shows), and a generated **world polygon** directly above it is filled with the *original* background paint. Without a background layer the world polygon is omitted, and a non-transparent `outsideColor` becomes a background layer of its own in those bands. Outline and graticule are opt-in. All generated layers are band copies like any other: gated by `rewriteStyle`'s gates, so the switcher cross-fades them.

Rules for `rewriteStyle` (add them to the module comment's rule list):

1. **Background.** If the style has a `background` layer `bg` and some band has blend < 1: emit one copy per band at `bg`'s position, in band order. Bands with blend < 1: id `${bg.id}__b<k>`, `paint['background-color'] = outsideColor`, `background-pattern` removed, `background-opacity` kept; the Mercator band: `bg` unchanged. Gate them on `background-opacity` (add `background: ['background-opacity']` to `OPACITY`, with the usual `*-transition`). Without a background layer and `outsideColor !== 'transparent'`: emit `equal-earth:background__b<k>` for each band with blend < 1 at the bottom of the layer list, `background-color: outsideColor`.
2. **World polygon.** Directly after the background copies, for each band with blend < 1: source `equal-earth:world__b<k>` = `{ type: 'geojson', data: worldPolygon(blend), buffer: 0, tolerance: 0 }`, layer `equal-earth:world__b<k>` of type `fill` whose `fill-color`, `fill-opacity` and `fill-pattern` are `bg`'s `background-color`, `background-opacity` and `background-pattern` (expressions and zoom curves carried verbatim — they are valid in the fill properties), `fill-antialias: false` (the edge is drawn by the outline when wanted). Omitted without a background layer.
3. **Outline and graticule.** Inserted directly before the first `symbol` layer of the output (at the end if there is none): graticule first, outline above it. Graticule in **every** band (the Mercator band gets geographic lines); outline only in bands with blend < 1. Both `line` layers with `line-color`/`line-width` from the options and `line-cap: 'round'`.
4. Every generated layer goes through `gateCopy`, so it has a gate and the initial band's state. Generated layers have no `minzoom`/`maxzoom` (GeoJSON is tiled by MapLibre itself; nothing to parse early). Collision with an existing source or layer id throws `TypeError` like the other generated ids.
5. With `transition === null` (pure Equal Earth) there is one band (blend 0); the rules apply to it alone.

- [ ] **Step 1: Failing geometry tests**

`tests/cartography.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { graticule, worldOutline, worldPolygon } from '../src/map/cartography.js';
import { geographicToMap } from '../src/math/backproject.js';

describe('worldPolygon', () => {
  for (const blend of [0, 0.5, 5 / 6]) {
    it(`is a closed ring through the four corners of the world at blend ${blend}`, () => {
      const ring = worldPolygon(blend).geometry.coordinates[0]!;
      expect(ring[0]).toEqual(ring.at(-1));
      for (const corner of [[-180, -90], [-180, 90], [180, 90], [180, -90]] as const) {
        const expected = geographicToMap([corner[0], corner[1]], blend);
        expect(ring.some((p) => Math.abs(p[0]! - expected[0]) < 1e-9 && Math.abs(p[1]! - expected[1]) < 1e-9)).toBe(true);
      }
      // ±180° sampled every 0.5° from pole to pole: 361 positions per side, plus the closing one.
      expect(ring).toHaveLength(2 * 361 + 1);
    });
  }

  it('is counter-clockwise in lng/lat (GeoJSON exterior), so MapLibre fills the inside', () => {
    const ring = worldPolygon(0).geometry.coordinates[0]!;
    let area2 = 0;
    for (let i = 0; i < ring.length - 1; i++) area2 += ring[i]![0]! * ring[i + 1]![1]! - ring[i + 1]![0]! * ring[i]![1]!;
    expect(area2).toBeGreaterThan(0);
  });

  it('bulges: the map-space ±180° meridian is curved, its equator point is the widest', () => {
    const ring = worldPolygon(0).geometry.coordinates[0]!;
    const east = ring.filter((p) => p[0]! > 0);
    const widest = east.reduce((a, b) => (b[0]! > a[0]! ? b : a));
    expect(Math.abs(widest[1]!)).toBeLessThan(1e-9);
    expect(Math.min(...east.map((p) => p[0]!))).toBeLessThan(widest[0]! * 0.7);
  });
});

describe('worldOutline', () => {
  it('traces the same boundary as the polygon', () => {
    expect(worldOutline(0.5).geometry.coordinates).toEqual(worldPolygon(0.5).geometry.coordinates[0]);
  });
});

describe('graticule', () => {
  it('has 11 meridians and 5 parallels at 30°, each sampled every 1°', () => {
    const lines = graticule(0, 30).features;
    const meridians = lines.filter((f) => f.properties!['kind'] === 'meridian');
    const parallels = lines.filter((f) => f.properties!['kind'] === 'parallel');
    expect(meridians).toHaveLength(11);  // −150 … 150
    expect(parallels).toHaveLength(5);   // −60 … 60
    expect(meridians[0]!.geometry.coordinates).toHaveLength(181);
    expect(parallels[0]!.geometry.coordinates).toHaveLength(361);
  });

  it('is geographic in the Mercator band', () => {
    const meridian = graticule(1, 30).features.find((f) => f.properties!['kind'] === 'meridian')!;
    expect(meridian.geometry.coordinates.every((p) => p[0] === -150)).toBe(true);
  });

  it('rejects a step that does not divide 180', () => {
    expect(() => graticule(0, 7)).toThrow(TypeError);
  });
});
```

(Set `properties: { kind: 'meridian' | 'parallel', value: <degrees> }` on graticule features. In the Mercator band, parallels and meridian points beyond ±85.0511° are clamped by `geographicToMap` already; keep them.)

- [ ] **Step 2: Failing rewrite tests**

`tests/style-rewrite.test.ts`, a new `describe('cartography')` using the file's `liberty()`, `rewrite`-style helpers (pass `cartography` through):

```ts
const cart = (options: CartographyOptions, style = liberty(), zoom = 4.6) =>
  rewriteStyle(style, { bands: SIX.bands, transition: SIX, templates: TEMPLATES, initialZoom: zoom, cartography: options });

it('recolours the background copies of Equal Earth bands and puts the world polygon above them', () => {
  const { style } = cart({ outsideColor: '#123456' });
  const ids = style.layers.map((l) => l.id);
  const first = ids.indexOf('background__b0');
  expect(ids.slice(first, first + 7)).toEqual(['background__b0', 'background__b1', 'background__b2', 'background__b3', 'background__b4', 'background__b5', 'background']);
  expect(ids[first + 7]).toBe('equal-earth:world__b0');
  const bg = (id: string) => style.layers.find((l) => l.id === id)!;
  expect(bg('background__b0').paint!['background-color']).toBe('#123456');
  expect(bg('background').paint!['background-color']).toBe(liberty().layers[0]!.paint!['background-color']);
  expect(bg('equal-earth:world__b3').paint!['fill-color']).toEqual(liberty().layers[0]!.paint!['background-color']);
  expect(style.sources['equal-earth:world__b3']).toMatchObject({ type: 'geojson' });
  expect(style.sources['equal-earth:world__b6']).toBeUndefined();
});

it("defaults the outside colour to transparent", () => {
  const { style } = cart({});
  expect(style.layers.find((l) => l.id === 'background__b2')!.paint!['background-color']).toBe('transparent');
});

it('carries a background expression and pattern onto the world polygon', () => {
  const style = liberty();
  style.layers[0]!.paint = { 'background-color': ['interpolate', ['linear'], ['zoom'], 0, '#eee', 6, '#ddd'], 'background-pattern': 'dots', 'background-opacity': 0.9 };
  const out = cart({}, style).style;
  const world = out.layers.find((l) => l.id === 'equal-earth:world__b1')!;
  expect(world.paint).toMatchObject({ 'fill-color': style.layers[0]!.paint['background-color'], 'fill-pattern': 'dots' });
  expect(out.layers.find((l) => l.id === 'background__b1')!.paint!['background-pattern']).toBeUndefined();
});

it('omits the world polygon without a background layer, and adds the outside colour as one', () => {
  const style = liberty();
  style.layers = style.layers.filter((l) => l.type !== 'background');
  const out = cart({ outsideColor: '#000' }, style).style;
  expect(out.layers.some((l) => l.id.startsWith('equal-earth:world'))).toBe(false);
  expect(out.layers[0]).toMatchObject({ id: 'equal-earth:background__b0', type: 'background', paint: { 'background-color': '#000' } });
  expect(cart({}, style).style.layers.some((l) => l.id.startsWith('equal-earth:background'))).toBe(false);
});

it('puts graticule then outline right below the first symbol layer; graticule in every band, outline not in Mercator', () => {
  const { style } = cart({ outline: true, graticule: { step: 15 } });
  const ids = style.layers.map((l) => l.id);
  const firstSymbol = style.layers.findIndex((l) => l.type === 'symbol');
  const generated = ids.slice(0, firstSymbol).filter((id) => /graticule|outline/.test(id));
  expect(generated).toEqual([
    ...[0, 1, 2, 3, 4, 5, 6].map((k) => `equal-earth:graticule__b${k}`),
    ...[0, 1, 2, 3, 4, 5].map((k) => `equal-earth:outline__b${k}`),
  ]);
  expect(ids.indexOf('equal-earth:outline__b5')).toBe(firstSymbol - 1);
});

it('gates every generated layer like a band copy', () => {
  const r = cart({ outline: true, graticule: true }, liberty(), 4.6); // initial band 1
  for (const id of ['background__b0', 'equal-earth:world__b0', 'equal-earth:outline__b0', 'equal-earth:graticule__b0']) {
    const gate = r.gates.find((g) => g.layerId === id);
    expect(gate, id).toBeDefined();
    expect(gate!.band).toBe(0);
  }
  const hidden = r.style.layers.find((l) => l.id === 'equal-earth:world__b0')!;
  expect(hidden.paint!['fill-opacity']).toBe(0);
  const shown = r.style.layers.find((l) => l.id === 'equal-earth:world__b1')!;
  expect(shown.paint!['fill-opacity']).toBeUndefined(); // own value: Liberty's background has none
});

it('validates with every option on', () => {
  expect(validateStyleMin(cart({ outsideColor: '#123', outline: { color: '#000', width: 2 }, graticule: { step: 10 } }).style as never)).toEqual([]);
});

it('works under pure Equal Earth (one band)', () => {
  const r = rewriteStyle(liberty(), { bands: EQUAL_EARTH_BANDS, transition: null, templates: TEMPLATES, initialZoom: 2, cartography: { outline: true } });
  expect(r.style.layers.filter((l) => l.id.startsWith('equal-earth:outline'))).toHaveLength(1);
  expect(r.style.layers.some((l) => l.id === 'background__b0')).toBe(true);
});
```

`TEMPLATES` is whatever the file's existing helper passes as `templates`; `validateStyleMin` is already imported there. Adapt the background id assertions to Liberty's real background layer id (read it from the fixture; it is `layers[0]`).

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run tests/cartography.test.ts tests/style-rewrite.test.ts`

- [ ] **Step 4: Implement**

`src/map/cartography.ts`: pure functions, no MapLibre. `worldPolygon`: east meridian (lng 180) from −90 up to +90, then west meridian (lng −180) from +90 down to −90, closing at the first point — counter-clockwise in lng/lat; each point through `geographicToMap(p, blend)`. `graticule` throws `TypeError` unless `180 % step === 0 && step > 0`.

`style-rewrite.ts`: implement rules 1–5 in `rewriteStyle`; resolve `outline: true` / `graticule: true` to the defaults. Keep the generation in small helpers next to `gateCopy` (`emitBackground`, `emitWorld`, `emitLines`); the main loop stays readable.

Controller and install: add `outsideColor`, `outline`, `graticule` to the option interfaces (doc comments say "spec §5" and the defaults), pass them as `cartography` to `rewriteStyle`. Export `CartographyOptions`, `OutlineOptions`, `GraticuleOptions`, `worldPolygon`, `worldOutline`, `graticule` from `src/index.ts`.

- [ ] **Step 5: Browser check**

`tests/browser/cartography.spec.ts`, new tests (harness gains `?outside=`, `?outline=1`, `?graticule=` parameters passed to `installEqualEarth`):

- `equal-earth` at z1 centred `[0, 0]`, `outside=%23ff00ff`: the canvas pixel at the top-left corner (outside the Equal Earth world) is `#ff00ff` within 8/255; the pixel at `pixelOf(page, [0, -60])` (open ocean in the fixture → background) is the fixture background `#f8f4f0`; the pixel at `pixelOf(page, [-175, 82])` (polar sea above box 4, below the pole) is the background colour too — the Arctic gap is closed (Task 3's pole snapping plus the world polygon).
- Default `outsideColor` (transparent): the corner pixel equals the page background (white).

- [ ] **Step 6: Verify and commit**

Run: `npm run verify`

```bash
git add src/map/cartography.ts src/map/style-rewrite.ts src/map/controller.ts src/install.ts src/index.ts tests/cartography.test.ts tests/style-rewrite.test.ts tests/browser
git diff --cached --name-only
git commit -m "Draw the Equal Earth world: outside colour, world polygon, opt-in outline and graticule" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `EqualEarthControl`

**Files:**
- Create: `src/map/control.ts`, `tests/control.test.ts`
- Modify: `src/install.ts` (fire `projectiontransition` on commit), `src/map/controller.ts` (`ControllerHost.fire` signature), `src/index.ts`, `style.css` is **not** touched (the control ships its icon inline)
- Test: `tests/install.test.ts`, `tests/browser/control.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface EqualEarthControlOptions {
    /** Projection the button turns on. @defaultValue 'equal' */
    on?: 'equal' | 'equal-earth';
    /** Projection it turns off to. @defaultValue 'mercator' */
    off?: 'mercator' | 'globe';
  }
  /** The slice of a MapLibre `Map` the control uses (structural; v5 and v6 satisfy it). */
  export interface ControlHost {
    getProjection(): { type?: unknown } | undefined;
    setProjection(projection: { type: string }): unknown;
    on(type: string, listener: () => void): unknown;
    off(type: string, listener: () => void): unknown;
  }
  export class EqualEarthControl {
    constructor(options?: EqualEarthControlOptions);
    onAdd(map: ControlHost): HTMLElement;
    onRemove(): void;
    getDefaultPosition(): 'top-right';
  }
  ```
  The element is `<div class="maplibregl-ctrl maplibregl-ctrl-group"><button type="button" class="maplibregl-ctrl-equal-earth" aria-pressed="…" title="…">` with an inline SVG of the Equal Earth outline (`worldOutline(0)` scaled into a 20×20 viewBox, `fill: none; stroke: currentColor`). Titles: `"Equal Earth"` when off (the action), `"Mercator"`/`"Globe"` when on. `aria-pressed` is `"true"` while the map's projection is `on`'s type.
- `installEqualEarth`'s polyfill fires `map.fire('projectiontransition', { newProjection: type })` (the event MapLibre's own `GlobeControl`, Marker and Popup listen to) when an `equal`/`equal-earth` activation commits; `ControllerHost.fire` becomes `fire?(event: unknown, properties?: object): unknown` (check v5/v6 `Evented.fire(event: Event | string, properties?)` in the sources and keep `tests/host-types.test.ts` green).

The control reads the state from `map.getProjection()` (polyfilled) on `projectiontransition` and on `styledata` (a `setStyle` may carry a projection), as MapLibre's `GlobeControl` does. Clicking calls `map.setProjection({ type: isOn ? off : on })`. It never touches the controller directly, so it also works with MapLibre's own `GlobeControl` on the same map.

- [ ] **Step 1: Failing unit tests**

`tests/control.test.ts` runs in node with a minimal fake DOM injected through `globalThis.document` (create it in the test file: `createElement` returning objects with `className`, `classList.toggle/contains`, `setAttribute/getAttribute`, `appendChild`, `addEventListener` storing the click handler, `innerHTML` setter, `remove()`), and a fake host:

```ts
class FakeHost {
  type = 'mercator';
  readonly listeners = new Map<string, (() => void)[]>();
  getProjection() { return { type: this.type }; }
  setProjection(p: { type: string }) { this.type = p.type; this.fire('projectiontransition'); return this; }
  on(t: string, l: () => void) { this.listeners.set(t, [...(this.listeners.get(t) ?? []), l]); }
  off(t: string, l: () => void) { this.listeners.set(t, (this.listeners.get(t) ?? []).filter((x) => x !== l)); }
  fire(t: string) { for (const l of this.listeners.get(t) ?? []) l(); }
}

it('turns Equal Earth on and off, reflecting the state in aria-pressed and the title', () => {
  const host = new FakeHost();
  const control = new EqualEarthControl();
  const el = control.onAdd(host);
  const button = el.children[0];
  expect(button.getAttribute('aria-pressed')).toBe('false');
  expect(button.getAttribute('title')).toBe('Equal Earth');
  button.click();
  expect(host.type).toBe('equal');
  expect(button.getAttribute('aria-pressed')).toBe('true');
  expect(button.getAttribute('title')).toBe('Mercator');
  button.click();
  expect(host.type).toBe('mercator');
});

it("follows a projection the application sets itself", () => {
  const host = new FakeHost();
  const el = new EqualEarthControl({ on: 'equal-earth', off: 'globe' }).onAdd(host);
  host.setProjection({ type: 'equal-earth' });
  expect(el.children[0].getAttribute('aria-pressed')).toBe('true');
  expect(el.children[0].getAttribute('title')).toBe('Globe');
});

it('removes its listeners and element on onRemove', () => {
  const host = new FakeHost();
  const control = new EqualEarthControl();
  control.onAdd(host);
  control.onRemove();
  expect([...host.listeners.values()].flat()).toHaveLength(0);
});
```

Shape the fake DOM so `el.children[0]` and `button.click()` work (the fake `click()` calls the stored handler). `tests/install.test.ts`: after `map.setProjection({ type: 'equal' })` commits on a fake controller host, the host recorded one `fire('projectiontransition', { newProjection: 'equal' })`; a superseded or failed activation fires nothing.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/control.test.ts tests/install.test.ts`

- [ ] **Step 3: Implement**

`src/map/control.ts` per the interface; build the SVG path from `worldOutline(0)` at module load (scale map-space lng ±180 → 1…19, lat → mirrored). In `install.ts`, chain `.then(() => { if (controller.projection === type) this.fire?.('projectiontransition', { newProjection: type }); })` onto the activation (before the `.catch`). Export `EqualEarthControl`, `type EqualEarthControlOptions`, `type ControlHost` from `src/index.ts`; add `const acceptsV6Control = (map: MapV6): ControlHost => map;` and the v5 twin to `tests/host-types.test.ts`.

- [ ] **Step 4: Browser check**

`tests/browser/control.spec.ts`: harness gains `?control=1` (adds `new EqualEarthControl()` top-right); clicking the button (`page.locator('.maplibregl-ctrl-equal-earth').click()`) activates Equal Earth (`controller.active` becomes true, `getProjection().type === 'equal'`), clicking again restores Mercator and the canvas equals the pre-click canvas. On v6 additionally add MapLibre's `GlobeControl`; clicking it while Equal Earth is on switches to globe and the Equal Earth button's `aria-pressed` becomes `"false"`.

- [ ] **Step 5: Verify and commit**

Run: `npm run verify`

```bash
git add src/map/control.ts src/install.ts src/map/controller.ts src/index.ts tests/control.test.ts tests/install.test.ts tests/host-types.test.ts tests/browser
git diff --cached --name-only
git commit -m "Add EqualEarthControl and announce Equal Earth activations as projectiontransition" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Geographic reads — `project`, `unproject`, `getCenter`, `getBounds`

**Files:**
- Create: `src/map/instance-wrap.ts`, `src/map/geo-api.ts`, `tests/instance-wrap.test.ts`, `tests/geo-api.test.ts`, `tests/support/fake-geo-host.ts`, `tests/browser/geo-read.spec.ts`
- Modify: `src/map/controller.ts`, `src/install.ts`, `src/index.ts`, `tests/install.test.ts` (fake module gains `LngLatBounds`), `tests/host-types.test.ts` (real v5 and v6 `Map`s satisfy `GeoApiHost`; Task 7 re-checks after extending it), `tests/browser/helpers.ts` (`pixelOf`), `tests/browser/harness.ts` (`?geoapi=0`), `demo/transition.ts`, `scripts/probe-transition.mjs`

**Read first:** `docs/superpowers/audits/2026-10-11-geo-api-audit.md` §0, §1 (rows `project`, `unproject`, `getCenter`, `getBounds`, events), §3 "Reads use the shown band", §6, §7 "Instance or prototype", §8. Spec §7. This task wraps only the four **reads**; Task 7 wraps the camera targets.

**Interfaces:**
- Consumes: `geographicToMap`, `mapToGeographic`, `mapSpaceMaxLatitude`, `mapSpaceMaxLongitude` (`src/math/backproject.ts`), `Band` (`src/map/bands.ts`), the controller's `blend` getter, `BandCamera.baselineBand`.
- Produces:
  ```ts
  // src/map/instance-wrap.ts
  /**
   * Install `make(original)` as an own property `name` of `target`, shadowing the prototype's
   * method. `original` is the method found there before, bound to `target`. The returned
   * restore puts back exactly what was there (an earlier own property, or nothing) — but only
   * while ours is still installed: an application that replaced it after us keeps its own.
   * A missing method is left alone and restore is a no-op.
   */
  export function wrapMethod<F extends (...args: never[]) => unknown>(
    target: object, name: string, make: (original: F) => F,
  ): () => void;

  // src/map/geo-api.ts
  export type LngLatTuple = [lng: number, lat: number];  // re-export of backproject's
  /** What the wrappers read from the controller, live, on every call. */
  export interface GeoApiState {
    /** False while inactive, during globe, or before the first activation: everything passes through. */
    readonly active: boolean;
    /** Blend of the band shown now (T's centre): reads convert with it. */
    readonly blend: number;
    /** Blend of the band the requested camera state R is in: targets convert with it (Task 7). */
    readonly baselineBlend: number;
    /** The bands in effect (Task 7's fitBounds solves over them). */
    readonly bands: readonly Band[];
  }
  export interface GeoApiFactories {
    lngLat(lng: number, lat: number): { lng: number; lat: number };
    lngLatBounds(sw: LngLatTuple, ne: LngLatTuple): unknown;
  }
  /** The map methods Task 6 wraps (both majors have them). Task 7 extends it. */
  export interface GeoApiHost {
    project(lngLat: unknown): { x: number; y: number };
    unproject(point: unknown): { lng: number; lat: number };
    getCenter(): { lng: number; lat: number };
    getBounds(): unknown;
    jumpTo(options: object, eventData?: unknown): unknown;
  }
  /** MapLibre's own methods, unconverted, captured before wrapping: what the plugin itself calls. */
  export interface RawCamera {
    getCenter(): { lng: number; lat: number };
    jumpTo(options: object, eventData?: unknown): unknown;
    unproject(point: unknown): { lng: number; lat: number };
  }
  export interface GeoApi { readonly raw: RawCamera; uninstall(): void }
  export function installGeoApi(host: GeoApiHost, state: GeoApiState, factories: GeoApiFactories): GeoApi;
  /** `RawCamera` without wrapping anything: for `geographicApi: false`. */
  export function rawCamera(host: GeoApiHost): RawCamera;
  /** Mark a value MapLibre produced in map space: target wrappers (Task 7) pass it through. */
  export function markMapSpace<T extends object>(value: T): T;
  export function isMarkedMapSpace(value: unknown): boolean;
  /** `[lng, lat]`, `{lng, lat}` or `{lon, lat}` → tuple; `undefined` for anything else. */
  export function lngLatTuple(value: unknown): LngLatTuple | undefined;
  /**
   * Geographic → map space of `blend`, for any longitude: world copies are kept
   * (`k = round(lng / 360)`, convert `lng − 360k`, add `360k` back), as MapLibre's Marker
   * `smartWrap` can hand `project` a longitude beyond ±180° (audit §8).
   */
  export function mapSpaceOf(lngLat: LngLatTuple, blend: number): LngLatTuple;
  /**
   * Map space of `blend` → geographic, first clamped into the band's world as the camera
   * does (moved here from the controller's private `centreToGeographic`). Always finite with
   * |lat| ≤ 90: MapLibre's `new LngLat` throws otherwise, inside every mousemove (audit §1).
   */
  export function geographicUnder(mapLngLat: LngLatTuple, blend: number): LngLatTuple;
  /** The part of a transform `getBounds` samples (both majors). */
  export interface BoundsTransform {
    readonly width: number;
    readonly height: number;
    screenPointToLocation(point: { x: number; y: number }): { lng: number; lat: number };
    isPointOnMapSurface(point: { x: number; y: number }): boolean;
  }
  /** Audit §6: the geographic bbox of the visible part of the world. */
  export function geographicBounds(transform: BoundsTransform, blend: number): [sw: LngLatTuple, ne: LngLatTuple];
  ```
  `ControllerOptions` gains `lngLatBoundsFactory?: (sw, ne) => unknown` and `geographicApi?: boolean` (default `true`); the controller gains `get baselineBlend(): number` and `get bands(): readonly Band[]`. `InstallOptions` gains `geographicApi?: boolean`; `MapLibreModule` gains `LngLatBounds: new (sw: [number, number], ne: [number, number]) => unknown` (both majors export it).

**Rules.**

1. **Per instance, through `wrapMethod`** (spec §7 says per instance; the audit shows both work, §7). The controller installs the wrappers in its constructor when `geographicApi !== false` and restores them in `destroy()` and `dispose()`; `controllerFor` creates the controller on the map's first `setProjection`, so a map that never asks for Equal Earth is never touched. With `geographicApi: false`, nothing is wrapped (today's behaviour: map space while active).
2. **Reads use the shown band** (`state.blend`, audit §3):
   - `getCenter()` → `lngLat(...geographicUnder(original center, blend))`.
   - `project(lngLat)` → `original(lngLat(...mapSpaceOf(tuple, blend)))`. A value `lngLatTuple` cannot read goes to the original unchanged (MapLibre throws its own error).
   - `unproject(point)` → `lngLat(...geographicUnder(original(point), blend))`.
   - `getBounds()` → `lngLatBounds(...geographicBounds(T, blend))`, where `T` is `host.transform` (v5) or `host._camera.transform` (v6); if neither is found, fall back to the original `getBounds()`'s four corners through `geographicUnder` (a looser box; log nothing).
3. **`geographicBounds`** (audit §6): find the top of the visible ground — `top = 0` if `isPointOnMapSurface({x: width/2, y: 0})`, else bisect y over `[0, height]` for the first on-surface y (20 steps). Sample the perimeter of `[0, width] × [top, height]`, 16 points per edge, with `screenPointToLocation`; clamp each sample into the band's world (`clampLatitude` to `mapSpaceMaxLatitude(blend)`, then `lng` to `mapSpaceMaxLongitude(lat, blend)`), convert with `mapToGeographic`, take the bbox. If the world's top edge is visible (some sample clamped at `+mapSpaceMaxLatitude`), `north = 90`; bottom likewise `south = −90`; if a left/right edge of the world is visible the longitude extends to ∓180. At z0 the result is `[-180, -90, 180, 90]`. World copies are off while active, so west < east always.
4. **Pass-through while inactive.** Each wrapper's first line: `if (!state.active) return original(...args)` with the caller's own argument objects.
5. **The plugin's own calls stay map space.** `EqualEarthController` uses `#raw.getCenter()` and `#raw.jumpTo(...)` (captured by `installGeoApi`, or `rawCamera(host)` when the API is off) everywhere it uses `host.getCenter`/`host.jumpTo` today (controller.ts:380, 570, 647, 669). Mark the centres it builds with `markMapSpace` (Task 7's `jumpTo` wrapper then passes them through even if a later refactor routes them through `host`). `toGeographic` uses `geographicUnder` (finite for points outside the world); `toMapSpace` is unchanged. Both stay public: they convert map-space values the API cannot (`queryRenderedFeatures` geometry, `getStyle()` contents).
6. **Zoom and bearing are not converted** (audit §9.6, ruling): `getZoom()`/`getBearing()` keep MapLibre's values, which carry the compensation offsets (≤ 0.07 zoom, ≤ 3°). A `setZoom(getZoom())` round trip is still the identity, because R is cloned from T with the same offsets the baseline records. Documented in Task 11.

- [ ] **Step 1: Failing tests**

`tests/instance-wrap.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { wrapMethod } from '../src/map/instance-wrap.js';

class Base { greet(name: string): string { return `hi ${name}`; } }

describe('wrapMethod', () => {
  it('shadows the prototype method on the instance and restores by deleting', () => {
    const a = new Base();
    const b = new Base();
    const restore = wrapMethod<(n: string) => string>(a, 'greet', (original) => (n) => original(n).toUpperCase());
    expect(a.greet('x')).toBe('HI X');
    expect(b.greet('x')).toBe('hi x');
    restore();
    expect(Object.prototype.hasOwnProperty.call(a, 'greet')).toBe(false);
    expect(a.greet('x')).toBe('hi x');
  });

  it('wraps and restores an existing own property', () => {
    const a = new Base();
    const own = (n: string) => `own ${n}`;
    (a as { greet: (n: string) => string }).greet = own;
    const restore = wrapMethod<(n: string) => string>(a, 'greet', (original) => (n) => `[${original(n)}]`);
    expect(a.greet('x')).toBe('[own x]');
    restore();
    expect(a.greet).toBe(own);
  });

  it('leaves a method the application replaced after us', () => {
    const a = new Base();
    const restore = wrapMethod<(n: string) => string>(a, 'greet', (original) => original);
    const app = (n: string) => `app ${n}`;
    (a as { greet: (n: string) => string }).greet = app;
    restore();
    expect(a.greet).toBe(app);
  });

  it('is a no-op for a missing method', () => {
    const a = {};
    const restore = wrapMethod(a, 'nope', (original) => original);
    expect('nope' in a).toBe(false);
    expect(() => restore()).not.toThrow();
  });
});
```

`tests/support/fake-geo-host.ts` — a flat Web Mercator viewport (no pitch, no bearing; `T.center` is map space). Task 7 adds the camera methods to it.

```ts
import { geographicToMapWorld, mapWorldToGeographic } from '../../src/math/backproject.js';
// At blend 1 these are plain Web Mercator: lng/lat → world [0, 1]² and back.

export class FakeLngLat { constructor(readonly lng: number, readonly lat: number) {} }
export class FakeLngLatBounds { constructor(readonly sw: [number, number], readonly ne: [number, number]) {} }

type Point = { x: number; y: number };
const toPoint = (p: unknown): Point => (Array.isArray(p) ? { x: p[0] as number, y: p[1] as number } : (p as Point));
const toTuple = (l: unknown): [number, number] => {
  if (Array.isArray(l)) return [l[0] as number, l[1] as number];
  const o = l as { lng?: number; lon?: number; lat: number };
  return [o.lng ?? o.lon!, o.lat];
};

/** A 512 × 384 Mercator viewport. `project`/`unproject` are exact; `T` is exposed v5-style as `transform`. */
export class FakeGeoHost {
  readonly width = 512;
  readonly height = 384;
  zoom = 3;
  center = new FakeLngLat(0, 0); // map space
  calls: { name: string; args: unknown[] }[] = [];
  readonly transform: {
    readonly width: number; readonly height: number; readonly center: FakeLngLat;
    screenPointToLocation(p: Point): FakeLngLat; isPointOnMapSurface(p: Point): boolean;
  };

  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const host = this;
    this.transform = {
      width: this.width,
      height: this.height,
      get center() { return host.center; },
      screenPointToLocation: (p) => host.#unproject(p),
      isPointOnMapSurface: () => true,
    };
  }

  get worldSize(): number { return 512 * 2 ** this.zoom; }

  #centreWorld(): [number, number] {
    const [x, y] = geographicToMapWorld([this.center.lng, this.center.lat], 1);
    return [x * this.worldSize, y * this.worldSize];
  }

  #unproject(p: Point): FakeLngLat {
    const [cx, cy] = this.#centreWorld();
    const wx = (cx + p.x - this.width / 2) / this.worldSize;
    const wy = (cy + p.y - this.height / 2) / this.worldSize;
    const [lng, lat] = mapWorldToGeographic([wx, wy], 1);
    return new FakeLngLat(lng, lat);
  }

  project(lngLat: unknown): Point {
    this.calls.push({ name: 'project', args: [lngLat] });
    const [x, y] = geographicToMapWorld(toTuple(lngLat), 1);
    const [cx, cy] = this.#centreWorld();
    return { x: x * this.worldSize - cx + this.width / 2, y: y * this.worldSize - cy + this.height / 2 };
  }

  unproject(point: unknown): FakeLngLat {
    this.calls.push({ name: 'unproject', args: [point] });
    return this.#unproject(toPoint(point));
  }

  getCenter(): FakeLngLat {
    this.calls.push({ name: 'getCenter', args: [] });
    return new FakeLngLat(this.center.lng, this.center.lat);
  }

  getBounds(): FakeLngLatBounds {
    this.calls.push({ name: 'getBounds', args: [] });
    const nw = this.#unproject({ x: 0, y: 0 });
    const se = this.#unproject({ x: this.width, y: this.height });
    return new FakeLngLatBounds([nw.lng, se.lat], [se.lng, nw.lat]);
  }

  jumpTo(options: { center?: unknown; zoom?: number }): this {
    this.calls.push({ name: 'jumpTo', args: [options] });
    if (options.center !== undefined) this.center = new FakeLngLat(...toTuple(options.center));
    if (options.zoom !== undefined) this.zoom = options.zoom;
    return this;
  }

  lastCall(name: string): unknown[] {
    const call = this.calls.filter((c) => c.name === name).at(-1);
    if (!call) throw new Error(`no ${name} call`);
    return call.args;
  }
}
```

`mapWorldToGeographic` at blend 1 must accept world y outside [0, 1] (beyond the Mercator square) without throwing; if it clamps, the fake's far-outside `unproject` simply returns the clamped edge, which is all the no-throw test needs. Mercator's own `unproject` has no world edge, so `unproject` far outside returns large |lat| < 90 or ±90 — the wrapper's `geographicUnder` is what must bring it into range.

`tests/geo-api.test.ts`:

```ts
const G: LngLatTuple = [-103.35, 20.67]; // Guadalajara
const state = (over: Partial<GeoApiState> = {}): GeoApiState => ({ active: true, blend: 0, baselineBlend: 0, bands: EQUAL_EARTH_BANDS, ...over });
const factories = { lngLat: (lng: number, lat: number) => new FakeLngLat(lng, lat), lngLatBounds: (sw: LngLatTuple, ne: LngLatTuple) => new FakeLngLatBounds(sw, ne) };

describe('geographic reads', () => {
  it('passes every read straight through while inactive', () => {
    const host = new FakeGeoHost();
    const plain = new FakeGeoHost();
    installGeoApi(host, state({ active: false }), factories);
    expect(host.getCenter()).toEqual(plain.getCenter());
    expect(host.project([10, 20])).toEqual(plain.project([10, 20]));
    expect(host.unproject([100, 50])).toEqual(plain.unproject([100, 50]));
    expect(host.getBounds()).toEqual(plain.getBounds());
  });

  it.each([0, 0.5, 1])('getCenter returns the geographic centre at blend %s', (blend) => {
    const host = new FakeGeoHost();
    host.center = new FakeLngLat(...geographicToMap(G, blend));
    installGeoApi(host, state({ blend }), factories);
    const c = host.getCenter();
    expect(c.lng).toBeCloseTo(G[0], 9);
    expect(c.lat).toBeCloseTo(G[1], 9);
  });

  it('project and unproject are inverse and agree with the map-space originals', () => {
    const host = new FakeGeoHost();
    const raw = new FakeGeoHost();
    host.center = raw.center = new FakeLngLat(...geographicToMap(G, 0));
    installGeoApi(host, state(), factories);
    expect(host.project(G)).toEqual(raw.project(geographicToMap(G, 0)));
    const back = host.unproject(host.project(G));
    expect(back.lng).toBeCloseTo(G[0], 6);
    expect(back.lat).toBeCloseTo(G[1], 6);
  });

  it('accepts every LngLatLike form', () => {
    const host = new FakeGeoHost();
    installGeoApi(host, state(), factories);
    const a = host.project(G);
    expect(host.project({ lng: G[0], lat: G[1] })).toEqual(a);
    expect(host.project({ lon: G[0], lat: G[1] })).toEqual(a);
  });

  it('projects a world copy one world width away (Marker smartWrap)', () => {
    const host = new FakeGeoHost();
    installGeoApi(host, state(), factories);
    const a = host.project([179, 70]);
    const b = host.project([179 - 360, 70]);
    expect(a.x - b.x).toBeCloseTo(512 * 2 ** host.zoom, 6);
    expect(a.y).toBeCloseTo(b.y, 9);
  });

  it('never returns NaN or |lat| > 90 from unproject, even far outside the world', () => {
    const host = new FakeGeoHost();
    host.zoom = 1;
    installGeoApi(host, state(), factories);
    for (const p of [[256, 0], [0, 0], [511, 383], [256, -5000], [-9000, 192]]) {
      const ll = host.unproject(p);
      expect(Number.isFinite(ll.lng) && Number.isFinite(ll.lat)).toBe(true);
      expect(Math.abs(ll.lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(ll.lng)).toBeLessThanOrEqual(180);
    }
    expect(host.unproject([256, 0]).lat).toBe(90); // above Equal Earth's pole line
  });

  it('getBounds covers the whole world at z0 and is tight at z4', () => {
    const host = new FakeGeoHost();
    host.zoom = 0;
    installGeoApi(host, state(), factories);
    expect(host.getBounds()).toEqual(new FakeLngLatBounds([-180, -90], [180, 90]));
    host.zoom = 4;
    host.center = new FakeLngLat(...geographicToMap(G, 0));
    const b = host.getBounds() as FakeLngLatBounds;
    const samples = [[0, 0], [256, 0], [511, 0], [511, 192], [511, 383], [256, 383], [0, 383], [0, 192]].map((p) => host.unproject(p));
    for (const s of samples) {
      expect(s.lng).toBeGreaterThanOrEqual(b.sw[0] - 1e-9);
      expect(s.lng).toBeLessThanOrEqual(b.ne[0] + 1e-9);
      expect(s.lat).toBeGreaterThanOrEqual(b.sw[1] - 1e-9);
      expect(s.lat).toBeLessThanOrEqual(b.ne[1] + 1e-9);
    }
    expect(Math.min(...samples.map((s) => s.lng))).toBeCloseTo(b.sw[0], 6); // tight: attained on the perimeter
    expect(Math.max(...samples.map((s) => s.lat))).toBeCloseTo(b.ne[1], 6);
  });

  it('uninstall restores the prototype methods', () => {
    const host = new FakeGeoHost();
    const api = installGeoApi(host, state(), factories);
    api.uninstall();
    for (const name of ['project', 'unproject', 'getCenter', 'getBounds']) {
      expect(Object.prototype.hasOwnProperty.call(host, name), name).toBe(false);
    }
  });

  it('raw reads stay map space', () => {
    const host = new FakeGeoHost();
    host.center = new FakeLngLat(...geographicToMap(G, 0));
    const api = installGeoApi(host, state(), factories);
    expect(api.raw.getCenter()).toEqual(host.center);
  });
});
```

`tests/controller.test.ts` (with the fake host's `getCenter`/`project`/`unproject` modelled as map space, which `FakeControllerHost` already is for `getCenter`): with the default `geographicApi`, `host.getCenter()` after `activate('equal')` returns the geographic centre (≈ the pre-activation centre within 1e-9), and after `deactivate()` too; with `geographicApi: false`, `host.getCenter()` while active is `toMapSpace` of it and `Object.prototype.hasOwnProperty.call(host, 'getCenter')` is false; `dispose()` restores the wrappers; `toGeographic([0, 89])` (above the world) is finite. `tests/install.test.ts`: `fakeModule` gains `LngLatBounds`; `geographicApi: false` reaches the controller.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/instance-wrap.test.ts tests/geo-api.test.ts tests/controller.test.ts tests/install.test.ts`

- [ ] **Step 3: Implement**

`wrapMethod` (the whole file):

```ts
export function wrapMethod<F extends (...args: never[]) => unknown>(
  target: object, name: string, make: (original: F) => F,
): () => void {
  const slots = target as Record<string, unknown>;
  const found = slots[name];
  if (typeof found !== 'function') return () => {};
  const previous = Object.getOwnPropertyDescriptor(target, name);
  const original = ((...args: Parameters<F>) => (found as F).apply(target, args)) as F;
  const wrapper = make(original);
  Object.defineProperty(target, name, { value: wrapper, writable: true, configurable: true, enumerable: false });
  return () => {
    if (slots[name] !== wrapper) return;
    if (previous) Object.defineProperty(target, name, previous);
    else delete slots[name];
  };
}
```

`geo-api.ts`: the mark set is module-level (`const mapSpace = new WeakSet<object>()`); `lngLatTuple` accepts arrays of two finite numbers and objects with finite `lng`/`lon` and `lat`; `installGeoApi` captures `raw` first (`jumpTo`/`getCenter`/`unproject` bound to the host), then wraps the four reads per Rules 2–4, and returns `{ raw, uninstall }` (uninstall runs every restore). Move `centreToGeographic` from the controller into `geographicUnder` and add the final guard (`clamp(lat, −90, 90)`, and `[0, 0]`-free: if the result is still not finite, return the clamped map-space point). Controller per Rule 5; `get baselineBlend()` = `this.#bands[installed.camera.baselineBand].blend` while installed, else `this.blend`; install.ts passes `lngLatBoundsFactory: (sw, ne) => new maplibregl.LngLatBounds(sw, ne)` and `geographicApi`. Export `wrapMethod`'s module privately (not from `index.ts`); export `geographicUnder` and `mapSpaceOf` from `index.ts` (application helpers for the map-space values listed in Rule 5).

Existing tests: the controller now wraps `FakeControllerHost`'s `getCenter` (and `project`/`unproject`/`getBounds` where the fake has them), so a test in `tests/controller.test.ts`, `tests/install.test.ts` or `tests/switcher.test.ts` that reads `host.getCenter()` while active and expects map space changes meaning. Update each such assertion to the geographic value it now means (most compare against `toMapSpace(x)`: compare against `x`), or construct that test's controller with `geographicApi: false` when the test is genuinely about map space. Never loosen a tolerance to make one pass; list every changed assertion in the report.

- [ ] **Step 4: Switch the demo, the probe and the browser helpers to the geographic reads**

- `demo/transition.ts:145-146`: `const { lng, lat } = map.getCenter();` (no `toGeographic`).
- `scripts/probe-transition.mjs:205-206`: `const geo = m.getCenter()` and `m.project(${JSON.stringify(ref)})`; `:213-214`: `return [p.lng, p.lat]` from `m.unproject(…)`.
- `tests/browser/helpers.ts`: `pixelOf(page, c)` evaluates `map.project(c)` (the map is geographic now, active or not). `centreOn` keeps its `toMapSpace` until Task 7.
- `tests/browser/harness.ts`: `?geoapi=0` passes `geographicApi: false`.

- [ ] **Step 5: Browser checks** — `tests/browser/geo-read.spec.ts`, both majors, `equal` unless stated, G = Guadalajara `[-103.35, 20.67]`:

1. **Event `lngLat`** (audit test 1): at z2 and z5.2 centred on G, dispatch a `click` at `pixelOf(G)` (`page.mouse.click`); the `click` listener's `e.lngLat` is within 1e-6° of G. Move the pointer to the canvas's top-left corner at z1 (outside the world): no `pageerror`, the `mousemove` `e.lngLat.lat` is within [−90, 90].
2. **Marker placement** (2): `new maplibregl.Marker().setLngLat(G).addTo(map)` at z3, 5, 7, 9; the marker element's centre-bottom (`getBoundingClientRect`, default anchor `bottom`: x = centre, y = bottom) equals `pixelOf(G)` ± 1 px, and the fixture place feature nearest G (`queryRenderedFeatures` around that pixel, layer `places`) is within 2 px.

   G is not a fixture place; use Zürich `[8.54, 47.37]` for the feature half of this check.
3. **Marker drag** (3): a `draggable: true` marker at Zürich, z4; drag it 100 px right with the mouse; after `dragend`, `getLngLat()` equals `map.unproject(<new pixel>)` within 1e-6° and the element sits at that pixel ± 1 px (no jump on `dragend`).
4. **Marker near the antimeridian** (4, Review Focus 2): marker at `[179.5, 0]` (a fixture place), view centred at `[-175, 0]` z3. The marker element's pixel equals `pixelOf([179.5, 0])` ± 1 px and lies inside the canvas, and the fixture place circle is rendered there (red pixel within 3 px). If MapLibre's `smartWrap` puts it a world away, record the measured offset in the report and **fail** the test: Task 6 then adds a `Marker`-level fix (wrap the instance's `_update` to call `setLngLat` with the geographic position wrapped to within 180° of `getCenter().lng`) — the audit's last resort.
5. **Popup anchor** (5): a Popup at G, z5: the tip's pixel equals `pixelOf(G)` ± 1 px.
6. **`getBounds`** (15): at z3, bearing 30, pitch 40, centred on G (use the raw API: `__h.controller` exposes nothing for this — set them with `map.jumpTo({ bearing: 30, pitch: 40 })`, which carries no centre): every `map.unproject` of 16 points per canvas edge below the horizon lies inside `getBounds()`; at z0 `getBounds()` is `[-180, -90, 180, 90]`.
7. **Hash and ScaleControl** (16, without geolocation): `hash: true` in the harness (`?hash=1`) → after `centreOn(G, 6)` the URL hash holds `6/20.67/-103.35` (to the hash's own precision); reloading the page with that hash shows G at the canvas centre ± 1 px. A `ScaleControl` (metric) at G z6: its label distance equals the haversine distance between `map.unproject` of the two pixels it measures (`[0, h/2]` → `[maxWidth, h/2]`, `maxWidth` 100) within 1 %.
8. **Pass-through** (18, Review Focus 5): under `mercator` and `globe`, with the plugin installed and the controller created (`__h.controller` exists: call `install.controllerFor(map)` explicitly), `getCenter`, `project([10, 20])`, `unproject([100, 50])` and `getBounds()` equal the values on a page without the plugin (`plugin=0`), and the methods are not own properties of the map.

- [ ] **Step 6: Verify and commit**

Run: `npm run verify`

```bash
git add src/map/instance-wrap.ts src/map/geo-api.ts src/map/controller.ts src/install.ts src/index.ts tests/instance-wrap.test.ts tests/geo-api.test.ts tests/support/fake-geo-host.ts tests/controller.test.ts tests/install.test.ts tests/host-types.test.ts tests/browser demo/transition.ts scripts/probe-transition.mjs
git diff --cached --name-only
git commit -m "Report project, unproject, getCenter and getBounds geographically while Equal Earth is active" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Geographic camera targets, bypasses, `fitBounds`

**Files:**
- Modify: `src/map/geo-api.ts`, `src/map/controller.ts` (nothing new unless the fake shows a gap), `tests/geo-api.test.ts`, `tests/support/fake-geo-host.ts`, `tests/browser/helpers.ts` (`centreOn`), `demo/transition.ts`
- Create: `tests/browser/geo-camera.spec.ts`

**Read first:** the audit §0–§5 and §7 in full; this task implements them.

**Interfaces:**
- Consumes: Task 6's `installGeoApi`, `GeoApiState` (`baselineBlend`, `bands`), `markMapSpace`, `isMarkedMapSpace`, `lngLatTuple`, `geographicUnder`, `wrapMethod`; `bandIndexForZoom` (`bands.ts`); `mapSpaceMaxLatitude`.
- Produces:
  ```ts
  // src/map/geo-api.ts (additions)
  export interface GeoApiHost {   // extends Task 6's
    // … Task 6's four reads, plus:
    setCenter(center: unknown, eventData?: unknown): unknown;
    easeTo(options: object, eventData?: unknown): unknown;
    flyTo(options: object, eventData?: unknown): unknown;
    panTo(lngLat: unknown, options?: object, eventData?: unknown): unknown;
    panBy(offset: unknown, options?: object, eventData?: unknown): unknown;
    zoomTo(zoom: number, options?: object, eventData?: unknown): unknown;
    zoomIn(options?: object, eventData?: unknown): unknown;
    zoomOut(options?: object, eventData?: unknown): unknown;
    rotateTo(bearing: number, options?: object, eventData?: unknown): unknown;
    resetNorth(options?: object, eventData?: unknown): unknown;
    resetNorthPitch(options?: object, eventData?: unknown): unknown;
    snapToNorth(options?: object, eventData?: unknown): unknown;
    cameraForBounds(bounds: unknown, options?: object): { center: { lng: number; lat: number }; zoom: number; bearing: number } | undefined;
    fitBounds(bounds: unknown, options?: object, eventData?: unknown): unknown;
    stop(): unknown;
  }
  /**
   * Mark what MapLibre's handlers read through `TransformProvider` (`unproject` results and the
   * `center` getter's result) as map space, once per prototype (`Symbol.for('equal-earth:provider-marked')`).
   * Safe for every map: the provider always answers in R/T space (audit §7, B1/B2).
   */
  export function markTransformProviders(provider: object): void;
  /** One band's fit, from MapLibre's own `cameraForBounds` on a map-space bbox. */
  export type BandFit = (sw: LngLatTuple, ne: LngLatTuple) => { center: { lng: number; lat: number }; zoom: number; bearing: number } | undefined;
  /**
   * Audit §5: fit geographic bounds across bands. For every band k, the map-space bbox of the
   * densified boundary (32 points per edge, lat clamped to ±90 before and to
   * `mapSpaceMaxLatitude(blend_k)` after the warp; split at the antimeridian when west > east)
   * is fitted with `fit`. Picks the band whose fit zoom falls in it (highest zoom if several);
   * a 2-cycle at a boundary β resolves to the lower band at `β − 1e-6`.
   */
  export function fitAcrossBands(
    bounds: [sw: LngLatTuple, ne: LngLatTuple], bands: readonly Band[], fit: BandFit,
  ): { band: number; center: LngLatTuple; zoom: number; bearing: number } | undefined;
  ```
  `RawCamera` gains `stop(): unknown`.

**Rules** (audit §3, §7; every one is a value-level decision, never a "we are inside our own wrapper" flag — application `move` listeners run synchronously inside camera calls and must still be converted):

1. **What is a target.** `center` and `around` in the options of `jumpTo`, `easeTo`, `flyTo` and of the options-only methods (`zoomTo`, `zoomIn`, `zoomOut`, `rotateTo`, `resetNorth`, `resetNorthPitch`, `snapToNorth`, `panBy`), the positional `center` of `setCenter` and `lngLat` of `panTo` (plus `around` in `panTo`'s options). Wrap the options-only methods on both majors: on v6 they reach `Camera.easeTo` directly (audit §9.2); on v5 they call the wrapped `easeTo`, which then sees an already-marked value.
2. **Is it map space already?** A value is passed through unconverted when `isMarkedMapSpace(value)`, or `value === T.center`, or `value === R?.center`, where `T` is the transform (v5 `host.transform`, v6 `host._camera.transform`) and `R` is `_requestedCameraState` on the same owner (v5 the map, v6 `_camera`). Identity, never numeric equality.
3. **Pre-stop, then read the baseline.** If at least one value needs converting and the call carries no `easeId`, call `raw.stop()` first — the original's own first statement is a stop, and that stop can fire the Camera's `moveend` or the handlers' `*end` events, which re-base `BandCamera` (audit §3). Then read `state.baselineBlend` and convert each value: `markMapSpace(lngLat(...geographicToMap(tuple, baselineBlend)))`. Pass a shallow copy of the options; never mutate the caller's object. With nothing to convert, call the original with the caller's own arguments and do not stop.
4. **Handler values.** On the first install per page, `markTransformProviders(Object.getPrototypeOf(host.keyboard?._tr))` when that exists (both majors set `keyboard._tr`). If it is missing, `console.warn` once (`[equal-earth] could not find MapLibre's TransformProvider; double-click, tap and keyboard zoom may land off target`) and, as the audit's fallback, pass through `easeTo` calls whose `eventData?.originalEvent` is a DOM `Event`.
5. **v5 box zoom.** If the host has its own or inherited `_cameraForBoxAndBearing` (v5 only), wrap it on the instance to `markMapSpace(result.center)` (B6).
6. **`cameraForBounds` / `fitBounds` are reimplemented** (audit §5), never delegating to the original `fitBounds`: `cameraForBounds(bounds, options)` → `fitAcrossBands(boundsTuple(bounds), state.bands, (sw, ne) => original cameraForBounds([sw, ne], options))` → `{ center: lngLat(...result.center) /* geographic, unmarked */, zoom, bearing }`. `fitBounds(bounds, options, eventData)` mirrors MapLibre's `_fitInternal`: `cam = host.cameraForBounds(bounds, options)`; if none, return `host`; `opts = { ...cam, ...options }`; `delete opts.padding`; then `opts.linear ? host.easeTo(opts, eventData) : host.flyTo(opts, eventData)` — through the **wrapped** methods, so the geographic centre is converted with the baseline band. `boundsTuple` accepts `LngLatBounds` (`getSouthWest()`/`getNorthEast()`), `[[w, s], [e, n]]` and `[w, s, e, n]`.
7. **Pass-through while inactive**, as in Task 6.
8. Not wrapped: `fitScreenCoordinates` (pixels), `setZoom`, `calculateCameraOptionsFrom*`, `getMaxBounds`/`setMaxBounds` (documented in Task 11).

- [ ] **Step 1: Failing tests**

`tests/support/fake-geo-host.ts` gains the camera methods: each records `{ name, args }` in `calls` and applies `center`/`zoom` to the fake's state; `stop()` records `'stop'` and runs an optional `onStop` hook; a v5-style subclass `FakeV5GeoHost` whose `setCenter(c)` calls `this.jumpTo({ center: c })` and whose `panBy(offset)` calls `this.panTo(this.transform.center, …)` (instance dispatch, as v5's Camera); `_requestedCameraState` settable; `keyboard = { _tr: new FakeTransformProvider(this) }` with a class whose `unproject(p)` and `get center()` return fresh map-space objects.

`tests/geo-api.test.ts` additions:

```ts
describe('geographic targets', () => {
  it('converts a jumpTo centre with the baseline band, on a copy, marked', () => {
    const host = new FakeGeoHost();
    installGeoApi(host, state({ blend: 0.5, baselineBlend: 0 }), factories);
    const options = { center: G, zoom: 5 };
    host.jumpTo(options);
    const passed = host.lastCall('jumpTo')[0] as { center: FakeLngLat; zoom: number };
    expect([passed.center.lng, passed.center.lat]).toEqual(geographicToMap(G, 0));
    expect(passed.zoom).toBe(5);
    expect(isMarkedMapSpace(passed.center)).toBe(true);
    expect(options.center).toBe(G); // caller's object untouched
  });

  it('stops before reading the baseline', () => {
    const host = new FakeGeoHost();
    const s = { active: true, blend: 0.5, baselineBlend: 0.5, bands: EQUAL_EARTH_BANDS };
    host.onStop = () => { s.baselineBlend = 1; }; // the stop's moveend re-bases the camera
    installGeoApi(host, s, factories);
    host.easeTo({ center: G, duration: 0 });
    expect(host.calls.map((c) => c.name)).toEqual(['stop', 'easeTo']);
    const passed = host.lastCall('easeTo')[0] as { center: FakeLngLat };
    expect([passed.center.lng, passed.center.lat]).toEqual(geographicToMap(G, 1));
  });

  it('does not stop or copy when nothing needs converting, nor with an easeId', () => {
    const host = new FakeGeoHost();
    installGeoApi(host, state(), factories);
    const zoomOnly = { zoom: 4 };
    host.easeTo(zoomOnly);
    expect(host.lastCall('easeTo')[0]).toBe(zoomOnly);
    host.easeTo({ center: G, easeId: 'keyboardHandler' });
    expect(host.calls.filter((c) => c.name === 'stop')).toHaveLength(0);
  });

  it('passes T.center, R.center and marked values through by identity', () => {
    const host = new FakeGeoHost();
    installGeoApi(host, state(), factories);
    const t = host.transform.center;
    host.easeTo({ center: t });
    expect((host.lastCall('easeTo')[0] as { center: unknown }).center).toBe(t);
    host._requestedCameraState = { center: new FakeLngLat(1, 2) };
    host.easeTo({ center: host._requestedCameraState.center });
    expect((host.lastCall('easeTo')[0] as { center: unknown }).center).toBe(host._requestedCameraState.center);
    const marked = markMapSpace(new FakeLngLat(3, 4));
    host.jumpTo({ center: marked });
    expect((host.lastCall('jumpTo')[0] as { center: unknown }).center).toBe(marked);
  });

  it('converts a mixed inertia call per value: centre is T, around is geographic', () => {
    const host = new FakeGeoHost();
    installGeoApi(host, state(), factories);
    host.easeTo({ center: host.transform.center, around: G });
    const passed = host.lastCall('easeTo')[0] as { center: unknown; around: FakeLngLat };
    expect(passed.center).toBe(host.transform.center);
    expect([passed.around.lng, passed.around.lat]).toEqual(geographicToMap(G, 0));
  });

  it('converts once through v5-style nested calls', () => {
    const host = new FakeV5GeoHost();
    installGeoApi(host, state(), factories);
    host.setCenter(G);
    const passed = host.lastCall('jumpTo')[0] as { center: FakeLngLat };
    expect([passed.center.lng, passed.center.lat]).toEqual(geographicToMap(G, 0));
    host.panBy([100, 0]);
    expect((host.lastCall('panTo')[0])).toBe(host.transform.center);
  });

  it.each(['zoomTo', 'rotateTo'] as const)('%s converts options.around', (name) => {
    const host = new FakeGeoHost();
    installGeoApi(host, state(), factories);
    host[name](5, { around: G });
    const passed = host.lastCall(name)[1] as { around: FakeLngLat };
    expect([passed.around.lng, passed.around.lat]).toEqual(geographicToMap(G, 0));
  });

  it('marks what the TransformProvider hands the handlers, once per prototype', () => {
    const host = new FakeGeoHost();
    installGeoApi(host, state(), factories);
    installGeoApi(new FakeGeoHost(), state(), factories); // second map, same prototype
    expect(isMarkedMapSpace(host.keyboard._tr.unproject([1, 2]))).toBe(true);
    expect(isMarkedMapSpace(host.keyboard._tr.center)).toBe(true);
    host.easeTo({ around: host.keyboard._tr.unproject([1, 2]) });
    expect(host.calls.filter((c) => c.name === 'stop')).toHaveLength(0);
  });

  it('passes every target straight through while inactive', () => {
    const host = new FakeGeoHost();
    installGeoApi(host, state({ active: false }), factories);
    const options = { center: G };
    host.flyTo(options);
    expect(host.lastCall('flyTo')[0]).toBe(options);
  });
});

describe('fitAcrossBands', () => {
  const SIX = resolveTransition();
  const bands = SIX.bands;

  /** A fit whose zoom grows as the bbox shrinks: z = log2(360 / width) − 0.2 · blend-dependent bias. */
  const fitWith = (bias: (blend: number) => number): BandFit => (sw, ne) => {
    const blend = /* recover from the call order: */ currentBlend;
    return { center: { lng: (sw[0] + ne[0]) / 2, lat: (sw[1] + ne[1]) / 2 }, zoom: Math.log2(360 / (ne[0] - sw[0])) + bias(blend), bearing: 0 };
  };
  // Implement `currentBlend` by wrapping: fitAcrossBands calls `fit` once per band in band order,
  // so the test can index `bands[callIndex].blend`. Write it as a counter closure.

  it('picks the band its own fit zoom falls in', () => {
    const r = fitAcrossBands([[5, 45], [11, 48]], bands, /* fit with bias 0 */);
    expect(bandIndexForZoom(bands, r!.zoom)).toBe(r!.band);
  });

  it('resolves a 2-cycle at a boundary to the lower band just below it', () => {
    // A bias that pushes band k's zoom above the k/k+1 boundary β and band k+1's below it.
    const beta = bands[2]!.minZoom;
    const r = fitAcrossBands(/* bounds */, bands, /* fit returning β + 0.1 for band 1 and β − 0.1 for band 2, other bands far away */);
    expect(r!.band).toBe(1);
    expect(r!.zoom).toBeCloseTo(beta - 1e-6, 9);
  });

  it('returns the geographic point under the fitted centre', () => {
    const r = fitAcrossBands([[5, 45], [11, 48]], bands, /* bias 0 */)!;
    const k = r.band;
    // the fit's map-space centre of band k, back through mapToGeographic(·, bands[k].blend)
    expect(r.center[0]).toBeGreaterThan(5);
    expect(r.center[0]).toBeLessThan(11);
  });

  it('splits bounds that cross the antimeridian', () => {
    const r = fitAcrossBands([[170, -20], [-170, 20]], bands, /* bias 0 */)!;
    expect(r.zoom).toBeLessThan(1); // near full width in a single-copy world
  });
});

describe('fitBounds and cameraForBounds', () => {
  it('fits through the wrapped flyTo with a geographic centre, never the original fitBounds', () => {
    const host = new FakeGeoHost();
    installGeoApi(host, state(), factories);
    host.fitBounds([[5, 45], [11, 48]], { padding: 20 });
    expect(host.calls.some((c) => c.name === 'fitBounds')).toBe(false);
    const fly = host.lastCall('flyTo')[0] as Record<string, unknown>;
    expect('padding' in fly).toBe(false);
    expect(isMarkedMapSpace(fly['center'])).toBe(true); // converted by the flyTo wrapper
    host.fitBounds([[5, 45], [11, 48]], { linear: true });
    expect(host.calls.at(-1)!.name).toBe('easeTo');
  });

  it('cameraForBounds returns a geographic centre that jumpTo lands on', () => {
    const host = new FakeGeoHost();
    installGeoApi(host, state(), factories);
    const cam = host.cameraForBounds([[5, 45], [11, 48]])!;
    expect(isMarkedMapSpace(cam.center)).toBe(false);
    host.jumpTo(cam);
    const c = host.getCenter();
    expect(c.lng).toBeCloseTo(cam.center.lng, 9);
    expect(c.lat).toBeCloseTo(cam.center.lat, 9);
  });
});
```

Complete the sketched `fitAcrossBands` tests: the `fit` closures count calls to know the band (`bands[call].blend`), and the 2-cycle fit returns `β + 0.1` for band 1, `β − 0.1` for band 2, and zooms outside both bands' ranges for the rest. `FakeGeoHost.cameraForBounds` fits a map-space bbox to its 512 × 384 viewport (`zoom = log2(min(512 / dxWorld, 384 / dyWorld) / 512)` with world coordinates in [0, 1]); `fitBounds` on the fake records only (never used by the wrapper).

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/geo-api.test.ts`

- [ ] **Step 3: Implement** Rules 1–8 in `geo-api.ts`. One helper does Rules 2–3 for all wrappers:

```ts
/** Convert the target values of one call (audit §3, §7). Returns `undefined` when nothing needs converting. */
function convertTargets<T extends Record<string, unknown>>(
  values: T, keys: readonly (keyof T)[], ctx: Context, easeId: unknown,
): T | undefined {
  const pending = keys.filter((k) => values[k] != null && !isNative(values[k], ctx));
  if (pending.length === 0) return undefined;
  if (easeId === undefined) ctx.raw.stop();
  const blend = ctx.state.baselineBlend;
  const copy = { ...values };
  for (const k of pending) {
    const tuple = lngLatTuple(values[k]);
    if (tuple) copy[k] = markMapSpace(ctx.factories.lngLat(...geographicToMap(tuple, blend))) as T[keyof T];
  }
  return copy;
}
```

`isNative(v, ctx)` is Rule 2 (plus Rule 4's fallback). The positional forms (`setCenter`, `panTo`) wrap the value as `{ center: value }` for the helper and unwrap it.

- [ ] **Step 4: Switch the remaining map-space writes to geographic**

- `demo/transition.ts:194` and `:204`: `map.jumpTo({ center: lngLat })`, `map.jumpTo({ center: [0, 0], zoom: 2 })`.
- `tests/browser/helpers.ts` `centreOn`: `map.jumpTo({ center: c, zoom: z })`.
- `grep -rn "toMapSpace" demo tests/browser scripts` must print nothing afterwards except deliberate low-level uses (comment each).

- [ ] **Step 5: Browser checks** — `tests/browser/geo-camera.spec.ts`, both majors, `equal`, G = Guadalajara. "Exact" means `getCenter()` within 1e-6° of the target and `pixelOf(target)` at the canvas centre ± 0.5 px after `idle`:

1. **Across bands** (audit 6): from `centreOn([0, 0], 2)`, each of `jumpTo({center: G, zoom: 9})`, `setCenter(G)` then `setZoom(9)`, `easeTo({center: G, zoom: 9, duration: 1500})`, `flyTo({center: G, zoom: 9, duration: 2000})`, `panTo(G, {duration: 1000})` (zoom unchanged) is exact; and from z5.5 to z2 with `flyTo`.
2. **`flyTo` interrupting an `easeTo`** (7): start `easeTo({center: [0, 0], zoom: 7, duration: 3000})` from G z2; after 1500 ms (it has crossed band 1), `flyTo({center: G, zoom: 4, duration: 1500})`: exact.
3. **v5 fallbacks** (8): with `page.emulateMedia({ reducedMotion: 'reduce' })`, `flyTo({center: G, zoom: 6})` is exact; `flyTo` to the current `getCenter()` and zoom moves the centre pixel by ≤ 0.5 px.
4. **Double-click zoom** (9): at z3 centred on `[0, 20]`, double-click at a pixel 120 px right of centre: the geographic point that was under it (`map.unproject` before) is within 2 px of the cursor after `idle` (band-step tolerance; a double conversion moves it by degrees, hundreds of px).
5. **Keyboard** (10): focus the canvas at z4; `ArrowRight` once: the old centre's `pixelOf` moves left by MapLibre's pan step (100 px) ± 1 px; three rapid presses produce exactly one `moveend` after the last ease and no centre jump between frames > the pan step.
6. **Drag with inertia** (11): drag 200 px left in 100 ms (`page.mouse` with 10 steps) and release; record `getCenter()` on every `move`: no frame-to-frame jump larger than 2 × the largest gesture-frame step.
7. **`panBy`** (12): at z3, `panBy([100, 0], {duration: 0})`: `pixelOf(oldCentre).x` = width/2 − 100 ± 0.5.
8. **Box zoom** (13): shift-drag a 150 × 100 px box; after `idle`, the box corners' prior geographic positions (`unproject` before) are inside `getBounds()`.
9. **`fitBounds` / `cameraForBounds`** (14): `fitBounds([[4, 55], [32, 71]], {padding: 20, duration: 0})` (Scandinavia): every point of the bounds' densified edge (`pixelOf`) is inside the canvas minus 20 px padding, and at least one is within 2 px of a padded edge; `jumpTo(map.cameraForBounds(b))` gives the same `getCenter()` within 1e-6°.
10. **GeolocateControl** (16): `context.grantPermissions(['geolocation'])`, `context.setGeolocation({ latitude: 47.37, longitude: 8.54, accuracy: 500 })`; trigger the control: after `idle`, `getCenter()` within 1e-4° of Zürich.
11. **NavigationControl and rotate** (17): click zoom-in four times from z3 at G (crossing band 1): `getCenter()` within 1e-6° of G after each `idle`; right-drag to rotate 45°: G stays at the canvas centre ± 1 px.

Write each as its own `test(...)`; a failure prints the measured offset.

- [ ] **Step 6: Verify and commit**

Run: `npm run verify`

```bash
git add src/map/geo-api.ts src/map/controller.ts tests/geo-api.test.ts tests/support/fake-geo-host.ts tests/host-types.test.ts tests/browser demo/transition.ts
git diff --cached --name-only
git commit -m "Take camera targets geographically: per-value bypasses, pre-stop baseline, fitBounds across bands" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


---

### Task 8: GeoJSON sources in every band

**Files:**
- Create: `src/map/geojson.ts`, `tests/geojson.test.ts`
- Modify: `src/map/style-rewrite.ts`, `src/map/controller.ts`, `src/index.ts`
- Test: `tests/style-rewrite.test.ts`, `tests/controller.test.ts`, `tests/browser/geojson.spec.ts` (create)

**Interfaces:**
- Consumes: `warpFeature(feature, tolerance, maxDepth, blend)` (`tiles/mvt.ts`), `toleranceForZoom`, `parseRange`, Task 6's `wrapMethod` (`src/map/instance-wrap.ts`).
- Produces:
  ```ts
  // src/map/geojson.ts
  /** Clip to ±180°, densify for `zoom` and warp into the map space of `blend`. Features that clip away are dropped. */
  export function warpGeoJSON(data: GeoJSON.GeoJSON, blend: number, zoom: number): GeoJSON.FeatureCollection;
  /** The zoom whose tolerance a band's GeoJSON is densified for: the top of its parse range, capped at 12 (pure Equal Earth: 12). */
  export function geojsonZoomForBand(transition: ResolvedTransition | null, band: number): number;
  export const GEOJSON_MAX_DENSIFY_ZOOM = 12;
  ```
  `RewriteOptions.geojson?: Record<string, GeoJSON.GeoJSON>` — resolved data for GeoJSON sources whose `data` is a URL (the controller fetches them). `RewrittenStyle.bandedSources` now lists GeoJSON sources too; `RewrittenStyle.geojsonSources: string[]` lists only those.

**Spec §7.** GeoJSON sources are fanned out into one copy per band with blend < 1, densified with that band's tolerance and warped on the main thread; the Mercator band keeps the original source and id. Their layers are banded exactly like a vector source's (copies, parse ranges, gates). `getSource(id).setData(…)` updates every copy. Clustering happens in map space (accepted; documented).

Rules:

1. `rewriteStyle`: a `type: 'geojson'` source is banded when its `data` is an object, or a string with an entry in `options.geojson`. Band `k` (blend < 1): `${id}__b${k}` = the source with `data: warpGeoJSON(data, blend_k, geojsonZoomForBand(transition, k))` (all other fields — `cluster*`, `promoteId`, `lineMetrics`, `buffer`, `tolerance`, `attribution`, `maxzoom` — carried). A string `data` without an `options.geojson` entry stays unbanded (its layers untouched; documented: the controller always resolves them).
2. Layers whose source is a banded GeoJSON source are copied per band like vector layers.
3. Controller: before rewriting, resolve every string `data` of a GeoJSON source with `fetchJson` (same error message form as TileJSON: `Equal Earth: could not load GeoJSON for source "<id>": <reason>`), cached per URL for the controller's life.
4. Controller, after install, per banded GeoJSON source id: wrap the **live source object**'s `setData(data)` (`host.getSource(id)`; the Mercator-band source keeps the original id) so it also calls `setData(warpGeoJSON(resolved, blend_k, zoom_k))` on `${id}__b${k}`, and stores `resolved` in `#original.sources[id].data` so a re-apply keeps it. `resolved` is `data` when it is an object, else the `fetchJson` result (then the fan-out happens when it arrives). Wrap `updateData(diff)` too when the source has it (v5.24+ and v6): call the original, then `await source.getData()` and fan the full result out (documented: an `updateData` costs a full re-warp of that source). Wrappers are removed on teardown and re-installed on every install (a re-apply creates new source objects). Use `wrapMethod` from Task 6.
5. `ControllerHost` gains `getSource(id: string): unknown` (both majors have it; keep `tests/host-types.test.ts` green).

- [ ] **Step 1: Failing tests**

`tests/geojson.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { GEOJSON_MAX_DENSIFY_ZOOM, geojsonZoomForBand, warpGeoJSON } from '../src/map/geojson.js';
import { resolveTransition } from '../src/map/bands.js';
import { geographicToMap } from '../src/math/backproject.js';

const zurich = { type: 'Feature', properties: { name: 'Zürich' }, geometry: { type: 'Point', coordinates: [8.54, 47.37] } } as const;

describe('warpGeoJSON', () => {
  it('warps a point into the band's map space', () => {
    const out = warpGeoJSON(zurich as GeoJSON.Feature, 0.5, 6);
    expect(out.features[0]!.geometry).toEqual({ type: 'Point', coordinates: geographicToMap([8.54, 47.37], 0.5) });
    expect(out.features[0]!.properties).toEqual({ name: 'Zürich' });
  });

  it('accepts a bare geometry and a FeatureCollection', () => {
    expect(warpGeoJSON({ type: 'Point', coordinates: [0, 0] }, 0, 2).features).toHaveLength(1);
    expect(warpGeoJSON({ type: 'FeatureCollection', features: [zurich as GeoJSON.Feature, zurich as GeoJSON.Feature] }, 0, 2).features).toHaveLength(2);
  });

  it('densifies a long parallel so it curves in Equal Earth', () => {
    const line: GeoJSON.Feature = { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[-170, 60], [170, 60]] } };
    const coords = (warpGeoJSON(line, 0, 4).features[0]!.geometry as GeoJSON.LineString).coordinates;
    expect(coords.length).toBeGreaterThan(10);
  });

  it('drops features that lie entirely beyond ±180°', () => {
    expect(warpGeoJSON({ type: 'Point', coordinates: [200, 0] }, 0, 2).features).toHaveLength(0);
  });
});

describe('geojsonZoomForBand', () => {
  it('uses the top of the band's parse range, capped', () => {
    const six = resolveTransition();
    expect(geojsonZoomForBand(six, 0)).toBeCloseTo(4.8, 9);   // band 0 parses up to b_1 + s = 4 + 0.8
    expect(geojsonZoomForBand(null, 0)).toBe(GEOJSON_MAX_DENSIFY_ZOOM);
  });
});
```

`tests/style-rewrite.test.ts`: a style with a GeoJSON source `pts` (inline FeatureCollection of the five cities) and a `circle` layer on it → sources `pts__b0`…`pts__b5` exist with warped coordinates (`pts__b0`'s Zürich equals `geographicToMap([8.54, 47.37], 0)`), `pts` is unchanged, the circle layer has seven copies with gates; a source whose `data` is a URL string is banded only when `options.geojson` has it; `cluster: true` is carried onto the copies.

`tests/controller.test.ts` (`FakeControllerHost` gains `getSource(id)` returning a fake source object per style source with `setData`, `updateData`, `getData` recorded): activating on a style with a URL GeoJSON source calls `fetchJson` with the URL and the band copies carry warped data; after activation `host.getSource('pts').setData(newData)` results in `setData` on every `pts__b<k>` with `warpGeoJSON(newData, blend_k, zoom_k)`; `deactivate` restores the original style whose `pts.data` is `newData`; `updateData` fans out the `getData()` result; a failing GeoJSON fetch rejects `activate` with the formatted message and leaves the map untouched.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/geojson.test.ts tests/style-rewrite.test.ts tests/controller.test.ts`

- [ ] **Step 3: Implement**

`warpGeoJSON` normalises the input to features, maps `warpFeature(feature, toleranceForZoom(zoom), 8, blend)`, drops `null`s. `geojsonZoomForBand`: `transition ? Math.min(parseRange(transition, band)[1], GEOJSON_MAX_DENSIFY_ZOOM) : GEOJSON_MAX_DENSIFY_ZOOM`. Rewrite rules 1–2; controller rules 3–5. Export `warpGeoJSON`, `geojsonZoomForBand`, `GEOJSON_MAX_DENSIFY_ZOOM` from `src/index.ts`.

- [ ] **Step 4: Browser check**

`tests/browser/geojson.spec.ts`: the harness gains `?geojson=1`, which adds an inline GeoJSON source `cities` (the fixture's six places) with a `circle` layer (`#0000ff`, radius 6) to the fixture style. Under `equal` at z2 and z6, the pixel at `pixelOf(page, zurich)` is blue; after `map.getSource('cities').setData(<only Tokyo>)`, the Zürich pixel is no longer blue and the Tokyo pixel is.

- [ ] **Step 5: Verify and commit**

Run: `npm run verify`

```bash
git add src/map/geojson.ts src/map/style-rewrite.ts src/map/controller.ts src/index.ts tests/geojson.test.ts tests/style-rewrite.test.ts tests/controller.test.ts tests/support/fake-maplibre.ts tests/host-types.test.ts tests/browser
git diff --cached --name-only
git commit -m "Fan GeoJSON sources out to every band and keep setData/updateData in step" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Live style edits while active

**Files:**
- Modify: `src/map/controller.ts`, `src/map/style-rewrite.ts` (`RewriteOptions.initialBand`), `src/map/switcher.ts` (gates read through a getter)
- Test: `tests/controller.test.ts`, `tests/style-rewrite.test.ts`, `tests/browser/live-edits.spec.ts` (create)

**Interfaces:**
- Consumes: `wrapMethod` (Task 6), `rewriteStyle`, `applyGate`, `LayerGate`.
- Produces: `RewriteOptions.initialBand?: number` (overrides `bandIndexForZoom(bands, initialZoom)` for the gate state the copies start in). `ControllerHost` gains `addSource`, `removeSource`, `addLayer(layer, beforeId?)`, `removeLayer`, `setPaintProperty`, `setLayoutProperty`, `setFilter` (all present on both majors).

**Why.** While active, the application's own `addLayer`, `setPaintProperty` and friends reach only the Mercator band (the original ids): a layer added at z3 is drawn on geographic data inside an Equal Earth band, and a paint change is undone or invisible below z8 (the README's current limitation). A reasonable person expects the map to behave as if the projection were native. So, per instance and while active:

1. **Structure edits** — `addSource`, `removeSource`, `addLayer`, `removeLayer`: call MapLibre's own method first (the application can use the id synchronously; it lands in the Mercator band), apply the same change to `#original` (`addLayer(layer, beforeId)`: insert before `beforeId` in `#original.layers`, or append), and schedule **one** amend per task with `queueMicrotask` (several edits in one tick coalesce). The amend: `rewriteStyle(#original, { …, initialBand: switcher.current() })`, `setStyle(diff)`, then point the switcher at the new rewrite's `sourceIdsForBand`/`gatesForBand` (keep one mutable `#rewritten` that the switcher's closures read). The camera, constraint and switcher are **not** re-installed and no `jumpTo` happens: the view does not move. Because the copies start in the shown band's state, MapLibre's diff touches only the added or removed layers and sources. A pending symbol hide of the band that is fading out is re-applied by the switcher (call `applyGate(…, 'hidden')` for the previous band's hide-by-visibility gates if its hide already fired; otherwise leave the timer).
2. **Property edits** — `setPaintProperty(id, name, value)`, `setLayoutProperty(id, name, value)`, `setFilter(id, filter)` on an **original** layer id that has band copies: apply to every copy and to `#original`. A gated paint property (`OPACITY`) or the `visibility` of a hide-by-visibility layer updates the gate's own value instead: written through only to the copy of the currently shown band (and the Mercator original when that is shown); hidden copies keep 0 / `"none"`. Edits to ids without copies pass through unchanged.
3. Methods are wrapped on construction of the controller with `wrapMethod` and pass straight through while inactive; `destroy`/`dispose` restore them.
4. **The plugin's own writes bypass the wrappers.** The switcher's `applyGate` calls (`setPaintProperty`/`setLayoutProperty` on copy ids **and on the Mercator band's original ids**), the controller's own `setStyle`, and the amend must not be read as application edits — a gate write to `water`'s opacity would otherwise fan out to every copy and break the cross-fade. Capture the seven originals before wrapping (as Task 6's `RawCamera` does for the camera) and hand the switcher a `GateHost` built from them. Test: after activation, a band switch that gates the Mercator band (`host.applyFrame` across `to`) leaves every `water__b<k>` copy's `fill-opacity` as the gate table says, and records no amend.

- [ ] **Step 1: Failing tests**

`tests/controller.test.ts` (`FakeControllerHost` gains the seven methods, recording calls and applying them to its stored style; `setStyle` already records `setStyleCalls`):

```ts
it('coalesces ten addLayer calls into one amend that neither re-installs nor moves the camera', async () => {
  const { host, controller } = setup();
  await controller.activate('equal');
  const styles = host.setStyleCalls.length;
  const jumps = host.jumps;
  const hook = host._camera.transformCameraUpdate;
  for (let i = 0; i < 10; i++) {
    host.addLayer({ id: `extra${i}`, type: 'line', source: 'openmaptiles', 'source-layer': 'transportation' });
  }
  await Promise.resolve();
  expect(host.setStyleCalls.length).toBe(styles + 1);
  expect(host.jumps).toBe(jumps);
  expect(host._camera.transformCameraUpdate).toBe(hook);
  for (let i = 0; i < 10; i++) {
    expect(host.style!.layers.some((l) => l.id === `extra${i}__b1`)).toBe(true);
  }
});

it('starts added copies in the band that is shown, not the zoom's band', async () => {
  // Hold band 1 while the zoom's band is 2 (band 2 not loaded), then addLayer: the new
  // extra__b1 copy has its own opacity, extra__b2 has 0.
});

it('fans a paint change out to every copy and keeps gated values gated', async () => {
  const { host, controller } = setup(); // z4.6: band 1 shown
  await controller.activate('equal');
  host.setPaintProperty('water', 'fill-color', '#123456');
  for (const id of ['water__b0', 'water__b1', 'water__b5', 'water']) {
    expect(host.paint[id]?.['fill-color'], id).toBe('#123456');
  }
  host.setPaintProperty('water', 'fill-opacity', 0.5);
  expect(host.paint['water__b1']?.['fill-opacity']).toBe(0.5);
  expect(host.paint['water__b0']?.['fill-opacity'] ?? 0).toBe(0);
  // ...and a later band switch shows 0.5, not Liberty's own value:
  host.loaded.add('openmaptiles__b2');
  host.applyFrame({ zoomDelta: 0.4 });
  expect(host.paint['water__b2']?.['fill-opacity']).toBe(0.5);
});

it('removeLayer removes every copy; edits pass through while inactive', async () => {
  // removeLayer('water') while active → no water__b<k> remains after the amend;
  // after deactivate, setPaintProperty('road', …) reaches only 'road' and #original is not involved.
});
```

Write the two sketched tests in full with the fake's API. `tests/style-rewrite.test.ts`: `initialBand: 3` with `initialZoom: 4.6` starts band 3's copies with their own paint and band 1's at 0.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/controller.test.ts tests/style-rewrite.test.ts`

- [ ] **Step 3: Implement**

As rules 1–3. Keep the amend path separate from `#applyNow` (no teardown, no `#nextGeneration`, no `jumpTo`), but run it only while installed and not `#applying`; an amend that finds a re-apply in flight just updates `#original` (the re-apply reads it). Document in the controller module comment why structure edits amend rather than re-apply (view and shown band must not change). Update the README Limitations entry about app paint writes (they now fan out) and keep `setLayerZoomRange` documented as not fanned out.

- [ ] **Step 4: Browser check**

`tests/browser/live-edits.spec.ts`: under `equal` at z2, `addLayer` a red `circle` layer on the fixture `places` → the pixel at `pixelOf(page, [139.69, 35.69])` is red; `setPaintProperty(<that id>, 'circle-color', '#00ff00')` → green; one `addLayer` loop of 10 layers keeps `map.getCenter()` unchanged (exactly) and produces no `error` events.

- [ ] **Step 5: Verify and commit**

Run: `npm run verify`

```bash
git add src/map/controller.ts src/map/style-rewrite.ts src/map/switcher.ts tests/controller.test.ts tests/style-rewrite.test.ts tests/support/fake-maplibre.ts tests/host-types.test.ts tests/browser README.md
git diff --cached --name-only
git commit -m "Apply the application's style edits to every band without moving the view" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Persistent output-tile cache and `sourceZoomOffset`

**Files:**
- Create: `src/tiles/persistent-cache.ts`, `tests/persistent-cache.test.ts`
- Modify: `src/tiles/protocol.ts`, `src/tiles/tile-cover.ts`, `src/map/style-rewrite.ts` (pass the options into each band source URL), `src/map/controller.ts`, `src/install.ts`, `src/types/vendor.d.ts` (`declare const __EQE_VERSION__: string`), `vite.config.ts`, `vite.worker.config.ts`, `vitest.config.ts` (`define`), `scripts/probe-openfreemap.ts` (`--budget`), `src/index.ts`
- Test: `tests/protocol.test.ts`, `tests/tiles.test.ts` (tile cover), `tests/browser/cache.spec.ts` (create)

**Interfaces:**
- Produces:
  ```ts
  // src/tiles/persistent-cache.ts
  export interface PersistentCacheOptions { /** @defaultValue 3 */ maxZoom?: number; /** @defaultValue 7 */ ttlDays?: number }
  /** The slice of `CacheStorage` used (injectable for tests). */
  export interface CacheStorageLike { open(name: string): Promise<CacheLike>; keys(): Promise<string[]>; delete(name: string): Promise<boolean> }
  export interface CacheLike { match(key: string): Promise<Response | undefined>; put(key: string, response: Response): Promise<void>; delete(key: string): Promise<boolean> }
  /** FNV-1a 64-bit over the config's stable JSON (sorted keys), `persistentCache` excluded; 16 hex digits. */
  export function hashSourceConfig(config: EqualEarthSourceConfig): string;
  /** `https://equal-earth.invalid/<hash>/<blend>/<z>/<x>/<y>` */
  export function persistentKey(config: EqualEarthSourceConfig, tile: TileId): string;
  export class PersistentTileCache {
    constructor(storage: CacheStorageLike | undefined, version: string, now?: () => number);
    /** Never rejects: any failure (no Cache Storage, insecure context, quota) is a miss. */
    get(key: string): Promise<ArrayBuffer | undefined>;
    /** Never rejects; stores with an `x-eqe-expires` header. */
    put(key: string, data: ArrayBuffer, ttlDays: number): Promise<void>;
  }
  export const CACHE_NAME_PREFIX = 'equal-earth-';
  ```
  `EqualEarthSourceConfig` gains `persistentCache?: PersistentCacheOptions | false`; `TileCoverOptions` gains `sourceZoomOffset?: number` (relative; ignored when `sourceZoom` is set; the source zoom is `clamp(z + offset, 0, sourceMaxZoom)`). `InstallOptions`/`ControllerOptions` gain `persistentCache?: PersistentCacheOptions | false` (default `{ maxZoom: 3, ttlDays: 7 }`) and `sourceZoomOffset?: number`; `RewriteOptions` gains both and writes them into every band source's URL config.

**Spec §6.** Cache Storage inside the worker; key `pluginVersion / hash(source config) / t / z / x / y`, the hash covering the upstream template *including the API key*, so key rotation starts a fresh namespace. The plugin version is the cache **name** (`equal-earth-<version>`); on the first use per worker, every other `equal-earth-*` cache is deleted (old versions). Entries older than `ttlDays` are misses and are deleted. Output tiles above `maxZoom` are never stored. Missing or throwing Cache Storage is skipped silently.

- [ ] **Step 1: Failing tests**

`tests/persistent-cache.test.ts` with a fake `CacheStorageLike` (Maps; `Response` is global in Node ≥ 20):

```ts
it('stores and returns a tile under the version's cache name', async () => {
  const storage = new FakeCacheStorage();
  const cache = new PersistentTileCache(storage, '1.2.3', () => 0);
  await cache.put('https://equal-earth.invalid/a/0/1/0/0', new Uint8Array([1, 2, 3]).buffer, 7);
  expect(storage.names()).toEqual(['equal-earth-1.2.3']);
  expect(new Uint8Array((await cache.get('https://equal-earth.invalid/a/0/1/0/0'))!)).toEqual(new Uint8Array([1, 2, 3]));
});

it('misses and deletes an entry past its TTL', async () => {
  let now = 0;
  const storage = new FakeCacheStorage();
  const cache = new PersistentTileCache(storage, '1', () => now);
  await cache.put('k', new ArrayBuffer(1), 7);
  now = 7 * 86_400_000 + 1;
  expect(await cache.get('k')).toBeUndefined();
  expect(await (await storage.open('equal-earth-1')).match('k')).toBeUndefined();
});

it("deletes other versions' caches once", async () => {
  const storage = new FakeCacheStorage(['equal-earth-0.9.0', 'someone-else']);
  const cache = new PersistentTileCache(storage, '1.0.0');
  await cache.get('k');
  expect(storage.names().sort()).toEqual(['equal-earth-1.0.0', 'someone-else']);
});

it('serves nothing and throws nothing without Cache Storage, or when it throws', async () => {
  expect(await new PersistentTileCache(undefined, '1').get('k')).toBeUndefined();
  const broken = { open: () => Promise.reject(new Error('SecurityError')), keys: () => Promise.reject(new Error('x')), delete: () => Promise.resolve(false) };
  const cache = new PersistentTileCache(broken, '1');
  await expect(cache.put('k', new ArrayBuffer(1), 7)).resolves.toBeUndefined();
  expect(await cache.get('k')).toBeUndefined();
});

it('hashes the source config including the template's API key, excluding persistentCache', () => {
  const a = hashSourceConfig({ url: 'https://t/{z}/{x}/{y}?key=A', blend: 0 });
  expect(hashSourceConfig({ url: 'https://t/{z}/{x}/{y}?key=B', blend: 0 })).not.toBe(a);
  expect(hashSourceConfig({ blend: 0, url: 'https://t/{z}/{x}/{y}?key=A', persistentCache: { maxZoom: 5 } })).toBe(a);
  expect(a).toMatch(/^[0-9a-f]{16}$/);
});
```

`tests/protocol.test.ts` (the handler takes an injectable `cacheStorage?: CacheStorageLike` in `ProtocolOptions`, default `globalThis.caches`; and `version?: string`, default `__EQE_VERSION__`): a z2 output tile is fetched upstream once, then served from the persistent cache by a **new** handler sharing the storage (zero upstream fetches); a z4 tile is never stored with the default `maxZoom: 3`; `persistentCache: false` in the config bypasses it; "serves the tile when Cache Storage throws on put" (put rejects → the tile is still returned, nothing logged: spy `console.warn`/`console.error`).

`tests/tiles.test.ts`: `sourceTilesFor({ z: 3, x: 4, y: 3 }, { sourceZoomOffset: -1 })` returns z2 tiles only; `sourceZoom` wins over the offset; offsets clamp at 0 and at `sourceMaxZoom`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/persistent-cache.test.ts tests/protocol.test.ts tests/tiles.test.ts`

- [ ] **Step 3: Implement**

`__EQE_VERSION__`: `define: { __EQE_VERSION__: JSON.stringify(pkg.version) }` in the three configs (read `package.json` with `readFileSync`), declared in `vendor.d.ts`. In the handler, for blend < 1 and `tile.z <= maxZoom` and `config.persistentCache !== false`: `get(persistentKey(config, tile))` before fetching; on a miss build the tile, return it, and `void cache.put(…)` with a copy of the bytes. Plumb the options from `installEqualEarth` → controller → `rewriteStyle` → `encodeSourceUrl`.

- [ ] **Step 4: World-view budget mode in the Node probe**

`scripts/probe-openfreemap.ts --budget`: for the output tiles of a 1280×800 world view (every output tile at z1 and z2 inside the Equal Earth rows, blend 0), run the real handler against live OpenFreeMap at `sourceZoomOffset` 0 and −1, with a fresh handler per run (cold), and print one table: offset, upstream bytes, upstream requests, total warp ms, features per layer for `place`, `water`, `boundary`, `transportation`. Run it (network) and paste the table into the report. Keep the default `sourceZoomOffset` at **0** in this task; Task 11 decides on −1 from the cold first-paint measurement.

- [ ] **Step 5: Browser check**

`tests/browser/cache.spec.ts`: the fixture server counts requests (`GET /fixture-tiles/__count` returns `{ count }`, `POST /fixture-tiles/__reset` zeroes it). Open the harness under `equal-earth` at z1, wait for idle, reset the counter, reload the page (new workers: their in-memory caches are empty), wait for idle: the count is 0. With `?persist=0` (harness passes `persistentCache: false`) the reload fetches again (count > 0). Clear Cache Storage at the start of the spec (`caches.keys()` → delete all) so runs are independent.

- [ ] **Step 6: Verify and commit**

Run: `npm run verify`

```bash
git add src/tiles/persistent-cache.ts src/tiles/protocol.ts src/tiles/tile-cover.ts src/map/style-rewrite.ts src/map/controller.ts src/install.ts src/types/vendor.d.ts src/index.ts vite.config.ts vite.worker.config.ts vitest.config.ts scripts/probe-openfreemap.ts tests/persistent-cache.test.ts tests/protocol.test.ts tests/tiles.test.ts tests/browser
git diff --cached --name-only
git commit -m "Cache low-zoom output tiles in Cache Storage and add sourceZoomOffset" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Demo for any style, first-paint measurement, docs

**Files:**
- Modify: `demo/transition.ts`, `demo/transition.html`, `scripts/probe-transition.mjs` (`--first-paint`), `README.md`, `CLAUDE.md`, `docs/superpowers/specs/2026-09-28-equal-earth-v5-v6-state-of-the-art-design.md` (findings only), `package.json` (`probe:first-paint` script)
- Possibly modify: `src/install.ts` / `src/map/controller.ts` default `sourceZoomOffset` (Step 3's rule)

**Interfaces:**
- Consumes: the whole public API.
- Produces: demo URL parameters `?style=<url>` (default OpenFreeMap Liberty; a SmartMaps style URL with its `?key=` works the same way), `?control=0` (the `EqualEarthControl` is on by default), `?outside=`, `?outline=1`, `?graticule=<step>`, `?persist=0`, `?zoomOffset=`; `performance.mark('eqe:start')` (module start), `'eqe:installed'`, `'eqe:first-idle'` (first `idle` after the initial projection is active) and `window.__eqe.firstPaintMs = measure('eqe:start' → 'eqe:first-idle')`.

- [ ] **Step 1: Demo**

Add the parameters, the control, the marks and a readout line `first paint: <ms> ms`. The page must work with any EPSG:3857 vector style whose sources are TileJSON or `tiles` URLs; failures (bad style URL, TileJSON 401) show in the readout through the existing `fatal`/error lines. Add a preset link list to the panel: Liberty, Liberty with graticule and outline, and "your style" with a text input that reloads with `?style=`.

- [ ] **Step 2: Throttled first paint in the probe**

`scripts/probe-transition.mjs --first-paint [--style <url>]`: fresh Chrome profile; CDP `Network.enable`, `Network.emulateNetworkConditions({ offline: false, latency: 20, downloadThroughput: 6_250_000, uploadThroughput: 1_250_000 })` (50 Mbit/s); **cold**: `Network.setCacheDisabled({ cacheDisabled: true })` and Cache Storage cleared (`Storage.clearDataForOrigin` for the page origin, `storageTypes: 'cache_storage'`), load the demo at its default world view, read `__eqe.firstPaintMs`; **warm**: re-enable the HTTP cache, reload, read again. Print `cold <ms> (budget 4000) PASS|MISS`, `warm <ms> (budget 1500) PASS|MISS`. Exit 0 either way (SwiftShader is not representative of a user's GPU; the numbers are indicative), exit 2 on errors. `package.json`: `"probe:first-paint": "node scripts/probe-transition.mjs --first-paint"`.

- [ ] **Step 3: Decide the `sourceZoomOffset` default**

Run `npm run build:js`, the dev server, and `npm run probe:first-paint` three times; take the median cold time. If it misses 4000 ms, set `?zoomOffset=-1` and measure again; if −1 brings the median under budget, make −1 the default (`InstallOptions.sourceZoomOffset` doc + code) and record both medians plus Task 10's budget table in the spec §6 as the measurement that set it. If even −1 misses, keep 0 and record the miss as a finding in spec §6 ("revisit the budget with the user", per the spec). Either way the report states the numbers.

- [ ] **Step 4: Docs**

README: the control (usage, options, coexistence with `GlobeControl`), cartography options, "data in, geo out" (the wrapped methods and the band each converts with, per the audit: reads in the shown band, targets in the baseline band after a stop, `fitBounds` across bands; Marker/Popup/events, ScaleControl/GeolocateControl/Hash now correct; `geographicApi: false` for map space; zoom and bearing carry the compensation offsets; what is not converted: `queryRenderedFeatures` geometry, `getStyle()` contents, `getMaxBounds`/`setMaxBounds`, `calculateCameraOptionsFrom*`, deck.gl; `toGeographic`/`toMapSpace`/`geographicUnder`/`mapSpaceOf` for those), GeoJSON (banded, `setData`/`updateData`, clustering in map space), live style edits (what fans out; `setLayerZoomRange` does not), the persistent cache (`persistentCache`, key rotation, clearing: `caches.delete('equal-earth-<version>')`), `sourceZoomOffset`, the demo parameters and `probe:first-paint`, browser tests in Contributing. Remove limitations Plan 3 fixed (GlobeControl deactivating Equal Earth is still true for MapLibre's control but `EqualEarthControl` now exists; app paint writes now fan out; markers and event lngLat are geographic). CLAUDE.md: Layout rows for every new file, Commands (`test:browser`, `probe:first-paint`), the "data in, geo out" boundary in "The central constraint" (map space is now internal while active, except `queryRenderedFeatures` geometry and `getStyle()` contents), Planned work (Plan 3 done; next: native support when maplibre-gl-js#8330 lands, `native: 'auto'`). Keep CLAUDE.md's voice: why, not changelog.

- [ ] **Step 5: SmartMaps**

The repo holds no SmartMaps style URL or key, and none may be committed. Document in the README how to run the demo against SmartMaps (`?style=<SmartMaps style URL including ?key=>`) and in the report that SmartMaps verification needs the user's style URL.

- [ ] **Step 6: Verify and commit**

Run: `npm run verify`

```bash
git add demo/transition.ts demo/transition.html scripts/probe-transition.mjs package.json README.md CLAUDE.md docs/superpowers/specs/2026-09-28-equal-earth-v5-v6-state-of-the-art-design.md
git add src/install.ts src/map/controller.ts   # only if Step 3 changed the default
git diff --cached --name-only
git commit -m "Demo any style with first-paint marks; throttled first-paint probe; Plan 3 docs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
