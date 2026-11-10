# MapLibre custom projections from 6.15 on, and what this plugin is still for

Date: 2026-11-10 · Kind: research note · Branch: `feature/native-blend-6.16`
Question: from MapLibre GL JS 6.15 on, what does MapLibre support for custom projections
(`addProjection`, the workers' `setProjectionHandler`, tile matrix sets)? In that light, (a) what
is the best architecture for this plugin, and (b) what does it still provide?
Builds on `2026-11-07-equal-earth-on-vanilla-maplibre.md` (the "11-07 note"). That note's §1.2
and §1.4 hold unless this note says otherwise; they are not repeated here.
Scope: primary sources only. Citations:
- `npm 6.16.0:path:lines` is the `maplibre-gl@6.16.0` npm tarball's `src/`.
- `v6.17.0:path:lines` is `raw.githubusercontent.com/maplibre/maplibre-gl-js/v6.17.0/…`.
- `repo:path:lines` is this repository.

**Evidence** is anything cited. Lines marked **Inference** are my reasoning, and
**UNVERIFIED** marks what I could not trace to a source.

## 0. Summary

- **6.17.0 is now the newest release, published 2026-11-07, and cannot be adopted before
  2026-11-15** under the seven-day rule. It has no custom-projection changes. It does rewrite
  camera scheduling (#8961), which removes `Camera#isEasing`. This plugin's band camera relies on
  that method (§1, §5).
- **The `addProjection` surface is unchanged since 6.15.** It registers a planar CRS whose tiles
  are already cut in its quad grid:
  - lng/lat API, queries, markers, `fitBounds`, terrain and GeoJSON all work, GeoJSON through a
    worker handler;
  - Mercator tiles are not reprojected;
  - there is no blend and no projection expression;
  - there are no world copies or globe;
  - switching projection after the sources load is unsupported "for now" (§2).
- **Upstream direction.** #168 is closed as delivered. #8330 (adaptive Equal Earth) is still
  open with no activity since 2026-09-08. Mercator-tile reprojection is "the GPU reprojection
  discussion in maplibre/maplibre#491" and has no PR. A naming collision is coming:
  - style-spec #1865 proposes `equal-earth` = **adaptive**;
  - this plugin, the fork spec and MapTiler's #1623 use `equal` = adaptive and
    `equal-earth` = pure (§3).
- **The user's example is correct for a GeoJSON-only world map** and is the same code as
  makewithmaplibre.com's world demo. It cannot draw a Mercator vector basemap, show detail
  beyond its own GeoJSON, or blend into Mercator (§4).
- **The plugin's unique value on stock MapLibre ≥ 6.15:**
  - warping Mercator vector tiles (the `eqearth://` pipeline plus its caches);
  - the adaptive `equal` mode;
  - switching projections on a live map.

  The geographic API wrappers and the band machinery are redundant for **pure** Equal Earth on
  6.15+. The plugin's native mode already drops them there (§5).

## 1. Releases from 6.15 on

npm registry `time` (fetched 2026-11-10): `dist-tags.latest` is `6.17.0`.

| Release | Published (UTC) | Adoptable (≥ 7 days) | Custom-projection changes |
|---|---|---|---|
| 6.15.0 | 2026-10-18 13:01 | yes | `addProjection`/`removeProjection`/`identity`/`{bbox}` (#8723); GeoJSON projected in workers from `definition` + handler (#8736/#8738); `hash` in a registered projection (#8743); blank map when the centre crosses 180° (#8802); world projections throwing/jumping in the space around the world (#8803) (`v6.17.0:CHANGELOG.md:44-69`) |
| 6.16.0 | 2026-10-25 13:17 | yes | none in the changelog (`CHANGELOG.md:22-42`). Internally, Core State Consolidation stage 1 landed, incl. "CSC-1.5 Give custom CRS transforms their mapping when created" (#8859) (GitHub compare v6.15.0…v6.16.0) |
| 6.17.0 | 2026-11-07 23:03 | **no: not before 2026-11-15** | none (`CHANGELOG.md:8-20`). The diff v6.16.0…v6.17.0 touches no file under `docs/guides` and does not touch `crs.ts` or `projection_crud.ts`. It contains CSC stage 2: #8902 "let Map change the camera only through Camera" and #8906 "make the camera's transform read-only outside Camera". It also contains #8961 "refactor camera task scheduling" and the experimental `sparse` vector source (#8335) |
| main (unreleased) | — | — | #8964 merged 2026-11-08: `hasLngLat` is false where the inverse's latitude passes ±90° (`src/geo/projection/crs.ts`, PR diff). Harmless here, because this plugin's inverse never returns \|lat\| > 90° |

**Consequence for this plugin (Inference from the cited code, not run):**

- In 6.16, `Camera#isEasing()` existed (`npm 6.16.0:src/ui/camera.ts:1586-1588`) and the
  Camera's `moveend` always deleted `_requestedCameraState` (`:478-480`).
- In 6.17.0, `isEasing` is gone from `src/ui/camera.ts` and `src/ui/map.ts`. It is replaced by
  `isMoving()` on a `CameraMovementScheduler` (`v6.17.0:src/ui/camera.ts:1561-1563`), and the
  Camera deletes `R` only `if (!this._scheduler.isMoving())` (`:471-473`).
- This repo's `discardRequestedState` returns `false` whenever `isEasing` is not a function
  (`src/map/camera.ts:184-190`). On 6.17 it therefore never deletes `R`, on a Map-fired `moveend`
  or on a gesture `*end`. That reopens the double conversion CLAUDE.md records: Guadalajara
  1.74° off.
- The peer range `>=6.6 <7` already admits 6.17.0. This needs a test on 6.17 once it is
  adoptable.

## 2. `addProjection` on the newest release: capabilities and limits

The API is identical in 6.16.0 and 6.17.0.

- `CRS = {name, projection: {forward, inverse}, tileMatrixSet, definition?}`
  (`npm 6.16.0:src/geo/projection/crs.ts:33-64`).
- `addProjection` throws in three cases (`projection_crud.ts:50-61`):
  - a name without a colon;
  - **a name already registered** (`:54-56`);
  - `extentAtZoom0 ≤ 0`.
- There is no update call: replacing a CRS takes `removeProjection` then `addProjection`
  (`docs/guides/custom-crs.md:224-226`).
- The whole surface, `setProjectionHandler` included, "can still change in a minor release"
  (`custom-crs.md:7`).

| Area | Registered CRS on stock 6.15–6.17 | Source |
|---|---|---|
| Vector / raster / DEM tiles | Must be cut in the CRS's square power-of-two quad grid; drawn "exactly as mercator tiles are" with the Mercator shader variant | `custom-crs.md:11,211,216`; 11-07 note §1.2 |
| Mercator-gridded basemaps (OpenMapTiles, OpenFreeMap, SmartMaps) | **No.** "A Mercator tile source on an EPSG:2193 map … renders in the wrong place"; reprojection "is the subject of maplibre/maplibre#491". PR author: "Mercator vector tiles drawn in a CRS: not this PR" | `custom-crs.md:5,215`; [#8723 comment](https://github.com/maplibre/maplibre-gl-js/pull/8723#issuecomment-6076437674) |
| GeoJSON | Parsed and tiled in the workers. The CRS's `definition` string goes to one per-worker handler (`self.setProjectionHandler`, loaded with `importScriptInWorkers`); a later call replaces it; converters are cached per string. Only positions are projected, so long edges need densifying by the caller. Data outside the grid is cut. With no handler, MapLibre warns and draws in the wrong place | `npm 6.16.0:src/source/projection_handler_worker.ts:11-44`; `custom-crs.md:165-187` |
| Image / video / canvas | Placed by four lng/lat corners, in the projection the map had when the source loaded | `custom-crs.md:210,221` |
| Labels, line widths | Laid out and collided in grid space, as in Mercator: upright text and screen-constant widths. **Inference**: the grid is affine per tile, so no shear | `custom-crs.md:11`; 11-07 note §1.2 |
| World copies, antimeridian | None; `wraps = false`; the centre is kept inside tile 0/0/0 | `crs.ts:84-85`; `custom-crs.md:14,30` |
| Space around a world projection | An inverse counts only if `forward` maps it back within `1e-3·extentAtZoom0`; otherwise the edge is found by bisecting towards the centre (30 halvings) and gestures zoom around the centre | `crs.ts:13-19,112-168`; `mercator_transform.ts:635-645` |
| lng/lat API | `project`, `unproject`, `getBounds`, `fitBounds`, `flyTo`, markers, events and `query*Features` speak lng/lat. Boxes are projected from a grid of samples | `custom-crs.md:203-208`; #8723 body item 6 |
| Initial `bounds` option | Fitted **in Mercator**, because the constructor calls `fitBounds` before `setStyle` | `npm 6.16.0:src/ui/map.ts:859-871` vs `:886` |
| Terrain / hillshade | From DEM tiles in the same grid; no latitude correction | `custom-crs.md:209` |
| Globe, projection expressions, transitions | Always flat, no globe transition. A registered name inside an expression produces a warning and globe is drawn | `custom-crs.md:15,220`; `projection_factory.ts:25-36` |
| Switching projection after load | "not supported … for now". The page's advice: "To switch, make a new map" | `custom-crs.md:221`; [makewithmaplibre](https://makewithmaplibre.com/projections/) "Good to know" |
| `within`/`distance`, `MercatorCoordinate`, custom layers | Still Mercator; custom layers get CRS world units | `custom-crs.md:191-201,219` |
| Status | `@experimental`. After 6.15 the maintainer said: "we have to let people use the experimental planar projections and gather feedback" | `crs.ts:22`; [#8723 comment, Birk Skyum, 2026-10-16](https://github.com/maplibre/maplibre-gl-js/pull/8723) |

## 3. Upstream status and direction

- [#168](https://github.com/maplibre/maplibre-gl-js/issues/168) was closed 2026-10-18 by Birk
  Skyum (member): "With 6.15 … most of the requests here are addressed … the new
  `addProjection` API is currently marked experimental"; he points to
  makewithmaplibre.com/projections.
- On the same issue, 1ec5 (contributor): "built-in on-the-fly reprojection into additional
  non-Mercator projections … will need to start at the style specification level. See …
  maplibre/maplibre-style-spec#1865 for adaptive Equal Earth" (2026-10-18).
- The author's scoping on #168 (johncarmack1984, 2026-08-25): "The GPU reprojection lane … is
  a different problem: re-rendering Mercator tiles into Equal Earth … The seam below is
  groundwork it can use too."
- [#8330](https://github.com/maplibre/maplibre-gl-js/issues/8330) is **open**, with 4 comments,
  the last on 2026-09-08. Nothing has changed since the 11-07 note §1.4.
- Style spec (GitHub API, 2026-11-10):
  - [#1865](https://github.com/maplibre/maplibre-style-spec/issues/1865) is open with no
    comments. It proposes `"type": "equal-earth"` as **adaptive by default**, with
    `"transition": [6, 7]`, and keeps fixed Equal Earth out (`transition: false` is "not …
    supported … yet").
  - [#1623](https://github.com/maplibre/maplibre-style-spec/issues/1623) (MapTiler) is open,
    with `equal` = adaptive and `equal-earth` = pure.
  - [#1866](https://github.com/maplibre/maplibre-style-spec/issues/1866) is open. HarelM: "we
    shouldn't do a breaking change soon (in the next 6 months at least)" (2026-09-07). Newest
    comment, sargunv (member), 2026-11-09: "it makes sense to fix the api and document the new
    simpler api, while keeping compatibility with the old form."
  - [#1921](https://github.com/maplibre/maplibre-style-spec/pull/1921) (`dataProjection`) was
    closed unmerged on 2026-10-14. No successor was found.
- Mercator-tile reprojection: Birk Skyum on #8803 said a re-projecting Equal Earth "goes well
  beyond this initial projection support, which is more about supporting non-mercator data
  sources. It's something we can expand with" (2026-10-18). #8807 reworded the docs so that the
  door stays open.
- [#8694 "[Tracking] Core State Consolidation"](https://github.com/maplibre/maplibre-gl-js/issues/8694)
  (Skyum, updated 2026-11-09):
  - stage 3 moves draw code to a plain `CameraData`;
  - stage 4 includes "CSC-4.1 Give each source its own tile grid instead of the map's" and
    "CSC-4.2 Move the rules for registered projections out of `MercatorTransform`".

  **Inference:** a per-source tile grid is the prerequisite for a Mercator source on a CRS map,
  that is for reprojection. The same stages move the seams that the 6.16 fork spec patches
  (§2 of that spec).
- [maplibre/maplibre#491](https://github.com/maplibre/maplibre/discussions/491): no activity
  after 2026-09-11 (page fetched 2026-11-10); still waiting on NLnet, and no PR exists.
- No release, PR or maintainer statement gives a timeline for (a) reprojecting Mercator tiles,
  (b) adaptive blends or (c) a built-in Equal Earth. **UNVERIFIED**: any date.

## 4. The user's example

It is the makewithmaplibre.com world demo (page source fetched 2026-11-10):
- `definition = EPSG_8857` from `crs-defs` 0.1.1, i.e.
  `"+proj=eqearth +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs"`
  (`unpkg.com/crs-defs@0.1.1/EPSG/8857.js`);
- `projection = proj4(EPSG_4326, definition)`;
- `worldSquare()`, which samples every 2° and takes `side = 1.04 · max(width, height)`;
- the name `` `custom:world-${++count}` ``;
- `await importScriptInWorkers(projection-handler.mjs)` before `new Map`;
- GeoJSON `sphere`, `graticule(15)` and Natural Earth 1:50m sources;
- `maxZoom: 5`;
- `fitBounds` on `style.load`.

**What it proves.** On stock 6.15+, a proj4 world projection with labels, hover queries and
popups in lng/lat needs no plugin when every layer is GeoJSON.

**Pitfalls, checked against the source:**
- **`projection` must be `{forward, inverse}` over arrays.** A proj4 converter fits, because the
  CRS type is "the shape of a proj4 converter" (`crs.ts:41-52`). Passing proj4 "straight in" is
  fine for Equal Earth:
  - proj4's `eqearth` wraps longitude (`adjust_lon`) past ±180°, so the round trip fails and
    MapLibre rejects the answer;
  - above the world, the inverse returns NaN;

  (`crs.ts:128-150`; proj4js v2.22.0 `lib/projections/eqearth.js`; #8803 body).
- **`definition` is read only in the workers, for GeoJSON** (`crs.ts:58-63`). It must be a
  string the worker's own proj4 can parse; a bare `"EPSG:8857"` code would fail without
  `proj4.defs` in the worker (**Inference**). The page and the worker must also use the same
  proj4 version, as the page itself warns.
- **One handler per worker.** It is global and the last setter wins
  (`projection_handler_worker.ts:13-28`). A page that also loads this plugin's worker bundle
  gets one handler or the other (README §Native).
- **Name uniqueness is required, not cosmetic.** A second `addProjection` with the same name
  throws (`projection_crud.ts:54-56`), hence `++count`.
- **The `fitBounds` timing is right.** The `bounds` option would fit in Mercator
  (`map.ts:859-871` vs `:886`), as the page's own comment says.
- **Padding by 1.04 only works because nothing is tiled.** The grid is arbitrary when every
  source is GeoJSON. Server tiles would need the server's exact matrix (`custom-crs.md:41`). This
  plugin's warped tiles fix `extentAtZoom0 = 2·X_MAX` with no padding (`src/math/crs.ts:66-73`).
  At the same zoom the example's world is about 4 % smaller.
- **Ellipsoid vs sphere.**
  - The example's `+datum=WGS84` is ellipsoidal: proj4js uses the authalic latitude when
    `es ≠ 0`, in `eqearth.js` `init`/`forward`.
  - This plugin uses a sphere (`EQUAL_EARTH_DEFINITION = '+proj=eqearth +R=6371008.7714 …'`,
    `src/math/crs.ts:26`).
  - Computed here: the maximum gap between geodetic and authalic latitude is ≈ e²/3 rad ≈
    0.128° (≈ 14 km), which settles the 11-07 note's "≈0.13° UNVERIFIED". That is ~6–7 px at
    z5.
  - Each setup is consistent with itself. Mixing EPSG:8857 overlays or server tiles with this
    plugin's grid would misregister.
- **Limits:**
  - no Mercator vector basemap ("a Mercator basemap won't line up", page "Good to know");
  - no detail beyond the GeoJSON (`maxZoom: 5`);
  - edges are straight chords between positions (the data is pre-densified "a point at least
    every degree");
  - `+lon_0` is fixed at 0 because the data is cut at 180°;
  - no blend and no world copies.

## 5. This plugin's capabilities on stock MapLibre ≥ 6.15

| Capability | Status on 6.15–6.17 | Evidence / reasoning |
|---|---|---|
| Backprojection polyfill (bands, map space, camera hooks) | **Redundant for pure `equal-earth`** (native mode replaces it); **still needed for `equal`** and for any peer before 6.15 | Expressions are refused (`projection_factory.ts:25-36`). At risk on 6.17 (§1) |
| `eqearth://` Mercator-tile warping (+ LRU, decode cache, coalescing) | **Uniquely needed** whenever the basemap is Mercator-gridded. Native mode is "native" only because this pipeline cuts the tiles | `custom-crs.md:5,215` |
| Adaptive `equal` | **Uniquely available on stock**; no upstream equivalent in any release | §3 |
| Native mode (`equal-earth:native`) | **This is the state-of-the-art use of the API**: same shape as the docs and the example | `src/math/crs.ts`, `src/install.ts:353-384` |
| Geographic API wrappers | **Redundant in native mode** (they already report inactive); needed for bands | `custom-crs.md:203-208` |
| Cartography (outline, graticule, outside colour) | **Partly redundant**: in native mode they are plain GeoJSON, as in the example. They remain a convenience; under bands they need the warp | example `sphere`/`graticule` |
| Control | **Still useful.** MapLibre has only `GlobeControl`, and switching a live map to or from a CRS is officially unsupported. The plugin's `setStyle(…, {diff:false})` swap was verified on 6.16 in the 11-07 spike, but it relies on unsupported behaviour | `custom-crs.md:221`; 11-07 note §8 |
| GeoJSON handling | **Partly redundant in native mode**: MapLibre projects it. The plugin still adds clipping at ±180° and densification in lng/lat, which MapLibre leaves to the caller | `src/map/geojson.ts:53-60`; `custom-crs.md:187` |
| Persistent tile cache | Needed as long as warping is client-side; unrelated to MapLibre features | — |
| UMD | **Weaker case.** MapLibre v6 is ESM-only (11-07 note §5) and v5 support is gone, so the UMD serves only classic pages that `import()` MapLibre (`demo/umd.html`) | **Inference** |

**`src/math/crs.ts` compared with the docs and the example:**
- Same CRS shape; a colon name; registered once, with remove/re-add on a stale registration
  (`install.ts:369-384`).
- The grid is exact rather than padded, because it must equal the warped tiles.
- An explicit inverse returns `null` beside or beyond the world, where the example relies on
  MapLibre's round-trip check.
- A spherical `definition`, consistent with the tiles.
- The worker handler throws on foreign definitions instead of building any proj4 string
  (`crs.ts:80-88`). That is safer than drawing wrongly, but it cannot coexist with an
  application's proj4 handler unless the application chains both (README §Native).

## 6. Recommendation

**(i) Pure Equal Earth.**
- *Evidence:* stock ≥ 6.15 renders, queries and converts natively once tiles exist in the grid.
- *Inference:* the plugin's native mode is already the best client-only design. The one
  architectural step up is to move the warp **server-side**:
  - run the same `buildTile` pipeline as a tile service or edge worker that emits tiles in the
    `equal-earth:native` grid, cached at the CDN (SmartMaps hosts its own basemaps);
  - pure Equal Earth then needs only `addProjection` + a handler, about 20 lines with no
    protocol, no worker bundle and no client cache;
  - the plugin could take a `tiles` option that points the CRS at such a tileset and skips the
    protocol.
- For GeoJSON-only thematic maps, the example pattern needs no plugin at all.

**(ii) Adaptive Equal Earth → Mercator.**
- *Evidence:* no stock route exists (§2, §3).
- *Inference:*
  - Stock: the stepped bands remain the only option; the shear snap is a fixed limit.
  - State of the art is per-vertex in the renderer: the planned 6.16 fork, Skyum's fork, MapTiler.
  - Before investing further:
    1. **Fix and test the 6.17 camera regression** (`isEasing` gone; probe
       `_camera.isMoving?.()` or `_scheduler`), or cap the peer at `<6.17` until verified.
    2. **Decide naming against #1865 and #1623**: the fork's `equal`/`equal-earth` cases could
       collide with a future upstream `equal-earth` = adaptive. Keep the names behind a small
       alias table.
    3. **Expect rebase cost** from CSC stages 3–4, which move the seams the fork patches.

**(iii) Arbitrary proj4 projections.**
- *Evidence:* MapLibre and makewithmaplibre already cover any proj4 CRS for pre-projected
  tiles and GeoJSON. Reprojecting Mercator tiles is the one gap, and #491 claims it upstream.
- *Inference:* do not generalise the plugin as a whole. The bands, camera compensation and
  geographic API only make sense for an EE↔Mercator blend. Several warp internals are specific
  to Equal Earth:
  - the pseudocylindrical pre-image bbox reject;
  - `sourceTilesFor`, which uses the EE inverse;
  - the ±180° clip that assumes `lon_0 = 0`.

  A generic "Mercator MVT → registered CRS grid" protocol could be split out later for
  pseudocylindrical world projections (Mollweide, Robinson, Natural Earth) if demand appears.
  It would compete with willcohen/backproj (CPU, GeoJSON, MVT planned) and with #491.

**Delete / keep / add (Inference):**
- **Keep:** the warp pipeline, caches, bands for `equal`, native mode, control, cartography and
  the GeoJSON densify/clip.
- **Delete when the peer floor moves to 6.15:** the band path for pure `equal-earth` (native
  only). The bands stay for `equal`.
- **Reconsider:** the UMD.
- **Add:**
  - 6.17 camera compatibility;
  - a raster/DEM warp (native mode hides raster layers today, README §Native);
  - optional externally hosted pre-warped tiles;
  - optionally `lon_0` variants as separate CRS names (EPSG:8858/8859). This needs the warp to
    take λ₀.
- **Peer range:** `>=6.6 <7` is still justified for bands. Native features need ≥ 6.15. Raising
  the floor to 6.15 would delete only the pure-EE band path.

## 7. Open questions

- Does banded `equal` actually break on 6.17.0 (§1)? It is untestable under the rule until
  2026-11-15.
- What will upstream call adaptive Equal Earth: `equal-earth` (#1865) or `equal` (#1623)?
- Will CSC-4.1 (per-source tile grid) lead to Mercator sources on CRS maps? There is no PR.
- When will NLnet decide on #491, and what will MapTiler's PR look like?
- Will a live-map projection switch to or from a registered CRS become supported, or break the
  plugin's `diff:false` swap?
- Is server-side warping viable at SmartMaps (cost, cache keys, tile sizes)? It has not been
  measured.
- How do native mode and bands compare on frame time and first paint on real hardware? Not
  measured here.

## 8. Sources

- npm registry `https://registry.npmjs.org/maplibre-gl` (`time`, `dist-tags`), `proj4`,
  `crs-defs`; fetched 2026-11-10.
- maplibre-gl-js:
  - `v6.17.0`: `CHANGELOG.md`, `docs/guides/custom-crs.md`, `developer-guides/custom-crs.md`,
    `src/ui/camera.ts`, `src/ui/camera_movement_scheduler.ts`, `src/ui/map.ts`;
  - the compare views v6.15.0…v6.16.0 and v6.16.0…v6.17.0;
  - the npm 6.16.0 tarball `src/geo/projection/{crs,projection_crud,projection_factory,mercator_transform}.ts`,
    `src/source/projection_handler_worker.ts`, `src/ui/{camera,map}.ts`.
- Issues and PRs:
  - maplibre-gl-js [#168](https://github.com/maplibre/maplibre-gl-js/issues/168),
    [#8330](https://github.com/maplibre/maplibre-gl-js/issues/8330),
    [#8694](https://github.com/maplibre/maplibre-gl-js/issues/8694),
    [#8723](https://github.com/maplibre/maplibre-gl-js/pull/8723),
    [#8738](https://github.com/maplibre/maplibre-gl-js/pull/8738),
    [#8803](https://github.com/maplibre/maplibre-gl-js/pull/8803),
    [#8807](https://github.com/maplibre/maplibre-gl-js/pull/8807),
    [#8961](https://github.com/maplibre/maplibre-gl-js/pull/8961),
    [#8964](https://github.com/maplibre/maplibre-gl-js/pull/8964);
  - maplibre-style-spec [#1623](https://github.com/maplibre/maplibre-style-spec/issues/1623),
    [#1865](https://github.com/maplibre/maplibre-style-spec/issues/1865),
    [#1866](https://github.com/maplibre/maplibre-style-spec/issues/1866),
    [#1921](https://github.com/maplibre/maplibre-style-spec/pull/1921);
  - [maplibre/maplibre#491](https://github.com/maplibre/maplibre/discussions/491).
- [makewithmaplibre.com/projections](https://makewithmaplibre.com/projections/) (page source,
  fetched 2026-11-10); proj4js v2.22.0 `lib/projections/eqearth.js`;
  `crs-defs@0.1.1/EPSG/8857.js`.
- This repo: `src/math/crs.ts`, `src/map/camera.ts`, `src/map/geojson.ts`, `src/install.ts`,
  `README.md` §Native, `docs/superpowers/specs/2026-11-10-native-equal-earth-blend-6.16-design.md`.
