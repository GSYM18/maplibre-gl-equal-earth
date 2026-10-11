# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```
npm run verify     # lint + typecheck + test + build + check:exports — run this before claiming done
npm run dev        # Vite dev server for the demo pages
npm test           # vitest run
npm run test:watch # vitest watch mode
npm run lint       # eslint (type-aware, .ts only)
npm run typecheck  # tsc --noEmit over src, tests, demo
npm run build      # vite build (ESM bundle) + tsc (.d.ts emit) → dist/
```

Single test file: `npx vitest run tests/camera.test.ts`.
Single test by name: `npx vitest run tests/camera.test.ts -t "crossing upward"`.

`npm run build` is two steps because Vite emits the bundle and `tsc -p tsconfig.build.json`
emits declarations separately. `npm run check:exports` runs two guards over the build.
`scripts/check-exports.mjs` diffs the built bundle's runtime exports against the value exports
declared in `src/index.ts` (it exists solely to make the 0.2.1 drift bug impossible to
reintroduce). `scripts/check-worker-bundles.mjs` asserts both worker bundles are self-contained
and actually register `eqearth` when loaded the way MapLibre v5 (`importScripts`) and v6
(`import()`) load them. `prepublishOnly` runs both.

ESLint's type-aware rules are confined to `**/*.ts`. `no-undef` is off there (tsc covers it),
which is why `scripts/*.mjs` needs an explicit `globals.node` block.

## What this package is

Equal Earth projection support for MapLibre GL JS v6, published as
`@yellowmap/maplibre-gl-equal-earth`. It is a rewrite of, and a hard fork from,
[pka/maplibre-gl-equal-earth](https://github.com/pka/maplibre-gl-equal-earth) (the old `lib/`,
proj4, and the `0.2.x` line are gone). ESM only — maplibre-gl v6 dropped CJS.

**Registry note:** this environment's npm proxy refuses packages published after 2026-08-31.
maplibre-gl is pinned to 6.6.0 (not 6.7.0) and vitest to 4.x (not 5.x) for that reason, and
`@deck.gl/maplibre` cannot be installed at all — it debuted in deck.gl 9.4.0 (2026-09-05).

## The central constraint

MapLibre has **no API for registering a custom projection**. `createProjectionFromName` is a
hard-coded switch over `mercator` / `globe` / `vertical-perspective`; an unknown name hits
`warnOnce` and silently falls back to Mercator, and `ITransform` is not exported. So Equal
Earth cannot be added as a projection. It is instead produced by **backprojection**: feed the
Mercator renderer fabricated lng/lat values chosen so that Mercator's own transform reproduces
the Equal Earth image.

```
real lng/lat → Equal Earth metres → × GRID_FACTOR → inverse Mercator → "map space" lng/lat
```

The technique is Development Seed's dirty-reprojectors (2016). Three consequences that drive
most design decisions here:

1. **"Map space" is not geographic.** While Equal Earth is active, `map.getCenter()`,
   `map.project()`, `getBounds()`, popup anchors and `queryRenderedFeatures()` all return map
   space. Anything crossing that boundary must go through `geographicToMap` / `mapToGeographic`.
2. **Equal Earth and globe are mutually exclusive.** Globe treats lng/lat as real geodetic
   coordinates, so warped input renders as a distorted sphere. The plugin disengages under globe.
3. **The renderer still believes it is Mercator**, which is the technique's hidden strength:
   labels lay out and collide in screen space as normal, so text stays upright. Raster
   reprojection approaches cannot offer that.

`GRID_FACTOR` (≈1.162) is independent of the sphere radius chosen for Equal Earth — the radius
appears in both `EQUAL_EARTH_X_MAX` and the easting it scales, and cancels. `EARTH_RADIUS` only
affects the absolute metre values from `toEqualEarth`.

## Layout

- `src/math/equal-earth.ts` — forward/inverse Equal Earth, implemented directly from
  Šavrič/Patterson/Jenny. Deliberately **not** proj4: it runs per-vertex per tile in a worker,
  and `proj4.defs` mutates a shared singleton that a host app may also be using. Dropping it
  took the bundle from ~128 kB to 3.4 kB.
- `src/math/backproject.ts` — the warp, `GRID_FACTOR`, and Web Mercator helpers.
- `src/math/subdivide.ts` — adaptive densification, and `geographicToMapWorld`'s tolerance helper.
- `src/math/antimeridian.ts` — restricts source geometry to longitude ±180° before warping.
- `src/map/bands.ts` — zoom bands: the unit the adaptive projection is built from.
- `src/map/camera.ts` — `BandCamera`, the `transformCameraUpdate` hook (`ThresholdCamera` is its
  two-band form).
- `src/map/constrain.ts` — camera clamp to the Equal Earth world, via `transformConstrain`.
- `src/tiles/tile-cover.ts` — output tile → covering source Mercator tiles.
- `src/tiles/mvt.ts` — decode → densify → warp → reslice → encode.
- `src/tiles/protocol.ts` — the `eqearth://` handler and its URL codec.
- `src/tiles/worker-entry.ts` — built twice by `vite.worker.config.ts`, as `dist/worker.mjs`
  (v6, dynamic `import()`) and `dist/worker.iife.js` (v5, classic `importScripts`). Both must be
  self-contained: v5 cannot parse `import`, and v6 imports non-`.mjs` scripts via a `blob:` URL
  where relative specifiers cannot resolve.
- `src/tiles/cache.ts` — byte-bounded LRU + in-flight request coalescing.
- `vite.worker.config.ts` — builds the two worker bundles (see `worker-entry.ts`).
- `demo/` + root `index.html` — Vite demo pages, not part of the published package.
- `scripts/check-exports.mjs` — build-artifact drift guard.
- `scripts/probe-openfreemap.ts` — runs the real pipeline against live OpenFreeMap tiles.
  `npx vite-node scripts/probe-openfreemap.ts`. Needs network; not part of `npm run verify`.

Both `map/` modules type their map dependency **structurally** rather than importing
`maplibre-gl`, so they are unit-testable with a plain fake and no WebGL context. Keep that
property; it is why `tests/camera.test.ts` can drive a 16-case state machine in milliseconds.

`EQUAL_EARTH_X_MAX` is **derived**, not hardcoded. The widely-quoted EPSG:8857 bound
`17243959.06` was computed with the authalic radius 6371007.1809 while the CRS declares
`+R=6371008.7714` — a 4.3 m inconsistency. Harmless visually, but hardcoding it decouples the
constant from the radius. `tests/equal-earth.test.ts` asserts against both the published bounds
and the derived form.

## ThresholdCamera: why it looks the way it does

`ThresholdCamera` is a two-band `BandCamera`. Both are pinned by `tests/band-camera.test.ts`
and `tests/camera.test.ts`, whose fakes in `tests/support/fake-maplibre.ts` model the real
mechanism, with line references:

- **How MapLibre feeds the hook.** Gestures and animations apply each frame's delta to a
  *requested* state `R` (`_requestedCameraState`). `getTransformForUpdate()` clones `R` from the
  rendered transform `T` and keeps it. `applyUpdatedTransform` runs the hook on a copy of `R` and
  writes the result to `T` **only**. So the hook never sees its own previous output. Every frame
  hands it `R`, whose centre is still in the map space of the band `R` was created in.
- **Convert relative to a baseline band.** The hook converts from that *baseline* band to the
  frame's band, and is a pure function of the two. The baseline is reset from the rendered zoom
  on the `moveend` that deletes `R`. On v6 that is only the **Camera's own** `moveend`
  (`host._camera`). A `moveend` the Map fires itself (a gesture ending without inertia, which
  includes every scroll zoom) does not bubble down, so `R` survives it.
- **Closing that v6 gap.** v5 deletes `R` on every `moveend`, v6 only on Camera-fired ones. A
  surviving `R` keeps the old band's space, so an app's `jumpTo({ center })` in the rendered
  band was misread (Guadalajara 1.74° off). So on a Map-fired `moveend` the camera deletes `R`
  itself, unless an ease is running (`_camera.isEasing()`; a v6 `Map` has no `isEasing`).
- **A gesture interrupting an ease.** The HandlerManager takes `R` *before* `stop(true)`, and
  that `stop` fires the Camera's `moveend`, which deletes `R`. So the interrupting frame renders
  a detached `R`, still in the space of the baseline the reset replaced. The hook spots this
  because `_requestedCameraState` is absent at hook time. It converts that frame from the
  previous baseline. The same applies to an ease whose `R` a mid-ease `moveend` deletes: on v6
  through `setVerticalFieldOfView`, on v5 through any Map `moveend`.
- **History.** The original compared against a zoom frozen at `movestart` and re-converted every
  frame (a Zürich pinch landed 24° off). The first rewrite compared against the previous frame's
  band, and so converted only on the crossing frame: the next frame rendered the unconverted `R`
  again, a ~217 px jump at Guadalajara at z6. A one-shot `jumpTo` hid this, because its own
  `moveend` deletes `R`.
- **State initialised in the constructor.** The original's `_zoomstart` was only assigned in an
  event handler, so it was `undefined` until first interaction. `undefined` fails *both* `<` and
  `>=`, so an initial `flyTo` across the threshold was silently left unconverted. Measured ~4° off.

`moveend` listeners are required: one on v5 (the Map), two on v6 (the Camera and the Map).
`destroy()` removes them. It also restores the host's prior `transformCameraUpdate` rather than nulling it,
unless the application replaced ours after we installed.

For clamping the camera to the Equal Earth world, prefer **`transformConstrain`** over
`transformCameraUpdate`: it is threaded into `createProjectionFromName` and survives projection
switches, whereas `migrateProjection` swaps `this.transform` wholesale and leaves
`transformCameraUpdate`'s `_requestedCameraState` stale.

## Publishing

`dist/` is gitignored and **not committed**. It is built by `prepublishOnly`, which also runs
typecheck and tests. This is deliberate: the previous workflow force-added `dist/` past
`.gitignore`, a human forgot to rebuild after a rename, and source / committed bundle / published
tarball drifted three ways — `0.2.1` on npm exports a function name that no longer exists and is
missing two that do. Never reintroduce `git add -f dist/`.

## Tile pipeline: what the measurements showed

Numbers from `scripts/probe-openfreemap.ts` against live OpenFreeMap Liberty. Keep these in
mind before "optimising" anything here.

- **Warp cost is 100–450 ms per output tile** (z0–z3, Node). That is why the protocol is
  registered in the worker pool, not on the main thread.
- **Source volume dominates, not CPU.** Output tile 2/1/1 needs 9 source tiles totalling
  9.4 MB to produce 516 kB. The byte-bounded LRU plus request coalescing in `cache.ts` is
  what makes this viable: neighbouring output tiles share nearly all of their source cover.
- **Subdivision adds only 1–3% vertices on real data.** This surprised us and is worth not
  re-litigating: OpenMapTiles/Planetiler geometry is already vertex-dense at low zoom, so
  almost no segment is long enough for the warp to deviate by a whole tile unit. Deviation
  scales with the *square* of segment length. Subdivision is not broken — `tests/tiles.test.ts`
  proves a long meridian gains >5× vertices end to end — it simply finds little to do. The
  visual risk from straight chords is therefore much smaller than anticipated.
- **`simplifyTolerance` defaults to 0, not geojson-vt's 3.** At 3 it deletes exactly the
  vertices subdivision adds. There is a regression test for this.
- **Equal Earth fills only ~49% of the Mercator grid vertically**, so whole rows of tiles
  (e.g. z2/0/0) are outside the world. `sourceTilesFor` returns `[]` for those and the
  protocol short-circuits without fetching.
- **Layers legitimately disappear** from an output tile when their geometry warps outside it.
  The probe's `explainDrop` distinguishes that from a bug; a verified example is `landcover`
  in z3/4/3, whose features warp to world x[0.674, 0.738] while the tile is x[0.500, 0.625].

Known artifact, not yet addressed: source tiles are clipped upstream, so a polygon spanning
several source tiles arrives as several pieces. After warping, the pieces meet exactly (the
shared edge derives from the same geographic tile boundary and `densify` is deterministic),
but hairline seams in fills are still possible.

## Planned work

Plan 1 (worker bundles, blended warp, `BandCamera`, constraint, spike) is done. Plan 2 (smooth
transition, `docs/superpowers/plans/2026-10-11-plan-2-smooth-transition.md`) is next; Plan 3
follows it.

Upstream is moving on this: [maplibre-gl-js#8330](https://github.com/maplibre/maplibre-gl-js/issues/8330)
tracks a native adaptive Equal Earth. The plugin is intentionally shaped as a polyfill so it can
be deleted when that lands.
