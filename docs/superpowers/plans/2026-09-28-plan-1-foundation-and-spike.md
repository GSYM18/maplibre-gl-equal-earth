# Plan 1 — Foundation and transition spike — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the worker bundles loadable by MapLibre v5 and v6, add the blended Equal Earth ↔ Mercator warp, thread it through the tile pipeline, replace the single-threshold camera with a band-aware one that works on real v5 *and* v6 maps, and then run the throwaway visual spike that decides go/no-go for the band design.

**Architecture:** The warp gains a blend factor `t` (0 = Equal Earth, 1 = Mercator) that mixes world positions linearly. A *band* is a zoom range with a fixed `t`. Tiles are warped per band, and `BandCamera` converts the camera centre once per band crossing. Everything here is independent of the spike's outcome. Plans 2 (polyfill + cartography) and 3 (geo API, performance, browser tests, demos) are written after the spike's findings.

**Tech Stack:** TypeScript 5.9, Vite 8 (library mode, rolldown), Vitest 4, maplibre-gl 6.6.0 (+ 5.24.0 as a type-only devDependency alias), `@mapbox/vector-tile`, `geojson-vt`, `pbf`, `vt-pbf`.

**Spec:** `docs/superpowers/specs/2026-09-28-equal-earth-v5-v6-state-of-the-art-design.md` — read §2–§4 before starting. This plan covers the spec's delivery steps 1–3 (§9).

## Global Constraints

- MapLibre support: `>= 5.24` and `6.x`. The dev environment's npm proxy refuses packages published after **2026-08-31**, so maplibre-gl stays pinned to `^6.6.0` and vitest to `4.x`. The v5 alias is `"maplibre-gl-v5": "npm:maplibre-gl@5.24.0"`.
- ESM-only package. The worker bundles must be **self-contained**: `dist/worker.mjs` (v6) and `dist/worker.iife.js` (v5), with no relative imports, and no `blob:` or `unsafe-eval` CSP requirement.
- Client-only: no server-side tile work.
- `src/map/*` modules type the map **structurally** and never import `maplibre-gl` at runtime.
- Blend semantics: `world_t(p) = (1 − t)·equalEarthWorld(p) + t·mercatorWorld(p)`. The `equal` bands are `[0,5)` t=0, `[5,6)` t=⅓, `[6,7)` t=⅔, `[7,∞)` t=1. A zoom is in band `i` when `zoom >= bands[i].minZoom` (and below the next band's `minZoom`).
- Inverse accuracy: `< 1e-9°` for `|lat| ≤ 82.5°`; `< 1e-5°` (≈1 m) at the poles, where the northing's derivative vanishes.
- `npm run verify` must be green before every commit. Never `git add -f dist/` (`dist/` is gitignored and built by `prepublishOnly`).
- Stage explicit paths only, and run `git diff --cached --name-only` before every commit to confirm nothing unrelated is staged.
- End every commit message with: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

## Review Focus

1. **A real MapLibre v6 `Map` given to the camera.** v6's `Map` no longer inherits `transformCameraUpdate`; assigning it does nothing, so the camera must install through `setTransformCameraUpdate()`. Expected: the conversion actually runs on v6. Pinned by the v6-host tests and the compile-time host test in Task 4.
2. **A camera centre outside the current band's world** (the user panned into the empty space above Equal Earth, then zoomed across a boundary). Expected: the centre clamps to the world edge and converts; no NaN, no skipped conversion. Pinned in Task 4.
3. **Longitude beyond ±180°, versus exactly ±180°.** Expected: 190° wraps to −170° before conversion, but ±180° is left alone, because on Equal Earth they are opposite edges of the map. Pinned in Task 4.
4. **A zoom exactly on a band boundary.** Expected: the camera and the constraint agree the zoom belongs to the *upper* band (`>=`). Pinned in Tasks 4 and 5.
5. **Pure Equal Earth at high zoom, and hand-crafted tile URLs.** Expected: blend 0 warps at z8+ (no leftover switch-zoom passthrough); a blend outside [0, 1] in a URL is rejected, not clamped. Pinned in Task 3.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `vite.config.ts` | modify | library build only (`index.js`) |
| `vite.worker.config.ts` | create | self-contained worker builds: `worker.mjs` + `worker.iife.js` |
| `scripts/check-worker-bundles.mjs` | create | static and load-time guard for both worker bundles |
| `src/math/backproject.ts` | modify | blended warp, its inverse, `worldYRange`, `mapSpaceMaxLatitude` |
| `src/math/subdivide.ts` | modify | subdivision measured in the blended warp |
| `src/tiles/tile-cover.ts` | modify | pre-image under the blended warp |
| `src/tiles/mvt.ts` | modify | `warpFeature` / `buildTile` take a blend |
| `src/tiles/protocol.ts` | modify | blend in the URL config (validated); `switchZoom` removed |
| `src/map/bands.ts` | create | `Band`, `validateBands`, `bandIndexForZoom` |
| `src/map/camera.ts` | rewrite | `BandCamera`, `cameraHookAccess`; `ThresholdCamera` becomes a two-band subclass |
| `src/map/constrain.ts` | modify | per-band world edge; Mercator band unconstrained |
| `src/index.ts` | modify | new exports |
| `tests/blend.test.ts` | create | blended warp and inverse |
| `tests/band-camera.test.ts` | create | `BandCamera` on v5- and v6-shaped hosts |
| `tests/host-types.test.ts` | create | compile-time: real v5/v6 `Map` satisfy the host interfaces |
| `tests/tiles.test.ts`, `tests/protocol.test.ts`, `tests/constrain.test.ts` | modify | blend coverage |
| `demo/spike/bands.html`, `demo/spike/bands.ts` | create, then delete | **throwaway** spike (Task 6) |
| `docs/superpowers/spikes/2026-09-28-band-transition.md` | create | spike findings (kept) |

---

### Task 0: Commit the Phase 1–2 baseline (human decision)

The branch `init` holds all of Phases 1–2 uncommitted: `src/`, `tests/`, `demo/`, `scripts/`, the configs, and nine staged deletions (`deckgl.html`, the old `dist/` files, and others). Per-task commits in this plan would otherwise sweep that work in with unrelated changes.

- [ ] **Step 1: Ask the human** whether to commit the current working tree as the Phase 1–2 baseline, or whether they will do it themselves. Do not proceed until they answer.

- [ ] **Step 2: If they approve,** verify, then commit everything as the baseline:

```bash
npm run verify
git add -A
git status --short   # show the human the list before committing
git commit -m "Rewrite as TypeScript Equal Earth plugin (Phases 1-2)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Expected: `verify` passes (94 tests, `check-exports: 36 exports match`). `git status --short` is empty afterwards.

---

### Task 1: Self-contained worker bundles for v5 and v6

**Files:**
- Modify: `vite.config.ts`
- Create: `vite.worker.config.ts`
- Create: `scripts/check-worker-bundles.mjs`
- Modify: `package.json` (`scripts.build:js`, `scripts.check:exports`, `exports`)
- Modify: `tsconfig.json` (`include`)
- Modify: `.github/workflows/ci.yml` (last step)
- Modify: `CLAUDE.md` (Commands + Layout)

**Interfaces:**
- Consumes: `src/tiles/worker-entry.ts` (unchanged; it calls `globalThis.addProtocol('eqearth', …)`).
- Produces: `dist/worker.mjs` and `dist/worker.iife.js`, and package export paths `@yellowmap/maplibre-gl-equal-earth/worker` (→ `worker.mjs`) and `@yellowmap/maplibre-gl-equal-earth/worker.iife.js`. Plan 2's `installEqualEarth` loads them.

Background: v5 loads a worker script with classic `importScripts(url)`, so top-level `import`/`export` is a syntax error. v6 `import()`s `.mjs` URLs directly; for other URLs it fetches, sniffs with `/^[ \t]*(import|export)\s/m`, and imports through a `blob:` URL, where a relative specifier cannot resolve. Today `dist/worker.js` begins `import { … } from "./protocol-….js"`, so it fails on both.

- [ ] **Step 1: Write the guard script (the failing test)**

Create `scripts/check-worker-bundles.mjs`:

```js
/**
 * Guard for the worker bundles loaded via `importScriptInWorkers`.
 *
 * Both supported MapLibre majors load the worker script by URL, and neither can follow a
 * relative import out of it (see vite.worker.config.ts). This checks the built files
 * statically, then loads each one the way its MapLibre major would and confirms the
 * `eqearth` protocol registers:
 *
 * - `worker.iife.js` is evaluated as a classic script in a fresh VM context, as v5's
 *   `importScripts` does. It must not match MapLibre v6's ESM sniff either.
 * - `worker.mjs` is dynamically imported, as v6 does for `.mjs` URLs.
 *
 * Run after `npm run build`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const dist = new URL('../dist/', import.meta.url);
/** The exact test MapLibre v6's worker `loadScript` uses to decide a script is ESM. */
const ESM_SNIFF = /^[ \t]*(import|export)\s/m;
/** A static or dynamic import of a relative specifier. */
const RELATIVE_IMPORT = /(\bfrom|\bimport\s*\(?)\s*['"]\.\.?\//;
const SCHEME = 'eqearth';

const failures = [];

function read(name) {
  const url = new URL(name, dist);
  try {
    return readFileSync(url, 'utf8');
  } catch {
    failures.push(`${name}: missing (looked for ${fileURLToPath(url)}). Run \`npm run build\` first.`);
    return null;
  }
}

const registeredScheme = (calls) =>
  calls.some(([scheme, handlerType]) => scheme === SCHEME && handlerType === 'function');

const iife = read('worker.iife.js');
if (iife !== null) {
  if (ESM_SNIFF.test(iife)) {
    failures.push('worker.iife.js: contains top-level import/export; v5 importScripts would throw.');
  }
  if (RELATIVE_IMPORT.test(iife)) failures.push('worker.iife.js: contains a relative import.');

  const calls = [];
  const context = vm.createContext({
    addProtocol: (scheme, handler) => calls.push([scheme, typeof handler]),
    console,
    fetch,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    AbortController,
    setTimeout,
    clearTimeout,
  });
  try {
    vm.runInContext(iife, context, { filename: 'worker.iife.js' });
  } catch (error) {
    failures.push(`worker.iife.js: threw when evaluated as a classic script: ${String(error)}`);
  }
  if (!registeredScheme(calls)) failures.push(`worker.iife.js: did not register ${SCHEME}.`);
}

const esm = read('worker.mjs');
if (esm !== null) {
  if (RELATIVE_IMPORT.test(esm)) {
    failures.push('worker.mjs: contains a relative import; it cannot resolve from a blob: URL or a CDN.');
  }

  const calls = [];
  globalThis.addProtocol = (scheme, handler) => calls.push([scheme, typeof handler]);
  try {
    await import(new URL('worker.mjs', dist).href);
  } catch (error) {
    failures.push(`worker.mjs: failed to import: ${String(error)}`);
  } finally {
    delete globalThis.addProtocol;
  }
  if (!registeredScheme(calls)) failures.push(`worker.mjs: did not register ${SCHEME}.`);
}

if (failures.length > 0) {
  console.error(`check-worker-bundles:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}

console.log('check-worker-bundles: worker.mjs and worker.iife.js are self-contained and register eqearth.');
```

- [ ] **Step 2: Run it against the current build to verify it fails**

Run: `npm run build && node scripts/check-worker-bundles.mjs`
Expected: exit code 1, output containing `worker.iife.js: missing` and `worker.mjs: missing`.

- [ ] **Step 3: Split the build**

Replace `vite.config.ts` with:

```ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const resolveFromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  build: {
    target: 'es2022',
    sourcemap: true,
    lib: {
      // ESM only: maplibre-gl v6 dropped CJS, so a UMD/CJS build of a plugin
      // whose peer dependency is ESM-only would have no valid consumer.
      //
      // The worker bundles are *not* a second entry here: a multi-entry build hoists
      // shared code into chunks, and a worker script cannot import a chunk. They have
      // their own build, vite.worker.config.ts.
      entry: { index: resolveFromRoot('src/index.ts') },
      formats: ['es'],
    },
    rollupOptions: {
      external: ['maplibre-gl'],
    },
  },
});
```

Create `vite.worker.config.ts`:

```ts
/**
 * Builds the worker-side protocol registration as two **self-contained** bundles.
 *
 * `importScriptInWorkers` loads a script by URL into MapLibre's worker pool, and the two
 * supported majors load it differently:
 *
 * - v5 calls classic `importScripts(url)`, so any top-level `import`/`export` is a SyntaxError.
 * - v6 `import()`s a `.mjs` URL directly. For any other extension it fetches the source,
 *   sniffs for ESM and imports it through a `blob:` URL — where a relative specifier such
 *   as `./protocol-abc.js` cannot resolve.
 *
 * So neither bundle may import anything, which rules out building the worker as a second
 * entry of the library build. `scripts/check-worker-bundles.mjs` guards both outputs.
 */

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const resolveFromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  build: {
    target: 'es2022',
    sourcemap: true,
    // Runs after the library build into the same dist/; emptying it would delete index.js.
    emptyOutDir: false,
    lib: {
      entry: resolveFromRoot('src/tiles/worker-entry.ts'),
      formats: ['es', 'iife'],
      // Required by the IIFE format. The entry exports nothing, so the global stays empty.
      name: 'EqualEarthWorker',
      fileName: (format) => (format === 'es' ? 'worker.mjs' : 'worker.iife.js'),
    },
  },
});
```

In `package.json`, change these entries:

```json
"build:js": "vite build && vite build --config vite.worker.config.ts",
"check:exports": "node scripts/check-exports.mjs && node scripts/check-worker-bundles.mjs",
```

and replace the `"./worker"` export with:

```json
"./worker": {
  "types": "./dist/tiles/worker-entry.d.ts",
  "import": "./dist/worker.mjs",
  "default": "./dist/worker.mjs"
},
"./worker.iife.js": "./dist/worker.iife.js",
```

In `tsconfig.json`, add `"vite.worker.config.ts"` to `include`:

```json
"include": ["src", "tests", "demo", "scripts", "vite.config.ts", "vite.worker.config.ts", "vitest.config.ts"]
```

In `.github/workflows/ci.yml`, replace the last step's `run: node scripts/check-exports.mjs` with `run: npm run check:exports`, and rename the step to `Verify built bundle exports and worker bundles`.

- [ ] **Step 4: Run the guard to verify it passes**

Run: `npm run build && npm run check:exports`
Expected: `check-exports: 36 exports match src/index.ts.` followed by `check-worker-bundles: worker.mjs and worker.iife.js are self-contained and register eqearth.` Also run `ls dist`: it lists `worker.mjs` and `worker.iife.js`, and there is no `worker.js` and no `protocol-*.js` chunk.

- [ ] **Step 5: Update CLAUDE.md**

In `## Commands`, replace the paragraph starting ``npm run check:exports`` with:

```markdown
`npm run check:exports` runs two guards over the build. `scripts/check-exports.mjs` diffs the
built bundle's runtime exports against the value exports declared in `src/index.ts` (it exists
solely to make the 0.2.1 drift bug impossible to reintroduce). `scripts/check-worker-bundles.mjs`
asserts both worker bundles are self-contained and actually register `eqearth` when loaded the
way MapLibre v5 (`importScripts`) and v6 (`import()`) load them. `prepublishOnly` runs both.
```

In `## Layout`, replace the `worker-entry.ts` line with:

```markdown
- `src/tiles/worker-entry.ts` — built twice by `vite.worker.config.ts`, as `dist/worker.mjs`
  (v6, dynamic `import()`) and `dist/worker.iife.js` (v5, classic `importScripts`). Both must be
  self-contained: v5 cannot parse `import`, and v6 imports non-`.mjs` scripts via a `blob:` URL
  where relative specifiers cannot resolve.
```

- [ ] **Step 6: Run the full verification**

Run: `npm run verify`
Expected: all steps pass, and both guard lines print.

- [ ] **Step 7: Commit**

```bash
git add vite.config.ts vite.worker.config.ts scripts/check-worker-bundles.mjs package.json tsconfig.json .github/workflows/ci.yml CLAUDE.md
git diff --cached --name-only
git commit -m "Build self-contained worker bundles for MapLibre v5 and v6

The worker bundle imported a shared chunk, which v5's importScripts cannot
parse and v6 cannot resolve from a blob: URL.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Blended warp and its inverse

**Files:**
- Modify: `src/math/backproject.ts`
- Create: `tests/blend.test.ts`
- Modify: `docs/superpowers/specs/2026-09-28-equal-earth-v5-v6-state-of-the-art-design.md` (§3 table row, §4 accuracy bullet)

**Interfaces:**
- Consumes: `toEqualEarth`, `fromEqualEarth` (`src/math/equal-earth.ts`, unchanged).
- Produces, all with `blend` defaulting to 0 (so existing callers are unchanged):
  - `geographicToMapWorld(lngLat: LngLatTuple, blend?: number): WorldTuple`
  - `mapWorldToGeographic(world: WorldTuple, blend?: number): LngLatTuple`: `[NaN, NaN]` outside the world band
  - `geographicToMap(lngLat: LngLatTuple, blend?: number): LngLatTuple`: the identity at blend 1
  - `mapToGeographic(lngLat: LngLatTuple, blend?: number): LngLatTuple`: the identity at blend 1
  - `worldYRange(blend?: number): [north: number, south: number]`
  - `mapSpaceMaxLatitude(blend?: number): number`
  - The constants `WORLD_Y_MIN`, `WORLD_Y_MAX` and `MAP_SPACE_MAX_LATITUDE` keep their values.

Why the inverse is cheap: both projections keep northing a function of latitude alone and easting linear in longitude for a fixed latitude, and a linear mix preserves both. So the inverse is a 1-D bisection on latitude followed by one division. Bisection rather than Newton, because the northing's derivative vanishes at the poles. Numbers measured in a prototype: ≤ 6e-12° error for |lat| ≤ 82.5°, ≤ 1.4e-6° at the poles, ~20–50 µs per call.

- [ ] **Step 1: Write the failing tests**

Create `tests/blend.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  MAP_SPACE_MAX_LATITUDE,
  MERCATOR_MAX_LATITUDE,
  WORLD_Y_MAX,
  WORLD_Y_MIN,
  geographicToMap,
  geographicToMapWorld,
  mapSpaceMaxLatitude,
  mapToGeographic,
  mapWorldToGeographic,
  worldYRange,
} from '../src/math/backproject.js';
import type { LngLatTuple } from '../src/math/equal-earth.js';

/** Web Mercator in normalised world space, written out independently of the module under test. */
function mercatorWorld([lng, lat]: LngLatTuple): [number, number] {
  const clamped = Math.max(-MERCATOR_MAX_LATITUDE, Math.min(MERCATOR_MAX_LATITUDE, lat));
  const phi = (clamped * Math.PI) / 180;
  return [lng / 360 + 0.5, 0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI)];
}

function grid(filter: (lat: number) => boolean = () => true): LngLatTuple[] {
  const points: LngLatTuple[] = [];
  for (let lng = -180; lng <= 180; lng += 15) {
    for (let lat = -90; lat <= 90; lat += 7.5) {
      if (filter(lat)) points.push([lng, lat]);
    }
  }
  return points;
}

const INTERMEDIATE = [1 / 3, 2 / 3];
const awayFromPoles = (lat: number) => Math.abs(lat) <= 82.5;
const nearPoles = (lat: number) => Math.abs(lat) > 82.5;

function maxError(a: LngLatTuple, b: LngLatTuple): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
}

describe('blended warp', () => {
  it('leaves the published blend-0 constants unchanged', () => {
    expect(worldYRange(0)).toEqual([WORLD_Y_MIN, WORLD_Y_MAX]);
    expect(WORLD_Y_MIN).toBeCloseTo(0.2566, 4);
    expect(mapSpaceMaxLatitude(0)).toBe(MAP_SPACE_MAX_LATITUDE);
    expect(MAP_SPACE_MAX_LATITUDE).toBeCloseTo(65.46, 2);
  });

  it('is plain Web Mercator at blend 1', () => {
    for (const p of grid((lat) => Math.abs(lat) <= 85)) {
      const world = geographicToMapWorld(p, 1);
      const expected = mercatorWorld(p);
      expect(world[0]).toBeCloseTo(expected[0], 12);
      expect(world[1]).toBeCloseTo(expected[1], 12);
      expect(geographicToMap(p, 1)).toEqual(p);
      expect(mapToGeographic(p, 1)).toEqual(p);
    }
  });

  it('mixes the two world positions linearly', () => {
    for (const t of INTERMEDIATE) {
      for (const p of grid()) {
        const world = geographicToMapWorld(p, t);
        const equalEarth = geographicToMapWorld(p, 0);
        const mercator = mercatorWorld(p);
        expect(world[0]).toBeCloseTo(equalEarth[0] + t * (mercator[0] - equalEarth[0]), 12);
        expect(world[1]).toBeCloseTo(equalEarth[1] + t * (mercator[1] - equalEarth[1]), 12);
      }
    }
  });

  it('inverts to 1e-9° away from the poles', () => {
    for (const t of [...INTERMEDIATE, 0.999]) {
      for (const p of grid(awayFromPoles)) {
        expect(maxError(mapWorldToGeographic(geographicToMapWorld(p, t), t), p)).toBeLessThan(1e-9);
      }
    }
  });

  it('inverts to 1e-5° (about 1 m) at the poles, where the northing flattens', () => {
    for (const t of INTERMEDIATE) {
      for (const p of grid(nearPoles)) {
        expect(maxError(mapWorldToGeographic(geographicToMapWorld(p, t), t), p)).toBeLessThan(1e-5);
      }
    }
  });

  it('round-trips through map-space lng/lat, which is what the camera sees', () => {
    for (const t of INTERMEDIATE) {
      for (const p of grid(awayFromPoles)) {
        expect(maxError(mapToGeographic(geographicToMap(p, t), t), p)).toBeLessThan(1e-9);
      }
    }
  });

  it('shrinks the empty bands above and below the world as the blend approaches Mercator', () => {
    const ranges = [0, 1 / 3, 2 / 3, 1].map((t) => worldYRange(t));
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i]![0]).toBeLessThan(ranges[i - 1]![0]);
      expect(ranges[i]![1]).toBeGreaterThan(ranges[i - 1]![1]);
    }
    expect(ranges[3]![0]).toBeCloseTo(0, 12);
    expect(ranges[3]![1]).toBeCloseTo(1, 12);
  });

  it('returns NaN outside the world band but accepts a point on its edge', () => {
    const t = 1 / 3;
    const [north] = worldYRange(t);
    expect(mapWorldToGeographic([0.5, north - 1e-6], t)[1]).toBeNaN();
    expect(mapWorldToGeographic([0.5, north - 1e-13], t)[1]).toBeCloseTo(90, 5);
    expect(mapWorldToGeographic([0.5, north], t)[1]).toBeCloseTo(90, 5);
  });

  it('raises the map-space world edge towards Mercator as the blend grows', () => {
    const edges = [0, 1 / 3, 2 / 3, 1].map((t) => mapSpaceMaxLatitude(t));
    for (let i = 1; i < edges.length; i++) expect(edges[i]!).toBeGreaterThan(edges[i - 1]!);
    expect(edges[3]).toBe(MERCATOR_MAX_LATITUDE);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/blend.test.ts`
Expected: FAIL. `worldYRange` and `mapSpaceMaxLatitude` are not exported (`is not a function`), and the blend-1 assertions fail because the second argument is ignored.

- [ ] **Step 3: Implement the blend in `src/math/backproject.ts`**

Replace everything from `export function geographicToMap` down to (but not including) `function clamp` with:

```ts
/**
 * Convert real geographic coordinates to the map-space coordinates MapLibre must be given
 * for the point to land in the right place on an Equal Earth map.
 *
 * Every overlay coordinate — deck.gl accessors, GeoJSON, marker positions, `flyTo` targets —
 * must pass through here while Equal Earth is active.
 *
 * `blend` selects a zoom band of the adaptive projection (see {@link geographicToMapWorld});
 * at 1 map space *is* geographic space and this is the identity.
 */
export function geographicToMap(lngLat: LngLatTuple, blend = 0): LngLatTuple {
  if (blend === 0) {
    const equalEarth = toEqualEarth(lngLat);
    return fromWebMercator([equalEarth[0] * GRID_FACTOR, equalEarth[1] * GRID_FACTOR]);
  }
  if (blend === 1) return [lngLat[0], lngLat[1]];
  return worldToMercatorLngLat(geographicToMapWorld(lngLat, blend));
}

/**
 * Inverse of {@link geographicToMap}: recover real geographic coordinates from the values
 * MapLibre reports (`map.getCenter()`, `map.unproject()`, `queryRenderedFeatures` geometry)
 * while Equal Earth is active.
 */
export function mapToGeographic(lngLat: LngLatTuple, blend = 0): LngLatTuple {
  if (blend === 0) {
    const mercator = toWebMercator(lngLat);
    return fromEqualEarth([mercator[0] / GRID_FACTOR, mercator[1] / GRID_FACTOR]);
  }
  if (blend === 1) return [lngLat[0], lngLat[1]];
  return mapWorldToGeographic(mercatorWorld(lngLat), blend);
}

/**
 * The map-space latitude of the geographic pole — the top edge of the world once it sits
 * on the Mercator grid. ≈ ±65.46° for pure Equal Earth, rising to Mercator's ±85.05° as the
 * blend approaches 1.
 *
 * Useful for constraining the camera: there is nothing to show beyond it, whereas Mercator
 * itself would happily pan on to ±85°.
 */
export function mapSpaceMaxLatitude(blend = 0): number {
  return Math.min(geographicToMap([0, 90], blend)[1], MERCATOR_MAX_LATITUDE);
}

/** {@link mapSpaceMaxLatitude} for pure Equal Earth (≈ ±65.46°). */
export const MAP_SPACE_MAX_LATITUDE = mapSpaceMaxLatitude(0);

/**
 * A point in normalised Mercator world space: `[0,1]²`, origin at the top-left
 * (north-west) corner, y increasing southward. This is MapLibre's tile coordinate space —
 * tile `(z, x, y)` covers `[x, x+1] × [y, y+1]` divided by `2^z`.
 */
export type WorldTuple = [number, number];

/**
 * Geographic coordinates straight to normalised world space, for the tile pipeline.
 *
 * `blend` mixes Equal Earth (0) and Web Mercator (1) *world positions* linearly — the zoom
 * bands of the adaptive `equal` projection each render one fixed blend:
 *
 *     world_t(p) = (1 − t) · equalEarthWorld(p) + t · mercatorWorld(p)
 *
 * The mix is continuous in p, so warped geometry never tears. And because in both
 * projections northing depends on latitude alone and easting is linear in longitude for a
 * fixed latitude, so does the mix — which is what makes {@link mapWorldToGeographic} cheap.
 *
 * At blend 0 this skips the inverse-Mercator step that {@link geographicToMap} ends with:
 * world coordinates are an *affine* function of Equal Earth metres, so it costs two
 * multiplies instead of a `log`/`tan` pair. Use this for every tile vertex; use
 * {@link geographicToMap} only at the camera boundary.
 */
export function geographicToMapWorld(lngLat: LngLatTuple, blend = 0): WorldTuple {
  if (blend === 0) return equalEarthWorld(lngLat);
  const mercator = mercatorWorld(lngLat);
  if (blend === 1) return mercator;
  const equalEarth = equalEarthWorld(lngLat);
  return [
    equalEarth[0] + blend * (mercator[0] - equalEarth[0]),
    equalEarth[1] + blend * (mercator[1] - equalEarth[1]),
  ];
}

/** Bisection steps for the blended inverse: 64 halvings of 180° exhaust double precision. */
const BLEND_INVERSE_STEPS = 64;

/** Slack for points on the world edge that round to just outside it. */
const WORLD_EDGE_EPSILON = 1e-12;

/**
 * Inverse of {@link geographicToMapWorld}. Returns `[NaN, NaN]` for a point above or below
 * the world band — there is no geographic location there.
 *
 * For an intermediate blend, latitude is found by bisection: the blended northing depends on
 * latitude alone and strictly decreases with it. Newton would converge faster, but its
 * derivative vanishes at the poles, where Equal Earth's northing flattens and Mercator's is
 * clamped; bisection is immune to both. That same flattening limits accuracy near the poles
 * to ~1e-6° — about 0.1 m, and inherent to the projection, not the solver.
 */
export function mapWorldToGeographic(world: WorldTuple, blend = 0): LngLatTuple {
  if (blend === 0) {
    const inverseScale = (2 * WEB_MERCATOR_MAX) / GRID_FACTOR;
    return fromEqualEarth([(world[0] - 0.5) * inverseScale, (0.5 - world[1]) * inverseScale]);
  }
  if (blend === 1) return worldToMercatorLngLat(world);

  const [north, south] = worldYRange(blend);
  if (!(world[1] >= north - WORLD_EDGE_EPSILON && world[1] <= south + WORLD_EDGE_EPSILON)) {
    return [Number.NaN, Number.NaN];
  }
  const y = clamp(world[1], north, south);

  let low = -90;
  let high = 90;
  for (let i = 0; i < BLEND_INVERSE_STEPS; i++) {
    const mid = (low + high) / 2;
    // World y grows southward: a point south of the target means the latitude is higher.
    if (geographicToMapWorld([0, mid], blend)[1] > y) low = mid;
    else high = mid;
  }
  const lat = (low + high) / 2;

  // Easting is linear in longitude for a fixed latitude: x = 0.5 + lng · slope(lat).
  const slope = geographicToMapWorld([1, lat], blend)[0] - 0.5;
  return [(world[0] - 0.5) / slope, lat];
}

/**
 * World-space y of the north and south edges of the world at a blend.
 *
 * Equal Earth has a ~2.05:1 aspect ratio, so once stretched to fill the Mercator grid
 * horizontally it occupies only the middle ~49% of it vertically; the band widens to the
 * whole grid as the blend approaches Mercator. Tiles wholly outside it contain no map at all
 * and can be skipped outright.
 */
export function worldYRange(blend = 0): [north: number, south: number] {
  return [geographicToMapWorld([0, 90], blend)[1], geographicToMapWorld([0, -90], blend)[1]];
}

/** World-space y of the north edge of the Equal Earth world (≈0.2566). */
export const WORLD_Y_MIN = worldYRange(0)[0];

/** World-space y of the south edge of the Equal Earth world (≈0.7434). */
export const WORLD_Y_MAX = worldYRange(0)[1];

function equalEarthWorld(lngLat: LngLatTuple): WorldTuple {
  const equalEarth = toEqualEarth(lngLat);
  const scale = GRID_FACTOR / (2 * WEB_MERCATOR_MAX);
  return [0.5 + equalEarth[0] * scale, 0.5 - equalEarth[1] * scale];
}

function mercatorWorld(lngLat: LngLatTuple): WorldTuple {
  const mercator = toWebMercator(lngLat);
  return [
    0.5 + mercator[0] / (2 * WEB_MERCATOR_MAX),
    0.5 - mercator[1] / (2 * WEB_MERCATOR_MAX),
  ];
}

function worldToMercatorLngLat(world: WorldTuple): LngLatTuple {
  return fromWebMercator([
    (world[0] - 0.5) * 2 * WEB_MERCATOR_MAX,
    (0.5 - world[1]) * 2 * WEB_MERCATOR_MAX,
  ]);
}
```

(Keep the existing `function clamp` at the bottom of the file. The blend-0 branches are the previous function bodies, byte for byte, so existing behaviour is untouched.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/blend.test.ts` — expected: PASS (9 tests).
Then run: `npm test` — expected: all tests pass (the previous 94 plus 9).

- [ ] **Step 5: Amend the spec to match the implementation**

In the spec's §3 components table, replace the `math/backproject.ts` row's responsibility with:
`` `geographicToMapWorld(p, t = 0)`; inverse `mapWorldToGeographic(w, t = 0)`, closed form at t ∈ {0, 1}, 1-D bisection on latitude otherwise (northing depends on latitude alone); `worldYRange(t)`, `mapSpaceMaxLatitude(t)` ``

In §4, replace the **Inverse accuracy** bullet with:
`- **Inverse accuracy.** Measured and tested: < 1e-9° for |lat| ≤ 82.5°, < 1e-5° (≈1 m) at the poles, where the northing's derivative vanishes and precision is limited by the projection itself. Out-of-band points return NaN; the camera clamps before converting.`

- [ ] **Step 6: Run the full verification**

Run: `npm run verify`
Expected: all steps pass.

- [ ] **Step 7: Commit**

```bash
git add src/math/backproject.ts tests/blend.test.ts docs/superpowers/specs/2026-09-28-equal-earth-v5-v6-state-of-the-art-design.md
git diff --cached --name-only
git commit -m "Add blended Equal Earth/Mercator warp and its inverse

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Blend through the tile pipeline

**Files:**
- Modify: `src/math/subdivide.ts`
- Modify: `src/tiles/tile-cover.ts`
- Modify: `src/tiles/mvt.ts`
- Modify: `src/tiles/protocol.ts`
- Modify: `tests/tiles.test.ts`, `tests/protocol.test.ts`

**Interfaces:**
- Consumes: `geographicToMapWorld(p, blend)`, `mapWorldToGeographic(w, blend)`, `geographicToMap(p, blend)` and `worldYRange(blend)` from Task 2.
- Produces:
  - `SubdivideOptions.blend?: number`, and `warpOnly(points, blend = 0)`
  - `TileCoverOptions.blend?: number`, used by `preimageBBox` and `sourceTilesFor`
  - `WarpTileOptions.blend?: number`, and `warpFeature(feature, tolerance, maxDepth, blend = 0)`
  - `EqualEarthSourceConfig.blend?: number`, validated to be in [0, 1] by `parseTileUrl`. **`switchZoom` is removed**: each band source has a fixed blend, blend 1 is a byte passthrough, and every blend below 1 warps at every zoom. Plan 2's style rewrite builds one `encodeSourceUrl({ url, blend, … })` per band.

- [ ] **Step 1: Write the failing tests**

In `tests/tiles.test.ts`, make sure these imports exist (add what is missing to the existing import lines):

```ts
import { geographicToMap } from '../src/math/backproject.js';
import { densify, toleranceForZoom } from '../src/math/subdivide.js';
import { preimageBBox, sourceTilesFor } from '../src/tiles/tile-cover.js';
import { warpFeature } from '../src/tiles/mvt.js';
```

Append:

```ts
describe('blended warp in the tile pipeline', () => {
  it('warps a point to its blended map-space position', () => {
    const feature: GeoJSON.Feature = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'Point', coordinates: [139.7, 35.7] },
    };
    const warped = warpFeature(feature, toleranceForZoom(5), 8, 1 / 3)!;
    const expected = geographicToMap([139.7, 35.7], 1 / 3);
    const coordinates = (warped.geometry as GeoJSON.Point).coordinates;
    expect(coordinates[0]).toBeCloseTo(expected[0], 12);
    expect(coordinates[1]).toBeCloseTo(expected[1], 12);
  });

  it('covers grid rows that are empty in pure Equal Earth once blended towards Mercator', () => {
    expect(sourceTilesFor({ z: 2, x: 0, y: 0 })).toEqual([]);
    expect(sourceTilesFor({ z: 2, x: 0, y: 0 }, { blend: 2 / 3 }).length).toBeGreaterThan(0);
  });

  it('keeps every pre-image a valid geographic box at intermediate blends', () => {
    for (const blend of [1 / 3, 2 / 3]) {
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const bbox = preimageBBox({ z: 3, x, y }, { blend });
          if (!bbox) continue;
          const [west, south, east, north] = bbox;
          expect(west).toBeLessThanOrEqual(east);
          expect(south).toBeLessThanOrEqual(north);
          expect(south).toBeGreaterThanOrEqual(-90 - 1e-9);
          expect(north).toBeLessThanOrEqual(90 + 1e-9);
        }
      }
    }
  });

  it('subdivides against the blend it will be drawn with', () => {
    const meridian: [number, number][] = [
      [150, -60],
      [150, 60],
    ];
    const options = { tolerance: toleranceForZoom(4) };
    expect(densify(meridian, { ...options, blend: 2 / 3 })).not.toEqual(densify(meridian, options));
  });
});
```

In `tests/protocol.test.ts`:

1. Add the import `import { sourceTilesFor } from '../src/tiles/tile-cover.js';`.
2. Replace the body of `it('round-trips a config through the URL', …)`: build the URL with `encodeSourceUrl({ url: UPSTREAM, blend: 1 / 3, sourceZoom: 3 })` and replace `expect(config.switchZoom).toBe(6);` with `expect(config.blend).toBe(1 / 3);`.
3. Add to the `tile URL codec` describe:

```ts
  it('rejects a blend outside [0, 1] rather than clamping it', () => {
    for (const blend of [-0.1, 1.5, 'half', null]) {
      const encoded = btoa(JSON.stringify({ url: UPSTREAM, blend }))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      expect(() => parseTileUrl(`eqearth://${encoded}/0/0/0`)).toThrow(/blend/);
    }
  });
```

4. In `describe('protocol handler', …)`, replace the `tileUrl` helper with:

```ts
  const tileUrl = (z: number, x: number, y: number, blend = 0) =>
    encodeSourceUrl({ url: UPSTREAM, blend })
      .replace('{z}', String(z))
      .replace('{x}', String(x))
      .replace('{y}', String(y));
```

5. Rename `'passes tiles through unwarped at and above the switch zoom'` to `'passes tiles through unwarped at blend 1'`, and change its request to `tileUrl(8, 3, 4, 1)`.
6. Add:

```ts
  it('warps pure Equal Earth at any zoom — there is no switch zoom any more', async () => {
    const tile = { z: 8, x: 130, y: 126 };
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      requested.push(url);
      return new Response(null, { status: 404 });
    });
    const handler = createEqualEarthProtocol({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await handler({ url: tileUrl(tile.z, tile.x, tile.y) }, new AbortController());

    const cover = sourceTilesFor(tile).map((source) => expandTemplate(UPSTREAM, source));
    expect(cover.length).toBeGreaterThan(0);
    expect([...requested].sort()).toEqual([...cover].sort());
    expect(requested).not.toEqual([expandTemplate(UPSTREAM, tile)]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/tiles.test.ts tests/protocol.test.ts`
Expected: FAIL. The blended point equals the blend-0 position, `sourceTilesFor(…, { blend })` returns `[]`, blend is not validated, and the z8 blend-0 request is passed through (a single request for `/8/130/126.pbf`).

- [ ] **Step 3: Thread `blend` through `src/math/subdivide.ts`**

Add to `SubdivideOptions`:

```ts
  /**
   * Blend between Equal Earth (0) and Web Mercator (1) that deviation is measured in. Each
   * zoom band of the adaptive projection warps with its own blend, so it subdivides with it
   * too. Refinement stays a pure function of the endpoints *and* the blend, so tiles of the
   * same band still meet exactly.
   *
   * @defaultValue 0
   */
  blend?: number;
```

Replace `densifyAndWarp`, `densify`, `refineGeographic`, `refine` and `warpOnly` with the versions below. The doc comments stay the same as today; the only change is that the blend is passed to every `geographicToMapWorld` call:

```ts
export function densifyAndWarp(
  points: readonly LngLatTuple[],
  options: SubdivideOptions,
): WorldTuple[] {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const toleranceSquared = options.tolerance * options.tolerance;
  const blend = options.blend ?? 0;

  if (points.length === 0) return [];

  const first = points[0]!;
  const output: WorldTuple[] = [geographicToMapWorld(first, blend)];

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    refine(
      a,
      output[output.length - 1]!,
      b,
      geographicToMapWorld(b, blend),
      0,
      maxDepth,
      toleranceSquared,
      blend,
      output,
    );
  }

  return output;
}

export function densify(
  points: readonly LngLatTuple[],
  options: SubdivideOptions,
): LngLatTuple[] {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const toleranceSquared = options.tolerance * options.tolerance;
  const blend = options.blend ?? 0;

  if (points.length === 0) return [];

  const output: LngLatTuple[] = [points[0]!];

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    refineGeographic(
      a,
      geographicToMapWorld(a, blend),
      b,
      geographicToMapWorld(b, blend),
      0,
      maxDepth,
      toleranceSquared,
      blend,
      output,
    );
  }

  return output;
}

function refineGeographic(
  a: LngLatTuple,
  aWorld: WorldTuple,
  b: LngLatTuple,
  bWorld: WorldTuple,
  depth: number,
  maxDepth: number,
  toleranceSquared: number,
  blend: number,
  output: LngLatTuple[],
): void {
  if (depth >= maxDepth) {
    output.push(b);
    return;
  }

  const mid: LngLatTuple = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const midWorld = geographicToMapWorld(mid, blend);

  const dx = midWorld[0] - (aWorld[0] + bWorld[0]) / 2;
  const dy = midWorld[1] - (aWorld[1] + bWorld[1]) / 2;

  if (dx * dx + dy * dy <= toleranceSquared) {
    output.push(b);
    return;
  }

  refineGeographic(a, aWorld, mid, midWorld, depth + 1, maxDepth, toleranceSquared, blend, output);
  refineGeographic(mid, midWorld, b, bWorld, depth + 1, maxDepth, toleranceSquared, blend, output);
}

function refine(
  a: LngLatTuple,
  aWorld: WorldTuple,
  b: LngLatTuple,
  bWorld: WorldTuple,
  depth: number,
  maxDepth: number,
  toleranceSquared: number,
  blend: number,
  output: WorldTuple[],
): void {
  if (depth >= maxDepth) {
    output.push(bWorld);
    return;
  }

  // Geographic midpoint — a plain arithmetic mean, which is what makes the decision
  // reproducible from the endpoints alone.
  const mid: LngLatTuple = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const midWorld = geographicToMapWorld(mid, blend);

  // How far the true warped midpoint sits from the chord's midpoint.
  const chordX = (aWorld[0] + bWorld[0]) / 2;
  const chordY = (aWorld[1] + bWorld[1]) / 2;
  const dx = midWorld[0] - chordX;
  const dy = midWorld[1] - chordY;

  if (dx * dx + dy * dy <= toleranceSquared) {
    output.push(bWorld);
    return;
  }

  refine(a, aWorld, mid, midWorld, depth + 1, maxDepth, toleranceSquared, blend, output);
  refine(mid, midWorld, b, bWorld, depth + 1, maxDepth, toleranceSquared, blend, output);
}

/** Warp a ring or line without densifying — for point geometry, or when detail is irrelevant. */
export function warpOnly(points: readonly LngLatTuple[], blend = 0): WorldTuple[] {
  return points.map((point) => geographicToMapWorld(point, blend));
}
```

- [ ] **Step 4: Thread `blend` through `src/tiles/tile-cover.ts`**

Change the import to:

```ts
import { MERCATOR_MAX_LATITUDE, mapWorldToGeographic, worldYRange } from '../math/backproject.js';
```

Add to `TileCoverOptions`:

```ts
  /** Blend of the zoom band the output tile belongs to. @defaultValue 0 */
  blend?: number;
```

In `preimageBBox`, replace the lines from `// Wholly outside the Equal Earth world's vertical band.` through the end of `consider` with:

```ts
  const blend = options.blend ?? 0;
  const [worldTop, worldBottom] = worldYRange(blend);

  // Wholly outside the world's vertical band at this blend.
  if (south <= worldTop || north >= worldBottom) return null;

  // Clamp to the world band so the inverse warp stays in domain.
  const top = Math.max(north, worldTop);
  const bottom = Math.min(south, worldBottom);

  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;

  const consider = (wx: number, wy: number): void => {
    const [lng, lat] = mapWorldToGeographic([wx, wy], blend);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  };
```

Update the function's doc comment first line to read: `The geographic bounding box of an output tile's pre-image under the warp at \`options.blend\`.`

- [ ] **Step 5: Thread `blend` through `src/tiles/mvt.ts`**

Add to `WarpTileOptions`:

```ts
  /** Blend of the zoom band this tile is built for: 0 Equal Earth … 1 Mercator. @defaultValue 0 */
  blend?: number;
```

Change `warpFeature`'s signature and its two helpers:

```ts
export function warpFeature(
  feature: GeoJSON.Feature,
  tolerance: number,
  maxDepth: number,
  blend = 0,
): GeoJSON.Feature | null {
  const geometry = feature.geometry;
  if (!geometry || geometry.type === 'GeometryCollection') return null;

  const warpPosition = (p: GeoJSON.Position): GeoJSON.Position =>
    geographicToMap([p[0]!, p[1]!], blend);

  const warpLine = (line: GeoJSON.Position[]): GeoJSON.Position[] =>
    densify(
      line.map((p) => [p[0]!, p[1]!] as LngLatTuple),
      { tolerance, maxDepth, blend },
    ).map((p) => geographicToMap(p, blend) as GeoJSON.Position);
```

(The rest of `warpFeature` is unchanged.) In `buildTile`, add `const blend = options.blend ?? 0;` after the `tolerance` line, and change the call to `warpFeature(feature, tolerance, maxDepth, blend)`.

- [ ] **Step 6: Replace `switchZoom` with a validated blend in `src/tiles/protocol.ts`**

Replace the `EqualEarthSourceConfig` interface and delete `DEFAULT_SWITCH_ZOOM`:

```ts
/**
 * Everything the handler needs, encoded into the tile URL.
 *
 * `blend` (from both option interfaces) fixes the zoom band this source serves. Blend 1 is
 * plain Mercator and is passed through byte for byte; every lower blend warps at every zoom
 * — pure Equal Earth has no switch zoom, it simply never changes band.
 */
export interface EqualEarthSourceConfig extends TileCoverOptions, WarpTileOptions {
  /** Upstream Mercator tile template, e.g. `https://…/{z}/{x}/{y}.pbf`. */
  url: string;
}
```

In the returned handler, replace the `switchZoom` block with:

```ts
    const { config, tile } = parseTileUrl(params.url);

    // Blend 1 is plain Mercator: the upstream tile is already correct, so pass its bytes
    // through untouched rather than warping them. The polyfill routes its Mercator band to
    // the original source and never asks for this, but a hand-built URL may.
    if ((config.blend ?? 0) === 1) {
      const passthrough = await loadSource(config.url, tile, abortController.signal);
      return { data: passthrough ?? new ArrayBuffer(0) };
    }
```

Replace `decodeConfig` with:

```ts
function decodeConfig(encoded: string): EqualEarthSourceConfig {
  const parsed: unknown = JSON.parse(base64UrlDecode(encoded));
  if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { url?: unknown }).url !== 'string') {
    throw new Error('Equal Earth: tile URL carries no upstream template.');
  }
  // Reject rather than clamp: a blend outside [0, 1] means the URL was built wrongly, and
  // silently clamping it would render a plausible-looking but wrong map.
  const blend = (parsed as { blend?: unknown }).blend;
  if (blend !== undefined && !(typeof blend === 'number' && blend >= 0 && blend <= 1)) {
    throw new Error(`Equal Earth: tile URL carries blend ${JSON.stringify(blend)}; expected a number in [0, 1].`);
  }
  return parsed as EqualEarthSourceConfig;
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/tiles.test.ts tests/protocol.test.ts` — expected: PASS.
Then run: `npm test` — expected: all tests pass.

- [ ] **Step 8: Run the full verification**

Run: `npm run verify`
Expected: all steps pass.

- [ ] **Step 9: Commit**

```bash
git add src/math/subdivide.ts src/tiles/tile-cover.ts src/tiles/mvt.ts src/tiles/protocol.ts tests/tiles.test.ts tests/protocol.test.ts
git diff --cached --name-only
git commit -m "Thread the warp blend through the tile pipeline

Each band source now carries a fixed, validated blend; switchZoom is gone.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Band model and `BandCamera` (working on real v5 and v6 maps)

**Files:**
- Create: `src/map/bands.ts`
- Rewrite: `src/map/camera.ts`
- Create: `tests/band-camera.test.ts`
- Create: `tests/host-types.test.ts`
- Modify: `package.json` (devDependency alias)
- Modify: `src/index.ts`
- Modify: `README.md` (camera section)
- Modify: spec §2 (new finding) and §3 (camera row)

**Interfaces:**
- Consumes: `geographicToMap(p, blend)`, `mapToGeographic(p, blend)` and `mapSpaceMaxLatitude(blend)` from Task 2.
- Produces:
  - `interface Band { readonly minZoom: number; readonly blend: number }`
  - `validateBands(bands: readonly Band[]): void`: throws `TypeError`
  - `bandIndexForZoom(bands: readonly Band[], zoom: number): number`
  - `type CameraUpdateFn`: bivariant, so MapLibre's `CameraUpdateTransformFunction` is assignable to it
  - `interface CameraHost { getZoom(): number; transformCameraUpdate?: CameraUpdateFn | null; setTransformCameraUpdate?(value: CameraUpdateFn | null): void }`
  - `cameraHookAccess(host: CameraHost): CameraHookAccess` (not exported from `index.ts`; Plan 2's controller imports it from the module)
  - `class BandCamera { constructor(host: CameraHost, options: BandCameraOptions); readonly bands: readonly Band[]; readonly blend: number; handleCameraUpdate: CameraUpdateFn; destroy(): void }`
  - `ThresholdCamera`: same public API as today, now a two-band `BandCamera`

**Finding this task fixes.** On MapLibre **v6**, `Map` no longer extends `Camera`. The hook lives on a private `map._camera`, and the only public accessor is the setter `map.setTransformCameraUpdate(fn)`. Assigning `map.transformCameraUpdate = fn`, which is what `ThresholdCamera` does today, sets an unused property: **the conversion never runs on a real v6 map.** v5's `Map` still inherits the public property. The existing tests pass only because `FakeMap` has the v5 shape. Checked with `tsc`: a real v6 `Map` is not assignable to today's `CameraHost`, while the shape above accepts both v5 and v6 maps.

- [ ] **Step 1: Add the v5 type alias**

Run: `npm install --save-dev maplibre-gl-v5@npm:maplibre-gl@5.24.0`
Expected: `package.json` gains `"maplibre-gl-v5": "npm:maplibre-gl@5.24.0"` under `devDependencies`. (5.24.0 was published 2026-04-23, inside the registry cutoff.)

- [ ] **Step 2: Write the failing tests**

Create `tests/host-types.test.ts`:

```ts
/**
 * Compile-time guard: real MapLibre maps must satisfy the structural host interfaces.
 *
 * `npm run typecheck` (tsc over tests/) is what enforces this — the runtime assertion only
 * keeps vitest from reporting an empty file. It exists because v6 moved the camera hook
 * behind a setter, and a v5-shaped `CameraHost` silently stopped matching a real v6 map.
 */
import type { Map as MapV6 } from 'maplibre-gl';
import type { Map as MapV5 } from 'maplibre-gl-v5';
import { describe, expect, it } from 'vitest';

import type { CameraHost } from '../src/map/camera.js';
import type { ConstrainHost } from '../src/map/constrain.js';

const acceptsV6 = (map: MapV6): [CameraHost, ConstrainHost] => [map, map];
const acceptsV5 = (map: MapV5): [CameraHost, ConstrainHost] => [map, map];

describe('host interfaces', () => {
  it('accept real v5 and v6 maps (enforced by the type checker)', () => {
    expect([typeof acceptsV5, typeof acceptsV6]).toEqual(['function', 'function']);
  });
});
```

Create `tests/band-camera.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import type { Band } from '../src/map/bands.js';
import {
  BandCamera,
  type CameraUpdate,
  type CameraUpdateFn,
  type CameraUpdateResult,
} from '../src/map/camera.js';
import { geographicToMap, mapSpaceMaxLatitude } from '../src/math/backproject.js';

/** The `equal` projection's bands (spec §3). */
const EQUAL: Band[] = [
  { minZoom: 0, blend: 0 },
  { minZoom: 5, blend: 1 / 3 },
  { minZoom: 6, blend: 2 / 3 },
  { minZoom: 7, blend: 1 },
];
const TOKYO: [number, number] = [139.69, 35.69];

const blendAt = (zoom: number) => (zoom < 5 ? 0 : zoom < 6 ? 1 / 3 : zoom < 7 ? 2 / 3 : 1);

interface Centred {
  center: { lng: number; lat: number };
}

/**
 * v5-shaped host: the hook is a public property. Like MapLibre's handler loop, it feeds the
 * returned centre back in as the next update's baseline.
 */
class FakeV5Map {
  transformCameraUpdate: CameraUpdateFn | null = null;
  center: { lng: number; lat: number };
  zoom: number;

  constructor(center: [number, number], zoom: number) {
    this.center = { lng: center[0], lat: center[1] };
    this.zoom = zoom;
  }

  getZoom(): number {
    return this.zoom;
  }

  step(zoom: number): void {
    this.zoom = zoom;
    const next: CameraUpdate = { center: { ...this.center }, zoom };
    const result: CameraUpdateResult = this.transformCameraUpdate?.(next) ?? {};
    if (result.center) this.center = result.center;
  }
}

/** v6-shaped host: no hook property; a setter writes it to a private `_camera`. */
class FakeV6Map {
  _camera: { transformCameraUpdate: CameraUpdateFn | null } = { transformCameraUpdate: null };
  center: { lng: number; lat: number };
  zoom: number;

  constructor(center: [number, number], zoom: number) {
    this.center = { lng: center[0], lat: center[1] };
    this.zoom = zoom;
  }

  getZoom(): number {
    return this.zoom;
  }

  setTransformCameraUpdate(value: CameraUpdateFn | null): void {
    this._camera.transformCameraUpdate = value;
  }

  step(zoom: number): void {
    this.zoom = zoom;
    const next: CameraUpdate = { center: { ...this.center }, zoom };
    const result: CameraUpdateResult = this._camera.transformCameraUpdate?.(next) ?? {};
    if (result.center) this.center = result.center;
  }
}

/** v6-shaped host whose hook storage cannot be read at all — a future MapLibre, say. */
class OpaqueV6Map {
  #hook: CameraUpdateFn | null = null;
  center = { lng: 0, lat: 0 };
  zoom = 4;

  getZoom(): number {
    return this.zoom;
  }

  setTransformCameraUpdate(value: CameraUpdateFn | null): void {
    this.#hook = value;
  }

  step(zoom: number): void {
    this.zoom = zoom;
    const result: CameraUpdateResult = this.#hook?.({ center: { ...this.center }, zoom }) ?? {};
    if (result.center) this.center = result.center;
  }
}

function expectAt(map: Centred, expected: [number, number], digits = 9): void {
  expect(map.center.lng).toBeCloseTo(expected[0], digits);
  expect(map.center.lat).toBeCloseTo(expected[1], digits);
}

describe('BandCamera', () => {
  it('keeps the centre on the same place through every band of a pinch zoom', () => {
    const map = new FakeV5Map(geographicToMap(TOKYO, 0), 4.2);
    new BandCamera(map, { bands: EQUAL });

    for (const zoom of [4.6, 4.9, 5.1, 5.5, 5.9, 6.2, 6.8, 7.1, 7.9]) {
      map.step(zoom);
      expectAt(map, geographicToMap(TOKYO, blendAt(zoom)));
    }
  });

  it('converts once, directly, when a single update skips several bands', () => {
    const map = new FakeV5Map(geographicToMap(TOKYO, 0), 3);
    new BandCamera(map, { bands: EQUAL });

    map.step(10);

    expectAt(map, TOKYO);
  });

  it('does not drift over many round trips through the bands', () => {
    const map = new FakeV5Map(TOKYO, 9);
    new BandCamera(map, { bands: EQUAL });

    for (let i = 0; i < 20; i++) {
      for (const zoom of [7.5, 6.5, 5.5, 4.5, 5.5, 6.5, 7.5]) map.step(zoom);
    }
    map.step(9);

    expectAt(map, TOKYO);
  });

  it('treats a zoom exactly on a boundary as inside the upper band', () => {
    const map = new FakeV5Map(geographicToMap(TOKYO, 0), 4.5);
    const camera = new BandCamera(map, { bands: EQUAL });

    map.step(5);

    expect(camera.blend).toBe(1 / 3);
    expectAt(map, geographicToMap(TOKYO, 1 / 3));
  });

  it('seeds the current band from the live zoom', () => {
    const map = new FakeV5Map(TOKYO, 6.5);
    expect(new BandCamera(map, { bands: EQUAL }).blend).toBe(2 / 3);
  });

  it('does not convert between adjacent bands that share a blend', () => {
    const map = new FakeV5Map([10, 20], 4);
    new BandCamera(map, {
      bands: [
        { minZoom: 0, blend: 0 },
        { minZoom: 5, blend: 0 },
      ],
    });

    map.step(6);

    expect(map.center).toEqual({ lng: 10, lat: 20 });
  });

  it('clamps a centre beyond the world edge instead of failing', () => {
    // Panned into the empty space above Equal Earth (edge ≈ 65.46° in map space).
    const onConversionFailure = vi.fn();
    const map = new FakeV5Map([0, 80], 4.5);
    new BandCamera(map, { bands: EQUAL, onConversionFailure });

    map.step(5.2);

    expect(onConversionFailure).not.toHaveBeenCalled();
    expect(map.center.lat).toBeCloseTo(mapSpaceMaxLatitude(1 / 3), 6);
  });

  it('wraps a longitude beyond ±180° before converting', () => {
    const map = new FakeV5Map([190, 0], 8);
    new BandCamera(map, { bands: EQUAL });

    map.step(6.5);

    expectAt(map, geographicToMap([-170, 0], 2 / 3));
  });

  it('leaves exactly ±180° alone — on Equal Earth those are opposite map edges', () => {
    const map = new FakeV5Map([180, 0], 8);
    new BandCamera(map, { bands: EQUAL });

    map.step(4);

    expectAt(map, geographicToMap([180, 0], 0));
    expect(map.center.lng).toBeGreaterThan(0);
  });

  it('still reports a genuinely non-finite centre', () => {
    const onConversionFailure = vi.fn();
    const map = new FakeV5Map([Number.NaN, Number.NaN], 4);
    new BandCamera(map, { bands: EQUAL, onConversionFailure });

    map.step(8);

    expect(onConversionFailure).toHaveBeenCalledOnce();
  });

  it('rejects malformed bands', () => {
    const map = new FakeV5Map([0, 0], 0);
    expect(() => new BandCamera(map, { bands: [] })).toThrow(TypeError);
    expect(
      () =>
        new BandCamera(map, {
          bands: [
            { minZoom: 0, blend: 0 },
            { minZoom: 5, blend: 1.5 },
          ],
        }),
    ).toThrow(/blend/);
    expect(
      () =>
        new BandCamera(map, {
          bands: [
            { minZoom: 0, blend: 0 },
            { minZoom: 5, blend: 0.5 },
            { minZoom: 5, blend: 1 },
          ],
        }),
    ).toThrow(/minZoom/);
  });

  describe('on a MapLibre v6-shaped host', () => {
    it('installs through setTransformCameraUpdate and converts', () => {
      const map = new FakeV6Map(geographicToMap(TOKYO, 0), 4.5);
      new BandCamera(map, { bands: EQUAL });

      map.step(8);

      expectAt(map, TOKYO);
    });

    it('chains to a hook the application set before installation', () => {
      const map = new FakeV6Map(geographicToMap(TOKYO, 0), 4.5);
      const upstream = vi.fn((): CameraUpdateResult => ({}));
      map.setTransformCameraUpdate(upstream);
      new BandCamera(map, { bands: EQUAL });

      map.step(4.6);

      expect(upstream).toHaveBeenCalledOnce();
    });

    it('restores that hook on destroy', () => {
      const map = new FakeV6Map(geographicToMap(TOKYO, 0), 4.5);
      const upstream = vi.fn((): CameraUpdateResult => ({}));
      map.setTransformCameraUpdate(upstream);
      const camera = new BandCamera(map, { bands: EQUAL });

      camera.destroy();

      expect(map._camera.transformCameraUpdate).toBe(upstream);
    });

    it('warns, and still installs, when the existing hook cannot be read', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const map = new OpaqueV6Map();
      const start = geographicToMap(TOKYO, 0);
      map.center = { lng: start[0], lat: start[1] };
      new BandCamera(map, { bands: EQUAL });

      map.step(8);

      expect(warn).toHaveBeenCalledOnce();
      // Tokyo, not the map-space start: proves the hook was installed and converted.
      expectAt(map, TOKYO);
      warn.mockRestore();
    });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/band-camera.test.ts tests/host-types.test.ts` — expected: FAIL (`src/map/bands.js` does not exist; `BandCamera` is not exported).
Run: `npm run typecheck` — expected: FAIL. `tests/host-types.test.ts` reports that `Map` is not assignable to `CameraHost` (the v6 line).

- [ ] **Step 4: Create `src/map/bands.ts`**

```ts
/**
 * Zoom bands: the unit the adaptive `equal` projection is built from.
 *
 * A band is a zoom range drawn with one fixed blend between Equal Earth (0) and Web
 * Mercator (1). Band `i` covers `[bands[i].minZoom, bands[i + 1].minZoom)`; the first band
 * also covers every zoom below its own `minZoom`, and the last extends upward without end.
 *
 * Tiles are warped per band and MapLibre draws tiles per integer zoom, so a blend varying
 * continuously with zoom is not achievable with backprojection — the design spec (§2–§4)
 * measures what a hard switch would cost and why three steps were chosen instead.
 */

export interface Band {
  /** Lowest zoom of the band. Only the first band may use `-Infinity`. */
  readonly minZoom: number;
  /** 0 = Equal Earth, 1 = Web Mercator. */
  readonly blend: number;
}

/** Throw a `TypeError` describing the first thing wrong with `bands`. */
export function validateBands(bands: readonly Band[]): void {
  if (!Array.isArray(bands) || bands.length === 0) {
    throw new TypeError('Equal Earth bands must be a non-empty array.');
  }
  for (let i = 0; i < bands.length; i++) {
    const { minZoom, blend } = bands[i]!;
    if (typeof blend !== 'number' || !(blend >= 0 && blend <= 1)) {
      throw new TypeError(`Band ${i} has blend ${String(blend)}; expected a number in [0, 1].`);
    }
    const validZoom =
      typeof minZoom === 'number' && (i === 0 ? !Number.isNaN(minZoom) : Number.isFinite(minZoom));
    if (!validZoom) {
      throw new TypeError(`Band ${i} has minZoom ${String(minZoom)}; expected a finite number.`);
    }
    if (i > 0 && !(minZoom > bands[i - 1]!.minZoom)) {
      throw new TypeError(
        `Band ${i} minZoom ${minZoom} must exceed band ${i - 1}'s ${bands[i - 1]!.minZoom}.`,
      );
    }
  }
}

/**
 * Index of the band a zoom falls in. A zoom exactly on a boundary belongs to the upper band.
 * `bands` must already be valid; a NaN zoom lands in the first band.
 */
export function bandIndexForZoom(bands: readonly Band[], zoom: number): number {
  for (let i = bands.length - 1; i > 0; i--) {
    if (zoom >= bands[i]!.minZoom) return i;
  }
  return 0;
}
```

- [ ] **Step 5: Rewrite `src/map/camera.ts`**

Replace the whole file with:

```ts
/**
 * Camera continuity across zoom bands.
 *
 * An adaptive Equal Earth map divides the zoom range into bands (see `bands.ts`), each drawn
 * with a fixed blend between Equal Earth and Mercator. The camera centre is expressed in the
 * current band's map space, so it means something different on either side of every band
 * boundary and must be converted whenever the camera crosses one — otherwise the view jumps.
 */

import { geographicToMap, mapSpaceMaxLatitude, mapToGeographic } from '../math/backproject.js';
import type { LngLatTuple } from '../math/equal-earth.js';
import { bandIndexForZoom, validateBands, type Band } from './bands.js';

/**
 * The subset of `maplibre-gl`'s camera-update payload we care about.
 *
 * Declared structurally rather than imported so this module stays testable without a
 * WebGL context, and so the plugin does not break if MapLibre adds fields.
 */
export interface CameraUpdate {
  center: { lng: number; lat: number };
  zoom: number;
  [key: string]: unknown;
}

export type CameraUpdateResult = {
  center?: { lng: number; lat: number };
  [key: string]: unknown;
};

/**
 * A `transformCameraUpdate` callback.
 *
 * Declared *bivariant* in its parameter (method-signature syntax) so MapLibre's own
 * `CameraUpdateTransformFunction` — whose payload carries a `LngLat` class instance — and
 * this type are assignable to each other. With a plain function type `strictFunctionTypes`
 * rejects that, and a real `maplibregl.Map` would not satisfy {@link CameraHost}.
 */
export type CameraUpdateFn = {
  bivarianceHack(next: CameraUpdate): CameraUpdateResult;
}['bivarianceHack'];

/**
 * Minimal structural view of the bits of `Map` this module touches.
 *
 * The camera hook moved between MapLibre majors. v5's `Map` inherits a public
 * `transformCameraUpdate` property from `Camera`. v6's `Map` no longer extends `Camera`:
 * assigning that property on a v6 map does nothing, and the hook can only be set through
 * `setTransformCameraUpdate()`. Both shapes are accepted — see {@link cameraHookAccess}.
 */
export interface CameraHost {
  getZoom(): number;
  /** MapLibre v5, and test doubles: the hook is a plain property. */
  transformCameraUpdate?: CameraUpdateFn | null;
  /** MapLibre v6: the hook can only be set through this method. */
  setTransformCameraUpdate?(value: CameraUpdateFn | null): void;
}

/** Constructs whatever `LngLat`-ish object the host expects. */
export type LngLatFactory = (lng: number, lat: number) => { lng: number; lat: number };

const defaultLngLatFactory: LngLatFactory = (lng, lat) => ({ lng, lat });

/** Reads and writes a host's camera hook across MapLibre majors. */
export interface CameraHookAccess {
  /** The installed hook; `undefined` when this MapLibre version offers no way to read it. */
  get(): CameraUpdateFn | null | undefined;
  set(hook: CameraUpdateFn | null): void;
}

type V6Host = CameraHost & { setTransformCameraUpdate(value: CameraUpdateFn | null): void };

function hasHookSetter(host: CameraHost): host is V6Host {
  return typeof (host as { setTransformCameraUpdate?: unknown }).setTransformCameraUpdate === 'function';
}

/**
 * Access a host's camera hook, whichever major it is.
 *
 * v6 has a public setter but no getter. The previous hook is read from the private
 * `_camera` the setter writes to, because without it an application's own hook could only
 * be silently replaced rather than chained. If a future release moves that field, `get()`
 * reports `undefined` ("unknown") rather than guessing.
 */
export function cameraHookAccess(host: CameraHost): CameraHookAccess {
  if (hasHookSetter(host)) {
    const internals = host as unknown as {
      _camera?: { transformCameraUpdate?: CameraUpdateFn | null };
    };
    return {
      get: () => (internals._camera ? (internals._camera.transformCameraUpdate ?? null) : undefined),
      set: (hook) => host.setTransformCameraUpdate(hook),
    };
  }
  return {
    get: () => host.transformCameraUpdate ?? null,
    set: (hook) => {
      host.transformCameraUpdate = hook;
    },
  };
}

export interface BandCameraOptions {
  /** Zoom bands, validated with `validateBands`. */
  bands: readonly Band[];
  /** Builds the center object handed back to MapLibre. Pass `maplibregl.LngLat`. */
  lngLatFactory?: LngLatFactory;
  /** Called when a conversion produces a non-finite coordinate. Defaults to a console warning. */
  onConversionFailure?: (reason: string, input: LngLatTuple) => void;
}

export interface ThresholdCameraOptions {
  /**
   * Zoom at which the map stops using Equal Earth and switches to plain Mercator tiles.
   * Below this the camera centre is in map space; at or above it, in geographic space.
   */
  switchZoom: number;
  /** Builds the center object handed back to MapLibre. Pass `maplibregl.LngLat`. */
  lngLatFactory?: LngLatFactory;
  /** Called when a conversion produces a non-finite coordinate. Defaults to a console warning. */
  onConversionFailure?: (reason: string, input: LngLatTuple) => void;
}

/**
 * Installs a `transformCameraUpdate` hook that converts the camera centre exactly once per
 * band crossing.
 *
 * Two bugs in the original implementation motivate the design here, and both are covered
 * by tests in `tests/camera.test.ts`:
 *
 * - **Edge-triggered, not level-triggered.** The original compared against a zoom frozen at
 *   `movestart`, so "started below, now above" stayed true for every remaining frame of a
 *   gesture and re-converted an already-converted centre each frame. Here the comparison is
 *   against the band seen on the previous camera update.
 * - **State initialised in the constructor**, from the live camera, so an initial `flyTo`
 *   across a boundary is converted even before any interaction.
 */
export class BandCamera {
  readonly #access: CameraHookAccess;
  readonly #bands: readonly Band[];
  readonly #lngLatFactory: LngLatFactory;
  readonly #onConversionFailure: (reason: string, input: LngLatTuple) => void;

  /** Band of the zoom observed on the previous camera update. Seeded from the live camera. */
  #lastBand: number;

  /** The host's own hook, chained rather than clobbered. */
  #previousHook: CameraUpdateFn | null;

  #installed = false;

  constructor(host: CameraHost, options: BandCameraOptions) {
    if (!host || typeof host.getZoom !== 'function') {
      throw new TypeError('BandCamera requires a map-like host exposing getZoom().');
    }
    validateBands(options.bands);

    this.#bands = [...options.bands];
    this.#lngLatFactory = options.lngLatFactory ?? defaultLngLatFactory;
    this.#onConversionFailure =
      options.onConversionFailure ??
      ((reason, input) => {
        console.warn(
          `[equal-earth] Skipped camera conversion (${reason}) for [${input[0]}, ${input[1]}]. ` +
            'The camera centre may be in the wrong coordinate space.',
        );
      });

    this.#lastBand = bandIndexForZoom(this.#bands, host.getZoom());
    this.#access = cameraHookAccess(host);

    const previous = this.#access.get();
    if (previous === undefined) {
      console.warn(
        '[equal-earth] Cannot read the existing transformCameraUpdate on this MapLibre ' +
          'version; a hook installed before the camera will be replaced, not chained.',
      );
    }
    this.#previousHook = previous ?? null;
    this.#access.set(this.handleCameraUpdate);
    this.#installed = true;
  }

  get bands(): readonly Band[] {
    return this.#bands;
  }

  /** Blend of the band the camera was in at the last update. */
  get blend(): number {
    return this.#bands[this.#lastBand]!.blend;
  }

  /**
   * The `transformCameraUpdate` implementation. Exposed for testing; MapLibre calls it
   * once per camera change, including every frame of an animation or gesture.
   */
  readonly handleCameraUpdate: CameraUpdateFn = (next) => {
    // Chain to whatever the host had installed, so we cooperate with bbox constraints,
    // map synchronisation, and anything else the application relies on.
    const upstream = this.#previousHook ? this.#previousHook(next) : {};
    const center = upstream.center ?? next.center;
    const upstreamZoom = upstream['zoom'];
    const zoom = typeof upstreamZoom === 'number' ? upstreamZoom : next.zoom;

    const previous = this.#lastBand;
    const current = bandIndexForZoom(this.#bands, zoom);
    this.#lastBand = current;

    const fromBlend = this.#bands[previous]!.blend;
    const toBlend = this.#bands[current]!.blend;

    // No crossing (or adjacent bands sharing a blend). Critically, this is the common case
    // during a gesture that has already crossed — the original code re-converted here.
    if (fromBlend === toBlend) return upstream;

    const source: LngLatTuple = [center.lng, center.lat];
    // Bring the centre into the old band's world first: a centre panned into the empty
    // space beyond the world edge has no geographic meaning, and would convert to NaN.
    const inWorld: LngLatTuple = [
      wrapLongitude(center.lng),
      clampLatitude(center.lat, mapSpaceMaxLatitude(fromBlend)),
    ];
    // One conversion straight from the old band to the new, however many bands a single
    // update skipped — chaining through each would accumulate error.
    const converted = geographicToMap(mapToGeographic(inWorld, fromBlend), toBlend);

    if (!Number.isFinite(converted[0]) || !Number.isFinite(converted[1])) {
      this.#onConversionFailure('non-finite result', source);
      return upstream;
    }

    return { ...upstream, center: this.#lngLatFactory(converted[0], converted[1]) };
  };

  /**
   * Uninstall. Restores the host's previous `transformCameraUpdate` rather than leaving
   * it null, so a map that had its own hook keeps working.
   *
   * Safe to call more than once.
   */
  destroy(): void {
    if (!this.#installed) return;
    this.#installed = false;
    // Only hand the hook back if it is still ours; if the application replaced it after we
    // installed, stomping on that would be worse than leaving it alone. When the host gives
    // no way to read the hook, restoring is the better guess.
    const current = this.#access.get();
    if (current === this.handleCameraUpdate || current === undefined) {
      this.#access.set(this.#previousHook);
    }
    this.#previousHook = null;
  }
}

/**
 * The single-switch form: Equal Earth below `switchZoom`, Mercator at or above it.
 *
 * Equivalent to a two-band {@link BandCamera}; kept because it is the simplest correct API
 * for a map that switches once.
 */
export class ThresholdCamera extends BandCamera {
  constructor(host: CameraHost, options: ThresholdCameraOptions) {
    super(host, thresholdBands(options));
  }

  get switchZoom(): number {
    return this.bands[1]!.minZoom;
  }

  /** True while the camera is below the switch zoom, i.e. rendering Equal Earth. */
  get isEqualEarthActive(): boolean {
    return this.blend < 1;
  }
}

function thresholdBands(options: ThresholdCameraOptions): BandCameraOptions {
  const { switchZoom, ...rest } = options;
  if (!Number.isFinite(switchZoom)) {
    throw new TypeError(`ThresholdCamera requires a finite switchZoom, received ${String(switchZoom)}.`);
  }
  return {
    ...rest,
    bands: [
      { minZoom: -Infinity, blend: 0 },
      { minZoom: switchZoom, blend: 1 },
    ],
  };
}

/**
 * Bring a longitude beyond ±180° back into range. ±180° itself is left alone: on Equal
 * Earth those are opposite edges of the map, not one meridian.
 */
function wrapLongitude(lng: number): number {
  if (!Number.isFinite(lng)) return lng;
  let wrapped = lng;
  while (wrapped > 180) wrapped -= 360;
  while (wrapped < -180) wrapped += 360;
  return wrapped;
}

/** Clamp to ±limit. NaN passes through, so a genuinely broken centre is still reported. */
function clampLatitude(lat: number, limit: number): number {
  return lat < -limit ? -limit : lat > limit ? limit : lat;
}
```

- [ ] **Step 6: Export from `src/index.ts`**

Replace the `./map/camera.js` export block with:

```ts
export {
  BandCamera,
  ThresholdCamera,
  type BandCameraOptions,
  type CameraHost,
  type CameraUpdate,
  type CameraUpdateFn,
  type CameraUpdateResult,
  type LngLatFactory,
  type ThresholdCameraOptions,
} from './map/camera.js';

export { bandIndexForZoom, validateBands, type Band } from './map/bands.js';
```

and add `mapSpaceMaxLatitude` and `worldYRange` to the `./math/backproject.js` export list.

- [ ] **Step 7: Run the tests and the typecheck to verify they pass**

Run: `npx vitest run tests/band-camera.test.ts tests/host-types.test.ts tests/camera.test.ts`
Expected: PASS. The existing `camera.test.ts` passes **unchanged**, because the `ThresholdCamera` API and behaviour are preserved.
Run: `npm run typecheck` — expected: PASS, with both v5 and v6 `Map` accepted.

- [ ] **Step 8: Update the README and the spec**

In `README.md`, directly after the `ThresholdCamera` code block and its paragraph, add:

````markdown
For the adaptive projection's intermediate steps, `BandCamera` takes a list of zoom bands,
each with a fixed blend between Equal Earth (0) and Mercator (1), and converts once per band
crossing:

```js
import { LngLat } from 'maplibre-gl';
import { BandCamera } from '@yellowmap/maplibre-gl-equal-earth';

const camera = new BandCamera(map, {
  bands: [
    { minZoom: 0, blend: 0 },
    { minZoom: 5, blend: 1 / 3 },
    { minZoom: 6, blend: 2 / 3 },
    { minZoom: 7, blend: 1 },
  ],
  lngLatFactory: (lng, lat) => new LngLat(lng, lat),
});
```

Both cameras work on MapLibre v5 and v6: v6 moved the hook behind `setTransformCameraUpdate()`.
````

In the spec's §2, append a new finding:

```markdown
**The camera hook moved in v6.** v6's `Map` no longer extends `Camera`; `transformCameraUpdate`
lives on a private `map._camera` and is set through `map.setTransformCameraUpdate()`, with no
public getter. Assigning `map.transformCameraUpdate` — what `ThresholdCamera` did — is a no-op
on v6. Fixed in Plan 1 via `cameraHookAccess`, pinned by a compile-time test against both
majors' `Map` types.
```

In §3's components table, change the `map/camera.ts` row to: `` `ThresholdCamera` → `BandCamera` (§4); `cameraHookAccess` bridges v5's property and v6's setter ``.

- [ ] **Step 9: Run the full verification**

Run: `npm run verify`
Expected: all steps pass, and `check-exports` reports 41 exports: the previous 36 plus `BandCamera`, `bandIndexForZoom`, `validateBands`, `mapSpaceMaxLatitude` and `worldYRange`.

- [ ] **Step 10: Commit**

```bash
git add src/map/bands.ts src/map/camera.ts src/index.ts tests/band-camera.test.ts tests/host-types.test.ts package.json package-lock.json README.md docs/superpowers/specs/2026-09-28-equal-earth-v5-v6-state-of-the-art-design.md
git diff --cached --name-only
git commit -m "Add BandCamera; install the camera hook correctly on MapLibre v6

v6 moved transformCameraUpdate behind setTransformCameraUpdate(), so the
previous property assignment silently did nothing on a real v6 map.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Per-band camera constraint

**Files:**
- Modify: `src/map/constrain.ts`
- Modify: `tests/constrain.test.ts`

**Interfaces:**
- Consumes: `Band`, `validateBands` and `bandIndexForZoom` (Task 4); `mapSpaceMaxLatitude(blend)` (Task 2).
- Produces: `EqualEarthConstrainOptions.bands?: readonly Band[]`. The default is a single Equal Earth band, which gives exactly today's behaviour.

- [ ] **Step 1: Write the failing tests**

In `tests/constrain.test.ts`, extend the backproject import to `import { MAP_SPACE_MAX_LATITUDE, mapSpaceMaxLatitude } from '../src/math/backproject.js';`, add `import type { Band } from '../src/map/bands.js';`, and append:

```ts
describe('createEqualEarthConstrain with bands', () => {
  const EQUAL: Band[] = [
    { minZoom: 0, blend: 0 },
    { minZoom: 5, blend: 1 / 3 },
    { minZoom: 6, blend: 2 / 3 },
    { minZoom: 7, blend: 1 },
  ];

  it('uses the world edge of the band the requested zoom falls in', () => {
    const constrain = createEqualEarthConstrain({ lngLatFactory, bands: EQUAL });

    expect(constrain({ lng: 0, lat: 80 }, 4).center.lat).toBeCloseTo(MAP_SPACE_MAX_LATITUDE, 9);
    expect(constrain({ lng: 0, lat: 80 }, 5.5).center.lat).toBeCloseTo(mapSpaceMaxLatitude(1 / 3), 9);
    // 80° is inside the ⅔ band's edge (≈81.5°), so it passes through untouched.
    const inside = { lng: 0, lat: 80 };
    expect(constrain(inside, 6.5).center).toBe(inside);
  });

  it('leaves the Mercator band unconstrained, starting exactly at its minZoom', () => {
    const constrain = createEqualEarthConstrain({ lngLatFactory, bands: EQUAL });
    const input = { lng: 0, lat: 84 };

    expect(constrain(input, 7).center).toBe(input);
    expect(constrain(input, 12).center).toBe(input);
  });

  it('treats a zoom exactly on a boundary as the upper band, like BandCamera', () => {
    const constrain = createEqualEarthConstrain({ lngLatFactory, bands: EQUAL });
    expect(constrain({ lng: 0, lat: 80 }, 5).center.lat).toBeCloseTo(mapSpaceMaxLatitude(1 / 3), 9);
  });

  it('rejects malformed bands when the constraint is built', () => {
    expect(() => createEqualEarthConstrain({ lngLatFactory, bands: [] })).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/constrain.test.ts`
Expected: FAIL. `bands` is ignored, so zoom 5.5 clamps at ≈65.46° and zoom 7 clamps at 84°; `bands: []` does not throw.

- [ ] **Step 3: Implement it in `src/map/constrain.ts`**

Change the imports to:

```ts
import { mapSpaceMaxLatitude } from '../math/backproject.js';
import { bandIndexForZoom, validateBands, type Band } from './bands.js';
import type { LngLatFactory } from './camera.js';
```

Add to `EqualEarthConstrainOptions`:

```ts
  /**
   * Zoom bands, for the adaptive projection. The world edge then depends on the band the
   * requested zoom falls in, and the Mercator band (blend 1) is left unconstrained.
   *
   * @defaultValue a single Equal Earth band — the world edge at ≈ ±65.46° at every zoom
   */
  bands?: readonly Band[];
```

Replace the body of `createEqualEarthConstrain` with:

```ts
  const { lngLatFactory } = options;
  const isActive = options.isActive ?? (() => true);
  const margin = options.latitudeMargin ?? 0;
  const bands = options.bands ?? [{ minZoom: 0, blend: 0 }];
  validateBands(bands);
  // Constrain runs on every camera change; the edge is a transcendental function of the
  // blend, so compute it once per band.
  const limits = bands.map((band) => mapSpaceMaxLatitude(band.blend) + margin);

  return (lngLat, zoom) => {
    if (!isActive()) {
      return { center: lngLat, zoom };
    }
    const index = bandIndexForZoom(bands, zoom);
    if (bands[index]!.blend === 1) {
      return { center: lngLat, zoom };
    }
    const limit = limits[index]!;
    const clamped = lngLat.lat < -limit ? -limit : lngLat.lat > limit ? limit : lngLat.lat;
    if (clamped === lngLat.lat) {
      return { center: lngLat, zoom };
    }
    return { center: lngLatFactory(lngLat.lng, clamped), zoom };
  };
```

In `installEqualEarthConstrain`, change the error message's `'(maplibre-gl >= 6).'` to `'(maplibre-gl >= 5.24).'`. (v5.24 has `setTransformConstrain`, verified in the tarball's type declarations.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/constrain.test.ts` — expected: PASS, including the previous cases unchanged.

- [ ] **Step 5: Run the full verification**

Run: `npm run verify`
Expected: all steps pass.

- [ ] **Step 6: Commit**

```bash
git add src/map/constrain.ts tests/constrain.test.ts
git diff --cached --name-only
git commit -m "Constrain the camera to each band's world edge

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Visual transition spike (THROWAWAY) and go/no-go gate

This task produces an **answer, not code**. The spike page is deleted at the end; only the findings document is kept. The go/no-go decision belongs to the human.

**Files:**
- Create, then delete: `demo/spike/bands.html`, `demo/spike/bands.ts`
- Create (kept): `docs/superpowers/spikes/2026-09-28-band-transition.md`

**Interfaces:**
- Consumes: `BandCamera`, `installEqualEarthConstrain` with `bands`, `encodeSourceUrl` with `blend`, `createEqualEarthProtocol`, `geographicToMap`/`mapToGeographic` with `blend`, `bandIndexForZoom`, and the built `dist/worker.mjs`.
- Produces: the findings document. Plans 2 and 3 are written from it.

What it must answer (spec §4 and §5):
1. Is any single band step clearly jarring at Tokyo, San Francisco or Anchorage? (The fail condition.)
2. Centre drift across each step: it must be ≤ 1 px. This also confirms Task 4's v6 path on a real map.
3. Off-centre drift at 300 px, which is what scroll-zoom users will see.
4. Rewritten layer count (spec estimate: ~250–300).
5. Whether the prefetch layer actually loads the next band's tiles before the crossing.
6. Fill seams at z2–4, at 1× and 2× DPR.
7. Time to first `idle`, cold and warm (a rough baseline only), and whether the worker path or the main-thread fallback was used.

- [ ] **Step 1: Build, so `dist/worker.mjs` exists**

Run: `npm run build`
Expected: `dist/worker.mjs` exists.

- [ ] **Step 2: Create the spike page**

Create `demo/spike/bands.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SPIKE — Equal Earth band transition (throwaway)</title>
    <style>
      .panel { position: absolute; top: 12px; left: 12px; z-index: 1; display: flex; flex-direction: column; gap: 6px;
        font: 12px/1.4 ui-monospace, Consolas, monospace; color: #e8eef5; }
      .panel button { font: inherit; padding: 4px 8px; background: #12202f; color: #e8eef5; border: 1px solid #3d7ea6; cursor: pointer; }
      .panel pre { margin: 0; padding: 8px; max-width: 560px; max-height: 50vh; overflow: auto; background: rgb(9 18 28 / 85%); }
    </style>
  </head>
  <body>
    <div id="map"></div>
    <div class="panel">
      <div id="cities"></div>
      <div>
        <button id="cross5" type="button">cross z5</button>
        <button id="cross6" type="button">cross z6</button>
        <button id="cross7" type="button">cross z7</button>
        <button id="world" type="button">world z2</button>
      </div>
      <pre id="readout">loading…</pre>
    </div>
    <script type="module" src="./bands.ts"></script>
  </body>
</html>
```

Create `demo/spike/bands.ts`:

```ts
/**
 * THROWAWAY SPIKE — Plan 1, Task 6. Delete once the findings are recorded.
 *
 * Hard-codes the `equal` bands onto OpenFreeMap Liberty to judge the stepped transition
 * before any production style-rewrite code exists.
 */

import { LngLat, Map as MapLibreMap, addProtocol, importScriptInWorkers } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../../style.css';

import {
  BandCamera,
  PROTOCOL_SCHEME,
  bandIndexForZoom,
  createEqualEarthProtocol,
  encodeSourceUrl,
  geographicToMap,
  installEqualEarthConstrain,
  mapToGeographic,
  type Band,
} from '../../src/index.js';

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const BANDS: Band[] = [
  { minZoom: 0, blend: 0 },
  { minZoom: 5, blend: 1 / 3 },
  { minZoom: 6, blend: 2 / 3 },
  { minZoom: 7, blend: 1 },
];
const CITIES: Record<string, [number, number]> = {
  Zürich: [8.54, 47.37],
  Tokyo: [139.69, 35.69],
  'San Francisco': [-122.42, 37.77],
  Anchorage: [-149.9, 61.22],
};
/** Screen offsets, in px from the centre, whose drift across a step is reported. */
const PROBES: [number, number][] = [
  [0, 0],
  [300, 0],
  [0, 300],
  [-300, -200],
];

interface Layer {
  id: string;
  type: string;
  source?: string;
  minzoom?: number;
  maxzoom?: number;
  [key: string]: unknown;
}
interface Style {
  sources: Record<string, Record<string, unknown>>;
  layers: Layer[];
  [key: string]: unknown;
}

const readout = document.getElementById('readout')!;
const log = (line: string): void => {
  console.log(`[spike] ${line}`);
  readout.textContent = `${line}\n${readout.textContent ?? ''}`.slice(0, 6000);
};

const bandMaxZoom = (i: number): number => BANDS[i + 1]?.minZoom ?? 24;

async function loadWorker(): Promise<string> {
  try {
    await importScriptInWorkers(new URL('/dist/worker.mjs', location.href).href);
    return 'worker (dist/worker.mjs)';
  } catch (error) {
    console.warn('[spike] worker load failed; falling back to the main thread', error);
    addProtocol(PROTOCOL_SCHEME, createEqualEarthProtocol());
    return 'MAIN-THREAD FALLBACK';
  }
}

async function bandedLiberty(): Promise<{ style: Style; before: number }> {
  const style = (await (await fetch(STYLE_URL)).json()) as Style;
  const vector = style.sources['openmaptiles']!;
  const tileJson = (await (await fetch(vector['url'] as string)).json()) as {
    tiles: string[];
    maxzoom: number;
  };
  const template = tileJson.tiles[0]!;

  const sources: Style['sources'] = { ...style.sources };
  BANDS.forEach((band, i) => {
    if (band.blend === 1) return;
    sources[`openmaptiles__b${i}`] = {
      type: 'vector',
      tiles: [encodeSourceUrl({ url: template, blend: band.blend, sourceMaxZoom: tileJson.maxzoom })],
      maxzoom: tileJson.maxzoom,
    };
  });

  const layers: Layer[] = [];
  for (const layer of style.layers) {
    const min = layer.minzoom ?? 0;
    const max = layer.maxzoom ?? 24;
    if (layer.source !== 'openmaptiles') {
      // Background stays single; raster relief cannot be warped, so Mercator band only.
      layers.push(layer.type === 'raster' ? { ...layer, minzoom: Math.max(min, 7) } : layer);
      continue;
    }
    BANDS.forEach((band, i) => {
      const lo = Math.max(min, band.minZoom);
      const hi = Math.min(max, bandMaxZoom(i));
      if (lo >= hi) return;
      layers.push(
        band.blend === 1
          ? { ...layer, minzoom: lo, maxzoom: hi }
          : { ...layer, id: `${layer.id}__b${i}`, source: `openmaptiles__b${i}`, minzoom: lo, maxzoom: hi },
      );
    });
  }
  // One invisible layer per band from one zoom early, so its tiles are loaded before the crossing.
  BANDS.forEach((band, i) => {
    if (i === 0) return;
    layers.push({
      id: `prefetch__b${i}`,
      type: 'fill',
      source: band.blend === 1 ? 'openmaptiles' : `openmaptiles__b${i}`,
      'source-layer': 'water',
      minzoom: band.minZoom - 1,
      maxzoom: band.minZoom,
      paint: { 'fill-opacity': 0 },
    });
  });

  return { style: { ...style, sources, layers }, before: style.layers.length };
}

const workerPath = await loadWorker();
const { style, before } = await bandedLiberty();
log(`worker path: ${workerPath}`);
log(`layers: ${before} → ${style.layers.length}`);

const lngLatFactory = (lng: number, lat: number) => new LngLat(lng, lat);
const started = performance.now();
const map = new MapLibreMap({
  container: 'map',
  style: style as never,
  center: geographicToMap(CITIES['Tokyo']!, 0),
  zoom: 4.6,
  renderWorldCopies: false,
});
new BandCamera(map, { bands: BANDS, lngLatFactory });
installEqualEarthConstrain(map, { bands: BANDS, lngLatFactory });
map.once('idle', () => log(`first idle after ${(performance.now() - started).toFixed(0)} ms`));

const tilesBySource = new Map<string, number>();
map.on('sourcedata', (event) => {
  if (!event.tile || !event.sourceId.startsWith('openmaptiles')) return;
  tilesBySource.set(event.sourceId, (tilesBySource.get(event.sourceId) ?? 0) + 1);
});

const blendNow = (): number => BANDS[bandIndexForZoom(BANDS, map.getZoom())]!.blend;

function crossing(boundary: number): void {
  map.jumpTo({ zoom: boundary - 1e-4 });
  const fromBlend = blendNow();
  const centre = map.project(map.getCenter());
  const anchors = PROBES.map(([dx, dy]) => {
    const screen: [number, number] = [centre.x + dx, centre.y + dy];
    const lngLat = map.unproject(screen);
    return { screen, geo: mapToGeographic([lngLat.lng, lngLat.lat], fromBlend) };
  });
  const loaded = [...tilesBySource].map(([id, n]) => `${id}:${n}`).join(' ');

  map.jumpTo({ zoom: boundary + 1e-4 });
  const toBlend = blendNow();
  const drifts = anchors.map(({ screen, geo }) => {
    const p = map.project(geographicToMap(geo, toBlend));
    return Math.hypot(p.x - screen[0], p.y - screen[1]);
  });
  log(
    `z${boundary} (${fromBlend.toFixed(2)}→${toBlend.toFixed(2)}): centre ${drifts[0]!.toFixed(2)} px; ` +
      `off-centre ${drifts.slice(1).map((d) => d.toFixed(1)).join(' / ')} px; tiles before: ${loaded}`,
  );
}

const cityButtons = document.getElementById('cities')!;
for (const [name, lngLat] of Object.entries(CITIES)) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = name;
  button.addEventListener('click', () => {
    map.jumpTo({ center: geographicToMap(lngLat, blendNow()), zoom: map.getZoom() });
    log(`→ ${name}`);
  });
  cityButtons.append(button);
}
for (const boundary of [5, 6, 7]) {
  document.getElementById(`cross${boundary}`)!.addEventListener('click', () => crossing(boundary));
}
document.getElementById('world')!.addEventListener('click', () => map.jumpTo({ center: [0, 0], zoom: 2 }));
```

Note: `map.jumpTo({ center: geographicToMap(lngLat, blendNow()) })` interprets the city in the band the camera is currently in. That is correct because the zoom does not change in that call.

- [ ] **Step 3: Check that it compiles**

Run: `npm run typecheck && npm run lint`
Expected: PASS. If the `style as never` cast or the `sourcedata` event typing needs adjusting for maplibre-gl 6.6.0's types, fix it locally in the spike; it is throwaway.

- [ ] **Step 4: Create the findings document**

Create `docs/superpowers/spikes/2026-09-28-band-transition.md`:

```markdown
# Spike: stepped Equal Earth → Mercator transition

Date: 2026-09-28 · Spec: `docs/superpowers/specs/2026-09-28-equal-earth-v5-v6-state-of-the-art-design.md` §4
Page (deleted after this spike): `demo/spike/bands.html`, MapLibre 6.6.0, OpenFreeMap Liberty.

## Setup
- Worker path: <!-- from the readout -->
- Layers: 111 → <!-- from the readout -->
- First idle: cold <!-- ms -->, warm (reload) <!-- ms -->

## Crossings (centre drift must be ≤ 1 px)

| City | z5 centre / off-centre px | z6 | z7 | Jarring? (human judgement + note) |
|---|---|---|---|---|
| Zürich | | | | |
| Tokyo | | | | |
| San Francisco | | | | |
| Anchorage | | | | |

## Prefetch
Were the next band's tiles loaded before each crossing (the `tiles before:` field)? Did any
misplaced placeholder geometry flash after a crossing?

## Seams (z2–4)
1× DPR: … 2× DPR (browser zoom 200% or a HiDPI screen): …

## Decision
- [ ] **GO** — the three steps are acceptable; write Plan 2 against the band design.
- [ ] **NO-GO** — revisit spec §4 (first fallback: six finer steps across z4–z8).

Notes for Plan 2/3 (layer count, seam mitigation needed?, prefetch works?):
```

- [ ] **Step 5: Hand the spike to the human — STOP**

Run: `npm run dev`, then open `http://localhost:5173/demo/spike/bands.html`.

Ask the human to:
1. For each city, press the city button, then **cross z5**, **cross z6** and **cross z7**. Also pinch or scroll through z4.5 → z7.5 by hand, and judge whether any single step is clearly jarring.
2. Press **world z2** and inspect fills for seams, at 100% and at 200% browser zoom.
3. Reload once for the warm idle time.
4. Paste the readout, together with their judgement, into the findings document.

Do **not** continue until the human has filled in the document and ticked GO or NO-GO.

- [ ] **Step 6: Delete the throwaway page and commit the findings**

```bash
rm -rf demo/spike   # never committed, so nothing to git rm
git add docs/superpowers/spikes/2026-09-28-band-transition.md
git diff --cached --name-only
git commit -m "Record band-transition spike findings

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Expected: the commit contains only the findings document, and `demo/spike/` no longer exists.

- [ ] **Step 7: Close Plan 1**

Run: `npm run verify` — expected: PASS.
Report to the human: the GO/NO-GO decision, and the numbers that shape Plan 2 (layer count, prefetch behaviour, whether seam mitigation is needed). If GO, the next step is writing Plan 2 (`bands.ts` projection mapping, `style-rewrite`, `controller`, `installEqualEarth` with version gate and `peerDependencies: ">=5.24 <7"`, `EqualEarthControl`, cartographic finish). If NO-GO, return to brainstorming on spec §4.
