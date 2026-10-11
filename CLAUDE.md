# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## Commands

```
npm run verify     # lint + typecheck + test + build + check:exports: run before claiming done
npm run dev        # Vite dev server for the demo pages
npm run build:js   # bundles only, no .d.ts: refreshes dist/worker.mjs, which the demos load
npm run probe:transition  # headless-Chrome probe of demo/transition.html; not part of verify
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

`npm run probe:transition` (`scripts/probe-transition.mjs`; flags `--city`, `--steps`,
`--anchor dx,dy`, `--url`, `--chrome`, `--port`, `--timeout`) needs Node ≥ 22 (global
`WebSocket`), local Chrome, the network, a fresh `npm run build:js` and `npm run dev` already
running. It drives the transition demo with real wheel events. Exit 1 means a finding: centre
drift above 0.001°, a map `error` or an uncaught page exception; exit 2 means the probe could
not run. With the wheel at the centre (default) the centre must not drift; `--anchor 300,0`
wheels off-centre and reports the per-step snap of the place under the pointer, the ceiling
the README states. Headless Chrome renders through SwiftShader, 5–15 s per band: use it for
correctness and geometry (switches happen, nothing drifts, nothing errors, snap sizes), never
for timing. Its empty-cell count is a rough hole detector (opacity-blind; see the header).
**Do not edit anything under `src/` or `demo/` while it runs**: Vite reloads the page and the
probe dies mid-run.

ESLint's type-aware rules are confined to `**/*.ts`. `no-undef` is off there (tsc covers it),
which is why `scripts/*.mjs` needs an explicit `globals.node` block.

## What this package is

Equal Earth projection support for MapLibre GL JS v6, and v5 from 5.24, published as
`@yellowmap/maplibre-gl-equal-earth`. It is a rewrite of, and a hard fork from,
[pka/maplibre-gl-equal-earth](https://github.com/pka/maplibre-gl-equal-earth) (the old `lib/`,
proj4, and the `0.2.x` line are gone). ESM only — maplibre-gl v6 dropped CJS.

**Registry note:** this environment's npm proxy refuses packages published after 2026-08-31.
maplibre-gl stays at 6.6.0, not 6.7.0 (`package.json` declares `^6.6.0`; the lockfile pins
6.6.0), and vitest at 4.x, not 5.x, for that reason, and `@deck.gl/maplibre` cannot be
installed at all — it debuted in deck.gl 9.4.0 (2026-09-05).

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
   space, and under `equal` that space is the *shown band's*. Anything crossing that boundary
   must go through the controller's `toMapSpace` / `toGeographic`; the bare `geographicToMap` /
   `mapToGeographic` default to blend 0 and are right only for pure `equal-earth`.
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
- `src/math/subdivide.ts` — adaptive densification, and `geographicToMapWorld`'s tolerance
  helper.
- `src/math/antimeridian.ts` — restricts source geometry to longitude ±180° before warping.
- `src/math/jacobian.ts` — the local Jacobian of a band step relative to Mercator and its
  similarity part (rotation + isotropic scale): the zoom and bearing offsets the camera absorbs
  (spec §4.2). Only shear is left, and nothing in a tile-warp polyfill can absorb that.
- `src/map/bands.ts` — zoom bands: the unit the adaptive projection is built from.
- `src/map/camera.ts` — `BandCamera`, the `transformCameraUpdate` hook (`ThresholdCamera` is its
  two-band form).
- `src/map/constrain.ts` — camera clamp to the Equal Earth world, via `transformConstrain`.
- `src/map/style-rewrite.ts` — pure: original style → banded style (one source and one layer
  copy per band, parse ranges, the gate table) plus `applyGate`. Gating is literal paint values
  set through `setPaintProperty`, never `global-state`: MapLibre re-evaluates a transition's
  prior expression against the live state, so a `global-state` flip can never cross-fade.
  Symbol, hillshade and color-relief copies are also hidden by `visibility: "none"`
  (`LayerGate.hideByVisibility`): transparent labels still collide, and a `basic` hillshade still tints
  at exaggeration 0.
- `src/map/switcher.ts` — `BandSwitcher`, the band selector: which band is *shown* is runtime
  state, moved only when the target band's sources report `isSourceLoaded`. Readiness is
  judged at the last *rendered* zoom, because `isSourceLoaded` is vacuously true for a source
  no layer used.
- `src/map/controller.ts` — one map's lifecycle: rewrite, install switcher + camera +
  constraint, follow the app's `setStyle`, restore. Its module doc records MapLibre's style
  event ordering, which decides when it may tear down and re-install (C7).
- `src/install.ts` — `installEqualEarth`: version gate, worker count, worker bundle loading
  with the main-thread fallback (also on a `workerTimeoutMs` timeout), and the
  `setProjection`/`getProjection` polyfill. A second install on the same `Map.prototype`
  (HMR) returns the first, through a `Symbol.for` marker.
- `src/tiles/tile-cover.ts` — output tile → covering source Mercator tiles.
- `src/tiles/mvt.ts` — decode → dedupe label points → densify → warp → clip → encode.
- `src/tiles/clip.ts` — direct clip into the buffered output tile (Sutherland–Hodgman rings,
  Liang–Barsky segments). Replaced geojson-vt, which is now a devDependency kept only as the
  reference in `tests/clip.test.ts`.
- `src/tiles/protocol.ts` — the `eqearth://` handler and its URL codec.
- `src/tiles/worker-entry.ts` — built twice by `vite.worker.config.ts`, as `dist/worker.mjs`
  (v6, dynamic `import()`) and `dist/worker.iife.js` (v5, classic `importScripts`). Both must be
  self-contained: v5 cannot parse `import`, and v6 imports non-`.mjs` scripts via a `blob:` URL
  where relative specifiers cannot resolve.
- `src/tiles/cache.ts` — byte-bounded LRU (raw tiles), count-bounded `EntryCache` (decoded
  tiles), in-flight request coalescing.
- `vite.worker.config.ts` — builds the two worker bundles (see `worker-entry.ts`).
- `demo/` + root `index.html` — Vite demo pages, not part of the published package.
- `demo/transition.html` + `.ts` — the adaptive transition on OpenFreeMap Liberty, public API
  only. It passes `workerUrl: /dist/worker.mjs?v=<now>`: under `vite dev` the library's own
  `new URL('./worker.mjs', import.meta.url)` resolves into `/src/`, where no worker exists, so
  it would silently warp on the main thread; and without the query Vite keeps serving its
  cached transform of an older `dist/worker.mjs`. Exposes `window.__eqe` for the probe.
- `scripts/check-exports.mjs` — build-artifact drift guard.
- `scripts/check-worker-bundles.mjs` — the two worker bundles load and register `eqearth`.
- `scripts/probe-transition.mjs` — the headless probe of the transition demo (see Commands).
- `scripts/probe-openfreemap.ts` — runs the real pipeline against live OpenFreeMap tiles.
  `npx vite-node scripts/probe-openfreemap.ts`. Needs network; not part of `npm run verify`.

All `map/` modules and `install.ts` type their MapLibre dependency **structurally** rather
than importing `maplibre-gl`, so they are unit-testable with a plain fake and no WebGL context,
and work with whichever major the app loaded (`tests/host-types.test.ts` checks real v5 and v6
maps against the interfaces). Keep that property; it is why `tests/camera.test.ts` can drive
21 state-machine cases in milliseconds.

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
- **Baseline offsets.** The hook also returns continuous zoom and bearing offsets (spec §4.2)
  and `R` is cloned from the rendered `T`, which carries them, so the baseline records the
  offsets in effect when `R` was created and the hook subtracts them before deciding the band
  and converting. A *selector* (the switcher, spec §4.3) may pick the band instead of the zoom.
- **Closing that v6 gap.** v5 deletes `R` on every `moveend`, v6 only on Camera-fired ones. A
  surviving `R` keeps the old band's space, so an app's `jumpTo({ center })` in the rendered
  band was misread (Guadalajara 1.74° off). So on a Map-fired `moveend` the camera deletes `R`
  itself, unless an ease is running (`_camera.isEasing()`; a v6 `Map` has no `isEasing`).
- **A gesture interrupting an ease.** The HandlerManager takes `R` *before* `stop(true)`, and
  that `stop` fires the Camera's `moveend`, which deletes `R`. So the interrupting frame renders
  a detached `R`, still in the space of the baseline the reset replaced. The hook spots this
  because `_requestedCameraState` is absent at hook time. It converts that frame from the
  previous baseline. The same applies to an ease whose `R` a mid-ease `moveend` deletes: on v6
  through `setVerticalFieldOfView`, on v5 through any Map `moveend`. A second such `moveend`
  during the same ease must not overwrite `#previousBaseline` (m13), and the stale frame's band
  is adopted as the baseline only once its conversion proved finite (m14).
- **Gesture end before inertia.** A gesture released with inertia ends without any `moveend`:
  the HandlerManager fires its `*end` events (`dragend`, `zoomend`, `rotateend`, `pitchend`,
  `rollend`) on the Map, then calls `easeTo` with a centre and anchor computed from the
  **rendered** `T`. That ease ran on the surviving `R`, still in the baseline band's space: a
  double conversion (1.74° at Guadalajara). So on each `*end` the camera deletes `R` (on v5
  too) and re-bases, and the inertial ease clones a fresh `R` from `T`. The Camera fires
  `zoomend`, `rotateend`, `pitchend` and `rollend` itself just before its own `moveend`
  (`_afterEase`, `jumpTo`). After an ease frame, that `*end` is ignored: a gesture
  interrupting the ease holds that ease's `R`, and re-basing on the `*end` and again on the
  `moveend` would lose its space. The fakes model all of this.
- **Construct the camera before adding `moveend` listeners that move the map** (m11). An app
  listener registered earlier runs first, so its `jumpTo` reuses a stale `R` against a stale
  baseline. The gesture-end fix narrows this window but does not close it.
- **History.** The original compared against a zoom frozen at `movestart` and re-converted every
  frame (a Zürich pinch landed 24° off). The first rewrite compared against the previous frame's
  band, and so converted only on the crossing frame: the next frame rendered the unconverted `R`
  again, a ~217 px jump at Guadalajara at z6. A one-shot `jumpTo` hid this, because its own
  `moveend` deletes `R`.
- **State initialised in the constructor.** The original's `_zoomstart` was only assigned in an
  event handler, so it was `undefined` until first interaction. `undefined` fails *both* `<`
  and `>=`, so an initial `flyTo` across the threshold was silently left unconverted. Measured
  ~4° off.

`moveend` listeners are required: one on v5 (the Map), two on v6 (the Camera and the Map).
The five gesture `*end` listeners go on the Map in both. `destroy()` removes them all. It also
restores the host's prior `transformCameraUpdate` rather than nulling it, unless the
application replaced ours after we installed.

For clamping the camera to the Equal Earth world, prefer **`transformConstrain`** over
`transformCameraUpdate`: it is threaded into `createProjectionFromName` and survives projection
switches, whereas `migrateProjection` swaps `this.transform` wholesale and leaves
`transformCameraUpdate`'s `_requestedCameraState` stale. The override is called **instead of**
`defaultConstrain` (min/max zoom, `maxBounds`, Mercator's world fill), so ours composes with it:
`installEqualEarthConstrain` reads it lazily from `map.transform` (v5) or `map._camera.transform`
(v6 `Map` has no `transform`). MapLibre also constrains `R` on every `setZoom`/`setCenter`, in
the requested zoom's band while `R`'s centre is in the baseline band's space, so the clamp is
never tighter than `baselineBand`'s edge (I3: Svalbard used to land at 70.65°).

## Publishing

`dist/` is gitignored and **not committed**. It is built by `prepublishOnly`, which also runs
typecheck and tests. This is deliberate: the previous workflow force-added `dist/` past
`.gitignore`, a human forgot to rebuild after a rename, and source / committed bundle / published
tarball drifted three ways — `0.2.1` on npm exports a function name that no longer exists and is
missing two that do. Never reintroduce `git add -f dist/`.

## Tile pipeline: what the measurements showed

Numbers from `scripts/probe-openfreemap.ts` against live OpenFreeMap Liberty. Keep these in
mind before "optimising" anything here.

- **Warp cost was 100–450 ms per output tile** (z0–z3, Node, before the direct clip and the
  decode cache; ~20–70 ms now, single-shot in the probe). That is why the protocol is
  registered in the worker pool, not on the main thread.
- **Source volume dominates, not CPU.** Output tile 2/1/1 needs 9 source tiles totalling
  9.4 MB to produce 225 kB. The byte-bounded LRU plus request coalescing in `cache.ts` is
  what makes this viable: neighbouring output tiles share nearly all of their source cover.
- **Subdivision adds only 1–3% vertices on real data.** This surprised us and is worth not
  re-litigating: OpenMapTiles/Planetiler geometry is already vertex-dense at low zoom, so
  almost no segment is long enough for the warp to deviate by a whole tile unit. Deviation
  scales with the *square* of segment length. Subdivision is not broken — `tests/tiles.test.ts`
  proves a long meridian gains >5× vertices end to end — it simply finds little to do. The
  visual risk from straight chords is therefore much smaller than anticipated.
- **Decode dominated, not the clip.** Decoding the 9 sources of 2/1/1 costs ~140–170 ms and
  ~40 MB of heap (decoded GeoJSON is ~4.4× the raw bytes); building the tile from them costs
  ~35–45 ms warmed. So the protocol keeps a per-worker `EntryCache` of decoded source tiles
  by URL (default 32): one decode serves every band and every overlapping output tile.
  `ProtocolOptions.decodedTiles` cannot be set from the shipped worker bundle, which has no
  configuration channel yet; only a protocol built with `createEqualEarthProtocol` takes it.
  Warmed, per output tile with the decode cached: 2/1/1 218 → 45 ms, 3/4/3 131 → 24 ms
  against the old decode + geojson-vt path.
- **The direct clip (`clip.ts`) replaced geojson-vt.** It matches geojson-vt per layer
  (feature counts, line lengths, ring areas) in a synthetic comparison in `tests/clip.test.ts`,
  plus a one-off scratch check on real OpenFreeMap tiles; a committed real-tile fixture is
  deferred to Plan 3 (Ruling P19). Ring areas differ only by buffer slivers, because vertices
  are rounded before clipping. It does not wrap world copies into the buffer, which geojson-vt
  did at z0–1. Build alone measured only 1.4–1.8× faster; the 2.5–5.5× end-to-end gain above
  is the decode cache. The profile is dominated by the warp's projection maths (~40%:
  `toEqualEarth` runs twice per vertex, and map-space lng/lat makes a Mercator round trip),
  then vt-pbf's property encoding (~17%; OpenFreeMap features carry ~80 `name:*` tags),
  densify (~10%) and the clip itself (~10%).
  A cheap geographic-bbox reject against the tile's pre-image skips the warp for features
  wholly outside it. It is safe because the warp is pseudocylindrical: the tile's horizontal
  edges map back to parallels and its vertical edges to longitudes monotone in |lat|, so the
  pre-image's extremes sit at sampled edge endpoints; the box is taken with twice the tile
  buffer, far more than the ~1 tile unit a densified chord deviates. `tests/clip.test.ts`
  ("buildTile pre-warp reject") fails without that margin. Nothing is simplified (the old
  `simplifyTolerance` is gone), so subdivision vertices survive; `tests/tiles.test.ts` pins
  that.
- **Label points were emitted once per source tile.** OpenFreeMap z2 tiles repeat a label in
  up to 9 source tiles' buffers; the old output for 2/1/1 held 1959 place points of which 228
  were distinct, and was 503 kB instead of 225 kB. `mergeLayers` now drops a point whose
  in-world positions (world copies beyond ±180° ignored) were already seen with the same `id`
  in that layer.
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

Plan 1 (worker bundles, blended warp, `BandCamera`, constraint, spike) and Plan 2 (smooth
transition: bands, compensation, style rewrite, gated switcher, controller,
`installEqualEarth`, throughput, demo + probe;
`docs/superpowers/plans/2026-10-11-plan-2-smooth-transition.md`) are done. Plan 3 is next and
not yet written: the cartographic finish (spec §5), `EqualEarthControl` (MapLibre's
`GlobeControl` reads `equal` as "not Mercator" and turns it off), a geographic API over the
map-space one with GeoJSON fan-out (§7), a persistent tile cache, a browser test matrix on
v5.24 and v6, and a SmartMaps demo.

The stepped transition has a ceiling: after compensation, shear still snaps at each step
(300 px off-centre, six steps: Zürich ≈ 7 px, San Francisco ≈ 16 px), shrinking only as
1/steps. Only per-vertex interpolation in the renderer removes it. Whether that is good enough
is an open product decision for the user, not a plan item; do not try to tune it away.

Upstream is moving on this:
[maplibre-gl-js#8330](https://github.com/maplibre/maplibre-gl-js/issues/8330) tracks a native
adaptive Equal Earth. The plugin is intentionally shaped as a polyfill so it can be deleted
when that lands.
