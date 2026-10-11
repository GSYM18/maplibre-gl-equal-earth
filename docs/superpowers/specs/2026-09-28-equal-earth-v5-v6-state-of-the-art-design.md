# Equal Earth for MapLibre GL JS v5 + v6 — state-of-the-art design

Date: 2026-09-28 · Amended 2026-10-11 after the transition spike (§3, §4, §6, §9; the spike's findings are in `docs/superpowers/spikes/2026-09-28-band-transition.md`) · Status: approved, Plan 1 done · Supersedes Phases 3–4 of
`~/.claude/plans/review-the-implementation-the-smooth-stearns.md` (Phases 1–2 are done and
remain the foundation).

## 1. Brief

**Goal.** `@yellowmap/maplibre-gl-equal-earth` becomes a state-of-the-art, **client-only**
Equal Earth polyfill for **MapLibre GL JS ≥ 5.24 and 6.x**, working against any EPSG:3857
vector tileset — specifically OpenMapTiles-schema styles (OpenFreeMap Liberty) and SmartMaps
Tiles. It is shaped so it can be deleted when native support
([maplibre-gl-js#8330](https://github.com/maplibre/maplibre-gl-js/issues/8330)) lands.

**Decisions taken during brainstorming**

| Question | Decision |
|---|---|
| MapLibre versions | v5 (≥ 5.24) **and** v6 |
| SmartMaps | YellowMap operates it, but the plugin stays **client-only**; no server-side pre-baking |
| SmartMaps auth | API key in the URL (already carried inside the `eqearth://` URL) |
| Adaptive transition | **Stepped blend** (approach A), gated by a visual spike |
| API transparency | **"Data in, geo out"** (§7) |

**Success criteria (all four are must-haves)**

1. **Native-like API.** `map.setProjection({type:'equal'|'equal-earth'})` per
   [style-spec#1623](https://github.com/maplibre/maplibre-style-spec/pull/1623);
   `mercator`/`globe` pixel-identical to a build without the plugin; `EqualEarthControl`;
   geographic in and out for GeoJSON, camera methods, `project`/`unproject`, Marker, Popup and
   event `lngLat`.
2. **Cartographic finish.** Curved world outline; ocean/land fill only inside the Equal Earth
   shape; optional graticule; Antarctica and the Arctic Ocean reaching ±90°; no visible fill
   seams at 1× and 2× DPR.
3. **Smooth adaptive zoom.** `equal` transitions in steps (default six, z4–z8, §3). The camera
   centre stays within **1 px** of the same geographic point across every step, under pinch,
   scroll and `flyTo`; the local scale and rotation at the centre change continuously with
   zoom (§4); a step is shown only once its tiles are drawable, so the map is never blank at a
   step (§4); the remaining geometry change is cross-faded, not cut.
4. **Fast first paint.** World view at 1280×800: **≤ 4 s cold at 50 Mbit/s**, **≤ 1.5 s
   warm**, measured with `performance.mark` in the demo. No warping on the main thread
   (except the documented worker-failure fallback).

**Non-goals.** Server-side pre-projected tiles; warping raster or hillshade sources; terrain;
Equal Earth and globe simultaneously; converting `queryRenderedFeatures` geometry or deck.gl
overlays back to geographic.

## 2. Findings that shape the design

**v5 compatibility.** Checked against the `maplibre-gl@5.24.0` tarball: `transformCameraUpdate`,
`transformConstrain`, `addProtocol`, `importScriptInWorkers`, `setProjection` and
`projectiontransition` all exist with signatures matching v6 (`importScriptInWorkers` returns
`Promise<void[]>` in v5 vs `Promise<void>` in v6). The structurally typed `map/` modules need no
changes for v5.

**Worker loading differs, and the current bundle is broken on both.**

- v5 loads imported scripts with classic `importScripts(url)`, so any top-level
  `import`/`export` is a syntax error.
- v6 `loadScript`: `.mjs` URLs → `import(url)`; other URLs → fetch, sniff for ESM, then
  `import()` via a `blob:` URL (or `eval` for IIFE).
- The current `dist/worker.js` begins `import { … } from "./protocol-….js"`. Under v6 it takes
  the `blob:` path, where a relative specifier cannot resolve
  (`new URL('./x.js', 'blob:…')` → `ERR_INVALID_URL`). Under v5 it fails to parse. The bug is
  latent only because `installEqualEarth` does not exist yet, so nothing loads the bundle.

**The size of the jump at a hard Equal Earth → Mercator switch.** Measured from the Jacobian
of `geographicToMapWorld` against Web Mercator (scratch script, decomposed via 2×2 SVD):

| Place | zoom jump | rotation | anisotropy |
|---|---|---|---|
| Zürich (8.5, 47.4) | −0.35 | −1.3° | 1.16× |
| Equator (0, 0) | +0.21 | 0.0° | 1.35× |
| New York | −0.18 | +10.2° | 1.43× |
| Tokyo | −0.09 | −16.7° | 1.82× |
| San Francisco | −0.12 | +15.5° | 1.73× |
| Reykjavík | −0.98 | +3.8° | 2.06× |
| Anchorage | −0.84 | +25.1° | 2.94× |

A hard switch is acceptable in central Europe and clearly jarring across much of the world.
The table is the baseline the transition spike (§4) must beat.

**The camera hook moved in v6.** v6's `Map` no longer extends `Camera`; `transformCameraUpdate`
lives on a private `map._camera` and is set through `map.setTransformCameraUpdate()`, with no
public getter. Assigning `map.transformCameraUpdate` — what `ThresholdCamera` did — is a no-op
on v6. Fixed in Plan 1 via `cameraHookAccess`, pinned by a compile-time test against both
majors' `Map` types.

**The Liberty style.** 111 layers: 1 background, 1 raster (`ne2_shaded`, maxzoom 6), 16 fill,
67 line, 25 symbol, 1 fill-extrusion. Sources: `openmaptiles` (vector) and `ne2_shaded`
(raster). The background, `#f8f4f0`, is the land colour; oceans come from the OMT `water`
layer.

## 3. Architecture: bands

A **band** is a zoom range with a constant blend factor `t` (0 = Equal Earth, 1 = Mercator):

```
world_t(p) = (1 − t) · geographicToMapWorld(p) + t · mercatorWorld(p)
```

`world_t` is continuous in `p`, so warped geometry never tears.

**Transition** `{ from = 4, to = 8, steps = 6 }` (configurable; `steps ≥ 2`). With spacing
`s = (to − from) / (steps − 1)` and boundaries `b_k = from + (k − 1)·s` for `k = 1 … steps`:

| Band `k` | Zoom range | `t` | Source |
|---|---|---|---|
| 0 | `[−∞, b_1)` | 0 | `eqearth://` copy, blend 0 |
| `1 … steps − 1` | `[b_k, b_{k+1})` | `k / steps` | `eqearth://` copy, blend `k/steps` |
| `steps` | `[b_steps, ∞)` | 1 | the **original** source, untouched |

Default: boundaries z4.0, 4.8, 5.6, 6.4, 7.2, 8.0; blends ⅙ … ⅚; Mercator from z8. `equal-earth`
is a single band `[−∞, ∞)` at t = 0. `mercator` and `globe` have no bands: the plugin is inactive
and the style untouched. The spike settled the trade-off behind the default: the geometry
change per step shrinks as 1/steps while the number of label re-placements grows with steps,
and the range z4–z8 spreads the steps out so a zoom gesture rarely crosses two.

The **continuous blend** `t(z) = clamp((z − from)/s + ½, 0, steps) / steps` is what a
per-vertex renderer would show; it equals band `k`'s blend at the band's midpoint and is the
reference the camera compensation (§4) steers towards. It is 0 below `from − s/2` and 1 above
`to + s/2`.

**One source per band.** MapLibre draws placeholder tiles from other zooms of the *same*
source only, so each band has its own source and a placeholder always carries its own `t`.
Each band's vector layers are copies of the original layers with the suffix `__b<k>`; a layer
is copied only into bands its own zoom range overlaps.

**Parse early, show late.** MapLibre's worker parses a layer into a tile only when
`floor(minzoom) ≤ z < maxzoom`, so a copy whose range begins at its band boundary has nothing
drawable in tiles loaded before the crossing (spike finding 3: a ~2 s blank at every step).
Therefore a copy's **zoom range is only the parse range**: the band's range widened by one
spacing `s` on each side, clamped to the layer's own range; a copy whose clamped range is
empty is dropped. Whether a copy is *shown* is a runtime decision (§4) carried by **literal
paint values** that the switcher sets through `setPaintProperty` / `setLayoutProperty`:

- `fill`, `line`, `fill-extrusion`, `circle`, `heatmap`, `raster`, `hillshade` copies: the
  layer's opacity-like properties (`OPACITY` per type) hold the **original value** while the
  band is shown and the constant `0` while it is hidden, with a 250 ms `*-transition` unless
  the layer declares its own. A switch is a paint update: main thread, no re-parse. MapLibre
  interpolates from the evaluated prior value to the new one, so the bands cross-fade.
- `symbol` copies: `layout.visibility` is the layer's own value while shown and `"none"` while
  hidden. Transparent labels would still take part in collision, so symbols must really be
  hidden, which re-parses (not re-warps) the two affected sources. Their
  `text-opacity`/`icon-opacity` are gated like paint above with a 300 ms transition, so the
  outgoing band's labels fade before they are hidden.
- `raster` / `hillshade` layers (relief) exist only in the Mercator band.
- The rewrite emits every copy in the state for its initial zoom's band and returns a **gate
  table** (layer id, band, gated paint originals, own visibility) that the switcher applies.

Why not `global-state`: MapLibre re-evaluates a transition's *prior* expression against the
live global state on every frame (`TransitioningPropertyValue.possiblyEvaluate`), so a flip of
`["case", ["global-state", k], v, 0]` yields prior = final and switches instantly. Literal
values are also valid for every paint shape (legacy functions, `let`, `coalesce`), where
wrapping an expression per stop output was not.

The spec's earlier hidden *prefetch layers* are dropped: they load tiles but cannot make them
drawable.

### Components

| Module | Status | Responsibility |
|---|---|---|
| `math/backproject.ts` | done | `geographicToMap(p, t)`, `mapToGeographic(w, t)`, `worldYRange(t)`, `mapSpaceMaxLatitude(t)` |
| `math/jacobian.ts` | new | local 2×2 Jacobian of `world_t` against Mercator at a point; its rotation and isotropic scale; `similarityOffsets` (§4) |
| `math/antimeridian.ts` | done | clip to lng [−180, 180] before warping |
| `tiles/protocol.ts` | extend | `blend` in the source config (done); decoded-tile sharing across bands (§6) |
| `tiles/clip.ts` | new | direct polygon/line/point clipping to the buffered output tile, replacing geojson-vt (§6) |
| `map/bands.ts` | extend | `Band`, `validateBands`, `bandIndexForZoom` (done); `transitionBands`, `continuousBlend`, `parseRange`, `bandSourceId` |
| `map/camera.ts` | extend | `BandCamera`: baseline model (done) + similarity compensation + a band *selector* hook (§4) |
| `map/switcher.ts` | new | ready-gated band selection, hysteresis, dwell, gate application, symbol fade sequence |
| `map/constrain.ts` | done | world bounds per band |
| `map/style-rewrite.ts` | new | pure: (style, bands, options) → rewritten style (sources, copies, parse ranges, initial shown/hidden paint, transitions, raster gating) + gate table and `applyGate` |
| `map/controller.ts` | new | per-map: intercepts `setProjection`/`getProjection`, listens to `projectiontransition` and `styledata`, applies and restores the rewrite, owns camera + switcher + constrain, toggles `renderWorldCopies` |
| `map/geo-api.ts` | new (Plan 3) | per-instance wrappers and GeoJSON fan-out (§7) |
| `map/graticule.ts` | moved (Plan 3) | from `demo/graticule.ts` |
| `control.ts` | new (Plan 3) | `EqualEarthControl`, modelled on `GlobeControl` |
| `install.ts` | new | `installEqualEarth(maplibregl, options)`: version gate, worker loading, worker count (§8, §6) |

Every `map/` module keeps the rule: types are structural and there is no runtime import of
`maplibre-gl`, so it can be tested with plain fakes. `bands`, `style-rewrite` and `jacobian`
are pure.

### Data flow

```
setProjection({type})  → controller → bands(type, transition) → styleRewrite(originalStyle, bands)
                       → map.setStyle(rewritten, {diff: true}); switcher.start(initialBand)
camera frame           → BandCamera hook: requested zoom/bearing (minus baseline offsets)
                       → switcher.decide(zoom) → shown band (may flip global state)
                       → centre converted baseline band → shown band; + similarity offsets
tile request           → eqearth://<config incl. t>/{z}/{x}/{y} → worker
                       → cover → fetch (memory LRU → network) → decode once per source tile
                       → densify + warp_t → clip → MVT
```

## 4. Transition and camera

### 4.1 Centre continuity (done in Plan 1)

`BandCamera` converts the camera centre relative to a *baseline* band: the band of the rendered
transform when MapLibre's requested camera state `R` was created. Every frame of a gesture or
animation hands the hook the unconverted `R`, never the hook's previous output, so the hook is
a pure function of `R` and the baseline; the baseline is reset on the `moveend` that deletes
`R` (on v6 the Camera's own; the plugin closes v6's Map-`moveend` gap itself). A gesture that
interrupts an ease renders a detached `R`, recognised by the absent `_requestedCameraState`
and converted from the previous baseline. CLAUDE.md "ThresholdCamera: why it looks the way it
does" is the authoritative description; `tests/band-camera.test.ts` and `tests/camera.test.ts`
pin it with fakes that model the real mechanism.

Conversion: `geographic = mapToGeographic(centre, t_baseline)`;
`centre' = geographicToMap(geographic, t_shown)`; one conversion however many bands apart.

### 4.2 What a step does to the picture, and what the camera can absorb

With the centre pinned, a step from `t_a` to `t_b` moves a feature at screen offset `d` from
the centre by `(M_b − M_a)·d` to first order, where `M_t = J_t·J_1⁻¹` is the local Jacobian
of the blended warp relative to Mercator at the centre. It does not depend on zoom. Measured
(spike), 300 px from the centre, six steps: Zürich ≈ 20 px, San Francisco ≈ 30 px, Anchorage
40–125 px per step. Reducing it by step count alone would need 100+ steps.

Because the blend is linear in world space, `M_t = (1 − t)·M_0 + t·I`. Polar-decompose `M`
into a rotation `θ(M)` and an isotropic scale `σ(M) = √|det M|`; the rest is shear. The
camera can absorb the rotation and the scale, **continuously**:

```
θ*(z, c) = θ(M_{t(z)}(c))      σ*(z, c) = σ(M_{t(z)}(c))      // what a continuous blend would show
Δbearing = θ* − θ(M_{t_shown}(c))      Δzoom = log2(σ* / σ(M_{t_shown}(c)))
```

`t(z)` is the continuous blend (§3). Within a band the offsets vary smoothly with zoom (the
picture rotates and scales as it would under a per-vertex renderer); at a crossing the shown
band's `θ`, `σ` jump and the offsets jump by the opposite amount, so the frame at the centre
is continuous. Only shear snaps: measured residual at 300 px, six steps: Zürich ≈ 7 px, San
Francisco ≈ 16 px, Anchorage 18–65 px, Singapore ≈ 7 px. Offsets are zero outside
`[from − s/2, to + s/2]`, bounded by half a step inside it (≤ 0.07 zoom, ≤ 3° at Anchorage for
six steps), and switchable: `compensate: 'none' | 'zoom' | 'zoom+bearing'` (default
`'zoom+bearing'`). The sign convention is pinned by a test, not by prose: with compensation
the largest of four 300 px probes must move less than 60 % of its uncompensated displacement
at San Francisco and Zürich.

The rendered zoom and bearing therefore differ from the requested ones mid-transition. `R` is
cloned from the rendered transform, so the hook must not compensate twice: alongside the
baseline band it keeps the **baseline offsets** (the offsets in effect when `R` was created,
i.e. the last ones it returned before the `moveend`), subtracts them from `R` to recover the
requested zoom and bearing, decides the band on the requested zoom, and adds the new offsets.
An application's `jumpTo({ zoom })` or `setBearing(0)` mid-transition is read as requested
values and lands within half a step's offset of what it asked for; `getZoom()`/`getBearing()`
return rendered values. Both are documented; Plan 3's geo API may expose requested values.

### 4.3 Switch only when the next step is ready

The shown band is runtime state owned by `map/switcher.ts`, decided in the camera hook
(`BandCamera` takes a *band selector* instead of deriving the band from zoom) so the camera
conversion and the style flip happen in the same frame. Rules, evaluated on the requested zoom:

1. `target = bandIndexForZoom(z)`, with **hysteresis** `h = 0.1`: within `h` below a boundary
   the previous band is kept, so a zoom hovering at a boundary does not flip back and forth.
2. If `target === shown`: nothing.
3. Otherwise walk from `target` towards `shown`; the first band `k` whose layers are parsed at
   `z` (parse range, §3) **and** whose source reports `isSourceLoaded` (every in-view tile has
   data or errored) is shown. The Mercator band's readiness is the original source's.
4. If none is ready and `shown` is still parsed at `z`: **hold** (the map keeps drawing the old
   band; the user sees a slightly late step, never a hole).
5. If `shown` is no longer parsed at `z` (the zoom outran tile production by more than one
   spacing): **forced** switch to the parsed band nearest `target` that is loaded, else `target`.
6. A **minimum dwell** of 300 ms between switches, except forced ones, so a fast zoom through
   several bands does not cascade one blink per band.

A switch applies the new band's gates as *shown* (original paint values restored, symbols
visible: re-parse begins and labels fade in as placed) and the old band's as *fading* (gated
paint to `0`, a 250/300 ms cross-fade), then as *hidden* (symbol `visibility: "none"`) after
one symbol fade (300 ms), so labels cross-fade rather than blink. While the map is idle no camera
frame runs the hook, so when a waited-for band becomes loaded (`sourcedata`) the switcher asks
the camera to run one update (`host.jumpTo({})`, which fires `movestart`/`moveend` as any
camera change does — documented). Readiness and band parse ranges come from public API
(`isSourceLoaded`, the rewritten style); nothing reads MapLibre's private tile caches.
`isSourceLoaded` is vacuously `true` for a source that no layer used at the last render (a
band whose copies were all outside their zoom range), so a band counts as ready only if it was
also parsed at the previous frame's zoom — otherwise an app's `jumpTo` across several bands
would switch onto a band whose tiles were never requested.

**Known residuals.** (a) The pointer, not the centre, is the anchor of a scroll zoom; the hook
cannot see it, so the point under the pointer moves by about the compensated residual × its
distance from the centre at each step. (b) Labels of the outgoing band may win collision
against the incoming band's for one fade when zooming out. (c) Zooming out reveals new edge
area that is empty until its tiles arrive, as in plain MapLibre, slower here.

**What this cannot reach.** A transition that is imperceptible everywhere on screen needs
per-vertex interpolation in the renderer, as MapLibre's globe transition does
(maplibre-gl-js#8330). The polyfill is shaped to be deleted when that lands.

## 5. Cartographic finish

- **World polygon and outside colour.** In every band with t < 1, the style's `background`
  layer copy is recoloured with `outsideColor` (default `transparent`, so the container's CSS
  shows through). Directly above it, a generated GeoJSON **world polygon** is inserted: the
  Equal Earth outline, meaning the ±180° meridians densified plus the pole lines, warped per
  band and filled with the *original* background colour. If the style has no background layer,
  the world polygon is omitted and `outsideColor` becomes the background.
- **Outline and graticule** are opt-in: `outline: {color, width}` and
  `graticule: {step, color, width}` (default step 30°).
- **Poles.** Mercator data ends at ±85.0511°, while Equal Earth shows up to ±90°. Unfixed, the
  gap would show the world polygon's land colour above the Arctic Ocean. During decode,
  **polygon** vertices at or beyond ±85.0511° are snapped to ±90°. Lines and points are left
  unchanged.
- **World copies.** `renderWorldCopies` is set to `false` while a t < 1 band is active and
  restored to the host's value afterwards.
- **Fill seams.** The spike measures them in Liberty at z2–4 at 1× and 2× DPR. Mitigations, in
  order: (1) `fill-antialias: false` on the warped band copies; (2) only if (1) is
  insufficient, merge the pieces of each feature by id before reslicing.
- **Raster layers** are hidden in bands with t < 1, restored in the t = 1 band, and announced
  with one `console.info` per page. The loss of `ne2_shaded` relief is documented in the README
  as the main visual trade-off for Liberty.
- **Labels** need nothing: the renderer believes it is Mercator, so text stays upright and
  collision works normally.

## 6. Fast first paint and tile throughput

Throughput is a transition requirement, not an optimisation: a step is shown only when its
tiles are drawable (§4.3), so slow tiles mean late steps. Measured (spike): 100–750 ms warp per
band tile in Node, 12–20 tiles per screen, up to three band sources live per tile position, and
MapLibre runs **one** tile worker by default (except Safari).

- **Workers.** `installEqualEarth` sets `setWorkerCount(max(2, min(4, ⌊hardwareConcurrency/2⌋)))`
  when the count is still MapLibre's default of 1, before any `Map` exists; option
  `workers: number | false`.
- **Decode once per source tile.** The geographic decode does not depend on the blend; a
  worker-local bounded cache of decoded source tiles (by URL) serves every band and every
  overlapping output tile. The byte LRU of raw tiles remains for the fetch tier.
- **Direct clip.** geojson-vt builds a tile index per output tile and layer; it is replaced by
  `tiles/clip.ts`: Sutherland–Hodgman per ring against the buffered tile rectangle (holes stay
  separate rings, orientation is preserved), Liang–Barsky per line segment with run merging,
  a bounds test for points, then the existing vt-pbf encoder fed the same tile structure.
  Measured before merging on fixture tiles: identical feature counts per layer and ring areas
  within 0.1 % of the geojson-vt output, and a timing table in the probe.
- **Existing:** worker-side warping, the byte-bounded LRU, and request coalescing.
- **Persistent output-tile cache.** Cache Storage inside the worker. Key:
  `pluginVersion / hash(source config) / t / z / x / y`, where the hash covers the upstream
  template including the API key, so key rotation starts a fresh namespace. Defaults are
  `maxZoom: 3` and `ttlDays: 7` (OpenFreeMap rebuilds weekly). If Cache Storage is missing or
  throws (insecure context, private mode), the tier is silently skipped. Option:
  `persistentCache: false | { maxZoom, ttlDays }`.
- **`sourceZoomOffset`** (relative, e.g. −1 = ¼ of the bytes), alongside the existing absolute
  `sourceZoom`. Its default is set from measurement: the probe gains a *world-view budget*
  mode that reports bytes, warp time and dropped features for offsets 0 and −1 at z1–3.
- **Prefetch cost** stays bounded: one zoom before each band boundary, current viewport only.
- If the cold budget is missed even at offset −1, it is recorded as a finding and the budget
  is revisited with the user. It is not silently traded for server-side work.

## 7. Geo API and GeoJSON ("data in, geo out")

- **Wrapped per instance** by `installEqualEarth` (pass-through while inactive): `getCenter`,
  `setCenter`, `jumpTo`, `easeTo`, `flyTo`, `panTo` (`center`, `around`), `fitBounds`,
  `cameraForBounds`, `getBounds`, `project`, `unproject`. Conversions use the current band's
  `t`. Bounds are converted by densifying the edge, warping it and taking the bbox, because
  the image of a geographic rectangle is not a rectangle.
- **Expected for free:** Marker, Popup and `MapMouseEvent.lngLat`, provided MapLibre derives
  them from the instance's `project`/`unproject`.
- **Main risk: double conversion.** Instance wrappers also intercept MapLibre's *internal*
  calls. The first task of this area is therefore an **audit of every internal call site** of
  each wrapped method in v5.24.0 and v6.6.0. It decides which methods are wrapped, and settles
  how a `flyTo` target centre interacts with `BandCamera` during an animation. Browser tests
  (§8) lock the outcome in.
- **GeoJSON.** Sources with inline or URL data are fanned out into one copy per band, densified
  with that band's tolerance and warped on the main thread. `getSource(id).setData()` is
  wrapped to update all copies; `addSource`/`removeSource` for GeoJSON are routed through the
  controller. Clustering happens in map space, which is accepted.
- **Not converted (documented):** `queryRenderedFeatures` geometry and deck.gl overlays.
  `geographicToMap`/`mapToGeographic` stay exported.

## 8. Compatibility, testing, error handling

### Compatibility and build

- `installEqualEarth(maplibregl, { workerUrl?, native?: 'auto' | 'never' })`:
  - `getVersion()` ≥ 6 → `importScriptInWorkers(worker.mjs)`;
  - 5.24 ≤ version < 6 → `importScriptInWorkers(worker.iife.js)`;
  - anything older → throws with a clear message.
- The default worker URL is `new URL('./worker.mjs' | './worker.iife.js', import.meta.url)`, so
  bundlers emit it as an asset. `workerUrl` overrides it (CDN, custom CSP).
- `native: 'auto'` behaves as `'never'` until #8330 defines a detectable signal; updating it is
  part of the native-support migration.
- CSP: neither worker path needs `blob:` or `unsafe-eval`; only `script-src` for the worker URL.
- Build: three Vite outputs — the `index.js` ESM library, a self-contained `worker.mjs` (ESM,
  no chunks) and `worker.iife.js`.
- `check:exports` gains a guard: worker bundles contain no relative imports, and
  `worker.iife.js` contains no top-level `import`/`export`.
- `peerDependencies`: `"maplibre-gl": ">=5.24 <7"`. The v5 test dependency is installed as a
  devDependency alias: `"maplibre-gl-v5": "npm:maplibre-gl@5.24.0"`.

### Testing

**vitest (node, existing harness):**
- `bands`;
- `style-rewrite` golden tests against a committed Liberty style fixture;
- `BandCamera` — the existing 16-case matrix extended to multiple bands and multi-band jumps;
- `world_t` and Newton-inverse convergence;
- pole snapping on a z0 tile;
- persistent cache with a fake Cache API;
- `geo-api` with a fake map;
- the worker-bundle guard.

**Browser (new, `npm run test:browser`, part of `verify`):**
- Playwright on Chromium with software WebGL, run once with v5.24.0 and once with v6.6.0.
  Local fixture tiles, no network. Playwright is pinned to a release before 2026-08-31 (the
  registry cutoff).
- Assertions:
  - tiles are warped in the worker (no main-thread fallback warning);
  - `mercator` and `globe` screenshots are identical with and without the plugin;
  - the centre is within 1 px across band crossings (pinch, scroll, `flyTo`);
  - `e.lngLat` is geographic;
  - Marker placement is correct;
  - a `setStyle` round trip keeps Equal Earth active;
  - `destroy()` restores the original style and hooks.

**Manual, needs network:** `scripts/probe-openfreemap.ts` world-view budget mode, and the
first-paint marks in the demo against OpenFreeMap and SmartMaps.

### Error handling

| Situation | Behaviour |
|---|---|
| Source tile 404 | Treated as empty (e.g. open ocean) |
| Other upstream fetch error | Propagated to MapLibre, which marks the tile errored and retries as usual |
| Newton inverse does not converge | `onConversionFailure` (existing pattern), conversion skipped |
| Worker bundle fails to load or times out | Main-thread fallback handler registered, one `console.warn` |
| `setStyle` while active | `styledata` re-applies the rewrite; rewritten styles carry `metadata["equal-earth:rewritten"]` so the plugin's own `setStyle` does not re-trigger |
| `getProjection()` when the style declares none | Returns `undefined` while inactive, `{type}` while active |
| Switch to `globe`/`mercator` | Original style, `renderWorldCopies` and camera hooks restored exactly |

## 9. Delivery order

Plan 1 (done): 1. worker bundles; 2. visual spike (GO, amended); 3. `world_t`, inverse,
`BandCamera` centre continuity, per-band constrain, antimeridian clip.

Plan 2 (smooth transition, end to end on the Liberty demo):
4. `bands` transition model; `jacobian` and similarity compensation in `BandCamera`.
5. `style-rewrite` with parse ranges, global-state gating and transitions; `switcher`.
6. `controller` (`setProjection` polyfill, `styledata`, restore), `installEqualEarth`
   (version gate, worker loading, worker count).
7. Throughput: decoded-tile sharing, direct clip replacing geojson-vt.
8. Demo `demo/transition.html` on OpenFreeMap Liberty replacing the spike, with a committed
   headless probe (`scripts/probe-transition.mjs`, needs local Chrome, not part of `verify`)
   that measures centre drift, holes and switch latency per step.

Plan 3: cartographic finish (§5); `EqualEarthControl`; geo API audit, `geo-api`, GeoJSON
fan-out (§7); persistent cache and `sourceZoomOffset` (§6); browser test matrix on v5.24 and
v6.6; SmartMaps demo; README.

## 10. Risks

- **Steps still look jarring after compensation and cross-fade** → the demo lets the human
  compare `steps`, `from`, `to`; the residual is shear, which only in-renderer interpolation
  removes (#8330). Recorded as a product decision, not a plan item.
- **Tile throughput too low for the gate on slow devices** → steps arrive late (held), never
  blank; §6's three measures; `steps` can be lowered per deployment.
- **Global state in `visibility` re-parses on every switch** → bounded to the two affected
  sources; measured in the demo probe as switch latency.
- **Layer count from band duplication** hurts style parse or render time → measured in the
  spike; copying only into overlapping bands keeps it bounded.
- **Wrapper double conversion** → the audit comes before implementation; browser tests pin it.
- **`importScriptInWorkers` is marked experimental** in both versions → the main-thread
  fallback, plus browser tests in both versions, catch breakage.
- **Upstream ships native Equal Earth or renames the spec values** → polyfill shape; follow
  #1623's final names.
