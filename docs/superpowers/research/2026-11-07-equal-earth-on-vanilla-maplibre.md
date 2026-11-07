# Equal Earth on vanilla MapLibre GL JS: what is reachable without a fork

Date: 2026-11-07 · Kind: research note · Branch: `native-projection`
Question: what is the best achievable Equal Earth integration on **unmodified** MapLibre GL JS
(v5 ≥ 5.24 and v6), and what does state of the art look like for each layer of it?
Scope: primary sources only. Code is cited as `repo@tag:path:lines`. "Local 6.6" is
`node_modules/maplibre-gl/src` (6.6.0), "local 5.24" is `node_modules/maplibre-gl-v5/src`
(5.24.0). Things not traced to a primary source are marked **UNVERIFIED**.

## 0. Executive summary

- **Adaptive per-vertex Equal Earth on vanilla MapLibre: no.** Neither 5.24.0 nor 6.16.0
  lets anything outside the bundle supply a vertex projection or blend one with Mercator. The
  renderer's only interpolation is globe↔plane (§1.3). The routes that technically reach the
  shaders are a custom-layer renderer, which would mean rewriting text, symbols, styling and
  querying, and runtime injection into internals, which is a fork that must pin MapLibre patch
  versions (§2). Upstream adaptive Equal Earth exists only as proposals and fork demos (#8330,
  style-spec #1623/#1866, maplibre#491) (§1.4).
- **New since this repo's last research: static Equal Earth is now native, from 6.15.0.** The
  experimental `addProjection` (6.15.0, 2026-10-18) registers a planar CRS with its own quad
  tile grid. MapLibre then renders, queries and converts lng/lat in that CRS, but only for tiles
  that are already cut in that grid (§1.2). This plugin's blend-0 warped tiles are exactly such
  tiles: their world square equals an Equal Earth CRS with `extentAtZoom0 = 2·X_MAX`. So on
  6.15+ a pure `equal-earth` mode can drop the bands and most of the geographic API wrapper and
  still keep per-vertex accuracy. The limits:
  - no world copies;
  - a fixed central meridian;
  - no blend with Mercator, since registered names are rejected in projection expressions;
  - no projection switch after sources load ("for now");
  - raster and DEM sources need warping too.
- **Best route today: two tiers.**
  1. On 6.15+, pure Equal Earth through `addProjection`, with the existing `eqearth://` worker
     pipeline as its tile source.
  2. On 5.24 and 6.x, adaptive `equal` through the shipped band polyfill. Its ceiling is
     unchanged: shear snaps at each step, falling only as 1/steps.

  Smooth adaptive quality needs the Plan 4 fork or upstream #8330.
- **Prior art agrees on a narrower, later transition than this plugin's z4–z8:**
  - Mapbox: smoothstep z3.5–7 at 1024 px, shifted by log2(size/1024).
  - MapTiler: linear z5–7.
  - Skyum's fork: z6–7.
  - Jenny's ACMP: fully Mercator from web z6.

  The per-vertex implementations, and Jenny's ACMP, move the central meridian with the
  camera; Mapbox keeps Equal Earth fixed at Greenwich (§3).

## 1. Projection extensibility in vanilla MapLibre today

### 1.1 Releases in scope

- Newest v6: **6.16.0** (2026-10-25); newest v5: **5.24.0** (2026-04-23), the last v5 release
  (GitHub Releases API, `repos/maplibre/maplibre-gl-js/releases`, queried 2026-11-07). Between
  the 6.6.0 this repo pins and 6.16.0 lie ten minor releases (6.7–6.16).

### 1.2 New since 6.15.0: `addProjection` (experimental, planar CRS only)

The most important fact for this question postdates the repo's CLAUDE.md ("MapLibre has no API
for registering a custom projection"), which is true for 5.24 and 6.6 but **no longer true for
6.15+**:

- 6.15.0 (2026-10-18) "Add experimental `addProjection`, `removeProjection`, a built-in
  `identity` projection and a `{bbox}` tile URL token for maps in a custom planar CRS with its own
  quad tile grid" (closes #168, #5764), plus "Project GeoJSON sources on a map in a registered
  CRS, in the workers, from a `definition` string and a projection handler" (#8736), "Fix a map
  in a registered projection going blank when its center crosses 180°" (#8802) and "Fix world
  projections like Equal Earth throwing and jumping when the mouse is in the space around the
  world" (#8803) (`maplibre-gl-js@v6.16.0:CHANGELOG.md:30-45`). The feature PR is
  [#8723](https://github.com/maplibre/maplibre-gl-js/pull/8723) (merged 2026-10-11), built on
  the `worldCoordinateHelper` seam reviewed in #8236/#8287/#8469/#8473/#8526/#8527/#8531.
- Public exports: `addProjection`, `removeProjection` and the types `CRS`, `TileMatrixSet`
  (`maplibre-gl-js@v6.16.0:src/index.ts:34,71-72,368-369,441-442`); the published bundle exports
  both (`maplibre-gl@6.16.0/dist/maplibre-gl.mjs`, export list, checked 2026-11-07). Not in
  5.24 (no `addProjection` in local 5.24's `dist/maplibre-gl.d.ts`).
- The registry is a module-level `Map` pre-seeded with `identity`
  (`v6.16.0:src/geo/projection/projection_crud.ts:5`); names must contain a colon — the error
  message's own example is literally `"custom:equal-earth"` (`projection_crud.ts:50-61`).
- `createProjectionFromName` now consults the registry **before** its built-in switch and, for a
  registered CRS, returns a `MercatorProjection` and `MercatorTransform` that share one
  `CRSWorldCoordinateHelper` and a `MercatorCameraHelper`
  (`v6.16.0:src/geo/projection/projection_factory.ts:19-45`). An unknown name still falls back to
  Mercator with `warnOnce` (`:80-88`; same in local 6.6 and 5.24
  `projection_factory.ts:65-67`).
- What a `CRS` is: `{name, projection: {forward, inverse}, tileMatrixSet: {origin,
  extentAtZoom0}, definition?}` (`v6.16.0:src/geo/projection/crs.ts:33-64`,
  `tile_matrix_set.ts:1-15`). World coordinates are
  `worldX = (crsX − origin[0]) / extentAtZoom0`, `worldY = (origin[1] − crsY) / extentAtZoom0`
  (`docs/guides/custom-crs.md:32-37`, `crs.ts:100-103`).
- **It does not reproject tile content.** "The map does not reproject tile content. It positions
  the tile grid registered with the CRS on screen and converts lng/lat to and from that grid
  through the converter you supply. Reprojecting tiles from another grid, such as Mercator tiles,
  into the CRS is tracked in maplibre/maplibre#491" (`v6.16.0:docs/guides/custom-crs.md:5`).
  "A registered CRS shares the mercator shader variant, prelude and tile mesh … tiles are drawn
  exactly as mercator tiles are, and only the lng/lat mapping around the edges differs"
  (`v6.16.0:developer-guides/custom-crs.md:26`).
- **Fence** (`docs/guides/custom-crs.md:9-17,213-222`; `developer-guides/custom-crs.md:40-42`):
  one CRS per map; no world copies and no antimeridian wrap (`wraps = false`,
  `crs.ts:85`); always flat, no globe transition; square power-of-two quad grids only;
  **registered names are rejected inside projection expressions** (the factory warns and draws
  globe, `projection_factory.ts:25-36`); **switching to or from a registered CRS after sources
  have loaded is not supported "for now"** (tile `bounds`, GeoJSON data and image corners are
  placed in the projection the map had when each source loaded), although `Style.setProjection`
  itself does migrate the transform and reload every tile manager
  (`v6.16.0:src/style/style.ts:1783-1795,1836-1850`); `within`/`distance` expressions compute
  in Mercator; `MercatorCoordinate` keeps answering in Mercator.
- **What keeps working**: `project`, `unproject`, `getBounds`, `fitBounds`, `flyTo`, markers,
  `queryRenderedFeatures`/`querySourceFeatures` (lng/lat), image/video/canvas sources, vector
  and raster sources with `bounds`/`minzoom`/`maxzoom`, terrain/hillshade from DEM tiles in the
  same grid (`docs/guides/custom-crs.md:203-211`).
- **World projections are anticipated.** The inverse may return `null`, non-finite values, or
  throw; an answer counts only if `forward` maps it back within `1e-3 × extentAtZoom0`
  (`crs.ts:13,128-137`); elsewhere the map uses the nearest in-square answer or bisects toward
  the square's centre (`crs.ts:112-120,156-168`), and `isPointOnMapSurface` is false there so
  gestures zoom around the centre (`v6.16.0:src/geo/projection/mercator_transform.ts:635-644`;
  PR #8803, whose description names Equal Earth). Without wrap the transform keeps the centre
  inside tile 0/0/0 (`mercator_transform.ts:701,800`). Follow-up work is still landing:
  [#8964](https://github.com/maplibre/maplibre-gl-js/pull/8964) "map jumping when dragging or
  zooming above or below the identity projection" was opened 2026-11-06 (open).
- **GeoJSON** in a registered CRS needs `definition` plus a worker-side
  `self.setProjectionHandler(definition => converter)` loaded with `importScriptInWorkers`;
  only positions are projected, so long edges need densifying by the caller
  (`docs/guides/custom-crs.md:163-187`; example
  `test/examples/display-geojson-in-a-polar-stereographic-projection.html:24-39`).
- **Custom layers** under a registered CRS receive `defaultProjectionData` in the CRS's world
  square, not Mercator (`v6.16.0:src/style/style_layer/custom_style_layer.ts:150-159`;
  `docs/guides/custom-crs.md:189-201`).
- Maintainer framing: asked on #8803 why Equal Earth does not "rotate" when panned, Birk Skyum
  answered that a runtime re-projection "goes well beyond this initial projection support, which
  is more about supporting non-mercator data sources" (PR #8803 comments, 2026-10-18).
  [#8807](https://github.com/maplibre/maplibre-gl-js/pull/8807) (merged 2026-10-17) reworded the
  docs so that a registered name denotes the CRS, leaving room for reprojected Mercator sources
  later, e.g. via `dataProjection` from
  [maplibre-style-spec#1921](https://github.com/maplibre/maplibre-style-spec/pull/1921) (opened
  2026-10-12, closed 2026-10-14 with `merged_at: null`, i.e. not merged; `dataProjection` is
  absent from the 6.16.0 changelog; **UNVERIFIED** whether it was superseded).

**Consequence for this plugin.** A registered CRS whose tile matrix set is the Equal Earth world
square makes MapLibre itself render, query and convert in Equal Earth — *if the tiles are
already in that grid*. This plugin already produces such tiles: at blend 0 its map space is
`inverseMercator(EE · GRID_FACTOR)` with `GRID_FACTOR = πR_merc / EQUAL_EARTH_X_MAX`
(`src/math/backproject.ts:39,78`), so its world coordinate is
`(E_x + X_MAX) / (2 X_MAX)`, identical to a CRS with `forward = toEqualEarth`,
`origin = [−X_MAX, X_MAX]`, `extentAtZoom0 = 2·X_MAX`. The blend-0 output of the existing
`eqearth://` pipeline can therefore be served unchanged as tiles of a registered
`custom:equal-earth` CRS on 6.15+. Caveat: `fromEqualEarth` extrapolates longitude linearly past
±180° and `toEqualEarth` does not clamp it (`src/math/equal-earth.ts:76-94,107-125`), so those
positions pass the round-trip test; a CRS adapter must return `null` for |λ| > 180° or
MapLibre will treat the space beside the world as map.

### 1.3 Still closed on every release: a custom *rendering* projection

- `Projection`, `ITransform`, `ICameraHelper`, `MercatorTransform`, `GlobeProjection` are not
  exported at 6.16.0 (`src/index.ts:218-444` exports only the types listed in 1.2 plus
  `ProjectionData*`, `CustomLayerProjectionData`, `CameraUpdateTransformFunction`,
  `TransformConstrainFunction`). `Map#migrateProjection` exists but is `@internal`
  (local 6.6 `src/ui/map.ts:4103-4110`).
- The style spec at its newest release (v26.5.1, 2026-11-01) still types `projection.type` as
  `projectionDefinition` — string, transition state or zoom expression
  (`maplibre-style-spec@v26.5.1:src/reference/v8.json`, `projection.type`). Only
  `mercator`, `globe`, `vertical-perspective` (and on 6.15+ `identity` and registered names)
  mean anything to the factory.
- An expression-valued projection always becomes `GlobeProjection`
  (local 6.6 `projection_factory.ts:23-30`; `v6.16.0:projection_factory.ts:25-36`): the only
  interpolation the renderer knows is sphere↔plane via `u_projection_transition`
  (`v6.16.0:src/shaders/glsl/_projection_globe.vertex.glsl:7,106-134`).
- How a third projection would plug in (and why it cannot from outside): the painter compiles
  every program with `projection.shaderPreludeCode`/`shaderDefine`, keyed by
  `shaderVariantName` (local 6.6 `src/render/painter.ts:814-840`); the Mercator prelude's
  `projectTile` is one matrix multiply (`v6.16.0:_projection_mercator.vertex.glsl:10-24`), the
  globe one maps to the sphere and mixes with the flat position
  (`_projection_globe.vertex.glsl:57-134`). The `Projection` interface carries the prelude,
  subdivision granularity, mesh, `transitionState`, and since 6.15 `worldCoordinateHelper`
  (`v6.16.0:src/geo/projection/projection.ts:37-130`). The repo's native spec already maps the
  remaining seams (≈8 `transitionState > 0` "is globe" sites, shaders that bypass
  `projectTile`, conformal-only `projectLineThickness`, CPU symbol projection through
  `transform.projectTileCoordinates`, covering tiles)
  (`docs/superpowers/specs/2026-10-14-native-equal-earth-projection-design.md` §2).

### 1.4 Upstream status of a native (adaptive) Equal Earth

- [#8330 "Equal Earth - Adaptive"](https://github.com/maplibre/maplibre-gl-js/issues/8330):
  **open**, opened 2026-09-05 by Birk Skyum, last comment 2026-09-08. HarelM: a spec change
  proposal is needed; Skyum has a working fork demo ("can proceed to PR when there's a style spec
  option in place"); John Carmack (contributor) notes the CPU half is the `worldCoordinateHelper`
  seam (#8236) and the GPU half would be "an Equal Earth variant next to `projectToSphere` in
  the vertex prelude, mixed with the flat position by `u_projection_transition` the way globe
  does today" (issue comments, 2026-09-05/07/08).
- [maplibre-style-spec#1623](https://github.com/maplibre/maplibre-style-spec/issues/1623)
  (MapTiler, open since 2026-04-30): proposes `"equal"` (Equal Earth preset, ≡
  `["interpolate", ["linear"], ["zoom"], 5, "<equal-earth>", 7, "mercator"]`), `"equal-earth"`
  (pure), `"geodetic"`, `"equirectangular"`. HarelM would prefer presets only. The names match
  this plugin's `equal`/`equal-earth`.
- [maplibre-style-spec#1866](https://github.com/maplibre/maplibre-style-spec/issues/1866)
  (open since 2026-09-07): replace zoom expressions by `projection.transition: [startZoom,
  endZoom] | false`; "Being able to select a custom projection doesn't automatically mean we can
  transition between it and another projection."
- [maplibre/maplibre discussion #491](https://github.com/maplibre/maplibre/discussions/491)
  "Custom coordinate systems: Client Side Map Reprojection" (klokan/MapTiler, opened
  2026-03-11, open): CPU (TS) + GPU (GLSL) Equal Earth and equirectangular with an optional
  adaptive transition; NLnet funding application in a second round (2026-09-11); MapTiler
  (Sorceror) asked for a *stateful* helper (moving central meridian) and per-axis scale because
  Equal Earth is equal-area (2026-08-30). No implementation PR yet.
- Conclusion: no upstream adaptive Equal Earth exists in any release; the earliest path is a
  style-spec decision (#1623/#1866) followed by a GL JS PR. **UNVERIFIED**: any timeline.

## 2. Non-fork routes to per-vertex quality

### 2.1 (a) CustomLayerInterface

- Surface at 6.16.0: `render`/`prerender(gl, CustomRenderMethodInput)` with `farZ`, `nearZ`,
  `fov`, `modelViewProjectionMatrix`, `projectionMatrix`, `shaderData` (`variantName`,
  `vertexShaderPrelude`, `define`), `defaultProjectionData`, `getProjectionData(params)`
  (`v6.16.0:src/style/style_layer/custom_style_layer.ts:57-183`); 6.13 added experimental
  `renderToTerrainTile` (`:270-336`; CHANGELOG 6.13.0). 5.24 has the same `shaderData` and
  `defaultProjectionData` (local 5.24 `dist/maplibre-gl.d.ts:4947-4998`).
- What it gives: a GL context and the camera's matrices. `shaderData.vertexShaderPrelude` is
  MapLibre's *own* projection prelude so custom geometry can follow Mercator/globe — it cannot
  inject a projection *into* MapLibre's layers.
- Could a plugin draw vector tiles in Equal Earth itself? Yes, per-vertex and with any blend,
  but it must re-implement MVT decoding, tessellation, line joins/extrusion, data-driven style
  evaluation, sprites/patterns, and — the hard part — glyph shaping, symbol placement and
  collision. Custom layers do not take part in `queryRenderedFeatures`, symbol collision with
  style layers, feature state or the style's layer model (they are opaque `custom` layers).
  **Verdict:** not a basemap route; right for overlays (graticule, thematic data) drawn on top
  of whatever projection the map shows.

### 2.2 (b) Runtime injection / prototype patching

- Reachability: the published bundle keeps internal member names (6.16.0's minified
  `dist/maplibre-gl.mjs` still contains `migrateProjection`, `shaderPreludeCode`, `_camera`,
  `_requestedCameraState`, `worldCoordinateHelper`, `projectTileCoordinates`; checked
  2026-11-07), members are TypeScript `private _x` (no `#private` in
  `mercator_transform.ts`), and classes are reachable through live instances
  (`map._camera.transform.constructor` is `MercatorTransform`). So a plugin *could* build a
  duck-typed `Projection` (Equal Earth/blend prelude, subdivision granularity, mesh) and a
  subclassed transform, assign `map.style.projection` and call `map.migrateProjection`.
- Ceiling: close to the fork for layers that go through `projectTile`, but the prelude cannot
  fix shaders that bypass it (fill-extrusion, depth) or the scalar line thickness, and the
  `transitionState > 0` sites would need to be steered (native spec §2). `setProjection`/`setStyle`
  re-create `style.projection` and would silently undo the injection.
- Robustness: worst of all routes. The seams moved repeatedly inside v6 minors: per-frame
  projection data upload (6.11.2, #8545), `worldCoordinateHelper` threaded through transform,
  sources, terrain (6.15), camera/terrain fixes touching `transformCameraUpdate` (6.11.2,
  #8550; 6.9.0, #8351). It would have to pin exact MapLibre patch versions — a fork in all but
  name, minus the fork's ability to change layer shaders.

### 2.3 (c) Backprojection (this repo)

Recorded in CLAUDE.md and the 2026-09-28 spec; not re-measured here. Limits: shear snaps at each
band step (300 px off-centre, six steps: Zürich ≈ 7 px, San Francisco ≈ 16 px, falling only as
1/steps), symbol copies per band re-lay out on a switch, N× layers and warped tiles per band,
map space leaks through `queryRenderedFeatures` geometry and `getStyle()`, and it depends on
internals (`_camera`, `_requestedCameraState`, `moveend` asymmetry).

### 2.4 (d) Other hooks

| Hook | Reaches | Projection use |
|---|---|---|
| `transformCameraUpdate`, `transformConstrain` (`v6.16.0:src/ui/map.ts:294-301,1050`) | camera state | band conversion, clamp (used) |
| `addProtocol` (main + `self.addProtocol` in workers), `importScriptInWorkers`, `setWorkerUrl` (`src/index.ts:181-216,438-444`) | tile bytes | warping (used) |
| `addSourceType` + `registerWorkerSource` (`src/index.ts:187-188,443`) | tile parsing in the worker | could replace the protocol; still produces Mercator-grid buckets |
| `addProjection` + `setProjectionHandler` (6.15+) | lng/lat ↔ world mapping, GeoJSON projection | **static** Equal Earth with native API (§1.2) |
| `StyleImageInterface` `renderWithWebGL` (6.3.0) | style images | none |
| Style-spec custom shaders | — | do not exist |

### 2.5 Verdict

| Route | Quality ceiling | Adaptive EE→Mercator | Robustness across versions | Effort | Versions |
|---|---|---|---|---|---|
| (c) Backprojection bands (shipped) | per-band exact; shear snap per step, label re-layout per switch | stepped | medium (public hooks + `_camera`/`_requestedCameraState` internals) | done | 5.24, 6.x |
| (d) `addProjection` CRS + plugin-warped tiles | **exact per vertex** (densified in the worker), native lng/lat API, labels laid out in EE | **none** (no expressions, no switch after load "for now") | medium: public but `@experimental` | moderate: reuse blend-0 pipeline, new CRS adapter, GeoJSON handler | 6.15+ |
| (a) Custom layer renderer | arbitrary, incl. smooth blend | yes, if you write it | high (public API) | prohibitive for basemaps (re-implement text/symbols/styling/query) | 5.24, 6.x |
| (b) Runtime injection | ≈ fork minus non-`projectTile` shaders | yes | very low; pin exact patch versions | fork-sized | per pinned version |
| Fork (Plan 4, not vanilla) | per vertex, smooth | yes | you own the merge | large | forked line |

## 3. Prior art

| Project | Mechanism | Transition to Mercator | Central meridian | Notes |
|---|---|---|---|---|
| Mapbox GL JS ≥ 2.6 (v3.34.2 read) | Per-vertex reprojection **on the CPU in the worker** for every non-Mercator projection (`isReprojectedInTileSpace = true`, `src/geo/projection/projection.ts:56`; `src/data/load_geometry.ts:54-77`). Edges are resampled at the Mercator midpoint to tolerance 1 (`src/geo/projection/resample.ts:9-41`). The Equal Earth class follows d3 (`equal_earth.ts:1-59`). | `t = smoothstep(range₀+adj, range₁+adj, zoom)` with `adj = log2(min(maxSize, max(w,h))/1024)` ("manually defined based on what makes sense in a 1024px wide map"), default range `[3.5, 7]` (`adjustments.ts:36-55`; `projection.ts:59`). The docs call it "gradually transitioning from the defined projection to Web Mercator" at the same scale as Mercator, with bearing moving from the projection centre to the screen centre ([guide](https://docs.mapbox.com/mapbox-gl-js/guides/projections/), "Map 'unskewing' on zoom"). The code applies a whole-map rotation, unskew and scale that make the centre locally Mercator-like (`getShearAdjustment`, `adjustments.ts:86-144`). | Fixed for Equal Earth; `center`/`parallels` apply to Albers and LCC only (guide) | No world copies, terrain, fog or custom layers off Mercator/globe (guide). Licence: v2+ is proprietary, so it can be described but not copied ([LICENSE.txt@v3.34.2](https://raw.githubusercontent.com/mapbox/mapbox-gl-js/v3.34.2/LICENSE.txt)). Whether the renderer also hands over to plain Mercator at high zoom: **UNVERIFIED**. |
| Development Seed dirty-reprojectors | Static preprocessing: project to the target projection scaled to Web Mercator's extent, then inverse-Mercator ([README:42-51](https://github.com/developmentseed/dirty-reprojectors)) | none | whatever the d3 projection is set to | "the output lng/lat … are totally wrong"; limited latitude range, precision loss (README:53-56). This repo is its adaptive, tile-time descendant. |
| MapTiler labs ([page](https://labs.maptiler.com/equal-earth-web-maps/)) | "GPU-accelerated client-side reprojection" in a patched MapLibre. The demo bundle uses an Equal Earth vertex prelude with `u_projection_transition` and `u_projection_central_meridian` | `"equal"` = `["interpolate",["linear"],["zoom"],5,"equal-earth",7,"mercator"]` (demo bundle; style-spec #1623) | "dynamic center": the central meridian set to `map.getCenter().lng` (demo, 2026-09-11) | The page says BSD; the bundle header says "All rights reserved MapTiler AG". Funding: NLnet second round (2026-07-23). |
| Birk Skyum fork ([repo](https://github.com/birkskyum/maplibre-gl-js-equal-earth) @2327107) | Patched MapLibre and style spec. `projectAdaptiveEqualEarth = mercator·(1−t) + equalEarth(rotated)·t` (`src/geo/projection/equal_earth_utils.ts:39-43`), and the same blend per vertex in `_projection_equal_earth.vertex.glsl` | linear z6–7 by default; `transition: false \| [start,end]` (`equal_earth_utils.ts:16-21`; README) | four modes. Adaptive with movable origin: drag east–west shifts the origin, which "stays on the equator so the transition can meet Mercator" (README). | Subdivision granularity: fill 128, line 512 (`equal_earth_projection.ts:13-18`). |
| deck.gl 9.4.1 | `MapView` (Mercator), experimental `GlobeView`; no Equal Earth ([views.md](https://github.com/visgl/deck.gl/blob/master/docs/developer-guide/views.md)) | — | — | `_CustomProjectionView` (PROJ strings, CPU) exists only on master, unreleased, and excludes tiled layers (`docs/api-reference/core/custom-projection-view.md:1-40,74-82`). |
| OpenLayers 10 | Raster: triangulated reprojection, 0.5 px error threshold ([tutorial](https://openlayers.org/doc/tutorials/raster-reprojection.html); `src/ol/reproj/common.js:10`). Vector: per-feature `dataProjection`/`featureProjection` on the CPU | none | the view projection | MapLibre's `dataProjection` proposal (style-spec #1921) took OpenLayers as its model. |
| d3-geo 3.1.2 | `geoEqualEarth`: 12 Newton iterations, ε = 1e-12 (`src/projection/equalEarth.js:4-31`). Adaptive resampling splits at the **spherical** midpoint, i.e. it treats edges as great circles (`resample.js:5,28-42`). | — | `rotate()` | MVT edges are straight in Mercator, so tile densification should follow Mapbox's Mercator midpoint, not d3's (this repo's `subdivide.ts` does). |
| Jenny 2012, ACMP (IEEE TVCG 18(12), doi 10.1109/TVCG.2012.192). Paper text not accessible; read from the authors' code [OSUCartography/adaptive-composite-map-projections](https://github.com/OSUCartography/adaptive-composite-map-projections) @bba9686 | World equal-area (Hammer, Wagner VII, Šavrič's pseudocylindrical) → Lambert azimuthal through the equal-area Wagner transformation, then large-scale projections by aspect ratio, then Mercator. Weighted x/y mix otherwise (`WeightedProjectionMix.js:23-28`; `Projection.js:478-516`). | `MERCATOR_LIMIT_WEB_MAP_SCALE = 6` (web zoom 6), transition width 0.75 in zoom factor (`src/map.js:4-6,113-138`) | Panning **rotates** the projection: the central meridian and latitude follow the centre (`src/MapEvents.js:166-187`) | Above the Mercator limit the UI hands over to a raster slippy map (`UI.js:86-98`). |

Design lessons:
1. **Window.** All three native implementations reach full Mercator by z7, and Jenny by z6.
   Mapbox scales the window with map size. This plugin's default z4–z8
   (`README.md:452`, `transition: {from: 4, to: 8, steps: 6}`) starts and ends later than all of
   them, and it is size-independent.
2. **Centre.** The per-vertex implementations and ACMP move the central meridian with the
   camera. Mapbox, which applies only a global affine correction, keeps it fixed. Under
   backprojection a moving meridian would re-warp every tile, so the fixed meridian here is
   forced by the technique, not chosen.
3. **Labels.** No source above documents label handling under its blend (**UNVERIFIED** for
   MapTiler and Skyum). In MapLibre, symbols are projected per frame through the
   transform/prelude, so a native blend keeps them laid out
   (`docs/superpowers/specs/2026-10-14-native-equal-earth-projection-design.md` §2).

## 4. Cartography

- **Formulas.** Šavrič, Patterson, Jenny, "The Equal Earth map projection", IJGIS 33(3):454–465
  (2019; online 2018-08-07), doi 10.1080/13658816.2018.1504949. **Closed access** (Unpaywall
  and OpenAlex report `oa_status: closed`), so the formulas are taken from the authors'
  "Mathematics and Implementation Details for the Equal Earth Projection" (rev. 2019-04-16,
  linked from [shadedrelief.com/ee_proj](http://shadedrelief.com/ee_proj/)):
  - `sin θ = (√3/2) sin β`
  - `x = R_A · 2√3 λ cos θ / [3(A1 + 3A2θ² + θ⁶(7A3 + 9A4θ²))]`
  - `y = R_A · θ(A1 + A2θ² + θ⁶(A3 + A4θ²))`
  - A1 = 1.340264, A2 = −0.081106, A3 = 0.000893, A4 = 0.003796
  - On the ellipsoid, β is the authalic latitude and `R_A = a√(q_P/2)`. On the sphere, β = φ and
    R_A = R.
  - Inverse: Newton–Raphson on θ from θ₀ = y/R_A until Δθ < ε. The PDF's WGS 84 test point
    converges in 4 steps.
- **Derived properties** (computed here from the formulas, not quoted from the paper):
  - the poles are straight lines, because θ_max = π/3 gives cos θ = ½;
  - pole line / equator = 0.5925;
  - width : height ≈ 2.0546 : 1.
- **Design intent** (first-party site, archived 2026-06-11): a "visually pleasing alternative to
  the Gall-Peters", Robinson-like, with "straight parallels" and meridians "evenly spaced along
  any given line of latitude".
- **EPSG.**
  - Method EPSG:1078 is ellipsoidal through the authalic latitude.
  - CRSs: EPSG:8857 (Greenwich, λ₀ = 0), 8858 (Americas, −90°) and 8859 (Asia-Pacific, 150°),
    all on the WGS 84 ellipsoid with no false origin.
  - Usage scope: "Very small scale equal-area mapping".
  - Sources: [EPSG API 1078](https://apps.epsg.org/api/v1/CoordOperationMethod/1078),
    [epsg.io/8857](https://epsg.io/8857).
  - The PROJ string is `+proj=eqearth +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m` with **no
    `+R`** ([epsg.io/8857.proj4](https://epsg.io/8857.proj4), fetched 2026-11-07).
  - R_A(WGS 84) = 6371007.1809 m gives x_max = 17243959.062 m (computed here), which is exactly
    the published bound. **This contradicts CLAUDE.md**, which says EPSG:8857 "declares
    `+R=6371008.7714`" and that the published bound is inconsistent with it by 4.3 m.
    6371008.7714 is the IUGG mean radius R₁. The plugin's sphere therefore differs from EPSG:8857
    by up to 4.3 m in easting, plus the authalic/geodetic latitude difference (up to ≈0.13°,
    **UNVERIFIED** magnitude). That is irrelevant to the warp, where `GRID_FACTOR` cancels the
    radius (`backproject.ts:37-39`), but it matters if the plugin ever registers itself as
    `EPSG:8857`.
- **PROJ `eqearth`** ([PROJ 9.9.0 `src/projections/eqearth.cpp`](https://github.com/OSGeo/PROJ/blob/9.9.0/src/projections/eqearth.cpp)):
  - "PCyl, Sph&Ell" (L21); constants at L24-28;
  - `MAX_Y = 1.3173627591574`, `EPS = 1e-11`, `MAX_ITER = 12` (L30-32);
  - the inverse clamps y to ±MAX_Y and errors if Newton does not converge (L89-92, L113-117);
  - added in PROJ 5.2.0 (`docs/source/operations/projections/eqearth.rst`).
  - The repo's `fromEqualEarth` uses the same budget (12, 1e-11) but does **not** reject |x|
    beyond the outline (§1.2 caveat).
- **Graticule and outline.** Statements in the paper on graticule density, outline and corner
  conventions are **UNVERIFIED** (closed access). Equal Earth has straight pole lines by
  construction, so its outline is the two pole lines plus the ±180° meridians, which this repo
  draws (`src/map/cartography.ts`).
- **Adaptive recommendations** (Jenny 2012; see §3 for the ACMP code):
  - equal-area at world scale;
  - blends that stay equal-area where possible;
  - the centre drives the projection's aspect;
  - Mercator for large scales, from web z6.

  Projection Wizard, the authors' implementation of their selection guide
  ([projectionwizard.org](https://projectionwizard.org), `outputFormat.js:33,53,116-160,173-197`):
  - "world" below scale factor 1.5;
  - Equal Earth as the default equal-area world projection;
  - the central meridian from the map centre.
- **User studies.**
  - Šavrič, Jenny, White, Strebe 2015, "User preferences for world map projections", CaGIS
    42(5), doi 10.1080/15230406.2015.1014425 (abstract):
    - map readers preferred Robinson and Plate Carrée, and favoured straight parallels and
      elliptical meridians;
    - they preferred pole lines to pointed poles, but had no clear preference for pole lines in
      general;
    - Mercator ranked 6th of 9.
  - Jenny, Šavrič, Patterson 2015 (Compact Miller, doi 10.1080/13658816.2014.997734): 448
    participants.
  - **No primary user study of zoom-adaptive or morphing web projections was found**
    (transition thresholds, perception of the blend). Any perceptual claim about the
    transition window is therefore **UNVERIFIED**.

## 5. Plugin engineering: state of the art vs. this repo

- **Official guidance.**
  - No plugin-development guide exists at 6.16.0. `docs/` and `developer-guides/` contain no
    such file (tree at v6.16.0).
  - The plugins page is generated from the `JAVASCRIPT-PLUGINS` block of
    [awesome-maplibre](https://github.com/maplibre/awesome-maplibre) README
    (`v6.16.0:build/generate-docs.ts:255-287`). You get listed by a PR to that README
    ("Map Rendering Plugins"); there are no criteria beyond its contributing guidelines.
  - `backproj/maplibre-proj`, which uses the same backprojection technique, is listed there.
    Neither this package nor pka's is.
- **v6 breaking changes that touch plugins:**
  - ESM-only, with no UMD (`v6.16.0:CHANGELOG.md:383`; migration guide L3).
  - `map.transform` removed and `Map` composes a `Camera` (CHANGELOG:386; guide L106-108).
  - Events are classes (guide L85-87).
  - `setMissingStyleImageResolver` (guide L89-100).
  - WebGL2 is required (guide L102-104).
  - `setWorkerUrl` is for bundlers only, and CDN use auto-detects the worker (guide L37-41).
  - CSP needs `worker-src 'self' blob:` from a CDN (guide L43-59).
  - Later 6.x changes: the RTL plugin was deprecated in 6.9 (#8343); `maplibre-gl-shared.mjs`
    was emptied and the worker URL versioned with `?v=` in 6.13 (#8621); pooled workers
    re-import `importScriptInWorkers` URLs when recreated in 6.16 (`src/index.ts:190-191`).
- **Worker extension points** (`v6.16.0:src/source/worker.ts`):
  - `self.addProtocol` L130-131, `self.registerWorkerSource` L123-128,
    `self.setProjectionHandler` L146-149, `self.makeRequest` L144.
  - `importScriptInWorkers` is "experimental" (`src/index.ts:182-216`).
  - `loadScript` uses `import()` only when the URL **ends in `.mjs`**. Otherwise it fetches and
    sniffs, then uses a blob `import()` for ESM or `eval` for classic code (`worker.ts:30-69`).
    A query-suffixed `worker.mjs?v=…` therefore takes the blob path.
  - 5.24 calls `importScripts` (local 5.24 `src/source/worker.ts:164-165`).
- **Packaging across majors.** Every plugin package below was read from unpkg on 2026-11-07
  (`package.json`):

  | Package | Peer `maplibre-gl` range |
  |---|---|
  | @maplibre/maplibre-gl-inspect 1.9.0 | `>=3.0.0 <7.0.0` |
  | @geoman-io/maplibre-geoman-free 0.10.8 | `>=6.0.0 <7.0.0` |
  | @watergis/maplibre-gl-terradraw 1.17.0 | `^4.0.0 \|\| ^5.0.0 \|\| ^6.0.0` |
  | @maplibre/maplibre-gl-directions 0.10.1 | `^6.0.0` |
  | @deck.gl/maplibre 9.4.1 | `^4.5.1 \|\| ^5.0.0 \|\| ^6.0.0` |

  - This repo's `>=5.24 <7` (`package.json:77-79`) is in line with them.
  - None of these packages ships separate v5/v6 workers. This repo's two worker bundles are a
    consequence of v5 `importScripts` vs v6 `import()`.
  - The closest worker-plugin peer is maplibre-contour: its own worker plus a main-thread
    `addProtocol`, or `importScriptInWorkers` of an `add-protocol-worker.js` (its README).
- **Testing practice upstream** (v6.16.0):
  - Unit and integration tests run under Vitest.
  - Render tests are `style.json` + `expected.png`, compared with pixelmatch (default `allowed`
    0.00025) and driven by **Puppeteer**, with `--enable-unsafe-swiftshader` and SwiftShader
    fallback (`test/integration/README.md:4-107`; `test/integration/lib/puppeteer_config.ts:6-15`;
    `render.test.ts:180,207`).
  - There are also query tests and six bundler consumer apps built and loaded in a browser
    (`test/integration/bundler/bundlers.test.ts:42-131`).
  - "All tests are run for every PR" (`test/integration/README.md:21`).
  - "You should not mock any internal domain objects … `Style`, `Map`, `Transform`"
    (`test/README.md:36`).
- **Browser tooling.**
  - Playwright 1.62.1 does not add `--enable-unsafe-swiftshader` by default; later main does
    (`packages/playwright-core/src/server/chromium/chromiumSwitches.ts`). Passing it explicitly,
    as this repo does, is right for its pin.
  - Chromium is deprecating automatic SwiftShader WebGL fallback
    (chromium `docs/gpu/swiftshader.md`).
  - Vitest browser mode recommends the Playwright provider, but its docs say nothing about
    WebGL and call GPU and drivers a source of screenshot variance
    ([vitest.dev/guide/browser](https://vitest.dev/guide/browser/)). No primary source makes it
    the recommended harness for WebGL. Upstream itself runs Puppeteer from node-environment
    Vitest.

## 6. UX

- **Projection control convention.**
  - GlobeControl toggles `mercator` ↔ `globe` and re-reads on `styledata` and
    `projectiontransition` (`v6.16.0:src/ui/control/globe_control.ts:20-70`).
  - Its name comes from `title` only: localized verb phrases `'GlobeControl.Enable': 'Enable
    globe'` / `'Disable globe'` (`src/ui/default_locale.ts:20-21`), overridable through the
    `locale` Map option (`src/ui/map.ts:303-308,810`).
  - It sets no `aria-pressed`.
  - The W3C APG button pattern: for a toggle button, "it is critical the label on a toggle does
    not change when its state changes"
    ([APG button](https://www.w3.org/WAI/ARIA/apg/patterns/button/)); WCAG 2.2 SC 4.1.2 applies.
- **World view.**
  - With `renderWorldCopies: false`, the space beyond ±180° stays empty. A registered CRS
    renders a single world regardless (`src/ui/map.ts:2016-2059`).
  - Globe does not constrain the centre (`developer-guides/globe.md:199`).
  - Mapbox leaves the outside of non-Mercator worlds transparent, so it is styled through the
    container's CSS (Mapbox guide, Limitations). This repo does the same (`outside`/`container`
    options).
- **Gestures past the world edge.** MapLibre's own answer for world projections (6.15, #8803):
  over empty space, gestures zoom around the centre and drag by pixels
  (`mercator_transform.ts:635-644`).
- **Reduced motion.** `prefers-reduced-motion` and the `reduceMotion` option set ease durations
  to 0 unless `essential` (`src/util/browser.ts:87-98`; `src/ui/camera.ts:874-876,1426-1428`).
  Symbol `fadeDuration` is not tied to it (`src/ui/map.ts:556`).
- **Markers and popups.**
  - On globe, markers are occluded via `isLocationOccluded`, with `opacityWhenCovered`
    (`src/ui/marker.ts:169-173,681-694`).
  - Markers and popups re-position on `projectiontransition` (`marker.ts:405,434`;
    `popup.ts:258,325`; fix #8433 in 6.11).
- **Examples.** Upstream has no "change projection" example. There are globe, transform
  constraint, world-copy and polar-stereographic `addProjection` examples (`test/examples/`).
- **Transition UX from prior art** (§3):
  - finish the blend by about z6–7;
  - shift the window by log2(map size/1024) (Mapbox);
  - move the central meridian toward the camera once zoomed in (MapTiler, Skyum, ACMP);
  - keep north up at the screen centre at high zoom (Mapbox: bearing moves from the projection
    centre to the screen centre).

## 7. Gaps vs. this repo (concrete only)

1. **CLAUDE.md, README and spec are stale on extensibility.** "MapLibre has no API for
   registering a custom projection" holds for 5.24 and 6.6 only; 6.15 added `addProjection`
   (§1.2). It still does not reproject Mercator tiles, so the backprojection pipeline remains
   necessary as the tile source.
2. **No `addProjection` path for pure `equal-earth` on 6.15+** (§1.2, §2.5 route d). Gains:
   - no band copies;
   - a native lng/lat API, `queryRenderedFeatures` in lng/lat, and no map-space leaks;
   - MapLibre's own edge-of-world gesture handling.

   Needs:
   - a CRS adapter whose `inverse` returns `null` for |λ| > 180° (or past ±Y_MAX);
   - `self.setProjectionHandler` in the plugin worker for GeoJSON;
   - dev-testing against 6.15+ (blocked by the registry note in CLAUDE.md).
3. **Test matrix trails the peer range.** It tests 6.6.0 while the newest is 6.16.0. Ten minors
   touched the plugin's seams: `transformCameraUpdate` (#8351 6.9, #8550 6.11.2),
   markers and popups on projection change (#8433 6.11), worker errors on the map `error` event
   (#8018 6.11), worker re-import on recreation (6.16), one-axis `setMaxBounds` (#6148 6.16).
4. **CI runs no browser tests.** `.github/workflows/ci.yml` runs lint, typecheck, unit, build and
   check:exports, but not `test:browser`. Upstream runs everything on every PR.
5. **No bundler consumer tests.** The ESM build relies on applications' bundlers keeping
   `new URL('./worker.mjs', import.meta.url)`. Upstream builds six real bundler apps
   (`test/integration/bundler/`).
6. **Worker URL not versioned.** Upstream fixed stale cached workers with `?v=` (6.13, #8621).
   But on v6 a query-suffixed `.mjs` URL leaves the `import()` path (`worker.ts:43`), so use a
   versioned file name or document it.
7. **No CSP documentation.** Needed: `script-src` for the worker URL, `blob:` for the
   fetch-and-blob path, and `'unsafe-eval'` for classic scripts (`worker.ts:30-69`). Upstream
   documents CSP (`docs/index.md:30-37`; migration guide L43-59).
8. **Control accessibility and i18n.**
   - `EqualEarthControl` sets `aria-pressed` and also swaps its `title` between "Equal Earth"
     and "Mercator" (`src/map/control.ts:53,118-119`), and the SVG is `aria-hidden`. That breaks
     the APG rule above. Use a constant name with `aria-pressed`, or GlobeControl-style verbs
     without it.
   - The English strings are hard-coded; MapLibre localizes control strings through `locale`.
9. **Transition window.**
   - The default z4–z8 is wider and earlier than every native implementation (z3.5/5/6 → z7).
   - Mapbox scales the window with map size; the plugin does not.
   - A narrower window would also reduce step count/shear exposure. **UNVERIFIED** that it is
     preferable perceptually (no user study, §4).
10. **Fixed central meridian, no option.** EPSG defines Americas (−90°) and Asia-Pacific (150°)
    variants (8858/8859). A static `centralMeridian` option is cheap in backprojection, and in a
    registered CRS it is one `lon_0`.
11. **EPSG:8857 radius statement in CLAUDE.md is wrong** (§4): the CRS is ellipsoidal (authalic),
    with no `+R`.
12. **Not listed on the MapLibre plugins page** (awesome-maplibre PR).
13. **Minor.**
    - The band cross-fade ignores `reduceMotion`. Arguably not "motion"; upstream's
      `fadeDuration` ignores it too.
    - Unit tests mock `Map`/`Transform`, which upstream discourages for its own code. This is
      mitigated by `tests/host-types.test.ts` and the browser matrix.

## 8. Open questions / UNVERIFIED

- Does a plugin-driven `setStyle` that replaces all sources **and** switches `projection.type`
  between `mercator` and a registered CRS work on 6.15+? The guide says switching after sources
  load is unsupported "for now" (`custom-crs.md:221`), while `Style.setProjection` reloads every
  tile manager (`style.ts:1844-1850`). This needs a spike before the control can toggle
  Mercator ↔ registered Equal Earth.
  **Answered by the spike (2026-11-07, branch `spike/addprojection-6.16`, commit 88877d0,
  `demo/spike-addprojection.html`):** `setStyle(style, {diff: false})` works both ways on
  6.16.0 with no errors and GeoJSON placed correctly. A diffed swap from Equal Earth to Mercator
  leaves unchanged GeoJSON sources in the old projection. Pure Equal Earth through
  `addProjection` with the blend-0 tiles is exact: `project` matches the formulas to 0 px, and
  `unproject` round-trips to ~1e-12°.
- Raster/DEM under a registered Equal Earth CRS: these would need warping in the worker. Cost
  and quality are unmeasured.
- Whether style-spec #1921 (`dataProjection`) was superseded by another PR.
- Mapbox: whether rendering hands over to plain Mercator at high zoom beyond the affine
  unskew; how labels behave during the unskew.
- MapTiler and Skyum label behaviour during the blend; MapTiler's licence (page "BSD" vs bundle
  "All rights reserved").
- Jenny 2012 paper text: its exact thresholds, rationale and any user evaluation (only the code
  was read). The 2017 "Guide to Selecting Map Projections" chapter's recommendations.
- The Equal Earth paper's own statements on graticule, outline and distortion statistics
  (closed access).
- Magnitude of the authalic-vs-geodetic latitude difference between the plugin's sphere and
  EPSG:8857 (≈0.13° is an estimate).
- Any timeline for #8330 / maplibre#491 / style-spec #1623/#1866.
- That #8491 introduced the 6.16 re-import sentence in the `importScriptInWorkers` JSDoc.
- Perceptual effect of transition window width: no primary user study found.

## 9. Sources

MapLibre (code cited by tag in the text):
- maplibre-gl-js v6.16.0: `CHANGELOG.md`, `src/index.ts`,
  `src/geo/projection/{projection_crud,projection_factory,crs,tile_matrix_set,projection,mercator_transform}.ts`,
  `src/geo/transform_interface.ts`, `src/style/style.ts`, `src/ui/map.ts`,
  `src/style/style_layer/custom_style_layer.ts`,
  `src/shaders/glsl/_projection_{mercator,globe}.vertex.glsl`, `src/source/worker.ts`,
  `src/ui/control/globe_control.ts`, `src/ui/default_locale.ts`, `src/ui/camera.ts`,
  `src/ui/marker.ts`, `src/ui/popup.ts`, `src/util/browser.ts`, `docs/guides/custom-crs.md`,
  `docs/guides/v5-to-v6-migration-guide.md`, `docs/index.md`, `developer-guides/custom-crs.md`,
  `developer-guides/globe.md`, `build/generate-docs.ts`, `test/README.md`,
  `test/integration/README.md`, `test/integration/lib/puppeteer_config.ts`,
  `test/integration/bundler/`,
  `test/examples/display-geojson-in-a-polar-stereographic-projection.html`;
  raw base `https://raw.githubusercontent.com/maplibre/maplibre-gl-js/v6.16.0/`.
- `maplibre-gl@6.16.0/dist/maplibre-gl.mjs` (unpkg), checked for exports and unmangled
  internal names.
- Local 6.6.0 and 5.24.0 sources under `node_modules/maplibre-gl{,-v5}`.
- maplibre-style-spec v26.5.1 `src/reference/v8.json`, `CHANGELOG.md`.
- Issues and PRs:
  - maplibre-gl-js: [#8330](https://github.com/maplibre/maplibre-gl-js/issues/8330),
    [#8723](https://github.com/maplibre/maplibre-gl-js/pull/8723),
    [#8803](https://github.com/maplibre/maplibre-gl-js/pull/8803),
    [#8807](https://github.com/maplibre/maplibre-gl-js/pull/8807),
    [#8736](https://github.com/maplibre/maplibre-gl-js/issues/8736),
    [#8800](https://github.com/maplibre/maplibre-gl-js/issues/8800),
    [#8964](https://github.com/maplibre/maplibre-gl-js/pull/8964),
    [#168](https://github.com/maplibre/maplibre-gl-js/issues/168),
    [#5764](https://github.com/maplibre/maplibre-gl-js/issues/5764);
  - maplibre-style-spec: [#1623](https://github.com/maplibre/maplibre-style-spec/issues/1623),
    [#1866](https://github.com/maplibre/maplibre-style-spec/issues/1866),
    [#1921](https://github.com/maplibre/maplibre-style-spec/pull/1921);
  - [maplibre/maplibre discussion #491](https://github.com/maplibre/maplibre/discussions/491).
- [awesome-maplibre README](https://github.com/maplibre/awesome-maplibre).

Prior art:
- Mapbox:
  - [Projections guide](https://docs.mapbox.com/mapbox-gl-js/guides/projections/);
  - [v2.6 blog](https://www.mapbox.com/blog/mapbox-gl-js-v2-6);
  - mapbox-gl-js v3.34.2 `src/geo/projection/{adjustments,projection,equal_earth,resample}.ts`,
    `src/data/load_geometry.ts`, `LICENSE.txt`.
- [developmentseed/dirty-reprojectors](https://github.com/developmentseed/dirty-reprojectors).
- MapTiler: [labs page](https://labs.maptiler.com/equal-earth-web-maps/) and its demo bundle.
- [birkskyum/maplibre-gl-js-equal-earth](https://github.com/birkskyum/maplibre-gl-js-equal-earth) @2327107.
- deck.gl docs (`views.md`, `globe-view.md`, `custom-projection-view.md` on master).
- OpenLayers: [raster reprojection tutorial](https://openlayers.org/doc/tutorials/raster-reprojection.html)
  and `src/ol/reproj/*`.
- d3-geo 3.1.2 `src/projection/{equalEarth,resample}.js`.
- [OSUCartography/adaptive-composite-map-projections](https://github.com/OSUCartography/adaptive-composite-map-projections) @bba9686.
- [projectionwizard.org](https://projectionwizard.org).

Cartography:
- Šavrič, Patterson, Jenny 2019, doi 10.1080/13658816.2018.1504949.
- Authors' "Mathematics and Implementation Details" PDF (rev. 2019-04-16, via
  [shadedrelief.com/ee_proj](http://shadedrelief.com/ee_proj/)).
- [EPSG method 1078](https://apps.epsg.org/api/v1/CoordOperationMethod/1078);
  [epsg.io/8857](https://epsg.io/8857), 8858, 8859.
- PROJ 9.9.0 `src/projections/eqearth.cpp`, `docs/source/operations/projections/eqearth.rst`.
- Jenny 2012, doi 10.1109/TVCG.2012.192.
- Šavrič & Jenny 2014, doi 10.1080/13658816.2014.924628.
- Jenny, Šavrič, Patterson 2015, doi 10.1080/13658816.2014.997734.
- Šavrič, Jenny, White, Strebe 2015, doi 10.1080/15230406.2015.1014425.
- Jenny et al. 2017, doi 10.1007/978-3-319-51835-0_9.

Testing and accessibility:
- [Vitest browser mode](https://vitest.dev/guide/browser/).
- Playwright `chromiumSwitches.ts` (v1.62.1 vs main).
- Chromium `docs/gpu/swiftshader.md`.
- [W3C APG button pattern](https://www.w3.org/WAI/ARIA/apg/patterns/button/).
- WCAG 2.2 SC 4.1.2.
