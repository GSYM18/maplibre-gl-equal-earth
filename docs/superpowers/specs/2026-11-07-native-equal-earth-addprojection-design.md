# Pure Equal Earth through MapLibre's `addProjection` (6.15+): design

Date: 2026-11-07 · Status: approved to implement (user: "start with a short spec and implement
afterwards, only stop for critical questions") · Builds on the research note
`docs/superpowers/research/2026-11-07-equal-earth-on-vanilla-maplibre.md` and the spike on branch
`spike/addprojection-6.16` (88877d0).

## 1. Goal

On stock MapLibre ≥ 6.15, `map.setProjection({ type: 'equal-earth' })` draws Equal Earth through
MapLibre's own experimental `addProjection` instead of the Mercator renderer. MapLibre then
converts lng/lat itself, so the result is exact at every vertex. The plugin's warped tiles still
feed it. Three things become native:

- **Coordinates:** `project`/`unproject`, markers, popups, events, `getBounds`, `fitBounds`,
  `queryRenderedFeatures` geometry and `querySourceFeatures` all speak geographic coordinates.
- **Wheel zoom** stays anchored under the pointer.
- **GeoJSON** is projected in MapLibre's workers.

Everything else keeps working as it does today:

- `equal` (the adaptive bands);
- MapLibre 5.24 and 6.6–6.14;
- the main-thread fallback;
- the application's live style edits, GeoJSON updates and feature state.

The application's code does not change: `getProjection()` still reports `equal-earth`.

The spike proved the core:
- the CRS below matches the blend-0 tile grid exactly: `project` is off by 0 px, the round trip is accurate to ~1e-12°, and GeoJSON agrees with the tiles;
- a diffed `setStyle` across projections leaves unchanged GeoJSON sources in the old projection.

## 2. The CRS

```ts
{
  name: 'equal-earth:native',
  definition: '+proj=eqearth +R=6371008.7714 +units=m +no_defs',
  projection: { forward: toEqualEarth, inverse: fromEqualEarth },
  tileMatrixSet: { origin: [-X_MAX, X_MAX], extentAtZoom0: 2 * X_MAX },
}
```

- **The inverse:** it returns `null` past ±180° or beyond ±Y_MAX, so MapLibre uses the edge of the world there.
- **The grid:** world = (EE + X_MAX) / 2X_MAX, which is exactly the blend-0 map space the `eqearth://` tiles are cut in (`backproject.ts`, `GRID_FACTOR`). So the tiles and zoom levels are those of today's pure `equal-earth`.
- **Where it lives:** in `src/math/crs.ts`, pure and without MapLibre types, so that the worker bundle can share it.

## 3. Install (`installEqualEarth`)

- **New option `nativeProjection?: 'auto' | false`**, default `'auto'`. Native mode is used when all of these hold:
  - the option is `'auto'`;
  - `maplibregl.addProjection` is a function;
  - the worker bundle loaded (`workerPath === 'worker'`). Only the worker bundle sets the GeoJSON projection handler, and the main-thread fallback has no handler.
- **Registration happens once per install.** If a CRS by that name is already registered (from an earlier install, such as Vite HMR after `uninstall`), it is removed first. If `addProjection` throws, the install warns once and goes on without native mode. `uninstall()` calls `removeProjection`.
- **`EqualEarthInstall.nativeProjection`** is the registered name, or `undefined` when native mode is off.
- **The `setProjection` polyfill** treats the registered name as ours, as it does `mercator`: it does not force Mercator first while native Equal Earth is live.

## 4. Worker bundle

`worker-entry.ts` also calls `self.setProjectionHandler(...)` when it exists, so the handler is a
no-op on older MapLibre. The handler:
- returns the Equal Earth converter for our `definition`;
- throws for any other definition.

MapLibre keeps one handler per worker. An application that sets its own later must answer our
definition too; the README documents this.

## 5. Controller: the `native` variant of `equal-earth`

`ControllerOptions.nativeProjection?: string` (the registered name). With it set, `equal-earth`
runs as follows; `equal` is unchanged.

**The rewrite** is the same single band at blend 0 (same tile URLs, same layer copies, gates and
relief removal), with three differences:
- **Projection:** the style's `projection` is `{ type: <name> }`, not `mercator`.
- **GeoJSON band copies** are clipped to ±180° and densified, but stay geographic (`warpGeoJSON(…, { geographic: true })`); MapLibre's worker projects their positions.
- **Cartography** (world polygon, outline, graticule) is generated in geographic coordinates (`RewriteOptions.geographic`).

**What is installed:**
- **Camera:** `BandCamera` stays. Its hook is the identity for one band without compensation, and it keeps the `requestedZoom` and `shownBand` bookkeeping the rest relies on.
- **Switcher:** stays as well, for the same reasons.
- **No world clamp:** MapLibre keeps the centre as a geographic `LngLat`, so the centre is always on the world. The band clamp works in map space and would be wrong here.
- **Geographic API:** passes everything through while native mode is shown (its state reports inactive).
- **Conversions:** `toMapSpace` and `toGeographic` are the identity. The controller's own camera writes and reads are geographic: the centre is not converted at install or at detach, and `View.blend` is 1.

**Crossing the projection boundary.** This happens on activation, on a type switch between
`equal` and `equal-earth`, on a re-apply after the application's `setStyle`, and on restore.
- **The diff:** MapLibre applies `setProjection` before any source operation, so new sources load in the new projection. A source in both styles with an unchanged spec keeps its old placement.
- **Re-placement:** after a diff of ours that changed the projection between native and non-native, every source present in both styles with an unchanged spec is placed again. GeoJSON gets `setData` with its own `serialize().data`; image, video and canvas sources get `setCoordinates` with their own corners. Vector and raster tiles need nothing: `setProjection` reloads every tile manager, and the grids match.
- **Events:** the `projectiontransition` MapLibre fires inside our own `setStyle` is swallowed, as `style.load` is (R15, R21). The install's own event, carrying `equal-earth` or the application's type, is the one listeners hear.

## 6. Not changed, limits (documented in the README)

- **Experimental API:** `addProjection` can change in a minor release. `'auto'` falls back to bands if registration throws, and `nativeProjection: false` opts out.
- **No blend with Mercator:** MapLibre rejects registered projections in expressions. `equal` therefore stays banded on every version.
- **Mercator-only content:** raster, hillshade and color-relief layers stay hidden under pure Equal Earth, as today. Their tiles are Mercator.
- **Fixed central meridian** at 0°, and no world copies.
- **`getStyle()`** shows the registered name as the projection; it is map-space style content, as today.
- **The application's own projection handler** replaces ours (§4).

## 7. Tests

**Unit (Vitest, fakes):**
- the CRS round trip and the grid identity against `geographicToMapWorld(·, 0)`;
- install detection and registration, including when `addProjection` throws and on `uninstall`;
- the polyfill skipping forced Mercator;
- the worker handler registration;
- the rewrite's `geographic` option for GeoJSON and cartography, and the native projection type;
- the controller in native mode: projection type, identity conversions, geographic API passing through, no constraint, re-placement after a crossing diff, `projectiontransition` swallowed.

**Browser (Playwright):**
- a new project `v6-native` runs `native.spec.ts` on MapLibre 6.16.0, loaded from unpkg by the harness (`mlv=6.16`);
- npm cannot install 6.16 here (registry note), and the rest of the matrix stays offline;
- it asserts:
  - the map is native (`getStyle().projection.type`);
  - `project` agrees with Equal Earth to within 0.5 px;
  - inline GeoJSON is hit where `project` says;
  - the fixture's tiles agree with `project`;
  - the switch back to Mercator places GeoJSON in Mercator again;
  - Equal Earth → globe → Equal Earth works;
  - with `nativeProjection: false`, bands are used.

## 8. Rulings

- **N-R1:** native mode is on by default (`'auto'`), behind feature detection. It is the better result, and opting out is one option.
- **N-R2:** native mode is not used with the main-thread fallback (no worker projection handler).
- **N-R3:** `equal` stays banded even on 6.15+ (no expressions with registered projections).
- **N-R4:** the 6.16 browser project loads MapLibre from unpkg, the precedent of `demo/umd.html`. It is the only network dependency of `test:browser`.
- **N-R5:** `BandCamera` and `BandSwitcher` stay installed in native mode rather than being made optional. They are the identity there, and the change stays small.
