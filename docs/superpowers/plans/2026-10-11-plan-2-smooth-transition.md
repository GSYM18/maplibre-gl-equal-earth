# Plan 2 — Smooth transition — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the stepped Equal Earth → Mercator transition as smooth as a tile-warping polyfill can be — centre pinned, scale and rotation at the centre continuous in zoom, a step shown only once its tiles are drawable, the remaining geometry change cross-faded — and deliver it end to end behind `map.setProjection({ type: 'equal' })` on the OpenFreeMap Liberty demo.

**Architecture:** The transition is a list of *bands* (zoom ranges with a fixed blend `t`), each with its own `eqearth://` source and layer copies. Which band is *shown* is runtime state (`BandSwitcher`), carried into the style through `global-state` expressions and decided inside the camera hook so the camera conversion and the style flip land in the same frame. `BandCamera` converts the centre between bands (Plan 1) and now also returns continuous zoom and bearing offsets that absorb each step's rotation and scale at the centre. A pure `rewriteStyle` produces the banded style; `EqualEarthController` owns the lifecycle per map; `installEqualEarth` polyfills `setProjection`/`getProjection` and loads the worker. Tile throughput — a hard requirement now that steps wait for tiles — gets more workers, one decode per source tile, and a direct clip instead of geojson-vt.

**Tech Stack:** TypeScript 5.9, Vite 8, Vitest 4, maplibre-gl 6.6.0 (+ 5.24.0 type alias `maplibre-gl-v5`), `@mapbox/vector-tile`, `pbf`, `vt-pbf`; `geojson-vt` becomes a devDependency used only by a comparison test.

**Spec:** `docs/superpowers/specs/2026-09-28-equal-earth-v5-v6-state-of-the-art-design.md` — read §3, §4 and §6 before starting; this plan covers the spec's delivery steps 4–8 (§9). The spike's findings are in `docs/superpowers/spikes/2026-09-28-band-transition.md`. The throwaway prototype of the gate lives untracked in `demo/spike/` (`bands.ts`, `gated-camera.ts`); implementers of Tasks 4 and 5 may read it for reference, never copy it wholesale, and never commit it.

## Global Constraints

- MapLibre support: `>= 5.24` and `6.x`. The npm proxy refuses packages published after **2026-08-31**: maplibre-gl stays `^6.6.0`, vitest `4.x`, `maplibre-gl-v5` is `npm:maplibre-gl@^5.24.0`. No new runtime dependencies.
- ESM-only package. Worker bundles stay self-contained (`dist/worker.mjs`, `dist/worker.iife.js`); `npm run check:exports` guards them.
- Client-only. `src/map/*` and `src/install.ts` type the map **structurally** and never import `maplibre-gl` at runtime (type-only imports in tests are fine).
- Band semantics (spec §3): `transition { from = 4, to = 8, steps = 6 }`, spacing `s = (to − from)/(steps − 1)`, boundaries `b_k = from + (k − 1)·s`, band `k` has blend `k/steps`, band `steps` is Mercator on the original source. Continuous blend `t(z) = clamp((z − from)/s + ½, 0, steps)/steps`. Parse range of band `k`: `[b_k − s, b_{k+1} + s)` (band 0 from −∞, the last to +∞). Global-state keys: `eqe-show-<k>` (paint) and `eqe-sym-<k>` (symbol visibility).
- Gate rules (spec §4.3): hysteresis `0.1`, dwell `300 ms`, fade `300 ms` for symbols and `250 ms` for paint; readiness is `isSourceLoaded` on **public** API only — nothing in `src/` reads `style.tileManagers`, `sourceCaches` or `_inViewTiles`.
- `npm run verify` green before every commit. Never `git add -f dist/`. Stage explicit paths; run `git diff --cached --name-only` before every commit.
- Never commit `demo/spike/**` or `docs/Screenshot*.png`.
- End every commit message with: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
- Code style: match the existing files (doc comments that explain *why*, `#private` fields, `readonly` where possible, no non-null assertions beyond what `noUncheckedIndexedAccess` forces). ESLint is type-aware; `eqeqeq` is on.

## Review Focus

1. **`map.setProjection({ type: 'equal' })` called before the style has loaded** (typical: right after `new Map`). MapLibre's `Style.setProjection` throws from `_checkLoaded()`; a reasonable app expects the plugin to activate once the style is there. Pinned in Task 7 (controller waits for `load`).
2. **A scroll zoom hovering at a band boundary** (z5.59 → 5.61 → 5.59). Expected: one switch, not a flip per wheel notch, because every flip re-parses the symbol layers. Pinned in Task 6 (hysteresis test).
3. **A band whose tiles are all missing upstream** (open ocean, 404s) must still count as ready, or the gate would hold forever over the Pacific. `isSourceLoaded` treats errored tiles as loaded; pinned in Task 6 with a host whose readiness is scripted and in Task 7's host-type test (the method exists on both majors).
4. **A `flyTo` from z2 to z10 that outruns tile production.** Expected: the held band is kept while parsed, then a forced switch to the best loaded band, never a blank frame, and Mercator at the end. Pinned in Task 6 (forced-switch test) and Task 4 (multi-band conversion with a selector).
5. **An application's own `transformCameraUpdate` that returns a bearing or zoom.** Expected: chained — the app's value is the *requested* one and our offsets add to it. Pinned in Task 4.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/map/bands.ts` | modify | + `Transition`, `ResolvedTransition`, `resolveTransition`, `continuousBlend`, `parseRange`, `bandIndexWithHysteresis`, `bandSourceId` |
| `src/math/jacobian.ts` | create | relative Jacobian of the blended warp against Mercator; `similarity`, `similarityOffsets` |
| `src/map/camera.ts` | modify | `BandCamera`: band selector, compensation, baseline offsets, `requestedZoom` |
| `src/map/style-rewrite.ts` | create | pure style rewrite: band sources, layer copies with parse ranges, global-state gating, transitions, `state` defaults |
| `src/map/switcher.ts` | create | `BandSwitcher`: ready-gated band selection, hysteresis, dwell, global-state flips, symbol fade, idle wake-up |
| `src/map/controller.ts` | create | `EqualEarthController`: activate/deactivate per map, TileJSON resolution, style apply/restore, camera + switcher + constrain lifecycle |
| `src/install.ts` | create | `installEqualEarth`: version gate, worker loading, worker count, `setProjection`/`getProjection` polyfill on `Map.prototype`, `uninstall` |
| `src/tiles/clip.ts` | create | direct clipping of warped features to the buffered output tile, in vt-pbf's feature shape |
| `src/tiles/mvt.ts` | modify | `buildTile` uses `clip.ts`; `simplifyTolerance` removed |
| `src/tiles/protocol.ts` | modify | decoded-source-tile cache shared across bands |
| `src/tiles/cache.ts` | modify | + `EntryCache<T>` (count-bounded LRU) |
| `src/index.ts` | modify | new exports |
| `tests/support/fake-maplibre.ts` | modify | bearing in the camera state; `FakeStyleHost` for the switcher/controller |
| `tests/fixtures/liberty.json` | create | OpenFreeMap Liberty style, fetched once and committed (BSD-licensed) |
| `tests/transition.test.ts`, `tests/jacobian.test.ts`, `tests/style-rewrite.test.ts`, `tests/switcher.test.ts`, `tests/controller.test.ts`, `tests/install.test.ts`, `tests/clip.test.ts` | create | per module |
| `tests/band-camera.test.ts`, `tests/host-types.test.ts`, `tests/tiles.test.ts`, `tests/protocol.test.ts` | modify | extended |
| `demo/transition.html`, `demo/transition.ts` | create | the Liberty demo of the real polyfill, with URL parameters and a readout |
| `scripts/probe-transition.mjs` | create | headless-Chrome probe: centre drift, holes, switch latency per step (local Chrome; not in `verify`) |
| `package.json` | modify | `peerDependencies` `>=5.24 <7`; `geojson-vt` → devDependencies |
| `README.md`, `CLAUDE.md` | modify | transition section; layout; planned work |

---

### Task 1: Transition band model

**Files:**
- Modify: `src/map/bands.ts`
- Create: `tests/transition.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `Band`, `validateBands`, `bandIndexForZoom` (existing).
- Produces:
  - `interface Transition { from?: number; to?: number; steps?: number }`
  - `interface ResolvedTransition { readonly from: number; readonly to: number; readonly steps: number; readonly spacing: number; readonly bands: readonly Band[] }`
  - `resolveTransition(options?: Transition): ResolvedTransition` — throws `TypeError` on `steps < 2`, non-integer `steps`, `from >= to`, non-finite values.
  - `continuousBlend(transition: ResolvedTransition, zoom: number): number`
  - `parseRange(transition: ResolvedTransition, band: number): [lo: number, hi: number]`
  - `bandIndexWithHysteresis(bands: readonly Band[], zoom: number, previous: number, hysteresis: number): number`
  - `bandSourceId(sourceId: string, bands: readonly Band[], band: number): string` → `sourceId` when `bands[band].blend === 1`, else `` `${sourceId}__b${band}` ``
  - `EQUAL_EARTH_BANDS: readonly Band[]` = `[{ minZoom: -Infinity, blend: 0 }]`

- [ ] **Step 1: Write the failing tests**

Create `tests/transition.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  EQUAL_EARTH_BANDS,
  bandIndexForZoom,
  bandIndexWithHysteresis,
  bandSourceId,
  continuousBlend,
  parseRange,
  resolveTransition,
} from '../src/map/bands.js';

describe('resolveTransition', () => {
  it('defaults to six steps over z4–z8 (spec §3)', () => {
    const t = resolveTransition();
    expect(t).toMatchObject({ from: 4, to: 8, steps: 6, spacing: 0.8 });
    expect(t.bands.map((b) => b.minZoom)).toEqual([-Infinity, 4, 4.8, 5.6, 6.4, 7.2, 8]);
    expect(t.bands.map((b) => b.blend)).toEqual([0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6, 1]);
  });

  it('reproduces the spike's three-step layout for { from: 5, to: 7, steps: 3 }', () => {
    const t = resolveTransition({ from: 5, to: 7, steps: 3 });
    expect(t.bands).toEqual([
      { minZoom: -Infinity, blend: 0 },
      { minZoom: 5, blend: 1 / 3 },
      { minZoom: 6, blend: 2 / 3 },
      { minZoom: 7, blend: 1 },
    ]);
  });

  it('rejects fewer than two steps, fractional steps, and a reversed range', () => {
    expect(() => resolveTransition({ steps: 1 })).toThrow(TypeError);
    expect(() => resolveTransition({ steps: 2.5 })).toThrow(TypeError);
    expect(() => resolveTransition({ from: 8, to: 4 })).toThrow(TypeError);
    expect(() => resolveTransition({ from: Number.NaN })).toThrow(TypeError);
  });
});

describe('continuousBlend', () => {
  const t = resolveTransition();

  it('equals each band's blend at the band's midpoint', () => {
    for (let k = 1; k < t.steps; k++) {
      const mid = t.bands[k]!.minZoom + t.spacing / 2;
      expect(continuousBlend(t, mid)).toBeCloseTo(t.bands[k]!.blend, 12);
    }
  });

  it('is 0 up to half a spacing below `from` and 1 from half a spacing above `to`', () => {
    expect(continuousBlend(t, 4 - 0.4)).toBe(0);
    expect(continuousBlend(t, 2)).toBe(0);
    expect(continuousBlend(t, 8 + 0.4)).toBe(1);
    expect(continuousBlend(t, 12)).toBe(1);
  });

  it('is continuous and monotonic across every boundary', () => {
    let previous = 0;
    for (let z = 3; z <= 9; z += 0.01) {
      const value = continuousBlend(t, z);
      expect(value).toBeGreaterThanOrEqual(previous - 1e-12);
      expect(value - previous).toBeLessThan(0.01 / (t.spacing * t.steps) + 1e-9);
      previous = value;
    }
  });
});

describe('parseRange', () => {
  const t = resolveTransition();

  it('widens each band by one spacing on both sides', () => {
    expect(parseRange(t, 0)).toEqual([-Infinity, 4 + 0.8]);
    expect(parseRange(t, 1)).toEqual([4 - 0.8, 4.8 + 0.8]);
    expect(parseRange(t, 6)).toEqual([8 - 0.8, Infinity]);
  });
});

describe('bandIndexWithHysteresis', () => {
  const { bands } = resolveTransition();

  it('switches up exactly at the boundary', () => {
    expect(bandIndexWithHysteresis(bands, 4.8, 1, 0.1)).toBe(2);
  });

  it('switches down only once the zoom is a full hysteresis below the boundary', () => {
    expect(bandIndexWithHysteresis(bands, 4.75, 2, 0.1)).toBe(2);
    expect(bandIndexWithHysteresis(bands, 4.69, 2, 0.1)).toBe(1);
  });

  it('is plain bandIndexForZoom when the zoom is more than one band away', () => {
    expect(bandIndexWithHysteresis(bands, 2, 4, 0.1)).toBe(bandIndexForZoom(bands, 2));
    expect(bandIndexWithHysteresis(bands, 9, 1, 0.1)).toBe(6);
  });
});

describe('bandSourceId', () => {
  const { bands } = resolveTransition();

  it('keeps the original id for the Mercator band and suffixes the others', () => {
    expect(bandSourceId('openmaptiles', bands, 6)).toBe('openmaptiles');
    expect(bandSourceId('openmaptiles', bands, 0)).toBe('openmaptiles__b0');
    expect(bandSourceId('openmaptiles', bands, 3)).toBe('openmaptiles__b3');
  });

  it('EQUAL_EARTH_BANDS is one band at blend 0 from -Infinity', () => {
    expect(EQUAL_EARTH_BANDS).toEqual([{ minZoom: -Infinity, blend: 0 }]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/transition.test.ts`
Expected: FAIL — `resolveTransition` is not exported.

- [ ] **Step 3: Implement**

Append to `src/map/bands.ts` (keep the existing exports untouched; replace the module header's last paragraph, which says "three steps were chosen", with a pointer to the spec §3 transition table):

```ts
/** The adaptive `equal` transition, as the user configures it (spec §3). */
export interface Transition {
  /** Zoom of the first step. @defaultValue 4 */
  from?: number;
  /** Zoom from which plain Mercator is drawn. @defaultValue 8 */
  to?: number;
  /** Number of steps, i.e. boundaries, including the one into Mercator. @defaultValue 6 */
  steps?: number;
}

export interface ResolvedTransition {
  readonly from: number;
  readonly to: number;
  readonly steps: number;
  /** Zoom between consecutive boundaries: `(to − from) / (steps − 1)`. */
  readonly spacing: number;
  /** Band 0 is Equal Earth from `−Infinity`; band `steps` is Mercator from `to`. */
  readonly bands: readonly Band[];
}

/** Pure Equal Earth at every zoom. */
export const EQUAL_EARTH_BANDS: readonly Band[] = [{ minZoom: -Infinity, blend: 0 }];

/**
 * Lay out the bands of a transition. Boundary `k` (1-based) sits at `from + (k − 1)·spacing`
 * and starts the band drawn at blend `k / steps`, so the last boundary, at `to`, starts the
 * Mercator band.
 */
export function resolveTransition(options: Transition = {}): ResolvedTransition {
  const from = options.from ?? 4;
  const to = options.to ?? 8;
  const steps = options.steps ?? 6;
  if (!Number.isFinite(from) || !Number.isFinite(to) || !(from < to)) {
    throw new TypeError(`Equal Earth transition needs finite from < to; received ${String(from)} and ${String(to)}.`);
  }
  if (!Number.isInteger(steps) || steps < 2) {
    throw new TypeError(`Equal Earth transition needs an integer steps >= 2; received ${String(steps)}.`);
  }
  const spacing = (to - from) / (steps - 1);
  const bands: Band[] = [{ minZoom: -Infinity, blend: 0 }];
  for (let k = 1; k <= steps; k++) {
    // The last boundary is `to` exactly, not `from + (steps − 1) · spacing`, which can differ
    // in the last bit and would put a zoom of exactly `to` in the wrong band.
    bands.push({ minZoom: k === steps ? to : from + (k - 1) * spacing, blend: k / steps });
  }
  validateBands(bands);
  return { from, to, steps, spacing, bands };
}

/**
 * The blend a per-vertex renderer would use at `zoom`: linear through the band midpoints,
 * 0 below `from − spacing/2`, 1 above `to + spacing/2`. The camera compensation steers the
 * rotation and scale at the centre towards this (spec §4.2).
 */
export function continuousBlend(transition: ResolvedTransition, zoom: number): number {
  const { from, spacing, steps } = transition;
  const raw = (zoom - from) / spacing + 0.5;
  return Math.min(steps, Math.max(0, raw)) / steps;
}

/**
 * Zoom range over which band `band`'s layers are parsed: the band widened by one spacing on
 * each side. A band may be shown anywhere inside it (spec §3 "parse early, show late").
 */
export function parseRange(transition: ResolvedTransition, band: number): [lo: number, hi: number] {
  const { bands, spacing } = transition;
  const lo = band === 0 ? -Infinity : bands[band]!.minZoom - spacing;
  const next = bands[band + 1];
  const hi = next === undefined ? Infinity : next.minZoom + spacing;
  return [lo, hi];
}

/**
 * `bandIndexForZoom`, except that a zoom less than `hysteresis` below the boundary of the
 * `previous` band stays in it. Crossing upward switches at the boundary; crossing back
 * switches only `hysteresis` lower, so a zoom hovering at a boundary does not flip.
 */
export function bandIndexWithHysteresis(
  bands: readonly Band[],
  zoom: number,
  previous: number,
  hysteresis: number,
): number {
  const target = bandIndexForZoom(bands, zoom);
  if (target === previous - 1 && zoom >= bands[previous]!.minZoom - hysteresis) return previous;
  return target;
}

/** Source id for band `band` of source `sourceId`: the original for Mercator, a suffix otherwise. */
export function bandSourceId(sourceId: string, bands: readonly Band[], band: number): string {
  return bands[band]!.blend === 1 ? sourceId : `${sourceId}__b${band}`;
}
```

Add to `src/index.ts`'s bands export line: `EQUAL_EARTH_BANDS, bandIndexWithHysteresis, bandSourceId, continuousBlend, parseRange, resolveTransition, type ResolvedTransition, type Transition`.

- [ ] **Step 4: Run the tests and verify**

Run: `npx vitest run tests/transition.test.ts && npm run verify`
Expected: all PASS; `check-exports` reports a count six higher than before (the new value exports).

- [ ] **Step 5: Commit**

```bash
git add src/map/bands.ts src/index.ts tests/transition.test.ts
git diff --cached --name-only
git commit -m "Add the transition band model: steps, continuous blend, parse ranges, hysteresis" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Local Jacobian and similarity offsets

**Files:**
- Create: `src/math/jacobian.ts`
- Create: `tests/jacobian.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `geographicToMapWorld(lngLat, blend): WorldTuple` from `src/math/backproject.ts` (world coordinates in [0, 1], y down; blend 1 is Web Mercator).
- Produces:
  - `type Matrix2 = [a: number, b: number, c: number, d: number]` for `[[a, b], [c, d]]` acting on column vectors `(dx, dy) = M · (dlng, dlat)`.
  - `relativeJacobian(point: LngLatTuple, blend: number): Matrix2` — `M_t = J_t · J_1⁻¹`, the local Jacobian of the blended warp **relative to Mercator**, by central finite differences with `h = 1e-4°`.
  - `similarity(m: Matrix2): { rotation: number; scale: number }` — rotation in radians `atan2(c − b, a + d)`, scale `√|ad − bc|`.
  - `type CompensationMode = 'none' | 'zoom' | 'zoom+bearing'`
  - `interface SimilarityOffsets { deltaZoom: number; deltaBearing: number }` (bearing in degrees)
  - `similarityOffsets(point: LngLatTuple, shownBlend: number, targetBlend: number, mode: CompensationMode): SimilarityOffsets` — zero for `mode === 'none'`, for `shownBlend === targetBlend`, and for a non-finite point or Jacobian. Uses the linearity `M_t = (1 − t)·M_0 + t·I` so only one Jacobian (at blend 0) is computed per call. **The sign of `deltaBearing` is fixed by Task 4's probe test, not here**: implement it as `BEARING_SIGN * degrees(θ_target − θ_shown)` with a module constant `BEARING_SIGN = 1` that Task 4 may flip to `-1`.

Background: spec §4.2. A step from `t_a` to `t_b` moves a feature at screen offset `d` by `(M_b − M_a)·d`. The camera can absorb the rotation and isotropic scale of `M` (a similarity); shear remains.

- [ ] **Step 1: Write the failing tests**

Create `tests/jacobian.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { geographicToMapWorld } from '../src/math/backproject.js';
import { relativeJacobian, similarity, similarityOffsets } from '../src/math/jacobian.js';

const ZURICH: [number, number] = [8.54, 47.37];
const SAN_FRANCISCO: [number, number] = [-122.42, 37.77];
const ANCHORAGE: [number, number] = [-149.9, 61.22];

describe('relativeJacobian', () => {
  it('is the identity at blend 1 (Mercator relative to itself)', () => {
    const [a, b, c, d] = relativeJacobian(ZURICH, 1);
    expect(a).toBeCloseTo(1, 9);
    expect(b).toBeCloseTo(0, 9);
    expect(c).toBeCloseTo(0, 9);
    expect(d).toBeCloseTo(1, 9);
  });

  it('is linear in the blend: M_t = (1 − t)·M_0 + t·I', () => {
    const m0 = relativeJacobian(SAN_FRANCISCO, 0);
    const mHalf = relativeJacobian(SAN_FRANCISCO, 0.5);
    const identity = [1, 0, 0, 1];
    for (let i = 0; i < 4; i++) {
      expect(mHalf[i]).toBeCloseTo(0.5 * m0[i]! + 0.5 * identity[i]!, 6);
    }
  });

  it('predicts the warp of a small displacement to first order', () => {
    const [a, b, c, d] = relativeJacobian(ZURICH, 0);
    // Mercator world units per degree at Zürich, for lng and lat.
    const [x0, y0] = geographicToMapWorld(ZURICH, 1);
    const [x1, y1] = geographicToMapWorld([ZURICH[0] + 0.01, ZURICH[1]], 1);
    const [x2, y2] = geographicToMapWorld([ZURICH[0], ZURICH[1] + 0.01], 1);
    const dMerc = [x1 - x0, y1 - y0, x2 - x0, y2 - y0]; // columns of J_1 · 0.01
    // Equal Earth world displacement for the same steps:
    const [ex0, ey0] = geographicToMapWorld(ZURICH, 0);
    const [ex1, ey1] = geographicToMapWorld([ZURICH[0] + 0.01, ZURICH[1]], 0);
    // M · (Mercator displacement) ≈ Equal Earth displacement for the lng step.
    expect(a * dMerc[0]! + b * dMerc[1]!).toBeCloseTo(ex1 - ex0, 7);
    expect(c * dMerc[0]! + d * dMerc[1]!).toBeCloseTo(ey1 - ey0, 7);
    void [ex0, ey0, ey1, x2, y2];
  });
});

describe('similarity', () => {
  it('reads rotation and scale off a pure similarity', () => {
    const s = 1.5, theta = 0.3;
    const m: [number, number, number, number] = [s * Math.cos(theta), -s * Math.sin(theta), s * Math.sin(theta), s * Math.cos(theta)];
    const result = similarity(m);
    expect(result.rotation).toBeCloseTo(theta, 12);
    expect(result.scale).toBeCloseTo(s, 12);
  });

  it('matches the spike's whole-transition figures (spec §4.2 table)', () => {
    const zurich = similarity(relativeJacobian(ZURICH, 0));
    const sf = similarity(relativeJacobian(SAN_FRANCISCO, 0));
    const anchorage = similarity(relativeJacobian(ANCHORAGE, 0));
    // Scale of Equal Earth relative to Mercator at the centre: 1/1.27, 1/1.09, 1/1.82.
    expect(Math.log2(1 / zurich.scale)).toBeCloseTo(0.35, 1);
    expect(Math.log2(1 / sf.scale)).toBeCloseTo(0.12, 1);
    expect(Math.log2(1 / anchorage.scale)).toBeCloseTo(0.86, 1);
    // Rotation ≈ 0 near the central meridian, ~16° at San Francisco, ~30° at Anchorage.
    expect(Math.abs((zurich.rotation * 180) / Math.PI)).toBeLessThan(2);
    expect(Math.abs((sf.rotation * 180) / Math.PI)).toBeGreaterThan(12);
    expect(Math.abs((anchorage.rotation * 180) / Math.PI)).toBeGreaterThan(25);
  });
});

describe('similarityOffsets', () => {
  it('is zero when disabled, when the blends agree, and for a non-finite point', () => {
    expect(similarityOffsets(ZURICH, 0, 0.5, 'none')).toEqual({ deltaZoom: 0, deltaBearing: 0 });
    expect(similarityOffsets(ZURICH, 0.5, 0.5, 'zoom+bearing')).toEqual({ deltaZoom: 0, deltaBearing: 0 });
    expect(similarityOffsets([Number.NaN, 0], 0, 1, 'zoom+bearing')).toEqual({ deltaZoom: 0, deltaBearing: 0 });
  });

  it('absorbs the whole scale change between Equal Earth and Mercator at Zürich', () => {
    const { deltaZoom, deltaBearing } = similarityOffsets(ZURICH, 0, 1, 'zoom+bearing');
    expect(deltaZoom).toBeCloseTo(0.35, 1);
    expect(Math.abs(deltaBearing)).toBeLessThan(2);
  });

  it('leaves the bearing alone in zoom-only mode', () => {
    const { deltaZoom, deltaBearing } = similarityOffsets(SAN_FRANCISCO, 0, 1, 'zoom');
    expect(deltaZoom).not.toBe(0);
    expect(deltaBearing).toBe(0);
  });

  it('is antisymmetric: going back cancels going forward', () => {
    const forward = similarityOffsets(SAN_FRANCISCO, 1 / 6, 3 / 6, 'zoom+bearing');
    const back = similarityOffsets(SAN_FRANCISCO, 3 / 6, 1 / 6, 'zoom+bearing');
    expect(forward.deltaZoom + back.deltaZoom).toBeCloseTo(0, 9);
    expect(forward.deltaBearing + back.deltaBearing).toBeCloseTo(0, 9);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/jacobian.test.ts`
Expected: FAIL — cannot resolve `../src/math/jacobian.js`.

- [ ] **Step 3: Implement**

Create `src/math/jacobian.ts`:

```ts
/**
 * What a band step does to the picture around the camera centre, and how much of it the
 * camera can absorb.
 *
 * With the centre pinned, a step from blend `a` to blend `b` moves a feature at screen offset
 * `d` by `(M_b − M_a) · d` to first order, where `M_t = J_t · J_1⁻¹` is the local Jacobian of
 * the blended warp relative to Mercator. That is independent of zoom (spec §4.2). `M` splits
 * into a similarity — a rotation and an isotropic scale, which the camera's bearing and zoom
 * can cancel — and a shear, which nothing but a cross-fade can soften.
 *
 * Because the world blend is linear in `t`, `M_t = (1 − t) · M_0 + t · I`: one Jacobian at
 * blend 0 describes every band at a point.
 */

import { geographicToMapWorld } from './backproject.js';
import type { LngLatTuple } from './equal-earth.js';

/** `[[a, b], [c, d]]`, acting on column vectors: `(dx, dy) = (a·u + b·v, c·u + d·v)`. */
export type Matrix2 = [a: number, b: number, c: number, d: number];

export type CompensationMode = 'none' | 'zoom' | 'zoom+bearing';

export interface SimilarityOffsets {
  /** Add to the requested zoom. */
  deltaZoom: number;
  /** Add to the requested bearing, in degrees. */
  deltaBearing: number;
}

/**
 * Sign relating the warp's rotation (in world coordinates, y down) to MapLibre's bearing.
 * Pinned by `tests/band-camera.test.ts` ("compensation reduces the probe displacement"),
 * which fails with the wrong sign; prose cannot be trusted with this.
 */
const BEARING_SIGN = 1;

const H = 1e-4;
const IDENTITY: Matrix2 = [1, 0, 0, 1];

/** Jacobian of `geographicToMapWorld(·, blend)` at `point`, by central differences. */
function worldJacobian(point: LngLatTuple, blend: number): Matrix2 {
  const [lng, lat] = point;
  const [xe, ye] = geographicToMapWorld([lng + H, lat], blend);
  const [xw, yw] = geographicToMapWorld([lng - H, lat], blend);
  const [xn, yn] = geographicToMapWorld([lng, lat + H], blend);
  const [xs, ys] = geographicToMapWorld([lng, lat - H], blend);
  return [(xe - xw) / (2 * H), (xn - xs) / (2 * H), (ye - yw) / (2 * H), (yn - ys) / (2 * H)];
}

function multiply(m: Matrix2, n: Matrix2): Matrix2 {
  return [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3]];
}

function invert(m: Matrix2): Matrix2 | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(det) || det === 0) return null;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det];
}

/** `M_t = J_t · J_1⁻¹` at `point`; the identity when the Jacobian cannot be formed. */
export function relativeJacobian(point: LngLatTuple, blend: number): Matrix2 {
  const inverseMercator = invert(worldJacobian(point, 1));
  if (!inverseMercator) return IDENTITY;
  const m = multiply(worldJacobian(point, blend), inverseMercator);
  return m.every(Number.isFinite) ? m : IDENTITY;
}

/** Rotation (radians) and isotropic scale of the similarity closest to `m`. */
export function similarity(m: Matrix2): { rotation: number; scale: number } {
  const [a, b, c, d] = m;
  return { rotation: Math.atan2(c - b, a + d), scale: Math.sqrt(Math.abs(a * d - b * c)) };
}

function blendMatrix(m0: Matrix2, t: number): Matrix2 {
  return [
    (1 - t) * m0[0] + t,
    (1 - t) * m0[1],
    (1 - t) * m0[2],
    (1 - t) * m0[3] + t,
  ];
}

const ZERO: SimilarityOffsets = { deltaZoom: 0, deltaBearing: 0 };

/**
 * Zoom and bearing offsets that make the rotation and scale at `point` look like blend
 * `targetBlend` while band `shownBlend` is drawn (spec §4.2).
 */
export function similarityOffsets(
  point: LngLatTuple,
  shownBlend: number,
  targetBlend: number,
  mode: CompensationMode,
): SimilarityOffsets {
  if (mode === 'none' || shownBlend === targetBlend) return ZERO;
  if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) return ZERO;
  const m0 = relativeJacobian(point, 0);
  const shown = similarity(blendMatrix(m0, shownBlend));
  const target = similarity(blendMatrix(m0, targetBlend));
  const deltaZoom = Math.log2(target.scale / shown.scale);
  if (!Number.isFinite(deltaZoom)) return ZERO;
  const deltaBearing =
    mode === 'zoom+bearing' ? (BEARING_SIGN * (target.rotation - shown.rotation) * 180) / Math.PI : 0;
  return { deltaZoom, deltaBearing: Number.isFinite(deltaBearing) ? deltaBearing : 0 };
}
```

Export from `src/index.ts`: `relativeJacobian, similarity, similarityOffsets, type CompensationMode, type Matrix2, type SimilarityOffsets` from `./math/jacobian.js`.

- [ ] **Step 4: Run the tests and verify**

Run: `npx vitest run tests/jacobian.test.ts && npm run verify`
Expected: PASS. If the "spike's whole-transition figures" test is off by more than the tolerance, the finite-difference step or the matrix order (`J_t · J_1⁻¹`, not `J_1⁻¹ · J_t`) is wrong — do not loosen the test.

- [ ] **Step 5: Commit**

```bash
git add src/math/jacobian.ts src/index.ts tests/jacobian.test.ts
git diff --cached --name-only
git commit -m "Add the local Jacobian of a band step and its similarity offsets" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---


### Task 3: Camera and constraint correctness (Plan 1 final-review findings I1, I2, I3)

**Files:**
- Modify: `src/map/camera.ts`
- Modify: `src/map/constrain.ts`
- Modify: `src/math/backproject.ts` (+ `mapSpaceMaxLongitude`)
- Modify: `tests/support/fake-maplibre.ts` (inertia handover; a constraint applied to `R`)
- Modify: `tests/band-camera.test.ts`, `tests/constrain.test.ts`, `tests/host-types.test.ts`, `tests/blend.test.ts`
- Modify: `CLAUDE.md` (camera section), `README.md` (constraint claim at the line that says Mercator/globe are untouched)

**Interfaces:**
- Consumes: existing `BandCamera`, `cameraHookAccess`, `createEqualEarthConstrain`, `installEqualEarthConstrain`, `mapSpaceMaxLatitude`, `geographicToMap`, `mapToGeographic`.
- Produces:
  - `CameraHost` gains `isEasing?(): boolean` (v5 `Map` has it; v6's does not — the v6 path reads it off `_camera` as today).
  - `BandCamera.baselineBand: number` getter (the band the requested state's centre is expressed in).
  - `cameraHookAccess(host).discardRequestedState()` now works on **v5 too** (`delete host._requestedCameraState` when `host.isEasing()` is false).
  - `ConstrainHost` gains `readonly transform: { defaultConstrain(lngLat: LngLatLike, zoom: number): { center: LngLatLike; zoom: number } }` — **method shorthand**, so MapLibre's `TransformConstrainFunction` (typed with its `LngLat` class) is assignable under `strictFunctionTypes`; the compile-time host test guards this.
  - `EqualEarthConstrainOptions` gains `fallback?: TransformConstrainFn` (what to compose with; `installEqualEarthConstrain` wires `(ll, z) => host.transform.defaultConstrain(ll, z)`, read lazily because `migrateProjection` swaps `host.transform`) and `baselineBand?: () => number`.
  - `mapSpaceMaxLongitude(mapLat: number, blend: number): number` in `src/math/backproject.ts`: the map-space longitude of the ±180° meridian at that map-space latitude (the Equal Earth outline is narrower than ±180° away from the equator).

Background — read `.superpowers/sdd/2026-09-28-plan-1-foundation-and-spike/final-review-report.md` sections I1, I2, I3, m10, m11, m13, m14 and the triage rows 9, 10, 16 before starting; this task implements exactly their "Minimal fix" items:

1. **I1 — inertia handover.** When a gesture ends with inertia the HandlerManager fires the gesture's `*end` events on the Map (`dragend`, `zoomend`, `rotateend`, `pitchend`, `rollend`), then calls `map.easeTo(inertialEase)` with a centre and anchor computed from the **rendered** transform, and that ease runs on the surviving requested state `R`, which is still in the **baseline** band's space: a double conversion (1.74° at Guadalajara). Fix: on each of those `*end` events, do what `#onMapMoveEnd` does — if `R` exists and no ease is running, delete it and rebase — so the inertial ease clones a fresh `R` from `T`. Listen on the **Map** (`host.on`) for all five; a Camera-fired `zoomend` at the end of an ease also bubbles to the Map, at which point `isEasing()` is already false and the deletion is harmless (the Camera's `moveend` deletes `R` anyway).
2. **I2 — compose with the default constraint.** Our `transformConstrain` *replaces* MapLibre's `defaultConstrain`, which clamps zoom to `[minZoom, maxZoom]`, enforces `maxBounds` and Mercator's world-fill clamp. Fix: inactive or blend-1 → return `fallback(lngLat, zoom)`; Equal Earth bands → `base = fallback(lngLat, zoom)` then clamp `base.center.lat` (keep `base.zoom`). Without a `fallback` (unit tests, custom hosts) behave as today.
3. **I3 — clamp against the baseline band too.** `R` carries the constraint and is clamped on every `setZoom`/`setCenter` in the **requested** zoom's band while its centre is in the **baseline** band's space; zooming out across a boundary therefore clamps every centre above ~70°N permanently. Fix: `limit = max(limits[index(zoom)], limits[baselineBand()])` when `baselineBand` is provided.
4. **m13** — in `#onMoveEnd`, do not overwrite `#previousBaseline` while the last hook frame saw `R` absent and an ease is running. **m14** — adopt the stale frame's band as the baseline only after the conversion proved finite. **Row 9** — before converting, clamp the centre's longitude to `±mapSpaceMaxLongitude(lat, fromBlend)` (a centre panned into the empty corner beyond the Equal Earth outline otherwise converts to a finite but out-of-world point). **Row 10** — a v6-shaped test that `destroy()` leaves an app-replaced hook alone. **Row 16** — constraint tests for `latitudeMargin` with bands, a non-zero first-band `minZoom`, and a negative zoom.

- [ ] **Step 1: Extend the fakes**

In `tests/support/fake-maplibre.ts`:
- `FakeCamera` gains `constrain: ((center: LngLat, zoom: number) => { center: LngLat; zoom: number }) | null = null`; `applyTo` becomes a `FakeCamera` method that, after applying the frame, runs `this.constrain` on the state when set (MapLibre's `setZoom`/`setCenter` call `constrainInternal` on `R`; dev.mjs `TransformHelper.setZoom` → `applyConstrain`). Both `applyFrame` and `jumpTo`/ease frames go through it.
- `FakeMapBase.setTransformConstrain(fn)` sets `camera.constrain` (and `transform` getter returns `{ defaultConstrain: (ll, z) => ({ center: ll, zoom: z }) }`, so the host satisfies the new `ConstrainHost`).
- `endGesture({ inertia: true })` now models the real handover (v6 dev.mjs 21995-22025): fire `zoomend` (and `dragend` when the gesture panned) on the **Map**, then return a `FakeEase` created like `easeTo()` **except** that its `R` is whatever `getTransformForUpdate()` returns at that moment and its first frame is given `center: [T.center.lng, T.center.lat]` by the caller (the test passes the rendered centre, as `handlePanInertia` does). Signature: `endGesture(options?: { inertia?: boolean }): FakeEase | undefined` — `undefined` without inertia (today's Map `moveend`). Existing callers pass no inertia or ignore the return value.

- [ ] **Step 2: Write the failing tests**

Append to `tests/band-camera.test.ts` (inside `describe.each(SHAPES)`):

```ts
  it('holds the centre through a pinch that crosses z5 and is released with inertia (I1)', () => {
    const map = mapAt(create, GUADALAJARA, 4.8);
    new BandCamera(map, { bands: EQUAL });
    for (const frame of zoomFrames(4.8, 5.2, 0.1)) map.applyFrame(frame);
    const ease = map.endGesture({ inertia: true })!;
    // The HandlerManager builds the inertial ease from the rendered transform.
    ease.frame({ center: [map.center.lng, map.center.lat], zoomDelta: 0.05 });
    expectGeographic(map, GUADALAJARA, 1e-9);
    ease.frame({ zoomDelta: 0.05 });
    ease.finish();
    expectGeographic(map, GUADALAJARA, 1e-9);
  });

  it('does not let the constraint clamp the requested state against a lower band's edge (I3)', () => {
    const SVALBARD: [number, number] = [15.6, 78.2];
    const map = mapAt(create, SVALBARD, 5.3);
    const camera = new BandCamera(map, { bands: EQUAL });
    map.setTransformConstrain(
      createEqualEarthConstrain({ lngLatFactory: (lng, lat) => ({ lng, lat }), bands: EQUAL, baselineBand: () => camera.baselineBand }),
    );
    expectHeldThrough(map, zoomFrames(5.3, 4.7, 0.1), SVALBARD);
  });

  it('brings a centre in the empty corner back onto the outline before converting (row 9)', () => {
    const map = create([179, 60], 4.9);
    new BandCamera(map, { bands: EQUAL });
    map.applyFrame({ zoomDelta: 0.2 });
    const [lng, lat] = renderedGeographic(map);
    expect(Math.abs(lng)).toBeLessThanOrEqual(180);
    expect(Math.abs(lat)).toBeLessThanOrEqual(90);
  });
```

and in the v6-only describe:

```ts
  it('leaves an app-replaced hook alone on destroy (row 10)', () => {
    const map = new FakeV6Map([0, 0], 3);
    const camera = new BandCamera(map, { bands: EQUAL });
    const replacement = () => ({});
    map.setTransformCameraUpdate(replacement);
    camera.destroy();
    expect(map._camera.transformCameraUpdate).toBe(replacement);
  });
```

Add to `tests/constrain.test.ts`:

```ts
  it('composes with the default constraint instead of replacing it (I2)', () => {
    const fallback = vi.fn((ll: { lng: number; lat: number }, zoom: number) => ({ center: { lng: ll.lng, lat: Math.min(ll.lat, 80) }, zoom: Math.min(zoom, 7) }));
    const constrain = createEqualEarthConstrain({ lngLatFactory, bands: EQUAL, fallback });
    // Mercator band: pure delegation (zoom clamped by the fallback's maxZoom).
    expect(constrain({ lng: 10, lat: 84 }, 9)).toEqual({ center: { lng: 10, lat: 80 }, zoom: 7 });
    // Equal Earth band: fallback first, then our tighter latitude clamp; the fallback's zoom survives.
    const result = constrain({ lng: 10, lat: 84 }, 3);
    expect(result.center.lat).toBeCloseTo(mapSpaceMaxLatitude(0), 9);
    expect(fallback).toHaveBeenCalledTimes(2);
  });

  it('delegates to the fallback while inactive', () => {
    const fallback = vi.fn((ll: { lng: number; lat: number }, zoom: number) => ({ center: ll, zoom: 5 }));
    const constrain = createEqualEarthConstrain({ lngLatFactory, fallback, isActive: () => false });
    expect(constrain({ lng: 0, lat: 89 }, 2)).toEqual({ center: { lng: 0, lat: 89 }, zoom: 5 });
  });

  it('installs a fallback that reads host.transform lazily', () => {
    let calls = 0;
    const host = {
      transform: { defaultConstrain: (ll: { lng: number; lat: number }, zoom: number) => { calls++; return { center: ll, zoom }; } },
      constrain: null as TransformConstrainFn | null,
      setTransformConstrain(fn: TransformConstrainFn | null) { this.constrain = fn; },
    };
    installEqualEarthConstrain(host, { lngLatFactory });
    host.constrain!({ lng: 0, lat: 0 }, 3);
    host.transform = { defaultConstrain: (ll, zoom) => { calls += 10; return { center: ll, zoom }; } };
    host.constrain!({ lng: 0, lat: 0 }, 3);
    expect(calls).toBe(11);
  });

  it('never clamps tighter than the baseline band's edge (I3)', () => {
    const constrain = createEqualEarthConstrain({ lngLatFactory, bands: EQUAL, baselineBand: () => 1 });
    const limit1 = mapSpaceMaxLatitude(1 / 3);
    expect(constrain({ lng: 0, lat: limit1 - 0.01 }, 4.9).center.lat).toBeCloseTo(limit1 - 0.01, 9);
  });

  it('adds the margin per band, and clamps at negative zoom and a non-zero first-band minZoom (row 16)', () => {
    const bands = [{ minZoom: 2, blend: 0 }, { minZoom: 5, blend: 1 }];
    const constrain = createEqualEarthConstrain({ lngLatFactory, bands, latitudeMargin: 1 });
    expect(constrain({ lng: 0, lat: 89 }, -1).center.lat).toBeCloseTo(mapSpaceMaxLatitude(0) + 1, 9);
    expect(constrain({ lng: 0, lat: 89 }, 1).center.lat).toBeCloseTo(mapSpaceMaxLatitude(0) + 1, 9);
    expect(constrain({ lng: 0, lat: 89 }, 5).center.lat).toBe(89);
  });
```

(`EQUAL` here is the three-step list already used in that file; add it if missing.) Fix the inert test at `tests/constrain.test.ts:54-64` so it asserts delegation to the fallback, not identity.

Add to `tests/blend.test.ts`:

```ts
  it('mapSpaceMaxLongitude follows the Equal Earth outline', () => {
    expect(mapSpaceMaxLongitude(0, 0)).toBeCloseTo(180, 6);
    // Half-way up, the outline is well inside ±180°, and it widens with the blend.
    const mid = mapSpaceMaxLongitude(50, 0);
    expect(mid).toBeLessThan(170);
    expect(mapSpaceMaxLongitude(50, 0.5)).toBeGreaterThan(mid);
    expect(mapSpaceMaxLongitude(50, 1)).toBeCloseTo(180, 9);
  });
```

`tests/host-types.test.ts`: nothing to add — it already asserts `[CameraHost, ConstrainHost]` for real v5 and v6 maps, so `tsc` fails if `transform.defaultConstrain` or `isEasing` are declared wrongly.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/band-camera.test.ts tests/constrain.test.ts tests/blend.test.ts`
Expected: the new tests FAIL (`endGesture` returns nothing; `fallback`/`baselineBand` are unknown; `mapSpaceMaxLongitude` missing); `npx tsc --noEmit -p .` fails until the host interfaces change.

- [ ] **Step 4: Implement**

- `src/math/backproject.ts`: 
  ```ts
  /** Map-space longitude of the ±180° meridian at map-space latitude `mapLat`: the outline's half-width. */
  export function mapSpaceMaxLongitude(mapLat: number, blend = 0): number {
    const geographicLat = mapToGeographic([0, mapLat], blend)[1];
    if (!Number.isFinite(geographicLat)) return 180;
    return Math.min(180, Math.abs(geographicToMap([180, geographicLat], blend)[0]));
  }
  ```
- `src/map/camera.ts`:
  - `CameraHost.isEasing?(): boolean`. In `cameraHookAccess`'s v5 branch implement `discardRequestedState` symmetrically to v6 (`if (internals._requestedCameraState === undefined) return false; if (typeof host.isEasing !== 'function' || host.isEasing()) return false; delete internals._requestedCameraState; return true;`) and update its comment: v5 deletes on `moveend` itself, but the gesture `*end` events fire *before* the inertial ease, when `R` must already be gone.
  - Constructor: `for (const type of GESTURE_END_EVENTS) host.on(type, this.#onGestureEnd)` with `const GESTURE_END_EVENTS = ['dragend', 'zoomend', 'rotateend', 'pitchend', 'rollend'] as const;` `#onGestureEnd = () => { if (this.#access.discardRequestedState()) this.#onMoveEnd(); }` (same body as `#onMapMoveEnd`; keep both names for the comments' sake or merge into one handler used for all six events). `destroy()` removes them.
  - `inWorld`: `[clampLongitude(wrapLongitude(center.lng), mapSpaceMaxLongitude(clampedLat, fromBlend)), clampedLat]` where `clampedLat = clampLatitude(center.lat, mapSpaceMaxLatitude(fromBlend))`.
  - m14: move `this.#baseline = current` (the stale-frame adoption) after the finiteness check; on failure leave `#baseline` as it was.
  - m13: `#lastFrameStale: boolean` set in the hook; `#onMoveEnd`: `if (!(this.#lastFrameStale && this.#isEasing())) this.#previousBaseline = this.#baseline;` where `#isEasing()` reads `host.isEasing?.() ?? access.requestOwner?.isEasing?.() ?? false` (add `isEasing` to the access object: `isEasing(): boolean | undefined`).
  - `get baselineBand(): number`.
- `src/map/constrain.ts`: `ConstrainHost` as in Interfaces; `fallback` and `baselineBand` options; `installEqualEarthConstrain` passes `fallback: (ll, z) => host.transform.defaultConstrain(ll, z)` when `host.transform?.defaultConstrain` is a function. Header comment: per-band edges, 65.54°, and the composition.
- `README.md`: the sentence claiming Mercator/globe are untouched by the constraint → "the plugin composes with MapLibre's own constraint (min/max zoom, `maxBounds`), tightening the latitude only in Equal Earth bands".
- `CLAUDE.md` camera section: add bullets **"Gesture end before inertia"** (I1, one paragraph as above) and **"Construct the camera before adding `moveend` listeners that move the map"** (m11: an app listener registered earlier runs first and would reuse a stale `R`).

- [ ] **Step 5: Run the tests and verify**

Run: `npx vitest run tests/band-camera.test.ts tests/camera.test.ts tests/constrain.test.ts tests/blend.test.ts && npm run verify`
Expected: PASS, including every pre-existing camera test.

- [ ] **Step 6: Commit**

```bash
git add src/map/camera.ts src/map/constrain.ts src/math/backproject.ts src/index.ts tests/support/fake-maplibre.ts tests/band-camera.test.ts tests/constrain.test.ts tests/blend.test.ts README.md CLAUDE.md
git diff --cached --name-only
git commit -m "Rebase the camera before an inertial ease, compose the constraint with MapLibre's, and clamp against the baseline band" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 4: `BandCamera` with a band selector and continuous compensation

**Files:**
- Modify: `src/map/camera.ts`
- Modify: `tests/support/fake-maplibre.ts` (bearing in the camera state)
- Modify: `tests/band-camera.test.ts`
- Modify: `CLAUDE.md` ("ThresholdCamera: why it looks the way it does": add the baseline-offsets paragraph)

**Interfaces:**
- Consumes: `resolveTransition`, `continuousBlend`, `bandIndexForZoom` (Task 1); `similarityOffsets`, `CompensationMode` (Task 2); existing `cameraHookAccess`, `geographicToMap`, `mapToGeographic`, `mapSpaceMaxLatitude`.
- Produces (all existing exports keep their behaviour; existing tests must pass unchanged):
  - `interface BandSelector { decide(requestedZoom: number): number; current(): number }`
  - `interface Compensation { transition: ResolvedTransition; mode: CompensationMode }`
  - `BandCameraOptions` gains `selector?: BandSelector` and `compensation?: Compensation`.
  - `CameraUpdate` gains `bearing: number`; `CameraUpdateResult` may carry `zoom` and `bearing` (it already has an index signature; make both explicit optional numbers).
  - `BandCamera.requestedZoom: number` getter — rendered zoom minus the zoom offset in effect; the switcher reads band decisions off this, not off `getZoom()`.
  - `BandCamera.shownBand: number` getter — `selector.current()` or the band of `requestedZoom`.
  - `CameraHost` gains optional `getBearing?(): number` (both majors have it; the fakes add it).

Background (spec §4.2): `R` is cloned from the rendered transform `T`, which already carries the previous offsets, so the hook must subtract the *baseline offsets* (those it last returned before the `moveend` that deleted `R`) to recover what was requested, decide the band on that, then add the new offsets. The baseline record is `{ band, offsets }` and replaces the two plain numbers; the stale-`R` branch uses the previous record exactly as before.

- [ ] **Step 1: Give the fakes a bearing**

In `tests/support/fake-maplibre.ts`: add `bearing: number` to `CameraState` (constructor sets `0`); `applyUpdatedTransform` builds `next` with `bearing: requested.bearing` and applies `result.bearing` when it is a number; `Frame` gains `bearing?: number` (absolute) and `applyTo` applies it; `FakeMapBase` gains `get bearing(): number` (from `T`) and `getBearing(): number`. Nothing else changes.

- [ ] **Step 2: Write the failing tests**

Append to `tests/band-camera.test.ts` (inside the file, after the existing describes; reuse its helpers):

```ts
import { resolveTransition, continuousBlend } from '../src/map/bands.js';
import { similarityOffsets } from '../src/math/jacobian.js';
import { geographicToMapWorld } from '../src/math/backproject.js';
import type { BandSelector } from '../src/map/camera.js';

const SIX = resolveTransition();
const ZURICH: [number, number] = [8.54, 47.37];

/** Screen position of a geographic point, MapLibre conventions: y down, `angle = −bearing`. */
function screen(map: FakeMapBase, geo: [number, number], blend: number): [number, number] {
  const scale = 512 * 2 ** map.zoom;
  const [px, py] = geographicToMapWorld(geographicToMap(geo, blend), 1);
  const [cx, cy] = geographicToMapWorld([map.center.lng, map.center.lat], 1);
  const dx = (px - cx) * scale, dy = (py - cy) * scale;
  const a = (-map.bearing * Math.PI) / 180;
  return [dx * Math.cos(a) - dy * Math.sin(a), dx * Math.sin(a) + dy * Math.cos(a)];
}

/** Geographic points 300 px from the centre in four directions, in the shown band's space. */
function probes(map: FakeMapBase, blend: number): [number, number][] {
  const scale = 512 * 2 ** map.zoom;
  const [cx, cy] = geographicToMapWorld([map.center.lng, map.center.lat], 1);
  const a = (map.bearing * Math.PI) / 180;
  return [[300, 0], [0, 300], [-300, 0], [0, -300]].map(([sx, sy]) => {
    const dx = sx * Math.cos(a) - sy * Math.sin(a), dy = sx * Math.sin(a) + sy * Math.cos(a);
    const world: [number, number] = [cx + dx / scale, cy + dy / scale];
    return mapToGeographic(mapWorldToGeographic(world, 1), blend);
  });
}

/** Largest probe displacement across the crossing from z5.59 to z5.61 (band 2 → 3). */
function crossingSnap(mode: 'none' | 'zoom+bearing', city: [number, number]): number {
  const map = new FakeV6Map(geographicToMap(city, SIX.bands[2]!.blend), 5.59);
  new BandCamera(map, { bands: SIX.bands, compensation: { transition: SIX, mode } });
  map.jumpTo({ zoom: 5.59 }); // settle the offsets of band 2 into T
  const before = probes(map, SIX.bands[2]!.blend);
  const seen = before.map((geo) => screen(map, geo, SIX.bands[2]!.blend));
  map.applyFrame({ zoomDelta: 0.02 });
  return Math.max(...before.map((geo, i) => {
    const [x, y] = screen(map, geo, SIX.bands[3]!.blend);
    // Remove the zoom step's own uniform scaling (0.02 zoom ≈ 1.4 %), which is not a snap.
    const s = 2 ** -0.02;
    return Math.hypot(x * s - seen[i]![0], y * s - seen[i]![1]);
  }));
}

describe('BandCamera compensation (spec §4.2)', () => {
  it('reduces the geometry snap at a crossing to under 60 % at San Francisco and Zürich', () => {
    for (const city of [SAN_FRANCISCO, ZURICH]) {
      const plain = crossingSnap('none', city);
      const compensated = crossingSnap('zoom+bearing', city);
      expect(plain, 'uncompensated snap must be measurable').toBeGreaterThan(5);
      expect(compensated).toBeLessThan(0.6 * plain);
    }
  });

  it('returns zero offsets outside the transition range', () => {
    const map = new FakeV6Map(geographicToMap(ANCHORAGE, 0), 3);
    new BandCamera(map, { bands: SIX.bands, compensation: { transition: SIX, mode: 'zoom+bearing' } });
    map.applyFrame({ zoomDelta: 0.3 });
    expect(map.zoom).toBeCloseTo(3.3, 12);
    expect(map.bearing).toBe(0);
    map.jumpTo({ zoom: 9 });
    expect(map.zoom).toBe(9);
    expect(map.bearing).toBe(0);
  });

  it('does not compensate twice when a new requested state is cloned from the rendered one', () => {
    const map = new FakeV6Map(geographicToMap(ZURICH, 0), 3.9);
    new BandCamera(map, { bands: SIX.bands, compensation: { transition: SIX, mode: 'zoom+bearing' } });
    // Two scroll gestures of +0.4 each, the first ending without inertia (Map moveend).
    for (const frame of zoomFrames(3.9, 4.3, 0.1)) map.applyFrame(frame);
    map.endGesture();
    for (const frame of zoomFrames(4.3, 4.7, 0.1)) map.applyFrame(frame);
    const geo = mapToGeographic([map.center.lng, map.center.lat], SIX.bands[1]!.blend);
    const expected = similarityOffsets(geo, SIX.bands[1]!.blend, continuousBlend(SIX, 4.7), 'zoom+bearing');
    expect(map.zoom).toBeCloseTo(4.7 + expected.deltaZoom, 9);
    expect(map.bearing).toBeCloseTo(expected.deltaBearing, 9);
    expect(expected.deltaZoom).not.toBe(0);
  });

  it('is continuous in zoom inside a band', () => {
    const map = new FakeV6Map(geographicToMap(SAN_FRANCISCO, SIX.bands[2]!.blend), 4.9);
    new BandCamera(map, { bands: SIX.bands, compensation: { transition: SIX, mode: 'zoom+bearing' } });
    let previous = { zoom: map.zoom, bearing: map.bearing };
    for (const frame of zoomFrames(4.9, 5.5, 0.01)) {
      map.applyFrame(frame);
      expect(Math.abs(map.zoom - previous.zoom)).toBeLessThan(0.02);
      expect(Math.abs(map.bearing - previous.bearing)).toBeLessThan(0.2);
      previous = { zoom: map.zoom, bearing: map.bearing };
    }
  });

  it('adds its offsets to a bearing returned by the host's own hook (chaining)', () => {
    const map = new FakeV6Map(geographicToMap(SAN_FRANCISCO, SIX.bands[2]!.blend), 5);
    map.setTransformCameraUpdate(() => ({ bearing: 10 }));
    new BandCamera(map, { bands: SIX.bands, compensation: { transition: SIX, mode: 'zoom+bearing' } });
    map.applyFrame({ zoomDelta: 0.1 });
    const geo = mapToGeographic([map.center.lng, map.center.lat], SIX.bands[2]!.blend);
    const expected = similarityOffsets(geo, SIX.bands[2]!.blend, continuousBlend(SIX, 5.1), 'zoom+bearing');
    expect(map.bearing).toBeCloseTo(10 + expected.deltaBearing, 9);
  });
});

describe('BandCamera with a selector (spec §4.3)', () => {
  function holdingSelector(held: number): BandSelector & { calls: number[] } {
    const calls: number[] = [];
    return { calls, decide: (zoom) => { calls.push(zoom); return held; }, current: () => held };
  }

  it('asks the selector on every frame with the requested zoom and renders the selector's band', () => {
    const selector = holdingSelector(0);
    const map = new FakeV6Map(geographicToMap(GUADALAJARA, 0), 3.9);
    new BandCamera(map, { bands: SIX.bands, selector });
    for (const frame of zoomFrames(3.9, 4.5, 0.1)) map.applyFrame(frame);
    expect(selector.calls.length).toBe(6);
    expect(selector.calls.at(-1)).toBeCloseTo(4.5, 9);
    // Band 0 is held past the z4 boundary: the centre is still band 0's map space, unconverted.
    expectAt(map, geographicToMap(GUADALAJARA, 0));
  });

  it('converts to the band the selector switches to, however many bands away', () => {
    let held = 0;
    const selector: BandSelector = { decide: () => held, current: () => held };
    const map = new FakeV6Map(geographicToMap(TOKYO, 0), 3.9);
    new BandCamera(map, { bands: SIX.bands, selector });
    map.applyFrame({ zoomDelta: 2 }); // z5.9, still held in band 0
    expectAt(map, geographicToMap(TOKYO, 0));
    held = 3; // the selector decides band 3 is ready
    map.applyFrame({ zoomDelta: 0.1 });
    expectAt(map, geographicToMap(TOKYO, SIX.bands[3]!.blend), 6);
    map.endGesture();
    // After the moveend the baseline is the selector's band: a pan stays converted.
    map.applyFrame({ panDelta: [0.1, 0] });
    const geo = mapToGeographic([map.center.lng, map.center.lat], SIX.bands[3]!.blend);
    expect(geo[1]).toBeCloseTo(TOKYO[1], 2);
  });

  it('exposes requestedZoom and shownBand for the switcher', () => {
    const selector = holdingSelector(1);
    const map = new FakeV6Map(geographicToMap(ZURICH, SIX.bands[1]!.blend), 4.2);
    const camera = new BandCamera(map, { bands: SIX.bands, selector, compensation: { transition: SIX, mode: 'zoom+bearing' } });
    map.applyFrame({ zoomDelta: 0.3 });
    expect(camera.requestedZoom).toBeCloseTo(4.5, 9);
    expect(map.zoom).not.toBeCloseTo(4.5, 3);
    expect(camera.shownBand).toBe(1);
  });
});
```

Add `mapWorldToGeographic` to the backproject import at the top of the test file.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/band-camera.test.ts`
Expected: the new describes FAIL (`compensation`/`selector` are unknown options, `bearing` stays 0); every existing test still PASSES.

- [ ] **Step 4: Implement**

In `src/map/camera.ts`:

1. Types: add `bearing: number` to `CameraUpdate`; make `CameraUpdateResult` `{ center?: …; zoom?: number; bearing?: number; [key: string]: unknown }`; add `getBearing?(): number` to `CameraHost`; add

```ts
export interface BandSelector {
  /** The band to render this frame, given the requested zoom. May switch bands. Called only from the hook. */
  decide(requestedZoom: number): number;
  /** The band rendered now; never switches. */
  current(): number;
}

export interface Compensation {
  transition: ResolvedTransition;
  mode: CompensationMode;
}
```
   and `selector?: BandSelector; compensation?: Compensation;` to `BandCameraOptions`.

2. State: replace `#baseline: number` / `#previousBaseline: number` with

```ts
interface Baseline {
  /** Band whose map space the requested camera state is in. */
  band: number;
  /** Zoom and bearing offsets already applied to the transform the state was cloned from. */
  offsets: SimilarityOffsets;
}
```
   `#baseline: Baseline`, `#previousBaseline: Baseline`, `#lastOffsets: SimilarityOffsets = ZERO_OFFSETS` (the offsets the hook last returned), `#selector`, `#compensation`.

3. The hook:

```ts
readonly handleCameraUpdate: CameraUpdateFn = (next) => {
  const upstream = this.#previousHook ? this.#previousHook(next) : {};
  const center = upstream.center ?? next.center;
  const zoomR = typeof upstream.zoom === 'number' ? upstream.zoom : next.zoom;
  const bearingR = typeof upstream.bearing === 'number' ? upstream.bearing : next.bearing;

  // See the class comment: an absent requested state means this frame renders a state a
  // `moveend` deleted while in use; it is in the space of the baseline that reset replaced.
  const stale = this.#access.hasRequestedState() === false;
  const baseline = stale ? this.#previousBaseline : this.#baseline;

  // Recover what was requested: the state was cloned from a transform that already carried
  // the baseline's offsets (spec §4.2 "baseline offsets").
  const requestedZoom = zoomR - baseline.offsets.deltaZoom;
  const requestedBearing = bearingR - baseline.offsets.deltaBearing;

  const shown = this.#selector ? this.#selector.decide(requestedZoom) : bandIndexForZoom(this.#bands, requestedZoom);
  const fromBlend = this.#bands[baseline.band]!.blend;
  const toBlend = this.#bands[shown]!.blend;

  const inWorld: LngLatTuple = [wrapLongitude(center.lng), clampLatitude(center.lat, mapSpaceMaxLatitude(fromBlend))];
  const geographic = mapToGeographic(inWorld, fromBlend);
  let converted: LngLatTuple | null = null;
  if (fromBlend !== toBlend) {
    converted = geographicToMap(geographic, toBlend);
    if (!Number.isFinite(converted[0]) || !Number.isFinite(converted[1])) {
      this.#onConversionFailure('non-finite result', [center.lng, center.lat]);
      converted = null;
    }
  }

  const offsets = this.#compensation
    ? similarityOffsets(geographic, toBlend, continuousBlend(this.#compensation.transition, requestedZoom), this.#compensation.mode)
    : ZERO_OFFSETS;
  this.#lastOffsets = offsets;
  if (stale) this.#baseline = { band: shown, offsets };

  const result: CameraUpdateResult = { ...upstream };
  if (converted) result.center = this.#lngLatFactory(converted[0], converted[1]);
  if (this.#compensation) {
    result.zoom = requestedZoom + offsets.deltaZoom;
    result.bearing = requestedBearing + offsets.deltaBearing;
  }
  return result;
};
```

   Note the conversion-failure case: when conversion fails, `converted` is null and the centre is left as upstream gave it (today's behaviour), but offsets are still applied for the shown band.

4. `#onMoveEnd`: `this.#previousBaseline = this.#baseline; this.#baseline = { band: this.shownBand, offsets: this.#lastOffsets };` where

```ts
get requestedZoom(): number { return this.#host.getZoom() - this.#lastOffsets.deltaZoom; }
get shownBand(): number { return this.#selector ? this.#selector.current() : bandIndexForZoom(this.#bands, this.requestedZoom); }
```
   and the constructor seeds `#baseline = { band: this.#selector ? this.#selector.current() : bandIndexForZoom(bands, host.getZoom()), offsets: ZERO_OFFSETS }`. The `blend` getter returns `this.#bands[this.shownBand]!.blend`.

5. If the test "reduces the geometry snap" fails with the compensated value *larger* than the plain one, flip `BEARING_SIGN` in `src/math/jacobian.ts` to `-1` and re-run; adjust the jacobian tests' sign expectations only where they assert a sign (they assert magnitudes). Record which sign won in the jacobian.ts comment.

6. CLAUDE.md: in "ThresholdCamera: why it looks the way it does" add one bullet after "Convert relative to a baseline band": **Baseline offsets.** The hook also returns continuous zoom and bearing offsets (spec §4.2) and `R` is cloned from the rendered `T`, which carries them, so the baseline records the offsets in effect when `R` was created and the hook subtracts them before deciding the band and converting. A *selector* (the switcher, spec §4.3) may pick the band instead of the zoom.

- [ ] **Step 5: Run the tests and verify**

Run: `npx vitest run tests/band-camera.test.ts tests/camera.test.ts && npm run verify`
Expected: all PASS (existing camera tests unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/map/camera.ts src/math/jacobian.ts tests/support/fake-maplibre.ts tests/band-camera.test.ts CLAUDE.md
git diff --cached --name-only
git commit -m "Let BandCamera take a band selector and absorb each step's rotation and scale continuously" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Pure style rewrite

**Files:**
- Create: `src/map/style-rewrite.ts`
- Create: `tests/fixtures/liberty.json`
- Create: `tests/style-rewrite.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `Band`, `ResolvedTransition`, `parseRange`, `bandSourceId`, `bandIndexForZoom` (Task 1); `encodeSourceUrl({ url, blend, sourceMaxZoom })` from `src/tiles/protocol.ts`.
- Produces:
  - `interface StyleLayerLike { id: string; type: string; source?: string; 'source-layer'?: string; minzoom?: number; maxzoom?: number; layout?: Record<string, unknown>; paint?: Record<string, unknown>; [key: string]: unknown }`
  - `interface StyleLike { version: number; sources: Record<string, Record<string, unknown>>; layers: StyleLayerLike[]; state?: Record<string, { default: unknown }>; metadata?: Record<string, unknown>; [key: string]: unknown }`
  - `interface SourceTemplate { tiles: string[]; maxzoom?: number }` — the resolved TileJSON of a vector source (the controller fetches `url` sources; `tiles` sources are used as they are).
  - `interface RewriteOptions { bands: readonly Band[]; transition: ResolvedTransition | null; templates: Record<string, SourceTemplate>; initialZoom: number; fadeMs?: number /* 250 */; symbolFadeMs?: number /* 300 */ }`
  - `interface RewrittenStyle { style: StyleLike; bandedSources: string[]; sourceIdsForBand(band: number): string[] }`
  - `rewriteStyle(original: StyleLike, options: RewriteOptions): RewrittenStyle` — pure; never mutates `original`.
  - `showKey(band: number): string` → `` `eqe-show-${band}` ``; `symKey(band: number): string` → `` `eqe-sym-${band}` ``
  - `REWRITTEN_METADATA_KEY = 'equal-earth:rewritten'`
  - `gateByState(value: unknown, key: string): unknown` (exported for tests)

Rules (spec §3 "parse early, show late"; a copy of each rule is in the code comments):
1. Banded sources = every key of `options.templates` that is a `type: 'vector'` source in `original.sources`. For each band `k` with `blend < 1` add source `bandSourceId(id, bands, k)`: `{ type: 'vector', tiles: [encodeSourceUrl({ url: template.tiles[0], blend, sourceMaxZoom: template.maxzoom })], maxzoom: template.maxzoom }` (`sourceMaxZoom` omitted when the template has no `maxzoom`). The original source stays.
2. For each layer of a banded source, for each band `k`: the copy's zoom range is the band's parse range (`transition ? parseRange(transition, k) : [-Infinity, Infinity]`) intersected with the layer's own `[minzoom ?? 0, maxzoom ?? 24]`; skip the band when the intersection is empty. Infinite bounds are written as the layer's own bound (or omitted). Band `steps` (blend 1) keeps the layer's **id and source** (it is the original layer, re-ranged and gated); other bands get id `` `${layer.id}__b${k}` `` and the band source. Copies are emitted in band order at the original layer's position, so the relative order of layers is preserved within each band and bands interleave per layer.
3. Gating: `fill` → `fill-opacity`, `line` → `line-opacity`, `fill-extrusion` → `fill-extrusion-opacity`, `circle` → `circle-opacity` and `circle-stroke-opacity`, `heatmap` → `heatmap-opacity`, `symbol` → `text-opacity` and `icon-opacity` **plus** `layout.visibility = ["case", ["global-state", symKey(k)], "visible", "none"]` (a layer whose own visibility is `"none"` stays `"none"`), `raster` and `hillshade` → see rule 5, `background` → untouched (rule 6). Each gated paint property gets `gateByState(paint[prop], showKey(k))` and, unless the layer already declares `${prop}-transition`, `{ duration: fadeMs (symbols: symbolFadeMs), delay: 0 }`.
4. `gateByState(value, key)`: `undefined` → `["case", ["global-state", key], 1, 0]`; a `["interpolate", …, ["zoom"], z1, v1, …]` or `["step", ["zoom"], v0, z1, v1, …]` expression → the same expression with every output `v` wrapped as `["case", ["global-state", key], v, 0]` (zoom must stay at the top level); a legacy `{ stops, base?, type? }` function → converted to `interpolate`/`step` first (`type: 'interval'` → `step`, otherwise `["exponential", base ?? 1]`), categorical legacy functions are left as they are; any other value (constant, data expression) → `["case", ["global-state", key], value, 0]`.
5. `raster` and `hillshade` layers (any source): kept once, with `minzoom = max(own, parseRange(transition, steps)[0])` and `raster-opacity` / `hillshade-exaggeration` gated by `showKey(steps)`; with `transition === null` (pure Equal Earth) they are removed and their ids listed in `RewrittenStyle.removedLayers: string[]` (add that field). Layers of non-banded sources (GeoJSON, images, other vector sources) are untouched.
6. `background` untouched.
7. `state`: `{ ...original.state }` plus, for every band `k`, `showKey(k): { default: k === initial }` and `symKey(k): { default: k === initial }` where `initial = bandIndexForZoom(bands, options.initialZoom)`.
8. `metadata[REWRITTEN_METADATA_KEY] = { bands: bands.map(b => b.blend), sources: bandedSources }`.
9. `sourceIdsForBand(k)` returns `bandedSources.map(id => bandSourceId(id, bands, k))`.

- [ ] **Step 1: Commit the Liberty fixture**

Run: `curl -sS https://tiles.openfreemap.org/styles/liberty -o tests/fixtures/liberty.json` and check it has 111 layers (`node -e "console.log(require('./tests/fixtures/liberty.json').layers.length)"` → `111`). The style is BSD-3 licensed (OpenFreeMap / Liberty); add a one-line `tests/fixtures/README.md` saying where it came from, when, and its licence.

- [ ] **Step 2: Write the failing tests**

Create `tests/style-rewrite.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { resolveTransition } from '../src/map/bands.js';
import {
  REWRITTEN_METADATA_KEY,
  gateByState,
  rewriteStyle,
  showKey,
  symKey,
  type StyleLike,
} from '../src/map/style-rewrite.js';
import { parseTileUrl } from '../src/tiles/protocol.js';

const liberty = (): StyleLike =>
  JSON.parse(readFileSync(new URL('./fixtures/liberty.json', import.meta.url), 'utf8')) as StyleLike;
const TEMPLATES = { openmaptiles: { tiles: ['https://tiles.example/planet/{z}/{x}/{y}.pbf'], maxzoom: 14 } };
const SIX = resolveTransition();

function rewrite(style = liberty(), transition = SIX, initialZoom = 4.6) {
  return rewriteStyle(style, { bands: transition.bands, transition, templates: TEMPLATES, initialZoom });
}

describe('rewriteStyle', () => {
  it('does not mutate the original', () => {
    const style = liberty();
    const snapshot = JSON.stringify(style);
    rewrite(style);
    expect(JSON.stringify(style)).toBe(snapshot);
  });

  it('adds one eqearth source per non-Mercator band and keeps the original', () => {
    const { style, bandedSources, sourceIdsForBand } = rewrite();
    expect(bandedSources).toEqual(['openmaptiles']);
    for (let k = 0; k < 6; k++) {
      const source = style.sources[`openmaptiles__b${k}`]!;
      expect(source['type']).toBe('vector');
      const { config } = parseTileUrl((source['tiles'] as string[])[0]!.replace('{z}/{x}/{y}', '3/4/2'));
      expect(config.blend).toBeCloseTo(k / 6, 12);
      expect(config.sourceMaxZoom).toBe(14);
      expect(config.url).toBe(TEMPLATES.openmaptiles.tiles[0]);
    }
    expect(style.sources['openmaptiles']).toEqual(liberty().sources['openmaptiles']);
    expect(style.sources['openmaptiles__b6']).toBeUndefined();
    expect(sourceIdsForBand(6)).toEqual(['openmaptiles']);
    expect(sourceIdsForBand(2)).toEqual(['openmaptiles__b2']);
  });

  it('gives every copy its band's parse range, clipped to the layer's own', () => {
    const { style } = rewrite();
    const water = style.layers.filter((l) => l.id === 'water' || l.id.startsWith('water__b'));
    expect(water.map((l) => l.id)).toEqual(['water__b0', 'water__b1', 'water__b2', 'water__b3', 'water__b4', 'water__b5', 'water']);
    expect(water[0]!.minzoom).toBeUndefined(); // -Infinity → the layer's own (none)
    expect(water[0]!.maxzoom).toBeCloseTo(4.8, 12);
    expect(water[1]!.minzoom).toBeCloseTo(3.2, 12);
    expect(water[1]!.maxzoom).toBeCloseTo(5.6, 12);
    expect(water[6]!.minzoom).toBeCloseTo(7.2, 12);
    expect(water[6]!.source).toBe('openmaptiles');
  });

  it('skips bands a layer's own zoom range never reaches', () => {
    const { style } = rewrite();
    // Liberty's building layer starts at z13: only the Mercator band keeps it.
    const building = style.layers.filter((l) => l.id === 'building' || l.id.startsWith('building__b'));
    expect(building.map((l) => l.id)).toEqual(['building']);
    expect(building[0]!.minzoom).toBe(13);
  });

  it('gates paint by global state and adds a transition', () => {
    const { style } = rewrite();
    const copy = style.layers.find((l) => l.id === 'water__b2')!;
    expect(copy.paint!['fill-opacity']).toEqual(['case', ['global-state', showKey(2)], 1, 0]);
    expect(copy.paint!['fill-opacity-transition']).toEqual({ duration: 250, delay: 0 });
    const line = style.layers.find((l) => l.type === 'line' && l.id.endsWith('__b2'))!;
    expect(JSON.stringify(line.paint!['line-opacity'])).toContain(`["global-state","${showKey(2)}"]`);
  });

  it('hides symbol copies through a visibility expression and fades their opacity', () => {
    const { style } = rewrite();
    const symbol = style.layers.find((l) => l.type === 'symbol' && l.id.endsWith('__b3'))!;
    expect(symbol.layout!['visibility']).toEqual(['case', ['global-state', symKey(3)], 'visible', 'none']);
    expect(JSON.stringify(symbol.paint!['text-opacity'])).toContain(showKey(3));
    expect(symbol.paint!['text-opacity-transition']).toEqual({ duration: 300, delay: 0 });
  });

  it('keeps raster relief only from the Mercator band's parse range, gated', () => {
    const { style } = rewrite();
    const raster = style.layers.filter((l) => l.type === 'raster');
    expect(raster).toHaveLength(1);
    expect(raster[0]!.minzoom).toBeCloseTo(7.2, 12);
    expect(JSON.stringify(raster[0]!.paint!['raster-opacity'])).toContain(showKey(6));
  });

  it('declares state defaults for the initial zoom's band only', () => {
    const { style } = rewrite(liberty(), SIX, 5.0); // band 2
    for (let k = 0; k <= 6; k++) {
      expect(style.state![showKey(k)]).toEqual({ default: k === 2 });
      expect(style.state![symKey(k)]).toEqual({ default: k === 2 });
    }
    expect(style.metadata![REWRITTEN_METADATA_KEY]).toEqual({ bands: SIX.bands.map((b) => b.blend), sources: ['openmaptiles'] });
  });

  it('leaves background and non-banded sources alone', () => {
    const { style } = rewrite();
    expect(style.layers[0]).toEqual(liberty().layers[0]);
    expect(style.layers[0]!.type).toBe('background');
  });

  it('pure Equal Earth: one band, no transition, raster removed', () => {
    const bands = [{ minZoom: -Infinity, blend: 0 }];
    const { style, removedLayers } = rewriteStyle(liberty(), { bands, transition: null, templates: TEMPLATES, initialZoom: 2 });
    expect(style.layers.some((l) => l.type === 'raster')).toBe(false);
    expect(removedLayers).toEqual(['ne2_shaded']);
    expect(style.layers.filter((l) => l.id.startsWith('water')).map((l) => l.id)).toEqual(['water__b0']);
    expect(style.sources['openmaptiles__b0']).toBeDefined();
  });

  it('matches the committed snapshot (layer ids, ranges and sources)', () => {
    const { style } = rewrite();
    const summary = style.layers.map((l) => `${l.id} ${l.source ?? '-'} [${l.minzoom ?? ''},${l.maxzoom ?? ''})`).join('\n');
    expect(summary).toMatchFileSnapshot('./__snapshots__/liberty-six-steps.txt');
  });
});

describe('gateByState', () => {
  const KEY = showKey(1);
  const on = (v: unknown) => ['case', ['global-state', KEY], v, 0];

  it('wraps constants and undefined', () => {
    expect(gateByState(undefined, KEY)).toEqual(on(1));
    expect(gateByState(0.6, KEY)).toEqual(on(0.6));
  });

  it('keeps zoom at the top level of interpolate and step', () => {
    expect(gateByState(['interpolate', ['linear'], ['zoom'], 5, 0.2, 10, 1], KEY)).toEqual(['interpolate', ['linear'], ['zoom'], 5, on(0.2), 10, on(1)]);
    expect(gateByState(['step', ['zoom'], 0.1, 8, 0.9], KEY)).toEqual(['step', ['zoom'], on(0.1), 8, on(0.9)]);
  });

  it('converts legacy stop functions', () => {
    expect(gateByState({ stops: [[5, 0.2], [10, 1]] }, KEY)).toEqual(['interpolate', ['exponential', 1], ['zoom'], 5, on(0.2), 10, on(1)]);
    expect(gateByState({ stops: [[5, 0.2], [10, 1]], base: 1.5 }, KEY)).toEqual(['interpolate', ['exponential', 1.5], ['zoom'], 5, on(0.2), 10, on(1)]);
    expect(gateByState({ type: 'interval', stops: [[5, 0.2], [10, 1]] }, KEY)).toEqual(['step', ['zoom'], on(0.2), 10, on(1)]);
  });

  it('wraps data expressions whole', () => {
    expect(gateByState(['get', 'opacity'], KEY)).toEqual(on(['get', 'opacity']));
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/style-rewrite.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement**

Create `src/map/style-rewrite.ts` following the rules above. Skeleton with the non-obvious parts written out:

```ts
/**
 * Rewrite a style into its banded form (spec §3).
 *
 * Pure: a function of the original style, the bands and the resolved tile templates. The
 * controller applies the result with `setStyle(…, { diff: true })` and restores the original.
 *
 * Two facts drive the shape of the output. MapLibre draws placeholder tiles from other zooms
 * of the *same* source only, so every band needs its own source. And the worker parses a
 * layer into a tile only when `floor(minzoom) <= z < maxzoom`, so a copy's zoom range is the
 * range over which it is *parsed* (the band widened by one spacing), and whether it is *shown*
 * is global state flipped at runtime by the switcher (`eqe-show-<k>` for paint, `eqe-sym-<k>`
 * for symbol visibility — transparent labels would still collide, so they must really hide).
 */

import { bandIndexForZoom, bandSourceId, parseRange, type Band, type ResolvedTransition } from './bands.js';
import { encodeSourceUrl } from '../tiles/protocol.js';

// … interfaces from the task's Interfaces block …

export const REWRITTEN_METADATA_KEY = 'equal-earth:rewritten';
export const showKey = (band: number): string => `eqe-show-${band}`;
export const symKey = (band: number): string => `eqe-sym-${band}`;

/** Paint properties that hide a layer at 0, per layer type. */
const OPACITY: Record<string, readonly string[]> = {
  fill: ['fill-opacity'],
  line: ['line-opacity'],
  'fill-extrusion': ['fill-extrusion-opacity'],
  circle: ['circle-opacity', 'circle-stroke-opacity'],
  heatmap: ['heatmap-opacity'],
  symbol: ['text-opacity', 'icon-opacity'],
  raster: ['raster-opacity'],
  hillshade: ['hillshade-exaggeration'],
};

type Stop = [number, unknown];
const isZoomCurve = (value: unknown, head: string, zoomAt: number): value is unknown[] =>
  Array.isArray(value) && value[0] === head && JSON.stringify(value[zoomAt]) === '["zoom"]';

export function gateByState(value: unknown, key: string): unknown {
  const on = (v: unknown): unknown => ['case', ['global-state', key], v, 0];
  if (value === undefined) return on(1);
  if (isZoomCurve(value, 'interpolate', 2)) return value.map((v, i) => (i >= 4 && i % 2 === 0 ? on(v) : v));
  if (isZoomCurve(value, 'step', 1)) return value.map((v, i) => (i >= 2 && i % 2 === 0 ? on(v) : v));
  if (value && typeof value === 'object' && !Array.isArray(value) && 'stops' in value) {
    const legacy = value as { stops: Stop[]; base?: number; type?: string };
    if (legacy.type && legacy.type !== 'exponential' && legacy.type !== 'interval') return value;
    if (legacy.type === 'interval') {
      const [first, ...rest] = legacy.stops;
      return ['step', ['zoom'], on(first![1]), ...rest.flatMap(([z, v]) => [z, on(v)])];
    }
    return ['interpolate', ['exponential', legacy.base ?? 1], ['zoom'], ...legacy.stops.flatMap(([z, v]) => [z, on(v)])];
  }
  return on(value);
}
```

   The layer loop: for each original layer, if `OPACITY[layer.type]` is undefined or the layer's source is not banded and the type is not raster/hillshade → push as-is. Raster/hillshade → rule 5. Banded → for `k` in `0 … bands.length − 1`: compute `[lo, hi]` = parse range ∩ own range; `if (lo >= hi) continue`; build the copy (`structuredClone` the layer, then set `id`, `source`, `minzoom` (omit when `lo === -Infinity` and the layer had none; else `max(lo, own)`), `maxzoom` likewise), gate paint, and for symbols set the visibility expression unless `layout.visibility === 'none'`. Zoom bounds: write finite numbers only.

   Export from `src/index.ts`: `rewriteStyle, gateByState, showKey, symKey, REWRITTEN_METADATA_KEY, type RewriteOptions, type RewrittenStyle, type SourceTemplate, type StyleLayerLike, type StyleLike`.

- [ ] **Step 5: Run the tests, create the snapshot, verify**

Run: `npx vitest run tests/style-rewrite.test.ts` (the first run writes `tests/__snapshots__/liberty-six-steps.txt`; read it once and check that the band copies interleave per layer and that `building` appears once), then `npm run verify`.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/map/style-rewrite.ts src/index.ts tests/style-rewrite.test.ts tests/fixtures/liberty.json tests/fixtures/README.md tests/__snapshots__/liberty-six-steps.txt
git diff --cached --name-only
git commit -m "Add the pure style rewrite: band sources, parse ranges and global-state gating" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `BandSwitcher` — switch only when the next step is ready

**Files:**
- Create: `src/map/switcher.ts`
- Create: `tests/switcher.test.ts`
- Modify: `tests/support/fake-maplibre.ts` (`FakeSwitcherHost`)
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `BandSelector` (Task 4); `bandIndexWithHysteresis`, `parseRange`, `ResolvedTransition`, `Band` (Task 1); `showKey`, `symKey` (Task 5).
- Produces:
  - `interface SwitcherHost { isSourceLoaded(id: string): boolean | undefined; setGlobalStateProperty(name: string, value: unknown): unknown; isMoving(): boolean; jumpTo(options: Record<string, never>): unknown; on(type: 'sourcedata' | 'idle', listener: () => void): unknown; off(type: 'sourcedata' | 'idle', listener: () => void): unknown }`
  - `interface SwitcherOptions { bands: readonly Band[]; transition: ResolvedTransition | null; sourceIdsForBand(band: number): string[]; initialBand: number; requestedZoom(): number; hysteresis?: number /* 0.1 */; dwellMs?: number /* 300 */; symbolFadeMs?: number /* 300 */; now?: () => number /* performance.now */; schedule?: (fn: () => void, ms: number) => () => void /* setTimeout, returns cancel */; onSwitch?: (event: SwitchEvent) => void }`
  - `interface SwitchEvent { from: number; to: number; requestedZoom: number; target: number; forced: boolean; waitedMs: number }`
  - `class BandSwitcher implements BandSelector { constructor(host: SwitcherHost, options: SwitcherOptions); decide(requestedZoom: number): number; current(): number; start(): void; destroy(): void }`
  - `chooseBand(input: { bands; transition; shown; requestedZoom; hysteresis; isReady(band): boolean }): { band: number; forced: boolean }` — exported pure core of the rules, for tests.

Rules are spec §4.3 1–6 verbatim. `isReady(k)` = every id in `sourceIdsForBand(k)` has `host.isSourceLoaded(id) === true`. `start()` subscribes to `sourcedata` and `idle`: when `!host.isMoving()` and `chooseBand(...)` would change the band, call `host.jumpTo({})` once (one pending wake at a time; a flag cleared in `decide`). `decide` is the only place that flips state; it runs the fade sequence: `setGlobalStateProperty(showKey(old), false)`, `setGlobalStateProperty(showKey(new), true)`, `setGlobalStateProperty(symKey(new), true)`, then `schedule(() => setGlobalStateProperty(symKey(old), false), symbolFadeMs)` (cancelling any pending hide of a band that is being shown again). Dwell: a non-forced switch is refused while `now() − lastSwitchAt < dwellMs` (the band is held). `destroy()` unsubscribes and cancels pending timers.

- [ ] **Step 1: Add a fake host**

Append to `tests/support/fake-maplibre.ts`:

```ts
/** A host for the switcher: scripted readiness, recorded state flips and wake-ups. */
export class FakeSwitcherHost {
  readonly loaded = new Set<string>();
  readonly state: Record<string, unknown> = {};
  readonly flips: [string, unknown][] = [];
  jumps = 0;
  moving = false;
  readonly #listeners = new Map<string, (() => void)[]>();

  isSourceLoaded(id: string): boolean { return this.loaded.has(id); }
  setGlobalStateProperty(name: string, value: unknown): void { this.state[name] = value; this.flips.push([name, value]); }
  isMoving(): boolean { return this.moving; }
  jumpTo(): void { this.jumps++; }
  on(type: string, listener: () => void): void { this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]); }
  off(type: string, listener: () => void): void { this.#listeners.set(type, (this.#listeners.get(type) ?? []).filter((l) => l !== listener)); }
  fire(type: string): void { for (const l of this.#listeners.get(type) ?? []) l(); }
  listenerCount(type: string): number { return (this.#listeners.get(type) ?? []).length; }
}
```

- [ ] **Step 2: Write the failing tests**

Create `tests/switcher.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { resolveTransition } from '../src/map/bands.js';
import { showKey, symKey } from '../src/map/style-rewrite.js';
import { BandSwitcher, chooseBand, type SwitchEvent } from '../src/map/switcher.js';
import { FakeSwitcherHost } from './support/fake-maplibre.js';

const SIX = resolveTransition();
const idsFor = (band: number) => [band === 6 ? 'openmaptiles' : `openmaptiles__b${band}`];

/** Manual clock and timer queue so the dwell and fade are deterministic. */
function clock() {
  let now = 0;
  const timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
  return {
    now: () => now,
    schedule: (fn: () => void, ms: number) => { const t = { at: now + ms, fn, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; },
    advance(ms: number) { now += ms; for (const t of timers.splice(0)) { if (!t.cancelled && t.at <= now) t.fn(); else if (!t.cancelled) timers.push(t); } },
  };
}

function setup(initialBand = 1, zoom = 4.4) {
  const host = new FakeSwitcherHost();
  const c = clock();
  const events: SwitchEvent[] = [];
  let requested = zoom;
  const switcher = new BandSwitcher(host, {
    bands: SIX.bands, transition: SIX, sourceIdsForBand: idsFor, initialBand,
    requestedZoom: () => requested, now: c.now, schedule: c.schedule, onSwitch: (e) => events.push(e),
  });
  switcher.start();
  return { host, c, events, switcher, zoomTo: (z: number) => { requested = z; return switcher.decide(z); } };
}

describe('chooseBand (spec §4.3 rules)', () => {
  const base = { bands: SIX.bands, transition: SIX, hysteresis: 0.1 };

  it('stays when the zoom's band is the shown band', () => {
    expect(chooseBand({ ...base, shown: 2, requestedZoom: 5.0, isReady: () => true })).toEqual({ band: 2, forced: false });
  });

  it('moves to the zoom's band when it is ready', () => {
    expect(chooseBand({ ...base, shown: 2, requestedZoom: 5.7, isReady: (k) => k === 3 })).toEqual({ band: 3, forced: false });
  });

  it('holds when the next band is not ready and the shown band is still parsed', () => {
    expect(chooseBand({ ...base, shown: 2, requestedZoom: 5.7, isReady: () => false })).toEqual({ band: 2, forced: false });
  });

  it('takes the nearest ready band towards the target when several are crossed at once', () => {
    // z7.0 is band 5; band 5 not ready, band 4 is, shown is 2 (parsed up to 5.6 + 0.8 = 6.4 → not parsed at 7.0).
    expect(chooseBand({ ...base, shown: 2, requestedZoom: 7.0, isReady: (k) => k === 4 })).toEqual({ band: 4, forced: true });
  });

  it('forces the target when nothing is ready and the shown band is no longer parsed', () => {
    expect(chooseBand({ ...base, shown: 2, requestedZoom: 7.0, isReady: () => false })).toEqual({ band: 5, forced: true });
  });

  it('never picks a band that is not parsed at the zoom', () => {
    // z7.0: band 1 is parsed only up to 4.8 + 0.8 = 5.6.
    expect(chooseBand({ ...base, shown: 2, requestedZoom: 7.0, isReady: (k) => k === 1 })).toEqual({ band: 5, forced: true });
  });

  it('applies hysteresis when zooming back down', () => {
    expect(chooseBand({ ...base, shown: 3, requestedZoom: 5.55, isReady: () => true })).toEqual({ band: 3, forced: false });
    expect(chooseBand({ ...base, shown: 3, requestedZoom: 5.45, isReady: () => true })).toEqual({ band: 2, forced: false });
  });

  it('pure Equal Earth (no transition) always returns band 0', () => {
    expect(chooseBand({ bands: [{ minZoom: -Infinity, blend: 0 }], transition: null, hysteresis: 0.1, shown: 0, requestedZoom: 12, isReady: () => false })).toEqual({ band: 0, forced: false });
  });
});

describe('BandSwitcher', () => {
  it('flips paint state at once and hides the old band's symbols after one fade', () => {
    const { host, c, zoomTo, events } = setup(1, 4.4);
    host.loaded.add('openmaptiles__b2');
    expect(zoomTo(4.9)).toBe(2);
    expect(host.flips).toEqual([[showKey(1), false], [showKey(2), true], [symKey(2), true]]);
    c.advance(299);
    expect(host.state[symKey(1)]).toBeUndefined();
    c.advance(1);
    expect(host.state[symKey(1)]).toBe(false);
    expect(events).toEqual([{ from: 1, to: 2, requestedZoom: 4.9, target: 2, forced: false, waitedMs: 0 }]);
  });

  it('holds while the next band loads, then wakes the camera once when it is ready', () => {
    const { host, zoomTo, c } = setup(1, 4.4);
    expect(zoomTo(4.9)).toBe(1); // not ready → hold
    host.fire('sourcedata'); // still not loaded
    expect(host.jumps).toBe(0);
    host.loaded.add('openmaptiles__b2');
    host.fire('sourcedata');
    host.fire('sourcedata');
    expect(host.jumps).toBe(1); // one pending wake
    c.advance(400);
    expect(zoomTo(4.9)).toBe(2); // the camera frame the jump caused
  });

  it('does not wake the camera while the map is moving (the next frame decides anyway)', () => {
    const { host, zoomTo } = setup(1, 4.4);
    zoomTo(4.9);
    host.moving = true;
    host.loaded.add('openmaptiles__b2');
    host.fire('sourcedata');
    expect(host.jumps).toBe(0);
  });

  it('refuses a second voluntary switch inside the dwell, but not a forced one', () => {
    const { host, c, zoomTo } = setup(1, 4.4);
    host.loaded.add('openmaptiles__b2').add('openmaptiles__b3');
    expect(zoomTo(4.9)).toBe(2);
    c.advance(100);
    expect(zoomTo(5.7)).toBe(2); // band 3 ready, but inside the dwell → held
    c.advance(250);
    expect(zoomTo(5.7)).toBe(3);
    // A forced switch ignores the dwell: z7.4 is outside band 3's parse range (≤ 6.4 + 0.8).
    expect(zoomTo(7.4)).toBe(5);
  });

  it('cancels a pending symbol hide when the band is shown again within the fade', () => {
    const { host, c, zoomTo } = setup(1, 4.4);
    host.loaded.add('openmaptiles__b2').add('openmaptiles__b1');
    zoomTo(4.9);
    c.advance(350); // past the dwell, inside no fade yet relevant
    zoomTo(4.5); // back to band 1 (hysteresis: 4.5 < 4.8 − 0.1)
    c.advance(300);
    expect(host.state[symKey(1)]).toBe(true);
    expect(host.state[symKey(2)]).toBe(false);
  });

  it('reports the hold time of a switch', () => {
    const { host, c, zoomTo, events } = setup(1, 4.4);
    zoomTo(4.9);
    c.advance(1200);
    host.loaded.add('openmaptiles__b2');
    zoomTo(4.9);
    expect(events[0]!.waitedMs).toBe(1200);
  });

  it('unsubscribes and cancels timers on destroy', () => {
    const { host, c, zoomTo, switcher } = setup(1, 4.4);
    host.loaded.add('openmaptiles__b2');
    zoomTo(4.9);
    switcher.destroy();
    c.advance(1000);
    expect(host.state[symKey(1)]).toBeUndefined();
    expect(host.listenerCount('sourcedata')).toBe(0);
    expect(host.listenerCount('idle')).toBe(0);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/switcher.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement**

Create `src/map/switcher.ts`:

```ts
/**
 * Which band is drawn, decided at runtime (spec §4.3).
 *
 * A band's tiles take time to fetch and warp. Switching by zoom alone showed the new band's
 * empty source for a second or more at every step (spike findings 3–4). So the shown band is
 * state: it follows the zoom's band only once that band's sources report loaded, and it is
 * held — still parsed, still drawn — until then. The decision runs inside the camera hook
 * (`BandSelector`), so the camera conversion and the style flip land in the same frame.
 *
 * Readiness comes from `isSourceLoaded`, public on both supported majors: every in-view tile
 * loaded or errored. Nothing here reads MapLibre's tile caches.
 */

import { bandIndexWithHysteresis, parseRange, type Band, type ResolvedTransition } from './bands.js';
import type { BandSelector } from './camera.js';
import { showKey, symKey } from './style-rewrite.js';

// … interfaces from the Interfaces block …

export function chooseBand(input: {
  bands: readonly Band[];
  transition: ResolvedTransition | null;
  shown: number;
  requestedZoom: number;
  hysteresis: number;
  isReady(band: number): boolean;
}): { band: number; forced: boolean } {
  const { bands, transition, shown, requestedZoom: z, hysteresis } = input;
  const parsedAt = (k: number): boolean => {
    if (!transition) return true;
    const [lo, hi] = parseRange(transition, k);
    return z >= lo && z < hi;
  };
  const target = bandIndexWithHysteresis(bands, z, shown, hysteresis);
  if (target === shown) return { band: shown, forced: false };
  const step = target > shown ? -1 : 1;
  // Rule 3: the first ready, parsed band from the target towards the shown one.
  for (let k = target; k !== shown; k += step) {
    if (parsedAt(k) && input.isReady(k)) return { band: k, forced: false };
  }
  // Rule 4: hold while the shown band is still parsed here.
  if (parsedAt(shown)) return { band: shown, forced: false };
  // Rule 5: forced — the parsed band nearest the target that is loaded, else the target.
  for (let k = target; k !== shown; k += step) {
    if (parsedAt(k) && input.isReady(k)) return { band: k, forced: true };
  }
  return { band: target, forced: true };
}
```

   `BandSwitcher`: fields `#shown`, `#lastSwitchAt = -Infinity`, `#waitingSince: number | null`, `#pendingHides = new Map<number, () => void>()`, `#wakePending = false`. `decide(z)`:

```ts
decide(requestedZoom: number): number {
  this.#wakePending = false;
  const { band, forced } = chooseBand({ …, shown: this.#shown, requestedZoom, isReady: (k) => this.#isReady(k) });
  const target = bandIndexWithHysteresis(this.#bands, requestedZoom, this.#shown, this.#hysteresis);
  if (target !== this.#shown) this.#waitingSince ??= this.#now();
  if (band === this.#shown) return band;
  if (!forced && this.#now() - this.#lastSwitchAt < this.#dwellMs) return this.#shown;
  this.#switch(band, { requestedZoom, target, forced });
  return band;
}
```
   `#switch(to, …)`: cancel a pending hide for `to`; flip `showKey(from)` false, `showKey(to)` true, `symKey(to)` true; schedule the hide of `symKey(from)` (store its cancel); set `#lastSwitchAt`, compute `waitedMs = waitingSince === null ? 0 : now − waitingSince`, reset `#waitingSince` when `to === target`; call `onSwitch`. The `sourcedata`/`idle` handler: `if (this.#wakePending || this.#host.isMoving()) return; const { band } = chooseBand({ … requestedZoom: this.#requestedZoom() … }); if (band !== this.#shown) { this.#wakePending = true; this.#host.jumpTo({}); }`. Note the dwell is not consulted by the wake-up; `decide` applies it.

   Export from `src/index.ts`: `BandSwitcher, chooseBand, type SwitchEvent, type SwitcherHost, type SwitcherOptions`.

- [ ] **Step 5: Run the tests and verify**

Run: `npx vitest run tests/switcher.test.ts && npm run verify`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/map/switcher.ts src/index.ts tests/switcher.test.ts tests/support/fake-maplibre.ts
git diff --cached --name-only
git commit -m "Add BandSwitcher: show a band only once its tiles are loaded" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `EqualEarthController` and `installEqualEarth`

**Files:**
- Create: `src/map/controller.ts`
- Create: `src/install.ts`
- Create: `tests/controller.test.ts`, `tests/install.test.ts`
- Modify: `tests/support/fake-maplibre.ts` (`FakeControllerHost`), `tests/host-types.test.ts`
- Modify: `src/index.ts`, `package.json` (`peerDependencies`), `src/tiles/worker-entry.ts` (comment only, if the fix round left "no fallback" wording: it is now the install's fallback)

**Interfaces:**
- Consumes: `BandCamera` (+ `selector`, `compensation`, `requestedZoom`, `shownBand`, `baselineBand`), `cameraHookAccess` (Tasks 3–4); `createEqualEarthConstrain`, `installEqualEarthConstrain` (Task 3); `rewriteStyle`, `REWRITTEN_METADATA_KEY`, `StyleLike`, `SourceTemplate` (Task 5); `BandSwitcher`, `SwitchEvent` (Task 6); `resolveTransition`, `EQUAL_EARTH_BANDS`, `Transition` (Task 1); `CompensationMode` (Task 2); `geographicToMap`, `mapToGeographic`; `PROTOCOL_SCHEME`, `createEqualEarthProtocol`.
- Produces:
  - `type EqualEarthProjection = 'equal' | 'equal-earth'`
  - `interface ControllerHost extends CameraHost, ConstrainHost, SwitcherHost { getStyle(): StyleLike | undefined; setStyle(style: StyleLike, options?: { diff?: boolean }): unknown; once(type: string, listener: () => void): unknown; getCenter(): { lng: number; lat: number }; getBearing(): number; getRenderWorldCopies(): boolean; setRenderWorldCopies(value: boolean): unknown; fire?(event: unknown): unknown }` (plus `on`/`off` with `type: string` — widen `SwitcherHost`'s to `string` so one interface covers all events).
  - `interface ControllerOptions { lngLatFactory: LngLatFactory; transition?: Transition; compensation?: CompensationMode /* 'zoom+bearing' */; fetchJson?: (url: string) => Promise<unknown> /* default fetch().json() */; onSwitch?: (event: SwitchEvent) => void }`
  - `class EqualEarthController { constructor(host: ControllerHost, options: ControllerOptions); readonly active: boolean; readonly projection: EqualEarthProjection | undefined; readonly blend: number /* shown band's blend, 1 when inactive */; activate(type: EqualEarthProjection): Promise<void>; deactivate(): Promise<void>; toMapSpace(lngLat: LngLatTuple): LngLatTuple; toGeographic(lngLat: LngLatTuple): LngLatTuple; destroy(): Promise<void> }`
  - `interface MapLibreModule { getVersion(): string; importScriptInWorkers(url: string): Promise<unknown>; addProtocol(scheme: string, handler: unknown): unknown; getWorkerCount(): number; setWorkerCount(count: number): void; LngLat: new (lng: number, lat: number) => { lng: number; lat: number }; Map: { prototype: { setProjection(projection: unknown): unknown; getProjection(): unknown } } }`
  - `interface InstallOptions { workerUrl?: string | URL; workers?: number | false; transition?: Transition; compensation?: CompensationMode; fetchJson?: ControllerOptions['fetchJson']; onSwitch?: ControllerOptions['onSwitch'] }`
  - `interface EqualEarthInstall { readonly version: string; readonly workerPath: 'worker' | 'main-thread'; controllerFor(map: ControllerHost): EqualEarthController; uninstall(): void }`
  - `installEqualEarth(maplibregl: MapLibreModule, options?: InstallOptions): Promise<EqualEarthInstall>`
  - `parseVersion(version: string): { major: number; minor: number }` (exported for tests)

Behaviour:

*Controller.* `activate(type)`:
1. If already active with the same `type`, resolve. If the host has no loaded style yet (`getStyle()` throws or returns no `layers` array), wait for one `styledata` and re-check (loop).
2. Capture `#original = structuredClone(getStyle())` unless the style carries `metadata[REWRITTEN_METADATA_KEY]` (then keep the previously captured original).
3. Bands: `type === 'equal'` → `resolveTransition(options.transition)`; `'equal-earth'` → `EQUAL_EARTH_BANDS`, `transition = null`.
4. Templates: for every `type: 'vector'` source: `tiles` present → `{ tiles, maxzoom }`; `url` present → `await fetchJson(url)` → `{ tiles: json.tiles, maxzoom: json.maxzoom }`. A fetch failure rejects `activate` with `Error('Equal Earth: could not resolve TileJSON for source "<id>": <reason>')` and leaves the map untouched.
5. `initialBand = bandIndexForZoom(bands, host.getZoom())`; `setStyle(rewriteStyle(original, { bands, transition, templates, initialZoom: host.getZoom() }).style, { diff: true })`.
6. Switcher (`initialBand`, `requestedZoom: () => camera.requestedZoom`, `sourceIdsForBand` from the rewrite, `onSwitch`), then camera (`selector: switcher`, `compensation: transition ? { transition, mode } : undefined`), then constraint (`bands`, `baselineBand: () => camera.baselineBand`, `isActive: () => this.active`), then `switcher.start()`.
7. `#worldCopies = getRenderWorldCopies(); setRenderWorldCopies(false)`.
8. Convert the centre into the initial band's space: `host.jumpTo({ center: lngLatFactory(...geographicToMap([c.lng, c.lat], bands[initialBand].blend)) })` (the map was in geographic = Mercator space).
9. Subscribe to `styledata`: when active, not applying, and the current style lacks the metadata key, the application replaced the style → capture it as the new original and re-apply (steps 4–6 again; the camera and switcher are rebuilt).

`deactivate()`: if inactive, resolve. Convert the centre back (`mapToGeographic(center, blend)`), and undo the offsets: `jumpTo({ center, zoom: camera.requestedZoom, bearing: host.getBearing() − lastBearingOffset })` — expose `camera.requestedBearing` too (mirror of `requestedZoom`). Then `switcher.destroy()`, `camera.destroy()`, uninstall the constraint, `setStyle(#original, { diff: true })`, restore `renderWorldCopies`, unsubscribe. `destroy()` = `deactivate()` + drop references. `toMapSpace`/`toGeographic` use the shown band's blend (identity when inactive).

*Install.* `parseVersion` reads `getVersion()` (`"6.6.0"` → `{6, 6}`); `major < 5 || (major === 5 && minor < 24)` → `throw new Error('Equal Earth needs maplibre-gl >= 5.24; found <v>.')`. Worker count: when `options.workers !== false` and `getWorkerCount() === 1` (MapLibre's default), `setWorkerCount(options.workers ?? Math.max(2, Math.min(4, Math.floor((globalThis.navigator?.hardwareConcurrency ?? 4) / 2))))` — before any `Map` exists; documented. Worker URL: `options.workerUrl ?? new URL(major >= 6 ? './worker.mjs' : './worker.iife.js', import.meta.url)`; `await importScriptInWorkers(String(url))`; on rejection: one `console.warn('[equal-earth] worker script failed to load (<reason>); warping tiles on the main thread.')`, `addProtocol(PROTOCOL_SCHEME, createEqualEarthProtocol())`, `workerPath = 'main-thread'`. Polyfill: save `Map.prototype.setProjection`/`getProjection`; replace with functions that, for `type` in `{'equal', 'equal-earth'}`, obtain the map's controller (a `WeakMap<object, EqualEarthController>`; constructed with `lngLatFactory: (lng, lat) => new maplibregl.LngLat(lng, lat)` and the install options) and call `activate(type)` (rejections → `map.fire?.(new ErrorEvent-like { type: 'error', error })` if `fire` exists, else `console.error`), returning `this`; for any other projection, `void controller?.deactivate()` then call the original. `getProjection()` returns `{ type }` while active, else the original's result. `uninstall()` restores both prototype methods only if they are still ours and destroys every controller it created (keep a `Set` of live controllers).

- [ ] **Step 1: Add the fake host**

Append to `tests/support/fake-maplibre.ts`: `export class FakeControllerHost extends FakeV6Map` adding `style: StyleLike | undefined`, `getStyle()` (returns `structuredClone(style)`; throws when `style` is undefined — MapLibre's `serialize` on an unloaded style), `setStyle(style, options)` (stores a clone, records `setStyleCalls.push({ layers: style.layers.length, diff: options?.diff })`, fires `styledata` **synchronously** on the Map emitter), `once(type, fn)` (one-shot listener on the Map emitter), `getCenter()` (from `T`), `getBearing()`, `isMoving()` (field `moving`), `isSourceLoaded(id)` (Set `loaded`), `setGlobalStateProperty` (records into `state`), `jumpTo` already exists (extend `Frame` with `bearing?` — Task 4 did), `getRenderWorldCopies`/`setRenderWorldCopies` (field `worldCopies = true`), `fire(event)` pushing into `errors` when `event.type === 'error'`, `transform` with `defaultConstrain` (Task 3) and `setTransformConstrain` recording `constrain`. The `jumpTo` must accept `{}` (no-op frame).

- [ ] **Step 2: Write the failing tests**

Create `tests/controller.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { EqualEarthController } from '../src/map/controller.js';
import { REWRITTEN_METADATA_KEY, type StyleLike } from '../src/map/style-rewrite.js';
import { geographicToMap, mapToGeographic } from '../src/math/backproject.js';
import { FakeControllerHost } from './support/fake-maplibre.js';

const liberty = (): StyleLike => JSON.parse(readFileSync(new URL('./fixtures/liberty.json', import.meta.url), 'utf8')) as StyleLike;
const TILEJSON = { tiles: ['https://tiles.example/planet/{z}/{x}/{y}.pbf'], maxzoom: 14 };
const lngLatFactory = (lng: number, lat: number) => ({ lng, lat });
const TOKYO: [number, number] = [139.69, 35.69];

function setup(zoom = 4.6, style: StyleLike | undefined = liberty()) {
  const host = new FakeControllerHost(TOKYO, zoom);
  host.style = style;
  const fetchJson = vi.fn(async () => TILEJSON);
  const controller = new EqualEarthController(host, { lngLatFactory, fetchJson });
  return { host, controller, fetchJson };
}

describe('EqualEarthController', () => {
  it('activates: rewrites the style, converts the centre, disables world copies', async () => {
    const { host, controller, fetchJson } = setup();
    await controller.activate('equal');
    expect(controller.active).toBe(true);
    expect(controller.projection).toBe('equal');
    expect(fetchJson).toHaveBeenCalledWith(liberty().sources['openmaptiles']!['url']);
    expect(host.setStyleCalls.at(-1)).toMatchObject({ diff: true });
    expect(host.style!.metadata![REWRITTEN_METADATA_KEY]).toBeDefined();
    expect(host.style!.sources['openmaptiles__b1']).toBeDefined();
    expect(host.worldCopies).toBe(false);
    // z4.6 is band 1 (blend 1/6): the centre is now in that band's map space.
    const expected = geographicToMap(TOKYO, 1 / 6);
    expect(host.center.lng).toBeCloseTo(expected[0], 9);
    expect(host.center.lat).toBeCloseTo(expected[1], 9);
    expect(controller.blend).toBeCloseTo(1 / 6, 12);
    expect(controller.toGeographic([host.center.lng, host.center.lat])[0]).toBeCloseTo(TOKYO[0], 9);
  });

  it('waits for a style when activated before one is loaded (Review Focus 1)', async () => {
    const { host, controller } = setup(4.6, undefined);
    const pending = controller.activate('equal');
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    host.style = liberty();
    host.fireMapEvent('styledata');
    await pending;
    expect(controller.active).toBe(true);
  });

  it('rejects, and leaves the map untouched, when a TileJSON cannot be fetched', async () => {
    const host = new FakeControllerHost(TOKYO, 4.6);
    host.style = liberty();
    const controller = new EqualEarthController(host, { lngLatFactory, fetchJson: async () => { throw new Error('offline'); } });
    await expect(controller.activate('equal')).rejects.toThrow(/openmaptiles.*offline/);
    expect(host.setStyleCalls).toHaveLength(0);
    expect(controller.active).toBe(false);
    expect(host.worldCopies).toBe(true);
  });

  it('deactivates: restores the original style, the centre, world copies and the hooks', async () => {
    const { host, controller } = setup();
    const original = JSON.stringify(host.style);
    await controller.activate('equal');
    await controller.deactivate();
    expect(JSON.stringify(host.style)).toBe(original);
    expect(host.center.lng).toBeCloseTo(TOKYO[0], 9);
    expect(host.center.lat).toBeCloseTo(TOKYO[1], 9);
    expect(host.worldCopies).toBe(true);
    expect(host._camera.transformCameraUpdate).toBeNull();
    expect(host.constrain).toBeNull();
    expect(controller.active).toBe(false);
    expect(controller.blend).toBe(1);
  });

  it('re-applies when the application replaces the style while active', async () => {
    const { host, controller } = setup();
    await controller.activate('equal');
    const replacement = liberty();
    replacement.layers = replacement.layers.slice(0, 10);
    host.setStyle(replacement, {}); // the app's own call: no metadata → styledata → re-apply
    await vi.waitFor(() => expect(host.style!.metadata![REWRITTEN_METADATA_KEY]).toBeDefined());
    expect(host.style!.layers.length).toBeGreaterThan(10);
    await controller.deactivate();
    expect(host.style!.layers).toHaveLength(10); // the new original is what deactivate restores
  });

  it('equal-earth: one band, no compensation, raster relief removed', async () => {
    const { host, controller } = setup(2);
    await controller.activate('equal-earth');
    expect(host.style!.layers.some((l) => l.type === 'raster')).toBe(false);
    expect(controller.blend).toBe(0);
    host.applyFrame({ zoomDelta: 6 });
    expect(host.zoom).toBe(8);
    expect(host.bearing).toBe(0);
  });

  it('forwards switch events', async () => {
    const onSwitch = vi.fn();
    const host = new FakeControllerHost(TOKYO, 4.6);
    host.style = liberty();
    const controller = new EqualEarthController(host, { lngLatFactory, fetchJson: async () => TILEJSON, onSwitch });
    await controller.activate('equal');
    host.loaded.add('openmaptiles__b2');
    host.applyFrame({ zoomDelta: 0.4 }); // z5.0 → band 2
    expect(onSwitch).toHaveBeenCalledWith(expect.objectContaining({ from: 1, to: 2 }));
    expect(controller.toGeographic([host.center.lng, host.center.lat])[1]).toBeCloseTo(TOKYO[1], 6);
    void mapToGeographic;
  });
});
```

`fireMapEvent(type)` is the public name of `FakeMapBase.fireOnMap` for tests — make `fireOnMap` public as `fireMapEvent` (keep `fireMapMoveEnd`).

Create `tests/install.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import { installEqualEarth, parseVersion } from '../src/install.js';

function fakeModule(version = '6.6.0', importResult: Promise<unknown> = Promise.resolve()) {
  class FakeMap {
    projection: unknown = undefined;
    setProjection(p: unknown) { this.projection = p; return this; }
    getProjection() { return this.projection; }
  }
  return {
    module: {
      getVersion: () => version,
      importScriptInWorkers: vi.fn(() => importResult),
      addProtocol: vi.fn(),
      getWorkerCount: vi.fn(() => 1),
      setWorkerCount: vi.fn(),
      LngLat: class { constructor(public lng: number, public lat: number) {} },
      Map: FakeMap,
    },
    FakeMap,
  };
}

describe('parseVersion', () => {
  it('reads major and minor', () => {
    expect(parseVersion('6.6.0')).toEqual({ major: 6, minor: 6 });
    expect(parseVersion('5.24.0-pre.1')).toEqual({ major: 5, minor: 24 });
  });
});

describe('installEqualEarth', () => {
  it('rejects MapLibre older than 5.24', async () => {
    await expect(installEqualEarth(fakeModule('5.23.1').module)).rejects.toThrow(/>= 5\.24.*5\.23\.1/);
    await expect(installEqualEarth(fakeModule('4.7.0').module)).rejects.toThrow(/>= 5\.24/);
  });

  it('loads the ESM worker on v6 and the classic one on v5', async () => {
    const v6 = fakeModule('6.6.0');
    await installEqualEarth(v6.module);
    expect(String(v6.module.importScriptInWorkers.mock.calls[0]![0])).toMatch(/worker\.mjs$/);
    const v5 = fakeModule('5.24.0');
    await installEqualEarth(v5.module);
    expect(String(v5.module.importScriptInWorkers.mock.calls[0]![0])).toMatch(/worker\.iife\.js$/);
  });

  it('raises the worker count from MapLibre's default of 1, but respects an app's own setting', async () => {
    vi.stubGlobal('navigator', { hardwareConcurrency: 12 });
    const a = fakeModule();
    await installEqualEarth(a.module);
    expect(a.module.setWorkerCount).toHaveBeenCalledWith(4);
    const b = fakeModule();
    b.module.getWorkerCount.mockReturnValue(3);
    await installEqualEarth(b.module);
    expect(b.module.setWorkerCount).not.toHaveBeenCalled();
    const c = fakeModule();
    await installEqualEarth(c.module, { workers: false });
    expect(c.module.setWorkerCount).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('falls back to a main-thread protocol when the worker script fails to load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { module } = fakeModule('6.6.0', Promise.reject(new Error('404')));
    const install = await installEqualEarth(module);
    expect(install.workerPath).toBe('main-thread');
    expect(module.addProtocol).toHaveBeenCalledWith('eqearth', expect.any(Function));
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('polyfills setProjection/getProjection on the prototype and restores them on uninstall', async () => {
    const { module, FakeMap } = fakeModule();
    const originalSet = FakeMap.prototype.setProjection;
    const install = await installEqualEarth(module);
    expect(FakeMap.prototype.setProjection).not.toBe(originalSet);
    const map = new FakeMap();
    // A plain Mercator projection passes straight through.
    map.setProjection({ type: 'mercator' });
    expect(map.getProjection()).toEqual({ type: 'mercator' });
    install.uninstall();
    expect(FakeMap.prototype.setProjection).toBe(originalSet);
  });
});
```

(`setProjection({ type: 'equal' })` against a real-looking host is covered by the controller tests; the install test only checks routing, because the fake Map here has no style machinery.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/controller.test.ts tests/install.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 4: Implement**

Write `src/map/controller.ts` and `src/install.ts` per Behaviour. Notes for the implementer:
- Keep the controller's `#apply()` (steps 4–8) as one method used by both `activate` and the `styledata` re-apply; guard re-entrancy with `#applying`.
- `structuredClone` is available in every supported runtime (Node 17+, all evergreen browsers).
- The style re-apply path must `camera.destroy()` and `switcher.destroy()` before building new ones; the constraint is replaced through `installEqualEarthConstrain` (call the previous teardown first).
- `host.once` exists on both majors (`Evented.once`).
- `package.json`: `"peerDependencies": { "maplibre-gl": ">=5.24 <7" }`.
- `src/index.ts`: export `EqualEarthController, installEqualEarth, parseVersion` and the types (`ControllerHost`, `ControllerOptions`, `EqualEarthProjection`, `MapLibreModule`, `InstallOptions`, `EqualEarthInstall`).
- `tests/host-types.test.ts`: add `const acceptsV6Controller = (map: MapV6): ControllerHost => map;` and the v5 twin. If `tsc` rejects a member, fix the **interface** (widen a parameter, use method shorthand), never the test.

- [ ] **Step 5: Run the tests and verify**

Run: `npx vitest run tests/controller.test.ts tests/install.test.ts && npm run verify`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/map/controller.ts src/install.ts src/index.ts src/tiles/worker-entry.ts package.json tests/controller.test.ts tests/install.test.ts tests/support/fake-maplibre.ts tests/host-types.test.ts
git diff --cached --name-only
git commit -m "Add the controller and installEqualEarth: setProjection polyfill, style lifecycle, worker loading" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Tile throughput — decode once, clip directly

**Files:**
- Modify: `src/tiles/cache.ts` (+ `EntryCache<T>`)
- Modify: `src/tiles/protocol.ts` (decoded-tile cache)
- Create: `src/tiles/clip.ts`
- Modify: `src/tiles/mvt.ts` (`buildTile` via `clip.ts`; `mergeLayers` dedupes points; `simplifyTolerance` removed)
- Modify: `src/index.ts`, `package.json` (`geojson-vt` → devDependencies), `CLAUDE.md` (tile pipeline notes), `README.md` (options)
- Create: `tests/clip.test.ts`
- Modify: `tests/tiles.test.ts`, `tests/protocol.test.ts`

**Interfaces:**
- Consumes: `decodeToGeographic`, `mergeLayers`, `warpFeature`, `GeographicLayers` (existing); `geographicToMapWorld(p, 1)` for map-space → Mercator world.
- Produces:
  - `class EntryCache<T> { constructor(maxEntries: number); get(key): T | undefined; set(key, value): void; readonly size: number }` — count-bounded LRU (same recency trick as `TileCache`).
  - `interface TileFeature { type: 1 | 2 | 3; geometry: number[][] | number[][][]; tags: Record<string, unknown>; id?: number }` — vt-pbf's `fromGeojsonVt` feature shape: points `[[x, y], …]`, lines/polygons `[[[x, y], …], …]`.
  - `clipFeatureToTile(feature: GeoJSON.Feature, output: TileId, extent: number, buffer: number): TileFeature | null` — `feature.geometry` is in **map-space lng/lat** (the output of `warpFeature`); coordinates are converted to integer tile units, clipped to `[−buffer, extent + buffer]²`, degenerate output dropped.
  - `buildTile(sourceLayers, output, options)` signature unchanged; `WarpTileOptions.simplifyTolerance` **removed** (geojson-vt's knob; nothing to simplify now).
  - `mergeLayers` drops a `Point` feature that repeats an earlier one with the same `id` **and** coordinates in the same layer (label points duplicated across source tiles' buffers; ledger row 22).

Rules for `clip.ts` (Sutherland–Hodgman for rings, Liang–Barsky for segments; document both in the module comment with one sentence on why geojson-vt was replaced: it builds a tile index per output tile and layer, 100–750 ms per tile, and the gate waits on it):
- Project: `[wx, wy] = geographicToMapWorld([lng, lat], 1)`; `x = Math.round((wx · 2^z − output.x) · extent)`, `y = Math.round((wy · 2^z − output.y) · extent)`. Clamp `wy` to `[0, 1]` first (Mercator's pole).
- Points (`Point`, `MultiPoint`): keep those with `−buffer ≤ x ≤ extent + buffer` (both axes); none left → `null`.
- Lines (`LineString`, `MultiLineString`): clip each segment with Liang–Barsky against the rectangle; consecutive surviving segments are joined into one run (a run breaks where a segment was cut at the exit or the next entered elsewhere); drop runs with < 2 distinct points; `type: 2`.
- Polygons (`Polygon`, `MultiPolygon`): clip each ring with Sutherland–Hodgman against the four edges in turn, keeping the ring closed (first point repeated last) and its orientation; drop rings with < 4 points or zero area; a polygon whose outer ring is dropped is dropped whole; `type: 3`, geometry = the surviving rings of all polygons concatenated (vt-pbf and MapLibre classify rings by winding, as geojson-vt's output does).
- `tags = feature.properties ?? {}`; `id` only when `typeof feature.id === 'number'`.

- [ ] **Step 1: Write the failing tests**

Create `tests/clip.test.ts`. It compares the new pipeline against geojson-vt on synthetic geometry (geojson-vt stays a devDependency for this file only):

```ts
import { VectorTile } from '@mapbox/vector-tile';
import geojsonvt from 'geojson-vt';
import { PbfReader } from 'pbf';
import { fromGeojsonVt } from 'vt-pbf';
import { describe, expect, it } from 'vitest';

import { toleranceForZoom } from '../src/math/subdivide.js';
import { clipFeatureToTile } from '../src/tiles/clip.js';
import { buildTile, warpFeature, type GeographicLayers } from '../src/tiles/mvt.js';
import type { TileId } from '../src/tiles/tile-cover.js';

const OUT: TileId = { z: 3, x: 4, y: 3 }; // mid-latitude Europe/Africa at blend 0
const EXTENT = 4096, BUFFER = 64;

/** The old pipeline, kept here as the reference: warp (blend 0) then geojson-vt. */
function referenceTile(layers: GeographicLayers): Uint8Array {
  const tolerance = toleranceForZoom(OUT.z, 1);
  const encoded: Record<string, { features: unknown[] }> = {};
  for (const [name, features] of layers) {
    const warped = features.map((f) => warpFeature(f, tolerance, 8, 0)).filter((f): f is GeoJSON.Feature => f !== null);
    const index = geojsonvt({ type: 'FeatureCollection', features: warped }, { maxZoom: Math.max(OUT.z, 1), indexMaxZoom: 0, tolerance: 0, extent: EXTENT, buffer: BUFFER, debug: 0 });
    const tile = index.getTile(OUT.z, OUT.x, OUT.y);
    if (tile && tile.features.length > 0) encoded[name] = tile;
  }
  return fromGeojsonVt(encoded, { version: 2, extent: EXTENT });
}

type Summary = { count: number; area: number; length: number; points: Set<string> };
function decode(bytes: Uint8Array): Record<string, Summary> {
  const out: Record<string, Summary> = {};
  if (bytes.byteLength === 0) return out;
  const tile = new VectorTile(new PbfReader(bytes));
  for (const name of Object.keys(tile.layers)) {
    const layer = tile.layers[name]!;
    const s: Summary = { count: layer.length, area: 0, length: 0, points: new Set() };
    for (let i = 0; i < layer.length; i++) {
      const feature = layer.feature(i);
      for (const ring of feature.loadGeometry()) {
        if (feature.type === 1) for (const p of ring) s.points.add(`${p.x},${p.y}`);
        if (feature.type === 2) for (let k = 1; k < ring.length; k++) s.length += Math.hypot(ring[k]!.x - ring[k - 1]!.x, ring[k]!.y - ring[k - 1]!.y);
        if (feature.type === 3) {
          let a = 0;
          for (let k = 0; k < ring.length; k++) { const p = ring[k]!, q = ring[(k + 1) % ring.length]!; a += p.x * q.y - q.x * p.y; }
          s.area += Math.abs(a) / 2;
        }
      }
    }
    out[name] = s;
  }
  return out;
}

const feature = (geometry: GeoJSON.Geometry, id?: number): GeoJSON.Feature => ({ type: 'Feature', id, properties: { kind: geometry.type }, geometry });
/** Tile 3/4/3 at blend 0 covers roughly lng 0…45°, lat 0…40° in map space; these straddle its edges. */
function world(): GeographicLayers {
  return new Map([
    ['poly', [feature({ type: 'Polygon', coordinates: [
      [[-20, 5], [30, 5], [30, 35], [-20, 35], [-20, 5]],           // outer, crosses the west edge
      [[0, 15], [10, 15], [10, 25], [0, 25], [0, 15]],              // hole, inside
    ] }, 1)]],
    ['multi', [feature({ type: 'MultiPolygon', coordinates: [
      [[[5, 10], [20, 10], [20, 20], [5, 20], [5, 10]]],            // inside
      [[[100, 10], [120, 10], [120, 20], [100, 20], [100, 10]]],    // far outside: dropped
    ] }, 2)]],
    ['line', [feature({ type: 'LineString', coordinates: [[-30, -10], [60, 50]] }, 3)]],   // diagonal through the tile
    ['points', [feature({ type: 'MultiPoint', coordinates: [[20, 20], [-0.4, 20], [80, 20]] }, 4)]], // inside, in the buffer, outside
  ]);
}

describe('clipFeatureToTile', () => {
  it('drops geometry entirely outside the buffered tile', () => {
    expect(clipFeatureToTile(feature({ type: 'Polygon', coordinates: [[[100, 10], [120, 10], [120, 20], [100, 10]]] }), OUT, EXTENT, BUFFER)).toBeNull();
    expect(clipFeatureToTile(feature({ type: 'Point', coordinates: [80, 20] }), OUT, EXTENT, BUFFER)).toBeNull();
  });

  it('keeps rings closed and oriented', () => {
    const result = clipFeatureToTile(world().get('poly')![0]!, OUT, EXTENT, BUFFER)!;
    expect(result.type).toBe(3);
    const rings = result.geometry as number[][][];
    expect(rings).toHaveLength(2);
    for (const ring of rings) expect(ring[0]).toEqual(ring[ring.length - 1]);
    const signedArea = (ring: number[][]) => ring.reduce((a, p, k) => { const q = ring[(k + 1) % ring.length]!; return a + p[0]! * q[1]! - q[0]! * p[1]!; }, 0);
    // The outer ring is CCW in lng/lat (y up), so clockwise (negative here, y down) in tile units; the hole is the opposite.
    expect(Math.sign(signedArea(rings[0]!))).toBe(-1);
    expect(Math.sign(signedArea(rings[1]!))).toBe(1);
    for (const [x, y] of rings[0]!) { expect(x).toBeGreaterThanOrEqual(-BUFFER); expect(y).toBeGreaterThanOrEqual(-BUFFER); expect(x).toBeLessThanOrEqual(EXTENT + BUFFER); expect(y).toBeLessThanOrEqual(EXTENT + BUFFER); }
  });

  it('splits a line that leaves and re-enters into two runs', () => {
    // Out through the north edge and back in: a "V" whose apex is far above the tile.
    const v = feature({ type: 'LineString', coordinates: [[5, 20], [15, 80], [25, 20]] });
    const result = clipFeatureToTile(v, OUT, EXTENT, BUFFER)!;
    expect(result.type).toBe(2);
    expect((result.geometry as number[][][]).length).toBe(2);
  });

  it('keeps a point inside the buffer and drops one beyond it', () => {
    const result = clipFeatureToTile(world().get('points')![0]!, OUT, EXTENT, BUFFER)!;
    expect(result.type).toBe(1);
    expect((result.geometry as number[][]).length).toBe(2);
  });
});

describe('buildTile (direct clip) against geojson-vt', () => {
  it('produces the same features, areas and lengths within 0.1 %', () => {
    const ours = decode(buildTile(world(), OUT, { blend: 0 }));
    const reference = decode(referenceTile(world()));
    expect(Object.keys(ours).sort()).toEqual(Object.keys(reference).sort());
    for (const name of Object.keys(reference)) {
      expect(ours[name]!.count).toBe(reference[name]!.count);
      expect(ours[name]!.area).toBeCloseTo(reference[name]!.area, -Math.log10(reference[name]!.area * 1e-3));
      expect(ours[name]!.length).toBeCloseTo(reference[name]!.length, -Math.log10(Math.max(1, reference[name]!.length * 1e-3)));
      expect(ours[name]!.points).toEqual(reference[name]!.points);
    }
  });
});
```

Fill in the `…` bodies (they are ordinary vitest code; the reference function is the pre-Task-8 `buildTile` loop with `geojsonvt({ type: 'FeatureCollection', features: warped }, { maxZoom: Math.max(output.z, 1), indexMaxZoom: 0, tolerance: 0, extent, buffer, debug: 0 }).getTile(z, x, y)` and `fromGeojsonVt`).

Add to `tests/protocol.test.ts`: "decodes each source tile once across bands" — two handler calls for the same output tile position at blend 0 and blend ⅓ (two `encodeSourceUrl` configs) sharing the same upstream template; spy on `decodeToGeographic` via `vi.spyOn` on the module namespace (`import * as mvt from '../src/tiles/mvt.js'`) or count through a `fetchImpl` returning a tile whose decode you can detect — assert the fetch count equals the cover size and the decode count equals the cover size too (not twice).

Add to `tests/tiles.test.ts`: `mergeLayers` dedupes a Point with the same id and coordinates appearing in two source tiles, and keeps two different points with the same id; remove the `simplifyTolerance` default test (the option no longer exists); strengthen "subdivides against the blend" (ledger row 5): after densifying a long segment at blend ½, every chord's maximum deviation from the blended warp of its midpoint is ≤ the tolerance in blended world units.

Add to `tests/protocol.test.ts` or a new `tests/cache.test.ts`: `EntryCache` evicts the least recently used entry beyond `maxEntries`, and `get` refreshes recency.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/clip.test.ts tests/tiles.test.ts tests/protocol.test.ts`
Expected: FAIL — `clip.js` missing; `EntryCache` missing.

- [ ] **Step 3: Record the baseline timing**

Run: `npx vite-node scripts/probe-openfreemap.ts 2>&1 | tail -30` (needs network) and keep the per-tile warp timings it prints; they go into the commit message of Step 6 next to the new numbers.

- [ ] **Step 4: Implement**

- `cache.ts`: `EntryCache<T>` next to `TileCache`.
- `clip.ts` per the rules. Liang–Barsky: parametric clip of `p0→p1` against `[xmin, xmax]×[ymin, ymax]` giving `t0, t1`; Sutherland–Hodgman: for each edge, walk the ring's consecutive pairs and emit per the four inside/outside cases; close the ring after each pass. Round after projection, before clipping; clip in integer space.
- `mvt.ts`: `buildTile` loops `warpFeature` → `clipFeatureToTile`, collects `{ features: TileFeature[] }` per layer, encodes with `fromGeojsonVt(encoded, { version: 2, extent })`; remove the geojson-vt import and `simplifyTolerance`; `mergeLayers` point dedupe with a per-layer `Set<string>` of `` `${id}|${lng}|${lat}` `` (only when `id !== undefined`).
- `protocol.ts`: `const decoded = new EntryCache<GeographicLayers>(options.decodedTiles ?? 64)`; `loadSource` returns bytes as today; a new `decodeSource(url, bytes, tile)` consults/fills the cache; apply `config.layers` by filtering keys afterwards; `ProtocolOptions.decodedTiles?: number`. Then `buildTile(mergeLayers(decodedList), tile, config)`. Keep `warpTiles` exported for the probe.
- `package.json`: move `geojson-vt` to `devDependencies`. `npm run check:exports` must still pass; `dist/worker.mjs` should shrink (note the sizes in the commit message).
- `CLAUDE.md` "Tile pipeline" section: replace the `simplifyTolerance` paragraph with one on the direct clip and the decoded-tile cache; `README.md`: drop `simplifyTolerance` from any options list.

- [ ] **Step 5: Run the tests and verify, then measure**

Run: `npx vitest run tests/clip.test.ts tests/tiles.test.ts tests/protocol.test.ts && npm run verify`, then `npx vite-node scripts/probe-openfreemap.ts 2>&1 | tail -30` again.
Expected: PASS; per-tile warp time lower than the baseline from Step 3 (expect several-fold; if it is not at least 2× lower, profile `buildTile` with `node --cpu-prof` before committing and say what dominates in the report).

- [ ] **Step 6: Commit**

```bash
git add src/tiles/cache.ts src/tiles/clip.ts src/tiles/mvt.ts src/tiles/protocol.ts src/index.ts package.json package-lock.json tests/clip.test.ts tests/tiles.test.ts tests/protocol.test.ts CLAUDE.md README.md
git diff --cached --name-only
git commit -m "Decode each source tile once and clip directly instead of through geojson-vt" -m "Before/after per-tile warp (probe-openfreemap, z0–z3): <baseline> → <new>. dist/worker.mjs <before> → <after> bytes." -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Liberty demo of the polyfill, headless probe, docs

**Files:**
- Create: `demo/transition.html`, `demo/transition.ts`
- Create: `scripts/probe-transition.mjs`
- Modify: `README.md` (new "Adaptive transition" section + demo link), `CLAUDE.md` (Layout, Commands, Planned work), `package.json` (`scripts.probe:transition`)
- Delete (untracked, on disk only): `demo/spike/`

**Interfaces:**
- Consumes: `installEqualEarth`, `EqualEarthInstall.controllerFor`, `EqualEarthController.toMapSpace/toGeographic/blend`, `SwitchEvent`.
- Produces: the page exposes `window.__eqe = { map, controller, install, ready: true }` for the probe; URL parameters `?steps=&from=&to=&compensate=none|zoom|zoom+bearing&projection=equal|equal-earth|mercator&workers=`.

Demo behaviour (`demo/transition.ts`), modelled on the untracked spike page but using only public API:
1. `const install = await installEqualEarth(maplibregl, { workerUrl: new URL(`/dist/worker.mjs?v=${Date.now()}`, location.href), transition: { steps, from, to }, compensation, workers, onSwitch })` — the query string defeats Vite's transform cache, which otherwise serves a stale worker after `npm run build:js` (spike finding). The readout shows `install.workerPath` and `getWorkerCount()`.
2. `new maplibregl.Map({ container: 'map', style: 'https://tiles.openfreemap.org/styles/liberty', center: [139.69, 35.69], zoom: 4.6, hash: false })`; on `load`: `map.setProjection({ type: projection })` unless `mercator`; `const controller = install.controllerFor(map)`.
3. Buttons: cities (Zürich, Tokyo, San Francisco, Anchorage, Singapore) → `map.jumpTo({ center: controller.toMapSpace(city) })`; "world z2"; projection toggle (`equal` / `mercator`).
4. Readout (a `<pre>`): first idle time, layer count, parameters, and one line per `SwitchEvent`: `shown b1→b2 at z4.83 (zoom's band b2; waited 120 ms)` plus `FORCED` when forced; the current geographic centre (`controller.toGeographic(map.getCenter())`) updated on `moveend`.
5. The page's overlay panel has `pointer-events: none`, with `pointer-events: auto` on buttons and the readout only.

Probe (`scripts/probe-transition.mjs`, Node ≥ 22 for `WebSocket`): generalised from the scratch harness used in the spike: launches local Chrome headless (`--use-angle=swiftshader`, `--enable-unsafe-swiftshader`) with `--remote-debugging-port`, opens `--url` (default `http://localhost:5173/demo/transition.html`), waits for `window.__eqe.ready`, then for `--city` (default `San Francisco`): jumps to z3.5, wheel-zooms in 12 steps of two notches and back out (`Input.dispatchMouseEvent` `mouseWheel` at the canvas centre, 120 ms apart, 450 ms settle), and after each step records: requested zoom, shown band, geographic centre (via `controller.toGeographic`), and the number of empty cells in a 4×3 grid of `queryRenderedFeatures` restricted to the shown band's non-symbol layers, sampled every 100 ms for 2.5 s. At the end it prints the readout's switch lines and the page's `error` events, and exits 1 when the centre drifted more than 0.001° or any map error occurred. Flags: `--chrome <path>` (default `C:/Program Files/Google/Chrome/Application/chrome.exe`, or `$CHROME`), `--steps N` passed through to the page. Not part of `verify`; documented as a developer tool.

- [ ] **Step 1: Write the page and the probe**

Write `demo/transition.html` (same panel CSS as `index.html`, plus the `pointer-events` rules; `<div id="map">`, `<div class="panel"><div id="cities"></div><div id="controls"></div><pre id="readout">loading…</pre></div>`, `<script type="module" src="./transition.ts">`) and `demo/transition.ts` per the behaviour above. Write `scripts/probe-transition.mjs` per the probe description (keep it under ~200 lines; `scripts/*.mjs` lint with Node globals already).

- [ ] **Step 2: Run the demo and the probe**

Run: `npm run build:js` (fresh worker), `npm run dev` in the background, then `node scripts/probe-transition.mjs --city "San Francisco"` and `node scripts/probe-transition.mjs --city "Zürich" --steps 9`.
Expected: exit 0; the switch lines show holds (`waited > 0`) rather than holes while holding; the centre line is constant to 1e-3°. Paste both outputs into the task report. If a run shows an error or drift, that is a defect in Tasks 3–8, not in the probe: report it, do not patch around it.

- [ ] **Step 3: Docs**

- `README.md`: an "Adaptive transition" section (how bands, the gate, the compensation and the cross-fade work in ~15 lines; the `transition`/`compensation`/`workers` options; the documented behaviours: rendered zoom/bearing differ from requested by ≤ half a step mid-transition, `jumpTo({})` wake-ups fire move events, labels cross-fade with a possible one-fade delay when zooming out), the demo link, and the probe's usage.
- `CLAUDE.md`: Layout rows for `jacobian.ts`, `clip.ts`, `style-rewrite.ts`, `switcher.ts`, `controller.ts`, `install.ts`, `demo/transition.*`, `scripts/probe-transition.mjs`; Commands: `npm run probe:transition` (add to `package.json` scripts: `"probe:transition": "node scripts/probe-transition.mjs"`); "Planned work": Plan 2 done, Plan 3 next (cartographic finish, `EqualEarthControl`, geo API, persistent cache, browser tests, SmartMaps demo).
- Delete the untracked `demo/spike/` directory (`rm -r demo/spike`); it was never committed, so `git status` shows nothing for it.

- [ ] **Step 4: Verify and commit**

Run: `npm run verify`
Expected: PASS.

```bash
git add demo/transition.html demo/transition.ts scripts/probe-transition.mjs package.json README.md CLAUDE.md
git diff --cached --name-only
git commit -m "Add the Liberty transition demo and a headless probe for drift, holes and switch latency" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review notes (written with the spec open)

- **Spec coverage.** §3 bands/parse ranges/global state → Tasks 1, 5. §4.1 → Plan 1 (+ Task 3 fixes). §4.2 compensation → Tasks 2, 4. §4.3 gate → Task 6 (+ Task 4's selector). §6 workers → Task 7; decode once + direct clip → Task 8. §8 install/version gate/worker loading/fallback → Task 7. §9 step 8 demo + probe → Task 9. Not in this plan, by the spec's own §9: §5 cartographic finish, §7 geo API, persistent cache, browser test matrix, `EqualEarthControl` (Plan 3).
- **Type consistency.** `BandSelector` (Task 4) is what `BandSwitcher` implements (Task 6) and what the controller passes (Task 7). `showKey`/`symKey` are defined once (Task 5) and used by the switcher (Task 6). `ResolvedTransition` (Task 1) is consumed by Tasks 4–7. `SwitchEvent` is produced by Task 6 and consumed by Tasks 7 and 9. `ControllerHost` extends the three host interfaces; `SwitcherHost.on/off` take `type: string`.
- **Review Focus** items 1–5 are pinned in Tasks 7, 6, 6/7, 6/4, 4 respectively.
- **Plan 1 review carry-overs.** I1/I2/I3/m13/m14/rows 9, 10, 16 → Task 3; row 7 (validate blend in `encodeSourceUrl`) → Task 5's rewrite calls `encodeSourceUrl` with blends from `resolveTransition`, which are always in [0, 1]; add the validator to `encodeSourceUrl` in Task 5 (one `if` + one test); rows 5, 18, 22 → Task 8; m12 → spec wording fixed by the controller.
