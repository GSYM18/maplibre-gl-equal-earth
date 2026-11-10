# Native Equal Earth → Mercator blend in a MapLibre GL JS 6.16.0 fork: design

Date: 2026-11-10 · Status: written, builder-checked; **to be retargeted** from 6.16.0 to the
newest MapLibre release at least seven days old on 2026-11-15 (6.17.x: its camera rewrite
#8902/#8906/#8961 touches the same seams), with decisions D1–D2 of
`docs/superpowers/handoffs/2026-11-15-maplibre-6.17-handoff.md` still open. Read that handoff
first.

Supersedes `2026-10-14-native-equal-earth-projection-design.md` (branch `native-projection`, a
5.24 + 6.6 design) and folds in its Plan 4's rulings P4-R1 to P4-R5. That spec's model and
decisions stand unless this one says otherwise; this document is self-contained. The polyfill
on `main` stays for stock MapLibre.

**Starting point: a working 5.24 implementation exists.** Plan 4 was carried out on 2026-10-14/15
in `C:/Users/georg.stubenrauch/Desktop/SmartMaps/maplibre-gl-js-equal-earth`, branch
`equal-earth/5.24`: 26 commits on tag `v5.24.0` (`fd31bd8`), package `5.24.0-ee.1`, unit and
render tests added, MapLibre's suites green, gate **GO** (2026-10-14: CPU/GPU agreement within
0.5 px, pointer drift 0.000 px wheel z2 → z9 at ±300 px). Its `README-EE.md` lists every
patched file and the known limits. This design is delivered by **porting that implementation
onto 6.16.0's seams** (§2), not by building afresh. Where the 5.24 code and the letter of this
spec differ, the 5.24 code wins (its choices were measured), unless a 6.16 seam forces a
change; each such case is recorded in the plan. (Builder check, 2026-11-10; my call.)

## 1. Problem and goal

**What the user sees today.** Under the plugin's adaptive `equal` on stock MapLibre, zooming in
past z4 makes the map jump: labels move up and down, and for a moment the map looks empty. The
stepped polyfill causes this and it cannot be tuned away:

- **Each band step snaps the off-centre geometry.** The camera absorbs the step's rotation and
  isotropic scale, not its shear: 300 px from the centre about 7 px at Zürich, 16 px at San
  Francisco, 18–65 px at Anchorage, per step, mostly north–south.
- **z4.0 is the first band boundary**, where MapLibre also switches tile zoom 3 → 4.
- **Scroll zoom anchors at the pointer, but the camera pins the centre**, so the place under the
  cursor moves most.
- **Every band has its own symbol layers and warped tiles.** A switch fades one set out and lays
  the other out again, so labels blink and the map looks empty while tiles are cold.

MapLibre 6.15+'s `addProjection` (used by the plugin since 2026-11-08 for pure `equal-earth`)
does not help `equal`: a registered projection is a fixed CRS whose tiles are pre-cut in its own
grid, it cannot be blended, and it is refused inside projection expressions (§2).

**Goal.** Zooming anywhere in the world, from the Equal Earth overview to street level, feels like
one continuous motion: labels and geometry move smoothly and never jump; labels never re-lay out
because of the projection; the map is never emptier than plain Mercator at the same moment.

**Decisions (user)**

| Question | Decision |
|---|---|
| How far to go | A **native renderer projection**, per-vertex in MapLibre's shaders like globe. No bands, no tile warping. (2026-10-14) |
| MapLibre line | **6.16.0 only** (2026-11-10). MapLibre 5 support was dropped from the plugin on 2026-11-10; the 5.24 fork and the 6.6 port are cancelled. |
| First consumer | **SmartMaps GL**, which no longer needs MapLibre 5. It takes the fork through an npm alias. (2026-10-14, updated 2026-11-10) |
| Upstream | **None.** The fork is for local use; maplibre-gl-js#8330 is not a target. (2026-10-14) |
| v1 layer types | fill, line, symbol, circle, background, **fill-extrusion**. Raster, hillshade and heatmap use the same path but are not acceptance criteria. Terrain is out of v1. (2026-10-14) |
| Approach | **A: flat plane blend** (§3). Rejected: a globe-style clip-space mix that leaks sphere assumptions; a generic projection API first. (2026-10-14) |
| Central meridian | **Fixed at world view, then follows the camera when zooming in** (§3.2). (2026-10-14) |
| Dependencies | **No external resource younger than seven days** (packages, CDN files, git tags), CVE fixes included. v6.16.0 was published 2026-10-25. (standing rule) |
| Commits | **No `Co-authored-by` trailer**, in this repository and in the fork. (standing rule) |

## 2. Findings in MapLibre 6.16.0 that shape the design

Verified 2026-11-10 against the npm tarball's `src/` (the fork clones tag `v6.16.0`; the plan
re-checks line numbers there). Paths are relative to `src/`.

- **WebGL2 only** (`ui/map.ts:79` `ContextType = 'webgl2'`). Shaders are GLSL ES 3.00 with
  `std140` blocks; `inverse()` is available.
- **Projection factory.** `createProjectionFromName(name, transformConstrain, globalState)`,
  `geo/projection/projection_factory.ts:19-90`. An array spec becomes globe (`:25-36`), a
  registered CRS name is checked before the `switch` (`:37-45`), unknown names fall back to
  Mercator (`:80-88`). The fork adds its cases to the `switch` (`:46`).
- **`addProjection` cannot host the fork.** It requires a colon in the name
  (`projection_crud.ts:51`), so `equal`/`equal-earth` are reserved for built-ins, and a CRS is
  only forward/inverse plus a tile matrix set (`crs.ts:33-64`): tiles pre-cut in that grid, the
  Mercator shader variant, no subdivision, no reprojection.
- **Style validation accepts any projection name string** (style-spec
  `validateProjectionDefinition`), so `{ "projection": { "type": "equal" } }` validates unpatched.
- **Globe coupling moved out of the painter.** `ui/map.ts` computes `transitionState > 0`
  (`:4440`, `:4478-4479`, `:4508`, `:4511`, `:4526`) and hands `isRenderingGlobe` to the painter
  in `FrameRenderData`. Its consumers: depth pass and atmosphere (`render/painter.ts:352`,
  `:367`), `webgl/draw/draw_custom.ts:18,24`, `draw_heatmap.ts:146,180`,
  `draw_terrain.ts:31-91`. Equal Earth reports `transitionState = 0`, so none fires.
- **Projection-name tests left:** `ui/map.ts:878` (initial constrain: `!== 'globe' &&
  !getRegisteredProjection`), `style/style.ts:1788` (same-name early return),
  `ui/control/globe_control.ts:51,62`, `source/geojson_source.ts:500`, `ui/map.ts:4273` (event
  payload). 6.6's `painter.ts:363` `name === 'mercator'` test is gone.
- **`worldCoordinateHelper`** (`geo/projection/projection.ts:50`, `transform_interface.ts:25-63,
  :168`) is the **tile-grid** mapping: tile URLs and `{bbox}` (`vector_tile_source.ts:207`), tile
  bounds, features from tiles (`tile.ts:459`), image sources, terrain. Equal Earth tiles are
  Mercator tiles, so it must stay `mercatorWorldCoordinateHelper`; the blend never goes there.
  `helper.wraps` gates world copies at ~20 sites.
- **Shaders.** `projectTile`, `projectTileWithElevation`, `projectTileFor3D`,
  `projectLineThickness`, `projectCircleRadius` live in `_projection_mercator.vertex.glsl:1-37`;
  the variant is chosen through `shaderDefine`/`shaderVariantName`
  (`render/frame_render_context.ts:155-159`). 24 files carry `#ifdef GLOBE`. Three non-globe
  branches bypass `projectTile`: `fill_extrusion.vertex.glsl:60`,
  `fill_extrusion_pattern.vertex.glsl:90`, `depth.vertex.glsl:7`. Line width is a scalar
  `projectLineThickness` in all five line shaders, which is right only for conformal
  projections; the line shaders also extrude `a_offset_normal` (`line-offset`). The Mercator
  fragment prelude's `clipAntimeridian()` is an empty stub.
- **No free plain uniforms.** Projection data is the std140 `ProjectionUBO`
  (`webgl/projection_uniform_buffer.ts:6-13`: `u_projection_matrix`, `…_fallback_matrix`,
  `…_tile_mercator_coords`, `…_clipping_plane`, `…_transition`, `…_clip_antimeridian`), one per
  tile key per frame; per-frame values are the `FrameUBO` (`webgl/frame_uniform_buffer.ts:7-17`,
  filled at `render/painter.ts:250`). Custom layers get the projection prelude without UBOs
  (`#ifndef PROJECTION_UBO`, `_projection_globe.vertex.glsl:3-9`).
- **Labels already move per frame.** Point anchors are projected in the vertex shaders; line
  labels are rebuilt on the CPU each frame through `transform.projectTileCoordinates`
  (`symbol/projection.ts:687-721`, `draw_symbol.ts:396`); collision uses it too
  (`symbol/collision_index.ts:444-484`, with a fast path when
  `getFastPathSimpleProjectionMatrix` returns a matrix, `placement.ts:481`). A projection that
  changes with zoom therefore moves labels continuously, with no re-layout.
- **New in 6.16: placement is skipped when nothing changed.**
  `style.ts:_placementInputsChanged` (`:1932-1940`) re-places only if the
  `modelViewProjectionMatrix`, `transitionState` or a few flags change. A blend or λ₀ change
  with an unchanged plane matrix would leave collision stale.
- **Globe's transition shortcut does not carry over.** During its transition `GlobeTransform`
  runs `projectTileCoordinates`, circle radius and occlusion through the sphere and ignores the
  blend (`globe_transform.ts:293-332`). Between z4 and z8 Equal Earth and Mercator differ a lot,
  so the CPU needs the exact blended map and its inverse. Globe now composes
  `MercatorTransform` and `VerticalPerspectiveTransform` over one shared `TransformHelper`
  (`:260-268`).
- **Subdivision** (`render/subdivision.ts`): granularity is fixed when a tile loads
  (`vector_tile_source.ts:219`, `geojson_source.ts:672` send `projection.subdivisionGranularity`
  to the worker), so the projection must always report its own; pole quads come from
  `_handlePoles` (`:462`); fills at z0 are X-clipped (`:634`). Meshes come through
  `FrameRenderContext.getMeshFromTileID` (`frame_render_context.ts:143`).
- **Covering tiles** (`geo/projection/covering_tiles.ts:286-398`): a details provider
  (`covering_tiles_details_provider.ts`: `distanceToTile2d`, `getWrap`,
  `getTileBoundingVolume`, `allowVariableZoom`, `allowWorldCopies`, `prepareNextFrame`, new
  `getCenter`). `coveringZoomLevel` (`:171-177`) uses the raw transform zoom with no hook.
- **`MercatorTransform`** (`geo/projection/mercator_transform.ts`) still has every method this
  design overrides (§4.2); `_viewProjMatrix`, `_pixelMatrix` and `_cameraState` are `private`.
  `transformConstrain` reaches it as `constrainOverride`.
- **Terrain has no projection gate:** `map.setTerrain` (`ui/map.ts:2990-3033`) builds terrain for
  any projection.
- **No GPU `atan` error correction** exists any more (`ProjectionErrorMeasurement` is gone; globe
  uses an atan-free form).

## 3. The projection model

### 3.1 One per-vertex map

Every vertex of a Mercator tile goes tile → lng/lat (λ, φ) → plane → screen. The plane position
is a pure function of the vertex and the camera, evaluated identically in GLSL and in TypeScript:

```
λ' = λ − λ₀ + 2π·wrap                               λ₀: central meridian (§3.2); wrap ∈ {−1,0,1} (§3.4)
E  = EqualEarth(λ', φ) · GRID_FACTOR                Mercator world units, as in the polyfill
M  = Mercator(λ', φ)
P  = (1 − t) · E + t · M                            t = t(zoom) (§3.3)
screen = viewProjection · (Mc + P(v) − P(c))        Mercator's plane camera, relative to the centre c
```

- `GRID_FACTOR` and the forward maths are those of this repository's `src/math/equal-earth.ts`
  and `src/math/backproject.ts`, so zoom levels mean the same as under the polyfill. `Mc` is the
  centre's Mercator coordinate.
- **Inverse.** Closed form where it exists, else a 2D Newton solve with the analytic Jacobian
  from the Mercator inverse (3–4 iterations to below 1e-9 world units).
- **The local Jacobian `J(λ, φ)` of `P`** is used for line extrusion and the covering zoom.
- **`t = 1` is plain Mercator.** Every CPU and GPU path then hands over to MapLibre's own
  Mercator code: pixel-identical, full precision, no cost.
- **The blend source of truth (P4-R5).** `t` is a pure function of the transform's zoom. The
  projection reads it from the transform the factory created with it, so the shader variant and
  the projection data always come from the same zoom.

### 3.2 Central meridian

- **Up to z2:** `λ₀ = centralMeridian` (option, default 0°): the world map stays still while
  panning.
- **z2 → z4:** λ₀ eases with smoothstep along the shorter arc from `centralMeridian` to the
  camera's longitude.
- **From z4:** λ₀ follows the camera's longitude, so the meridian through the centre is vertical
  and the z4–z8 blend never rotates the map; only the north–south stretch changes.
- **λ₀ is path state, not a function of the centre** (5.24 commit `fb46563`). A pure function
  of the centre would jump by about 90° when a pan at z2–z4 crosses `centralMeridian ± 180°`,
  where the shorter arc flips side. So λ₀ is camera state that follows the pan path, carried
  through `clone()`/`apply()` of the requested camera state, and re-anchored canonically after
  any centre jump wider than 45° (`jumpTo` across the world). "This lng/lat under this pixel" is
  still solved exactly, so panning stays exact while the world reshapes around z2–z4.
  `setEqualEarthOptions` keeps the anchor unless `centralMeridian` changes (`48a39fa`).
- **Options** `followFrom`, `followTo`, defaults 2 and 4.

### 3.3 Blend

- `t(zoom) = smoothstep(from, to, zoom)`, defaults `from = 4`, `to = 8`, both options. No kink at
  either end.
- `equal-earth` is `t ≡ 0` at every zoom.

### 3.4 Level of detail, seam, poles, outside, precision

- **Covering zoom.** Corrected by `log2` of the local isotropic scale `√|det J|` at the centre;
  without it, at high latitudes too-fine tiles load.
- **Seam (P4-R1).** λ₀ follows the camera, so the back meridian `λ₀ ± π` can cut any tile. Each
  tile is drawn on up to three longitude branches, `wrap` −1, 0, 1; the covering tiles cull
  branches that are not visible; the fragment `clipAntimeridian()` discards `|λ'| > π`. No world
  copies, whatever `renderWorldCopies` says.
- **Poles (P4-R4).** The pole quads of the edge tile rows map to the Equal Earth pole line at
  latitude `±mix(90°, 85.0511°, t)`, drawn in their edge's colour as globe does; the caps shrink
  continuously as the blend nears Mercator.
- **Outside.** Tiles cover only the lens-shaped world; outside it the canvas is transparent and
  the container's background shows.
- **Precision.** Under `t < 1`, `P` is evaluated relative to the camera centre (`P(v) − P(c)`,
  §3.1). The prelude takes sin φ and the Mercator term from the vertex's own Mercator y, never
  from GPU `sin()` or a float32 round trip (5.24 commits `fc3f026`, `c401acb`: GPU `sin()` put
  pure `equal-earth` about 100 px off at z14). The vertex's Mercator y is still absolute float32,
  so pure `equal-earth` jitters above z15 (≤ 0.7 px at z14, ≤ 2.5 px at z16 on SwiftShader): an
  accepted v1 limit; `equal` is unaffected (stock Mercator from z8).

## 4. MapLibre integration (6.16.0)

### 4.1 Projection

- `createProjectionFromName` resolves `'equal'` and `'equal-earth'` to `EqualEarthProjection` +
  `EqualEarthTransform` + `MercatorCameraHelper`, as new `switch` cases. The registry of
  `addProjection` stays untouched and keeps working for colon names.
- `EqualEarthProjection`: `name` is the requested name; `shaderDefine`
  `#define PROJECTION_EQUAL_EARTH`, `shaderVariantName` `'equal-earth'`; `useSubdivision` always
  true with its own granularity (starting from globe's); `getMeshFromTileID` returns subdivided
  meshes with pole quads; `transitionState` always 0; `worldCoordinateHelper` is
  `mercatorWorldCoordinateHelper`; `useGlobeControls` false.
- `ui/map.ts:878`'s initial-constrain test learns the two names. The other name tests (§2) need
  no change; the plan confirms each.

### 4.2 Transform

`EqualEarthTransform` builds on `MercatorTransform` (subclass with the three private members
widened, or composition over a shared `TransformHelper` as globe does: the builder's choice).

- **Kept from Mercator:** camera, pitch, frustum and the view-projection matrix, in plane space.
- **Overridden:** `getProjectionData` (plane matrix, tile Mercator coordinates; blend, λ₀ and
  the centre's `P` via §4.4); `projectTileCoordinates`; `locationToScreenPoint`,
  `screenPointToLocation`, `screenPointToLocationAtElevation`,
  `screenPointToMercatorCoordinate`; `setLocationAtPoint` and `getCameraForLocationAtPoint`;
  `calculateCameraOptionsFromTo`, `getCameraLngLat`; `getBounds` (screen samples, unprojected);
  `isPointOnMapSurface` and `isLocationOccluded` (inside the lens); `defaultConstrain` (centre
  inside the lens, minimum zoom fits the world; an application's `transformConstrain` and
  `maxBounds` still apply); `getVisibleUnwrappedCoordinates` (one world plus the seam branches);
  `getCoveringTilesDetailsProvider` (§4.5); `getPixelScale`, `getCircleRadiusCorrection`,
  `getPitchedTextCorrection` from `J` at the centre; `getFastPathSimpleProjectionMatrix`
  `undefined` while `t < 1`. (`getProjectionDataForCustomLayer` is not overridden in v1, as in
  5.24; see §4.7.)
- **At t = 1 every override defers to Mercator.**

### 4.3 Camera

The Mercator camera helper is used unchanged: pan and zoom-around go through the exact
`setLocationAtPoint`, so the point under the pointer stays put. `easeTo`, `flyTo` and
`fitBounds` interpolate as today.

### 4.4 Shaders and uniforms

- **New prelude** `_projection_equal_earth.vertex.glsl` plus a fragment part: forward Equal
  Earth, the blend, λ₀, the branch offset, the relative-to-centre form, `projectTile*` with the
  existing signatures, `projectLineThickness`, a helper returning `J`, and `clipAntimeridian()`
  for the seam. It also compiles without `PROJECTION_UBO` for custom layers.
- **Uniforms.** Blend, λ₀ and the centre's `P` are per frame: extend the `FrameUBO` (TS layout and
  GLSL block together). The per-tile branch `wrap` goes into the `ProjectionUBO` (an unused slot
  under this variant, or an added field). Never write `in <word> <word>` in a prelude comment:
  the shader `prepare()` reads it as a vertex attribute.
- **Unchanged:** background, fill, fill-pattern, raster, hillshade, color-relief, circle, heatmap
  and collision shaders, through `projectTile*`.
- **Patched by hand:**
  - **The five line shaders:** the extrusion vector and `a_offset_normal` go through `J` and are
    renormalised in screen space, so width, joins and offsets stay true on screen.
  - **`fill_extrusion`, `fill_extrusion_pattern`, `depth`:** the non-globe branch goes through
    `projectTileFor3D`. Wall normals stay in tile space (P4-R3); extrusions appear from z13,
    where `t = 1`.
  - **Map-aligned symbols and circles (P4-R2):** while `t < 1`, `text-/icon-pitch-alignment: map`
    and `circle-pitch-alignment: map` are evaluated as `viewport`, so glyphs and dots keep their
    shape; rotation alignment is unchanged and line labels still follow their line.

### 4.5 Covering tiles

- The details provider gives an axis-aligned box of each warped tile per branch in plane units,
  sampled along the tile's curved meridian edges; `distanceToTile2d` measures in plane space;
  `allowWorldCopies` is false; `getWrap` returns the branch; `getCenter` returns the plane centre.
- Variable zoom only when pitched, as in Mercator.
- `coveringZoomLevel` gets the `√|det J|` correction (§3.4) through a small patch or a new
  provider hook.

### 4.6 Symbol placement

`_placementInputsChanged` also compares the blend and λ₀ of the last placement, so collision
follows the projection while the plane matrix stays unchanged (panning east–west at z ≥ 4,
`setEqualEarthOptions`).

### 4.7 Not in v1

- **Terrain.** `setTerrain` under `equal-earth`, and under `equal` while `t < 1`, warns once and
  stays suspended until `t = 1` (a patch in `map.setTerrain` and the style's terrain paths).
- **Raster, hillshade, heatmap:** same path, untested.
- **Custom layers** that treat the matrix as Mercator break below `t = 1`, as under globe; no
  `getProjectionDataForCustomLayer`/`getMatrixForModel` override; documented.
- **The rest of 5.24's known limits carry over as accepted v1 limits** (its `README-EE.md`):
  approximate line caps and joins under strong shear, dash/pattern spacing in tile units while
  `t < 1`, DOM Markers with `pitchAlignment: 'map'`, the snap when crossing `to` with
  `renderWorldCopies: false` or `maxBounds`, the polar slide near z7.6–8, and
  `setEqualEarthOptions` not re-running the constraint. The port re-measures each and updates
  the list.

## 5. API, packaging, the plugin

### 5.1 API of the fork

- **Switching:** `map.setProjection({ type: 'equal' | 'equal-earth' })` and the style's
  `projection`.
- **Map option** `equalEarth: { from, to, centralMeridian, followFrom, followTo }`, plus
  `map.setEqualEarthOptions(options)`: the fork's only API divergence from MapLibre.
- **Geographic everywhere:** `getCenter`, `project`/`unproject`, events, markers, popups,
  `queryRenderedFeatures` geometry and `getStyle()` are geographic natively.
- **Detection:** `getVersion()` ends in `-ee.<n>` (e.g. `6.16.0-ee.1`).

### 5.2 Packaging

- **Fork repository:** the existing
  `C:/Users/georg.stubenrauch/Desktop/SmartMaps/maplibre-gl-js-equal-earth`. Fetch tag `v6.16.0`
  into it (it is a shallow clone of maplibre-gl-js) and start branch `equal-earth/6.16` there;
  `equal-earth/5.24` stays as the reference. Nothing in it has ever been pushed.
- **Commit messages.** The 5.24 branch's messages carry 30 `Co-authored-by` trailers. Before
  porting, they are removed by rewriting that local branch (backup bundle first), so nothing
  cherry-picked or quoted brings one along. (My call, applying the standing rule.)
- **Package** `@yellowmap/maplibre-gl@6.16.0-ee.1`. Pushing and publishing are the user's steps.
- **Install** with `npm ci` from the tag's lockfile. The registry is registry.npmjs.org; the old
  proxy cutoff (2026-08-31) no longer applies (verified 2026-11-10: Vite 8.3.5 of 2026-10-21
  installed). `min-release-age=7` holds; everything the tag's lockfile pins predates the tag
  (2026-10-25). Add no dependency younger than seven days.
- **Fork hygiene:** no reformatting; patches touch only the lines they need; every patched file
  is listed in `README-EE.md`. MapLibre's BSD-3 licence and attribution stay intact.
- **Consumption:** wrappers alias it, e.g. SmartMaps GL
  `"maplibre-gl": "npm:@yellowmap/maplibre-gl@6.16.0-ee.1"`. SmartMaps GL's own move from its
  embedded 5.13 to MapLibre 6 is its migration, done with guidance if its source is reachable.

### 5.3 This plugin

- **On a fork build** (`-ee` tag) `installEqualEarth` installs no worker bundle, protocol, style
  rewrite, camera hook, wrappers or `addProjection` CRS; its `transition` options map to
  `equalEarth`.
- **Kept:** `EqualEarthControl` and the cartography options (`outline` and `graticule` become
  plain GeoJSON layers; `outside` becomes the container's background).
- **On stock MapLibre 6.6+** the plugin stays as it is: bands for `equal`, `addProjection` for
  pure `equal-earth` on 6.15+. Applications keep one API either way.

## 6. Acceptance criteria

Measured at Zürich, Tokyo, San Francisco, Anchorage, Singapore, Reykjavík and Sydney, at dpr 1
and 2, on `6.16.0-ee`.

1. **The pointer stays put.** Wheel zoom z1 → z12 with the pointer 300 px off-centre: the place
   under it drifts ≤ 1 px at every frame; the same for pinch; `flyTo` lands within 1 px.
2. **Labels glide.** Zooming through z2–z9 at constant speed, each label anchor's frame-to-frame
   motion is ≤ 1.5× a pure zoom about the same point. No label vanishes or reappears except by
   zoom-dependent collision, as in Mercator.
3. **Never empty.** No frame shows uncovered area inside the world outline where stock Mercator
   would have drawn a tile or placeholder.
4. **Mercator unchanged.** At `t = 1`, and under `mercator` and `globe`, rendering is
   pixel-identical to stock 6.16.0. MapLibre's own unit and render suites pass unchanged.
5. **CPU and GPU agree.** `project()` of markers and rendered point features is within 0.5 px of
   the drawn position at every `t`.
6. **Lines and text keep their shape.** At 70°N under `equal-earth`, screen line width within 5 %
   of specified, map-aligned glyph aspect within 5 %.
7. **Same Equal Earth as stock.** Under `equal-earth` at the world view, the fork's rendering of a
   point matches the plugin's `addProjection` mode on stock 6.16.0 within 1 px.
8. **Performance on real hardware** (the user's machine, not SwiftShader): frame time ≤ 1.3×
   Mercator in the same view; first paint at the world view no slower than stock Mercator.

## 7. Testing

- **Fork, unit:** the maths (forward against `equal-earth.ts` to 1e-9, inverse round trip, `J`
  against finite differences, λ₀ easing); the transform (project/unproject round trips across
  `t`, `setLocationAtPoint` exactness); covering tiles and branches; the constraint; terrain
  suspension; placement re-triggering.
- **Fork, render tests:** MapLibre's render suite gains `equal` and `equal-earth` cases (world,
  z4, z6, z8, high latitude, pitched, extrusions, line widths, a Pacific `centralMeridian: 150`
  world).
- **This repository:** a Playwright project `v6-ee` against the fork's build, with specs for
  criteria 1–5 and 7; the `v6` and `v6-native` projects stay for the polyfill; the native probe
  script from branch `native-projection` (`scripts/probe-native.mjs`) is reused for the gate.

## 8. Delivery order

1. **Port the core and re-run the gate:** maths, prelude, projection, transform, factory and
   covering on 6.16.0's seams (UBOs, the shared `TransformHelper`, `worldCoordinateHelper`), then
   the 5.24 gate probe (`scripts/probe-native.mjs`, branch `native-projection`) against the port:
   criterion 5 and criterion 1 at Anchorage must hold before the rest is ported.
2. **6.16.0-ee complete:** every v1 layer type, symbols and the placement trigger (§4.6), camera,
   constraint, seam and poles, terrain suspension, the 5.24 unit and render tests ported, the
   patch list rewritten for 6.16.
3. **Plugin handover:** fork detection, control, cartography, the `v6-ee` browser project.
4. **SmartMaps GL:** the alias and its move to MapLibre 6, guided.

## 9. Risks

- **CPU/GPU disagreement during the blend.** One shared formulation, a read-back test comparing
  GLSL with TypeScript, and the gate first.
- **Maintaining a fork.** Each MapLibre update is a rebase; patches stay confined to listed seams,
  no reformatting, a patch list in `README-EE.md`.
- **UBO layout changes** touch every program. Extend the blocks in one place (layout + GLSL) and
  pin them with the pixel-identity criterion 4.
- **Shader cost of `J` in lines.** Measure under criterion 8; fall back to the isotropic part
  `√|det J|` if it misses the budget.
- **float32 at high zoom in `equal-earth`.** Relative-to-centre evaluation and a render test at z14.

## 10. Left to the builder

Subclass versus composition for the transform (§4.2); which UBO slot carries `wrap` (§4.4);
patch versus hook for the covering zoom (§4.5); the exact subdivision granularity; render-test
image tolerances; the debug page's form; the plan's task split. Mark each choice in the plan.
