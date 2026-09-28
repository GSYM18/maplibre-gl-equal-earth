# Equal Earth for MapLibre GL JS v5 + v6 — state-of-the-art design

Date: 2026-09-28 · Status: awaiting review · Supersedes Phases 3–4 of
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
3. **Smooth adaptive zoom.** `equal` transitions in three steps (z5, z6, z7). The camera centre
   stays within **1 px** of the same geographic point across every step, under pinch, scroll
   and `flyTo`. Placeholder tiles are always drawn in the correct step's geometry.
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

| Projection | Bands |
|---|---|
| `equal-earth` | `[0, ∞)` t = 0 |
| `equal` | `[0,5)` t = 0 · `[5,6)` t = ⅓ · `[6,7)` t = ⅔ · `[7,∞)` t = 1 |
| `mercator`, `globe` | none — the plugin is inactive and the style is untouched |

The `equal` boundaries follow style-spec#1623's
`["interpolate", ["linear"], ["zoom"], 5, "equal-earth", 7, "mercator"]`. The t = 1 band uses
the **original source** and never touches the protocol.

**One source per band.** MapLibre draws placeholder tiles from other zooms of the *same*
source only. Giving each band its own source guarantees that a placeholder always carries its
own band's `t`. Each band's vector layers are copies of the original layers, with
`minzoom`/`maxzoom` clamped to the band. A layer is copied only into the bands its own zoom
range overlaps, so Liberty's z ≥ 7 layers are never copied. The expected total is ~250–300
layers; the spike measures the real figure.

**Prefetch.** One hidden layer per non-first band (for example a `fill` with `filter: false`)
references that band's source from `bandStart − 1`. When the camera enters the band, its tiles
are already loaded and are drawn overzoomed in the correct geometry.

### Components

| Module | Status | Responsibility |
|---|---|---|
| `math/backproject.ts` | extend | `geographicToMapWorld(p, t = 0)`; inverse `mapWorldToGeographic(w, t = 0)`, closed form at t ∈ {0, 1}, 2-D Newton otherwise (seeded from the Mercator inverse) |
| `math/subdivide.ts` | extend | densify/warp take `t` |
| `tiles/protocol.ts` | extend | `t` encoded in the source config; pole snapping (§5) during decode |
| `tiles/tile-cover.ts` | extend | pre-image under `world_t`; relative `sourceZoomOffset` |
| `tiles/cache.ts` | extend | persistent tier (§6) |
| `map/camera.ts` | generalise | `ThresholdCamera` → `BandCamera` (§4) |
| `map/constrain.ts` | extend | world bounds per band |
| `map/bands.ts` | new | pure: projection spec → band list |
| `map/style-rewrite.ts` | new | pure: (style, bands, options) → rewritten style (sources, layer copies, prefetch layers, raster suppression, world polygon, outline, graticule) |
| `map/controller.ts` | new | per-map state machine: intercepts `setProjection`/`getProjection`, listens to `projectiontransition` and `styledata`, applies and restores the rewrite, toggles `renderWorldCopies` |
| `map/geo-api.ts` | new | per-instance wrappers and GeoJSON fan-out (§7) |
| `map/graticule.ts` | moved | from `demo/graticule.ts` |
| `control.ts` | new | `EqualEarthControl`, modelled on `GlobeControl` |
| `install.ts` | new | `installEqualEarth(maplibregl, options)`: version gate, native detection, worker loading (§8) |

Every new `map/` module keeps the existing rule: types are structural and there is no import
of `maplibre-gl`, so it can be tested with plain fakes. `bands` and `style-rewrite` are pure
functions.

### Data flow

```
setProjection({type})  → controller → bands(type) → styleRewrite(originalStyle, bands)
                       → map.setStyle(rewritten, {diff: true})
tile request           → eqearth://<config incl. t>/{z}/{x}/{y} → worker
                       → cover → fetch (memory LRU → persistent cache → network)
                       → decode + pole snap → densify + warp_t → reslice → MVT
```

## 4. Transition and camera

**`BandCamera`** replaces `ThresholdCamera`. It keeps the edge-triggered design, the state
seeded in the constructor, the chaining to the host's previous hook and the careful
`destroy()`. It accepts a list of band boundaries instead of one `switchZoom`. On any update
whose zoom falls in a different band from the previous update's zoom:

```
geographic = mapToGeographic(centre, tOld)     // leave the old band's map space
centre'    = geographicToMap(geographic, tNew) // enter the new band's map space
```

Both functions generalise the existing exports with a `t` parameter (default 0, today's
behaviour); at t = 1 they are the identity. When several bands
are crossed in one update (`flyTo` z3 → z10), it converts once, directly from `tOld` to `tNew`.

- **Zoom is not compensated.** The per-step scale jump is roughly a third of the table's
  "zoom jump" column. Changing it would break zoom-driven style expressions.
- **Known residual.** With scroll-zoom the anchor is the pointer, which `transformCameraUpdate`
  cannot see, so the point under the pointer drifts by about (step difference × distance from
  centre). The 1 px criterion applies to the centre; the spike measures pointer drift.
- **Inverse accuracy.** The Newton inverse must round-trip to < 1e-9° over a global grid that
  includes ±90° latitude and ±180° longitude. Non-convergence goes to `onConversionFailure`.

**Visual spike (the first task of the plan, throwaway code).** Hard-code the three `equal`
steps on the Liberty demo; fly to Tokyo, San Francisco, Anchorage and Zürich; record a screen
capture of each step, pointer drift, and the rewritten layer count.
**Fail condition:** if a single step is still clearly jarring at Tokyo, stop and revisit this
section before building production code; the first fallback is six finer steps across z4–z8.

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

## 6. Fast first paint

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

1. Worker bundle fix (`worker.mjs` + `worker.iife.js` + guard). Independent of everything else
   and fixes a real bug.
2. **Visual spike** (§4). Go/no-go for the band design.
3. `world_t`, Newton inverse, `BandCamera`, per-band constrain.
4. `bands`, `style-rewrite`, `controller`, `installEqualEarth`, `EqualEarthControl`.
5. Cartographic finish (§5), including the seam measurement.
6. Geo API audit, then `geo-api` and GeoJSON fan-out.
7. Persistent cache, `sourceZoomOffset`, probe budget mode.
8. Browser test matrix, then demos (OpenFreeMap Liberty + SmartMaps) and the README.

## 10. Risks

- **Stepped blend still looks jarring** → the spike's fail condition is the gate; the fallback
  is finer steps.
- **Layer count from band duplication** hurts style parse or render time → measured in the
  spike; copying only into overlapping bands keeps it bounded.
- **Wrapper double conversion** → the audit comes before implementation; browser tests pin it.
- **`importScriptInWorkers` is marked experimental** in both versions → the main-thread
  fallback, plus browser tests in both versions, catch breakage.
- **Upstream ships native Equal Earth or renames the spec values** → polyfill shape; follow
  #1623's final names.
