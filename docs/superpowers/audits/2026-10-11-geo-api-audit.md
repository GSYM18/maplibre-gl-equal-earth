# Geo API audit: MapLibre's internal call sites (v5.24.0, v6.6.0)

Spec §7 wants "data in, geo out": per-instance wrappers so that `getCenter`, `project`,
`jumpTo` and friends speak geographic coordinates while Equal Earth is active. A wrapper on the
map also intercepts MapLibre's **own** calls to the same method, and some of those pass or
expect map space. This audit lists every internal call site of the affected methods in both
supported versions and classifies each one. For each method it gives the band that conversion
must use, and from that derives the wrap list, the bypasses, and the Marker/Popup/event verdict.
It also settles how a `flyTo` target interacts with `BandCamera`.

**Sources.** v6 = `node_modules/maplibre-gl/src` (6.6.0). v5 = `node_modules/maplibre-gl-v5/src`
(5.24.0, which ships `src/`, so `src/` lines are cited, not `dist/`). Paths are relative to each
`src/`. Polyfill paths are prefixed `repo:`.

**Vocabulary.** *T* is the rendered transform, whose centre is in the map space of the **shown**
band (`BandCamera.shownBand`/`.blend`). *R* is `_requestedCameraState`, whose centre is in the
map space of the **baseline** band (`BandCamera.baselineBand`). Classes:
**A** = the consumer should see geographic values and works once wrapped.
**B** = an internal caller that would double-convert or break.
**C** = irrelevant: transform-level, pre-install, or carries no coordinates.

## 0. Two structural facts that decide most of this

1. **v6 splits Map and Camera; v5 does not.** In v6, `class Map extends Evented` (map.ts:590)
   and every camera method is a one-line delegate to `this._camera` (map.ts:1034-1494). The
   Camera's internal chains (`setCenter→jumpTo`, `panBy→panTo→easeTo`, `fitBounds→flyTo`,
   `flyTo→jumpTo/easeTo`, ...) run on the **Camera object** and never reach a Map-level wrapper.
   In v5, `class Map extends Camera` (map.ts:542), so every `this.easeTo(...)` inside camera.ts
   resolves through the map instance and **does** hit the wrapper. v5 therefore has a family of
   internal B callers that v6 lacks. Conversely, in v6 a wrapper on `easeTo` does **not** cover
   `zoomTo`/`rotateTo`/`panBy`/... (they call `Camera.easeTo` directly), so their options need
   their own wrappers.
2. **No captured references.** Neither version has a `bindAll`, `.bind(this)`, stored method
   reference, or `X.prototype.m.call(...)` for any audited name in `ui/`, `util/` or `geo/`. The
   only `.call(this, ...)` hits are event listeners and `onEaseEnd` (v6 camera.ts:1210, v5
   camera.ts:1618). Every internal use is a dynamic `map.m(...)`/`this.m(...)`, for example the
   closure at v6 handler_manager.ts:303. A wrapper installed at any time, on the instance or
   on `Map.prototype`, sees all of them.

Also relevant: `transform.apply` copies the centre **by reference** (v6
geo/transform_helper.ts:198, v5 195), and `center` returns the stored object (v6
mercator_transform.ts:187-189 → transform_helper.ts:399; v5 mercator_transform.ts:158,
transform_helper.ts:388). So `R.center === T.center` right after `getTransformForUpdate()`
clones T, and identity checks against `T.center`/`R.center` are meaningful.

## 1. Per-method table

| Method | v6 internal call sites | v5 internal call sites | Class | Band | Wrap? | Notes |
|---|---|---|---|---|---|---|
| `project` | ui/marker.ts:628, 762; ui/popup.ts:674; ui/control/scale_control.ts:109; ui/control/geolocate_control.ts:572; ui/handler_manager.ts:303 | ui/marker.ts:637; ui/popup.ts:644; scale_control.ts:109; geolocate_control.ts:477; handler_manager.ts:284 | A (all inputs geographic: marker/popup `_lngLat`, or the output of wrapped `unproject`/`getCenter`) | shown | yes | Must map world copies: `k = round(lng/360)`, convert `lng − 360k`, add `360k` (smartWrap can hand it `lng ± 360`, §8). |
| `unproject` | ui/events.ts:665, 741, 745; marker.ts:629, 869; scale_control.ts:106-107; geolocate_control.ts:573; ui/handler_inertia.ts:193 | events.ts:551, 627, 631; marker.ts:744; scale_control.ts:106-107; geolocate_control.ts:478; handler_inertia.ts:141 | A | shown | yes | **Must never return NaN or \|lat\| > 90**: `new LngLat` throws (v6 geo/lng_lat.ts:66-74), and it runs inside the `MapMouseEvent` constructor on every mousemove (handler/map_event.ts:36-143). Clamp to the world outline first, like `repo:src/map/controller.ts:779` `centreToGeographic` and unlike `controller.toGeographic` (controller.ts:243). The inertia `around` (handler_inertia.ts:193) becomes geographic and is converted back by the `easeTo` wrapper (§2, B3). |
| `getCenter` | handler_manager.ts:303 (rotate/roll pivot, used at handler/mouse.ts:73, 130); handler_inertia.ts:193; ui/hash.ts:46 | handler_manager.ts:284 (mouse.ts:69, 122); handler_inertia.ts:141; hash.ts:46 | A | shown | yes | :303 is `project(getCenter())`, which round-trips to the centre pixel, exact while T's centre is inside the world. Hash URLs become geographic, and so band-independent. |
| `getBounds` | none (definition map.ts:1674-1675) | none (map.ts:1120-1121) | C | shown | yes | Reimplement (§6). |
| `setCenter` | none at Map level (camera.ts:415-416 is Camera→Camera) | camera.ts:383-384 → `this.jumpTo({center})` | v6 C, v5 B | baseline | yes | v5: the inner `jumpTo` wrapper must pass the already-converted centre through (mark, §7). |
| `jumpTo` | map.ts:832 (constructor, pre-install, C); map.ts:869 (`style.load`, stylesheet centre, A); hash.ts:98 (A). Camera-internal: camera.ts:416, 422, 446, 490, 497, 532, 539, 1020 (C) | map.ts:800 (C), 837 (A); hash.ts:112 (A); camera.ts:384 (B, setCenter), 403/491/637/664/747/767 (no centre, C), 1425 (flyTo reduced motion: converted options, B) | A/B | baseline | yes | v5 B cases carry a marked centre and pass through. |
| `easeTo` | handler/click_zoom.ts:31-35 (`around: _tr.unproject`, **B**); handler/tap_zoom.ts:59-63, 70-74 (**B**); handler/keyboard.ts:122-132 (`center: tr.center`, **B**); handler_manager.ts:768 (inertia: `center` = `T.center` from geo/projection/mercator_camera_helper.ts:32 via handler_inertia.ts:162, **B**; `around` from wrapped unproject/getCenter, **A**). Camera-internal: camera.ts:438, 451, 502, 513, 633, 1126 (C) | click_zoom.ts:31-34; tap_zoom.ts:59-62, 70-73; keyboard.ts:122-131; handler_manager.ts:697 (inertia: handler_inertia.ts:110 + mercator_camera_helper.ts:32): same classes. Plus camera.ts:461 (panTo), 515 (zoomTo), 679 (rotateTo), 706 (resetNorthPitch) with user options (A); 919 (`_fitInternal`) and 1531 (flyTo short path) with converted or map-space centre (B) | A/B | baseline | yes | One call can mix spaces (the inertia call: `center` is map space, `around` geographic). The decision must be **per value**, not per call (§7). |
| `flyTo` | none at Map level (camera.ts:634 is Camera-internal) | camera.ts:920 (`_fitInternal`, reached from fitBounds :871 and fitScreenCoordinates :900 ← handler/box_zoom.ts:163) | v6 C, v5 B | baseline | yes | §4. |
| `panTo` | none (camera.ts:434 Camera-internal) | camera.ts:441: `panBy` → `this.panTo(this.transform.center, …)` (B: T-space) | v6 C, v5 B | baseline | yes | v5: passed through by the `=== T.center` identity rule. |
| `panBy` | none | none | — | (pixels) | v6: options only | Pixel offset, nothing to convert, except `options.center/around` in v6 (Camera path, never reaches `easeTo`). |
| `zoomTo` / `zoomIn` / `zoomOut` | ui/control/navigation_control.ts:72, 74 (`{}` options, C) | navigation_control.ts:72, 74; camera.ts:534, 552 → zoomTo → :515 easeTo (user options only, C) | C | baseline (for `options.around`) | v6: options only | v6 needs its own wrapper to convert a user `around`; v5 gets it via `easeTo`. |
| `rotateTo` / `resetNorth` / `resetNorthPitch` / `snapToNorth` | navigation_control.ts:80, 82; handler_manager.ts:772 (no coordinates, C) | navigation_control.ts:80, 82; handler_manager.ts:701 (C) | C | baseline | v6: options only | Same reasoning as `zoomTo`. |
| `setZoom` | none | none (camera.ts:491 is its own body) | C | — | no | No centre. Zoom offsets: see §9 item 6. |
| `cameraForBounds` | none (camera.ts:608 Camera-internal) | camera.ts:872 (inside `fitBounds`) | v6 C, v5 B if the original `fitBounds` ran | destination band, output geographic | yes, reimplemented | §5. |
| `fitBounds` | map.ts:843 (constructor, C); geolocate_control.ts:544 (geographic bounds, **A**) | map.ts:811 (C); geolocate_control.ts:449 (A) | A | destination band | yes, reimplemented | Must not call the original: in v6 it would read geographic bounds as map space and fly through the unwrapped Camera `flyTo`. |
| `fitScreenCoordinates` | box_zoom.ts:162 → Camera (C) | box_zoom.ts:163 → camera.ts:900-920 → **`this.easeTo`** with a fresh map-space centre (**B**) | v6 C, v5 B | — | no, but v5 needs the `_cameraForBoxAndBearing` mark | §7. |
| `getFreeCameraOptions` / `setFreeCameraOptions` | do not exist | do not exist | — | — | — | Mapbox GL API. Zero hits in either `src/` or `dist/*.d.ts`. |
| `queryRenderedFeatures` (box from lngLat) | pixel input (map.ts:2552) | pixel input | C | — | no | A box built with the wrapped `project` is correct. Returned geometry stays map space (spec: documented). |
| `MapMouseEvent.lngLat`, `MapTouchEvent.lngLat`/`lngLats` | events.ts:665, 741, 745 | events.ts:551, 627, 631 | A | shown | via `unproject` | `MapWheelEvent` has no `lngLat` (v6 events.ts:756, v5 642). |
| `calculateCameraOptionsFromTo`, `…FromCameraLngLatAltRotation` | map.ts:1538, 1434 | camera.ts (inherited) | — | — | no | Map space in and out. Document. |

## 2. The B cases, and what neutralises each

| # | Caller | Value | Why a naive wrapper breaks it | Neutraliser |
|---|---|---|---|---|
| B1 | click_zoom.ts:34, tap_zoom.ts:62/73 (both) | `around = _tr.unproject(p)` = `(R ?? T).screenPointToLocation` (handler/transform-provider.ts:21-23, 41-43) | Already in R space. Converting it again anchors the double-click/tap zoom degrees away from the cursor. | Mark the outputs of `TransformProvider.prototype.unproject` (§7). |
| B2 | keyboard.ts:131 (both) | `center: tr.center`, a fresh `{lng, lat}` from R/T (transform-provider.ts:25-27) | Same: arrow-key pans would jump. It also carries `easeId: 'keyboardHandler'` (keyboard.ts:124), whose continuation relies on `_stop(false, easeId)` suppressing `moveend` (v6 camera.ts:750, 1197-1213). | Mark the `TransformProvider` `center` getter's result. Nothing is left to convert, so there is no pre-stop and `easeId` continuity is preserved. |
| B3 | handler_manager.ts:768 (v6), :697 (v5): inertial ease | `center` = `T.center` **object** (mercator_camera_helper.ts:32). `around` = wrapped `unproject(last)` / `getCenter()` (geographic) | Converting `center` double-converts every drag-release. Skipping the whole call leaves `around` geographic but read as map space. | `center === T.center` → pass through. `around` is unmarked → convert. Exact: the `*end` events fire first (v6 handler_manager.ts:741, then :759; v5 :671, then :688), `BandCamera.#onGestureEnd` re-bases to the shown band, and the round trip is the identity. |
| B4 | v5 camera.ts:441 `panBy` | `this.transform.center` (T) | v5 only: reaches the `panTo` wrapper. | `=== T.center` identity → pass through. |
| B5 | v5 camera.ts:384, 461, 1425, 1531 | Options our own wrapper already converted (`setCenter→jumpTo`, `panTo→easeTo`, `flyTo→jumpTo/easeTo`) | v5 only: the second wrapper converts again. | The wrapper marks the LngLat it creates. `extend` and `pick` copy the reference, and `LngLat.convert` returns a LngLat unchanged (lng_lat.ts:157-160). |
| B6 | v5 camera.ts:900-920 (`fitScreenCoordinates`, used by box zoom) | `_cameraForBoxAndBearing(...)` result: a fresh map-space LngLat → `_fitInternal` → `this.easeTo/flyTo` | v5 only: the box zoom lands double-converted. | v5: wrap the instance's `_cameraForBoxAndBearing` (camera.ts:815) to mark `result.center`. Both its callers (:791, :901) produce map space. |

Class A consumers that change meaning when wrapped, all for the better: `ScaleControl`
(scale_control.ts:106-109, both versions) then measures **true geographic** distance; today it
measures map-space haversine, which is wrong under Equal Earth. `GeolocateControl` fits
geographic bounds (geolocate_control.ts:538-547) and sizes the accuracy circle (:566-577) from
geographic `project`/`unproject`; today both are wrong. `Hash` round-trips geographic values.
One caveat: `GeolocateControl._isOutOfMapMaxBounds` (v6 geolocate_control.ts:417-426) compares
the geographic position against `getMaxBounds()`, which stays map space (not in scope).

## 3. Which band each conversion uses

**Reads use the shown band.** `project`, `unproject`, `getCenter` and `getBounds` read T
(v6 map.ts:1034, 1675, 2025, 2043 via `this._camera.transform`; v5 camera.ts:369, map.ts:1121,
1470, 1488). T's centre is what the hook returned: a centre converted into `shown`
(`repo:src/map/camera.ts` `handleCameraUpdate`, `converted = geographicToMap(geographic,
toBlend)`). After each frame, `BandCamera.shownBand` = `selector.current()`, or
`bandIndexForZoom(getZoom() − lastOffsets.deltaZoom)`. That is the same requested zoom the
hook decided on, because the hook returns `zoom = requestedZoom + offsets.deltaZoom` and
stores `#lastOffsets = offsets`. So `controller.blend` is the right blend for reads.

**Targets use the baseline band, read after the stop the original would perform.** Every
target lands in R. `jumpTo` writes `R.center` (v6 camera.ts:644 → mercator_camera_helper.ts:67;
v5 camera.ts:964). `easeTo` derives its path from R and computes `aroundPoint` from R
(v6 camera.ts:766, 780; v5 :1149). `flyTo` constrains and normalises the target in R
(mercator_camera_helper.ts:147-154). `applyUpdatedTransform` then hands R to the hook
(v6 camera.ts:935-963, v5 :1304-1332), and the hook reads R's centre in
`#baseline.band`'s space. R's identity is decided by the **first statement of the original**:
`this.stop()` (v6 camera.ts:638, 1031; v5 :949, 1436) or `this._stop(false, options.easeId)`
(v6 :750, v5 :1119). If that stop ends an ease or a gesture, it fires the Camera's `moveend`
(deleting R, v6 camera.ts:402-404, v5 :340-342) or `*end` events (handlers stop), and
`BandCamera` re-bases to `shownBand`. R is then cloned fresh from T (v6 camera.ts:892-896).
If the stop leaves R alive (matching `easeId`, or an R left over mid-gesture), the baseline is
unchanged. A wrapper converting before the original runs would therefore read the wrong band in
exactly the interrupt cases. The fix:

1. If the call carries an unmarked value to convert, **pre-stop identically**. Use
   `map.stop()` for `jumpTo`/`setCenter`/`flyTo` (v6 map.ts:1494, v5 camera.ts:1601). For the
   `easeTo` family, use the equivalent of `_stop(false, options.easeId)`, which is `map.stop()`
   when `easeId` is undefined. The original's own stop then does nothing.
2. Read `blend = bands[camera.baselineBand].blend` and convert `center`/`around` with it.

In the idle case `baselineBand === shownBand`, so this equals "the current band" in practice.
It is still **not** the band of the target zoom: converting with the destination blend would
make the hook read a destination-space point as baseline-space and land wrong.

## 4. `flyTo` across bands: verdict

Convert the target with the baseline blend at call time (after the pre-stop). Let the hook
convert per frame. **The final frame lands exactly on the geographic target**, up to the
round-trip error of the inverse (≤ ~1e-9° for Equal Earth, ~1e-6° near the poles for blended
bands, `repo:src/math/backproject.ts:175-189`). The trace (v6, v5 identical in substance):

- Wrapper: `M0 = geographicToMap(G, b_baseline)`, marked. `flyTo` clones R from T, in baseline
  space. `targetCenter = R.applyConstrain(M0, z1).center` (mercator_camera_helper.ts:147-152;
  v5 :147). `normalizeCenter` is a no-op because the controller turns `renderWorldCopies` off
  (transform_helper.ts:19-25).
- Frames k < 1 interpolate in R's world coordinates at the start zoom (`from + delta·u(s)`,
  mercator_camera_helper.ts:172-175), so the path is a straight line in **baseline** map
  space. Each frame the hook converts that centre baseline → the frame's band through
  geographic. The geographic centre is continuous across a crossing, and the image jumps only by
  the band step, as for gestures.
- Frame k = 1 (`easing(1) = 1`, camera.ts:1238-1240): `tr.setZoom(targetZoom)`,
  `newCenter = targetCenter`, `setLocationAtPoint(targetCenter, pointAtOffset)`
  (mercator_camera_helper.ts:171-175, v5 :174-176). With `offset = [0,0]`, `pointAtOffset` is
  `centerPoint`, so `R.center = M0`. That holds with any `padding` too, since the centre *is*
  the location at the padded centre point. Hook: `geographicToMap(mapToGeographic(M0,
  b_baseline), b_final) = geographicToMap(G, b_final)` → T. The wrapped `getCenter()` then
  returns `mapToGeographic(·, b_final) = G`.
- A mid-flight `moveend` (v6 `setVerticalFieldOfView`, v5 any Map `moveend` such as `resize`)
  detaches R. The ease's closure keeps the old `tr`, and the hook's stale path converts from
  `#previousBaseline` (m13/m14). Still exact.

**Not exact:**
- **`offset` ≠ 0.** `targetCenter` is pinned at `centerPoint + offset` *in baseline space*, but
  the hook pins only the centre's geographic point. The target drifts by roughly |offset| × the
  local Jacobian difference between the two blends: tens of px for 100 px at mid/high latitude
  with EE → Mercator. The same applies to `easeTo` `around`/`aroundPoint`
  (mercator_camera_helper.ts:122). This is the gestures' existing pinch-around behaviour, not a
  wrapper bug.
- **Clamping.** R's constraint clamps no tighter than the baseline band's edge (I3), and T is
  re-constrained in the final band. A target outside the final band's allowed area moves, as in
  Mercator.
- **Zoom.** With compensation (default `'zoom+bearing'`, `repo:src/map/controller.ts:543`) the
  hook reads `R.zoom` as carrying the baseline offset (`requestedZoom = zoom −
  baseline.offsets.deltaZoom`). The landing zoom is off by up to the offset (≤ 0.07). Centre
  unaffected.
- **`minZoom`.** Only shapes the arc (mercator_camera_helper.ts:162-168), computed in baseline
  space. No effect on the landing.
- **Poles in the Mercator band.** For `|lat| > 85.05°` with `b_final = 1` the target is
  clamped.
- **v5 fallbacks.** Reduced motion → `this.jumpTo(pick(...))` (camera.ts:1422-1425), and the
  zero-length path → `this.easeTo(options)` (:1531). Both carry the marked `M0` and pass
  through. Unmarked, they would double-convert.

## 5. `fitBounds` / `cameraForBounds`

The image of a geographic rectangle is not a rectangle. Its map-space bbox depends on the blend,
and the blend depends on the resulting zoom. Proposal:

1. `B = LngLatBounds.convert(bounds).adjustAntiMeridian()` (as v6 camera.ts:544). If B crosses
   ±180°, the Equal Earth world is a single copy (world copies off), so split B at the
   antimeridian and union the two images. The result is near full width. Document it.
2. Densify B's **boundary** only: the warp is a homeomorphism, so the image's bbox is attained
   on the image of the boundary. 32 points per edge are plenty. Clamp latitudes to ±90 before
   the warp and to `mapSpaceMaxLatitude(blend)` after it. Otherwise, in the Mercator band,
   lat 90 sends MapLibre's zoom to NaN.
3. For **every** band k (≤ 7 with the default transition 4→8, 6 steps; one forward warp of ~128
   points plus one original `cameraForBounds` per band): take the map-space bbox `Bk`, then
   `ck = origCameraForBounds(Bk, options)` → `{center, zoom zk, bearing}`. This is Camera-level
   in v6, and on v5 the `_cameraForBoxAndBearing` mark tags `ck.center`.
4. Pick the **fixed point** `band(zk) = k`. Iterating from the current band also works:
   adjacent blends change `zk` by ≈ log2 of the EE/Mercator local scale ratio over 6 steps.
   That is ≈ 0.17 zoom per band at 60°, ≈ 0.23 at 70°, far below the 0.8 spacing, so it
   settles in ≤ 3 evaluations. At high latitude, however, `zk` *decreases* with k, which allows a
   2-cycle at a boundary β: band k gives zk ≥ β and band k+1 gives z(k+1) < β. Resolve it as
   band k at `z = β − ε`, which fits because it is < zk. That is the tightest consistent fit.
   With several fixed points (possible where `zk` increases with k), take the highest zoom.
   Evaluating all bands avoids the iteration logic and is cheap.
5. `cameraForBounds` returns `{center: mapToGeographic(ck.center, blend_k), zoom: zk, bearing}`.
   That is the **geographic point under the fitted view's centre**, not the geographic midpoint
   of the bounds. Passing it to the wrapped `jumpTo`/`flyTo` converts it with the baseline band.
   The hook re-expresses it in band k, so the fit is exact.
6. `fitBounds` reimplements `_fitInternal` (v6 camera.ts:624-635): `opts = extend(cam,
   options)`, `delete opts.padding`, then the wrapped `easeTo` if `linear` or the wrapped
   `flyTo`. Never call the original `fitBounds` or `_fitInternal`.

Caveats: with bearing ≠ 0, MapLibre rotates the corners of the axis-aligned `Bk`, which is
conservative (fits, not tight). A tight fit would rotate the densified points first. Compensation
can render the final zoom up to +0.07 above `zk`, so subtract the band's maximum offset when an
exact fit inside `padding` matters. `maxZoom` caps `zk`: apply `band()` to the capped zoom.

## 6. `getBounds`

1. Sample T's viewport perimeter, 16 points per edge, from `top = max(0, height/2 −
   horizon)`, as Mercator's own `getBounds` does (v6 geo/projection/mercator_transform.ts:490-
   497, v5 :390). Use the **original** `unproject`/`T.screenPointToLocation` (map space).
2. Clamp each point to the world outline in the shown band:
   `clampLatitude(lat, mapSpaceMaxLatitude(b))`, then clamp `lng` to
   `mapSpaceMaxLongitude(lat, b)`, exactly as `handleCameraUpdate` does. Then call
   `mapToGeographic(·, b)`.
3. Take the bbox, return `new LngLatBounds(sw, ne)`.

This works because the geographic extremes of the visible region lie on its boundary, which is
the viewport perimeter plus the world outline segments inside it. Clamped samples land on that
outline. Edge cases: at z0 every sample is clamped and the result is `[-180, -90, 180, 90]`.
Equal Earth's pole is a **line**, so `north = 90` whenever the top edge of the world is visible,
with the longitudes of the visible part. With world copies off the result never straddles the
antimeridian (west < east always). With pitch, only the part below the horizon counts.

## 7. Wrap mechanism and bypasses

**Instance or prototype.** Both work, because no reference is captured (§0.2). The repo already
patches `Map.prototype.setProjection`/`getProjection` with per-map dispatch through a WeakMap
(`repo:src/install.ts:210-257`). Doing the same for the geo methods (`this` → controller →
`active ? convert : original`) is the most consistent option. It also covers maps created after
install, whose constructor calls (v6 map.ts:832, 843; v5 :800, 811) then pass through while
inactive. If per-instance is preferred, use
`Object.defineProperty(map, name, {value, writable: true, configurable: true})`, keep any
pre-existing own property as the "original", and on destroy restore only while `map[name]` is
still ours (same rule as `BandCamera.destroy`). v5 caveat: `Map.prototype.easeTo` is inherited
from `Camera.prototype`, so the prototype variant assigns an own property and uninstall must
`delete` it (or reassign the inherited function). v6: all are own `Map.prototype` methods.

**Bypass by value, not by caller.** A depth flag ("inside our wrapper, pass through") is wrong
here. Every camera method fires `movestart`/`move`/`moveend` synchronously (v6
camera.ts:681-708 for `jumpTo`, 835 and 1013 for eases), so an application listener calling `map.panTo(geo)` would run inside the
flag and go unconverted. Decide per **value** instead:

```ts
const mapSpace = new WeakSet<object>();   // module-level; marks values native to MapLibre
const isMapSpace = (v, T, R) => typeof v === 'object' && v !== null &&
  (mapSpace.has(v) || v === T.center || v === R?.center);
```

- Wrappers convert only unmarked `center`/`around`, mark the LngLat they create, and pass a
  shallow-copied options object (never mutate the caller's). This covers B5. A wrapper with
  nothing to convert skips the pre-stop and calls the original untouched.
- `=== T.center || === R.center` covers B3 and B4. Identity, not numeric equality: no heuristics.
- Patch `TransformProvider.prototype` once to mark `unproject` results and the `center` getter's
  result (B1, B2). Reach it via `Object.getPrototypeOf(map.keyboard._tr)`: `_tr` is set in both
  versions (v6 keyboard.ts:39; v5 keyboard.ts:39). In v6 one provider per map is shared
  (handler_manager.ts:202). In v5 each handler has its own (click_zoom.ts:19, tap_zoom.ts:19,
  keyboard.ts:39, box_zoom.ts:51, scroll_zoom.ts:72), all of the same class. Marking is true for
  every map, Equal Earth or not, because the provider always returns R/T space, so the global
  patch is safe. Fallback if `_tr` is missing: warn once and do not convert `around`/`center`
  on `easeTo` calls whose `eventData.originalEvent` is a DOM `Event` (heuristic).
- v5 only: mark `result.center` from the instance's `_cameraForBoxAndBearing` (B6).
- Pass-through while inactive or under globe, as the spec requires.

**Methods whose internal callers would outnumber the benefit:** none. Every audited internal
caller is either A, or B with a value-level neutraliser above. No method needs to stay unwrapped
for safety. `fitScreenCoordinates` is not wrapped; it is pixel API.

## 8. Marker, Popup, events: verdict

**Events: free.** `lngLat`/`lngLats` come from `map.unproject` (events.ts as in §1), so they
become geographic once `unproject` is wrapped. The hard requirement: no NaN and |lat| ≤ 90 for
points outside the world, or every mousemove there throws.

**Popup: free.** Anchor at popup.ts:674 (v5 :644) via wrapped `project`. `trackPointer` uses the
cursor pixel and `smartWrap(..., useNormalWrap = true)` → `lngLat.wrap()`
(util/smart_wrap.ts:20-22). Nothing to fix.

**Marker: mostly free.** Placement (marker.ts:762, v5 :637), drag (`_onMove` :869, v5 :744)
and v6 keyboard nudging (:628-629) all go through the wrapped `project`/`unproject`. Extras:
- `smartWrap(this._lngLat, this._flatPos, transform)` (marker.ts:760, v5 :635) runs in full even
  with `renderWorldCopies: false`, because Mercator's `allowWorldCopies()` is always `true`
  (geo/projection/mercator_covering_tiles_details_provider.ts:50-52, v5 same). It feeds a
  **geographic** `lngLat` to `transform.locationToScreenPoint` and compares it with the
  **map-space** `transform.center.lng` (smart_wrap.ts:29-55). The world-copy decision can then
  differ from MapLibre's, by up to tens of degrees of longitude at high latitude, which matters
  only for off-screen markers or ones near ±180°. It can also leave `_lngLat` at `lng ± 360`
  (`getLngLat()` reports it, as in stock MapLibre). So the `project` wrapper must map world
  copies (§1). A browser test should pin the antimeridian case (§10, test 4). A full fix would
  need a Marker-level override and is not recommended unless that test fails visibly.
- The terrain-only branches use the transform directly with a geographic `lngLat`
  (marker.ts:731, 765; popup.ts:677; v5 marker.ts:606, 640; popup.ts:647): wrong, but terrain is
  out of scope under Equal Earth. `isLocationOccluded` (marker.ts:708, popup.ts:285) returns
  false outside globe.
- During a Plan-2 cross-fade, markers align with the **shown** band (the band T's centre is
  in), not with a fading band's layers.

## 9. Spec §7 assumptions the sources contradict or refine

1. "Conversions use the current band's `t`": true for reads (shown band). Targets must use the
   **baseline** band, read **after** a pre-stop that mirrors the original (§3). Bounds need the
   **destination** band, solved as a fixed point (§5). Using the target zoom's band is wrong.
2. The wrap list is incomplete for v6: `zoomTo`, `zoomIn`, `zoomOut`, `rotateTo`, `resetNorth`,
   `resetNorthPitch`, `snapToNorth` and `panBy` reach `Camera.easeTo` without passing the Map
   (map.ts:1082-1295), so a user `around`/`center` in their options would go unconverted.
3. `fitBounds` cannot wrap the original. It must be reimplemented on v6 (§1).
4. "Main risk: double conversion" is real, and broader than Camera chains. The **handlers**
   (double-click, tap, keyboard, inertia) cause it in **both** versions, and v5 adds the Camera
   chains plus box zoom (§2). A per-caller flag cannot fix it; per-value marking can.
5. "Marker/Popup/lngLat for free": confirmed, conditional on the `unproject` no-throw clamp and
   world-copy handling in `project`. The smartWrap mixing is a residual, test-pinned risk.
6. Not covered by §7, but adjacent: with compensation, absolute `zoom`/`bearing` targets and
   `getZoom()`/`getBearing()` are offset-carrying values (≤ 0.07 zoom, ≤ 3°). "Geo out" for zoom
   and bearing is undecided.
7. `getFreeCameraOptions`/`setFreeCameraOptions` do not exist in MapLibre.
   `calculateCameraOptionsFrom*`, `getMaxBounds`/`setMaxBounds` and `queryRenderedFeatures`
   geometry stay map space. Document them.

## 10. Browser tests that pin these conclusions

Playwright, Chromium with software WebGL, run on v5.24.0 and v6.6.0, local fixtures, default
transition and compensation. G = Guadalajara unless stated.

1. **Event lngLat.** At z2 and z5.2, dispatch `click` at `map.project(G)`: `e.lngLat ≈ G` (1e-6°).
   Move the pointer over the empty canvas above the world: no exception, `|e.lngLat.lat| ≤ 90`.
2. **Marker placement.** A Marker at G and a fixture point feature at G at z3/5/7/9: the marker's
   pixel = `project(G)` = the rendered feature's pixel (`queryRenderedFeatures`) ± 1 px.
3. **Marker drag.** Drag by 100 px: `getLngLat()` equals `unproject(newPixel)`. No jump on
   `dragend`.
4. **Marker antimeridian (smartWrap).** Marker at (179°, 70°), view centred at (−170°, 60°),
   z2: the marker is visible at `project` of its lngLat and lies on the warped land.
5. **Popup anchor.** Popup at G: its tip equals `project(G)` ± 1 px.
6. **`jumpTo`/`setCenter`/`easeTo`/`panTo`/`flyTo` across bands.** From z2 (0,0) to G at z9,
   and z5.5 → z2. After `moveend`, `getCenter() ≈ G` (1e-6°) and `project(G)` = canvas centre
   ± 0.5 px.
7. **`flyTo` interrupting a running `easeTo`** that has crossed a band: the landing is exact
   (pre-stop/baseline rule).
8. **v5 fallbacks.** `flyTo` with `prefers-reduced-motion` emulated, and `flyTo` to the current
   centre with the same zoom (zero-length path): no movement beyond 0.5 px.
9. **Double-click and tap zoom (B1).** At z3, the geographic point under the cursor stays within
   band-step tolerance after zoom-in. A double conversion moves it by degrees.
10. **Keyboard (B2).** ArrowRight pans exactly the pan step in pixels. Three rapid presses
    (`easeId` continuation) give no extra `moveend` and no jump.
11. **Drag-pan with inertia (B3).** No jump > 1 px between the last gesture frame and the first
    inertial frame. Pinch-zoom inertia across a band keeps the pinch point within band-step
    tolerance.
12. **v5 `panBy` (B4).** `panBy([100, 0])` at z3: `project(oldCentreGeo).x = width/2 − 100`
    ± 0.5 px.
13. **Box zoom (B6).** Shift-drag a box: after the ease, the box corners' prior geographic
    positions are inside `getBounds()`.
14. **`fitBounds`/`cameraForBounds`.** Scandinavia at the EE band, and a bounds whose fit falls
    at a band boundary (the 2-cycle). Every densified edge point projects inside the viewport
    minus padding, and one touches an edge within 2 px. `cameraForBounds(b).center`, passed to
    `jumpTo`, gives the same view.
15. **`getBounds`.** At z3, bearing 30°, pitch 40°: every perimeter `unproject` is inside the
    result, and the result is no larger than needed (+ε). At z0 the result is
    `[-180, -90, 180, 90]`.
16. **Hash, GeolocateControl, ScaleControl.** Hash stores geographic values and reloads to the
    same view. Mocked geolocation centres on the position (`getCenter` ≈ position) with an
    accuracy circle of `2·accuracy/(m per px)`. The scale label matches the haversine distance
    of the geographic endpoints.
17. **NavigationControl and right-drag rotate.** Zoom buttons across a band keep the centre
    geographic. Rotating keeps the pivot at the canvas centre.
18. **Pass-through.** Under `mercator` and `globe`, every wrapped method's output is identical
    with and without the plugin.
