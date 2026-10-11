# @yellowmap/maplibre-gl-equal-earth

Equal Earth projection support for [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/) v6.

The [Equal Earth projection](https://equal-earth.com/) (Šavrič, Patterson & Jenny, 2018) is an
equal-area pseudocylindrical projection — countries appear at their true relative size, unlike
Web Mercator, while still looking like a world map rather than a sinusoid.

> **Status: `1.0.0-alpha.1`.** `installEqualEarth` and `map.setProjection({ type: 'equal' })`
> work end to end: the style rewrite, the `eqearth://` tile pipeline in the worker pool, the
> camera, and the [adaptive transition](#adaptive-transition). Not done yet: the cartographic
> finish, a projection control, a geographic wrapper around the map-space API, and a browser
> test matrix (see [Roadmap](#roadmap)).

## Install

```sh
npm install @yellowmap/maplibre-gl-equal-earth maplibre-gl
```

ESM only. The peer range is `maplibre-gl >=5.24 <7`; the demo runs on v6. v5 is checked by type
tests against its `Map` and by the worker-bundle guard, but not yet in a browser.

## How it works, and what that costs you

MapLibre has no API for registering a custom projection — `createProjectionFromName` is a
hard-coded switch, and an unknown projection name silently falls back to Mercator. Equal Earth is
therefore produced by **backprojection**: the Mercator renderer is fed fabricated longitude and
latitude values chosen so that Mercator's own transform reproduces the Equal Earth image.

```
real lng/lat → Equal Earth metres → × 1.162 → inverse Mercator → "map space" lng/lat
```

This is the [dirty-reprojectors](https://github.com/developmentseed/dirty-reprojectors) technique,
also used by Mapbox for Albers USA election maps.

Three consequences you must design around:

- **Coordinates the map reports are not geographic.** While Equal Earth is active,
  `map.getCenter()`, `map.project()`, `getBounds()`, popup anchors and `queryRenderedFeatures()`
  return map space. Convert with `mapToGeographic` / `geographicToMap`.
- **Equal Earth and globe cannot be shown at once.** Globe interprets lng/lat as real geodetic
  coordinates, so warped values would render as a distorted sphere.
- **Labels stay upright.** Because MapLibre still believes it is rendering Mercator, text layout
  and collision detection work normally — an advantage no raster-reprojection approach has.

## Usage

### Turning it on

```js
import * as maplibregl from 'maplibre-gl';
import { installEqualEarth } from '@yellowmap/maplibre-gl-equal-earth';

// Once, before creating any map: MapLibre sizes its worker pool with the first map.
const eqe = await installEqualEarth(maplibregl);

const map = new maplibregl.Map({ container: 'map', style: 'https://tiles.openfreemap.org/styles/liberty' });
map.on('load', () => map.setProjection({ type: 'equal' }));   // or 'equal-earth'; 'mercator' turns it off

const controller = eqe.controllerFor(map);
map.jumpTo({ center: controller.toMapSpace([8.54, 47.37]) });   // geographic → the shown band's map space
controller.toGeographic(map.getCenter().toArray());             // and back
```

`{ type: 'equal' }` is the adaptive projection: Equal Earth at world zoom, plain Mercator from
`transition.to`, stepped in between. `{ type: 'equal-earth' }` is Equal Earth at every zoom.
The names follow [style-spec#1623](https://github.com/maplibre/maplibre-style-spec/pull/1623).
`map.getProjection()` reports them once the activation has committed, i.e. after the vector
sources' TileJSON was fetched.

`installEqualEarth` loads its worker bundle from `new URL('./worker.mjs', import.meta.url)`,
which bundlers (Vite, webpack, Rollup, Parcel) emit as an asset. A plain dev server that serves
the library from source may have no file there: pass `workerUrl`, pointing at the built
`dist/worker.mjs` (v6) or `dist/worker.iife.js` (v5). Without the worker bundle the tiles are
warped on the main thread, 100–450 ms per tile; `eqe.workerPath` says which path is in use.

### Converting coordinates

```js
import { geographicToMap, mapToGeographic } from '@yellowmap/maplibre-gl-equal-earth';

geographicToMap([8.54, 47.38]);   // → map-space lng/lat to hand to MapLibre
mapToGeographic([9.92, 42.09]);   // → back to real lng/lat
```

Anything you place on an Equal Earth map — GeoJSON, marker positions, deck.gl accessors,
`flyTo` targets — must be passed through `geographicToMap` first.

### Raw projection

```js
import { toEqualEarth, fromEqualEarth } from '@yellowmap/maplibre-gl-equal-earth';

toEqualEarth([180, 0]);   // → [17243963.37, 0] metres (EPSG:8857)
fromEqualEarth([0, 8392929.69]);   // → [0, 90]
```

### Camera continuity across a zoom threshold

An adaptive Equal Earth map shows warped coordinates at low zoom and true geographic coordinates
once it switches to plain Mercator tiles. `ThresholdCamera` converts the camera centre so the
place under it stays put across the switch, in either direction, on every frame of a gesture or
animation:

```js
import { LngLat } from 'maplibre-gl';
import { ThresholdCamera } from '@yellowmap/maplibre-gl-equal-earth';

const camera = new ThresholdCamera(map, {
  switchZoom: 6,
  lngLatFactory: (lng, lat) => new LngLat(lng, lat),
});

// later
camera.destroy();   // restores any transformCameraUpdate the app had installed
```

It chains to an existing `transformCameraUpdate` rather than overwriting it, so bbox constraints
and map synchronisation keep working.

For the adaptive projection's intermediate steps, `BandCamera` takes a list of zoom bands,
each with a fixed blend between Equal Earth (0) and Mercator (1), and does the same across every
band boundary:

```js
import { LngLat } from 'maplibre-gl';
import { BandCamera } from '@yellowmap/maplibre-gl-equal-earth';

const camera = new BandCamera(map, {
  bands: [
    { minZoom: 0, blend: 0 },
    { minZoom: 5, blend: 1 / 3 },
    { minZoom: 6, blend: 2 / 3 },
    { minZoom: 7, blend: 1 },
  ],
  lngLatFactory: (lng, lat) => new LngLat(lng, lat),
});
```

Both cameras work on MapLibre v5 and v6: v6 moved the hook behind `setTransformCameraUpdate()`.

### Keeping the world in view

On the Mercator grid the Equal Earth world only reaches map-space latitude ±65.54°, but Mercator
will happily pan on to ±85° and show empty background above and below:

```js
import { LngLat } from 'maplibre-gl';
import { installEqualEarthConstrain } from '@yellowmap/maplibre-gl-equal-earth';

const uninstall = installEqualEarthConstrain(map, {
  lngLatFactory: (lng, lat) => new LngLat(lng, lat),
  isActive: () => equalEarthEnabled,   // only MapLibre's own constraint under Mercator and globe
  latitudeMargin: 2,
});
```

The plugin composes with MapLibre's own constraint (min/max zoom, `maxBounds`), tightening the
latitude only in Equal Earth bands. With an adaptive `BandCamera`, pass `bands` and
`baselineBand: () => camera.baselineBand` as well, so that zooming out across a band boundary
does not clamp a high-latitude centre against the lower band's edge.

This uses `transformConstrain` rather than `transformCameraUpdate`, because it survives a
projection switch — `migrateProjection` replaces the transform wholesale.

## Adaptive transition

A tile-warp polyfill cannot morph geometry per frame, so `equal` steps. The range
`from`–`to` is divided into `steps` zoom bands, each drawn at a fixed blend between Equal Earth
and Mercator. Every band is a copy of the style's vector layers on its own `eqearth://` source;
the Mercator band uses the original source untouched. Four things make the steps hard to see:

- **Parse early, show late.** A band's layers are parsed one band spacing beyond its range on
  both sides, so its tiles are already drawable when it is shown.
- **The gate.** The shown band follows the zoom only once that band's in-view tiles are
  loaded. Until then the old band is held, so a step arrives late rather than as a hole. If
  the zoom outruns tile production by more than one spacing, the switch is forced.
- **Camera compensation.** The geographic position under the centre is kept exactly across a
  switch. The camera also absorbs the local rotation and scale of each step, so the rendered
  zoom and bearing follow what a continuous blend would show. What is left is shear.
- **Cross-fade.** Fills and lines fade between bands over 250 ms; labels fade out over 300 ms
  before the outgoing band's symbols are hidden.

```js
await installEqualEarth(maplibregl, {
  transition: { from: 4, to: 8, steps: 6 },   // the defaults: steps at z4, 4.8 … 7.2, Mercator from z8
  compensation: 'zoom+bearing',               // the default; or 'zoom', or 'none'
  workers: 4,                                 // or false to leave MapLibre's pool alone
  onSwitch: (e) => console.log(`b${e.from}→b${e.to} at z${e.requestedZoom}`, e.forced, e.waitedMs),
});
```

`workers`: MapLibre's default pool is one worker, which serialises every warp. While the count
is still 1 it is raised to `clamp(hardwareConcurrency / 2, 2, 4)`, or to the number given. Any
other count, Safari's default of up to 3 included, is treated as the application's own setting.
The pool is created at install time, before any map exists.

Behaviours to expect:

- Mid-transition, `map.getZoom()` and `map.getBearing()` return the **rendered** values. While
  the shown band is the zoom's own, they differ from the requested ones by at most half a
  step's offset (≤ 0.07 zoom, ≤ 3° at Anchorage with six steps), and a `jumpTo({ zoom })`
  lands within that of what it asked for. While the gate holds a band `j` steps behind the
  zoom, the offset grows to about `j + ½` steps' worth.
- When a held band becomes ready while the map is idle, the switch runs through an empty
  `jumpTo({})`, which fires `movestart`/`moveend` like any camera change.
- Labels cross-fade. Zooming out, the outgoing band's labels may win collision against the
  incoming band's for one fade. With `fadeDuration: 0`, incoming labels can pop in at full
  opacity when a band's symbol re-parse takes longer than the 300 ms fade.
- A scroll zoom is anchored at the pointer, which the camera hook cannot see. The point under
  the pointer moves at each step by about the residual below, scaled by its distance from the
  centre.

**The ceiling.** What remains after compensation is shear, and it snaps at every step.
Measured 300 px from the centre with six steps: Zürich ≈ 7 px, Singapore ≈ 7 px, San
Francisco ≈ 16 px, Anchorage 18–65 px. More steps shrink the snap only as 1/steps while
multiplying the label re-placements. An imperceptible transition needs per-vertex
interpolation inside the renderer, as MapLibre's globe transition does: that is
[maplibre-gl-js#8330](https://github.com/maplibre/maplibre-gl-js/issues/8330). Whether this
stepped polyfill is good enough, or a renderer-side transition is needed, is an open product
decision; judge it on the demo.

### Demo and probe

Run `npm run build:js` (the demo loads the built `dist/worker.mjs`), then `npm run dev` and
open <http://localhost:5173/demo/transition.html>. URL parameters:
`?steps=&from=&to=&compensate=none|zoom|zoom+bearing&projection=equal|equal-earth|mercator&workers=`.
The readout logs every band switch, how long it was held, and the geographic centre.

`npm run probe:transition` is a developer tool, not part of `npm run verify`. It drives the
demo in headless Chrome with real wheel events, zooming in and out through the transition,
and fails on a centre drift above 0.001° or any map error. It needs local Chrome
(`--chrome <path>` or `CHROME_PATH`), the network and the running dev server:

```sh
node scripts/probe-transition.mjs --city "San Francisco"
node scripts/probe-transition.mjs --city "Zürich" --steps 9
```

Headless Chrome renders through SwiftShader, several seconds per band, so the hold times it
prints say nothing about latency on real hardware.

## Limitations

- **Map space.** Everything MapLibre reports while Equal Earth is active is in the shown
  band's map space; convert with `controllerFor(map).toGeographic` / `toMapSpace`.
- **`GlobeControl`** treats `{ type: 'equal' }` as "not Mercator", switches to Mercator and so
  turns Equal Earth off. Use your own control for now.
- **Style changes while active.** A new style passed to `setStyle` is followed: it becomes the
  new original and is rewritten. But `getStyle()` → modify → `setStyle()` hands back our
  rewritten style, which still counts as ours: the change is not captured as the original and
  is dropped on deactivation, and layers added against the original source id find no band
  source. Change the style before activating, or deactivate first.
- **Sources.** Band sources inherit `attribution`, `minzoom` and `promoteId` from the original
  source, but not `bounds` (geographic bounds would cut off map-space tiles). TMS sources are
  rejected on activation.
- **TileJSON** given by `url` is fetched with plain `fetch`, without MapLibre's
  `transformRequest`, and relative tile URLs in it are not resolved. Pass
  `fetchJson: (url) => …` for authenticated endpoints or `pmtiles://` sources.
- **Failed switches.** A switch between `equal` and `equal-earth` that fails after the old type
  was torn down leaves Equal Earth off, with the original style restored.
- **Raster layers** (relief) cannot be warped: they are drawn only in the Mercator band.

## API

| Export | Description |
| --- | --- |
| `toEqualEarth(lngLat)` | Geographic degrees → Equal Earth metres (EPSG:8857). |
| `fromEqualEarth(point)` | Equal Earth metres → geographic degrees. Newton inverse. |
| `geographicToMap(lngLat)` | Geographic degrees → map space. |
| `mapToGeographic(lngLat)` | Map space → geographic degrees. |
| `installEqualEarth(maplibregl, opts)` | Checks the version, sizes the worker pool, loads the worker bundle, polyfills `setProjection`/`getProjection`. Resolves to `{ version, workerPath, controllerFor(map), uninstall() }`. |
| `EqualEarthController` | Per map, from `controllerFor(map)`: `active`, `projection`, `blend`, `toMapSpace(lngLat)`, `toGeographic(lngLat)`. |
| `BandCamera` | The `transformCameraUpdate` hook across zoom bands, with compensation. |
| `ThresholdCamera` | `transformCameraUpdate` hook for the Equal Earth ↔ Mercator switch. |
| `installEqualEarthConstrain(map, opts)` | Clamps the camera to the Equal Earth world; returns a teardown function. |
| `createEqualEarthConstrain(opts)` | The bare `TransformConstrainFunction`, if you want to compose it yourself. |
| `GRID_FACTOR` | ≈1.162, the Equal Earth → Mercator grid scale. |
| `EQUAL_EARTH_X_MAX` / `EQUAL_EARTH_Y_MAX` | Half-extents in metres, derived from `EARTH_RADIUS`. |
| `MAP_SPACE_MAX_LATITUDE` | Map-space latitude of the geographic pole (≈65.54°). |
| `MERCATOR_MAX_LATITUDE` | 85.051128779806589. |

Full TypeScript declarations ship with the package.

## Roadmap

Next: the cartographic finish, a projection control (`EqualEarthControl`), a geographic API
over the map-space one with GeoJSON fan-out, a persistent tile cache, a browser test matrix on
MapLibre 5.24 and 6.x, and more demos.

MapLibre is working on a native adaptive Equal Earth
([maplibre-gl-js#8330](https://github.com/maplibre/maplibre-gl-js/issues/8330)). This package is
deliberately shaped as a polyfill of the pending spec so that it can simply be removed once that
ships.

## Credits

A rewrite of [pka/maplibre-gl-equal-earth](https://github.com/pka/maplibre-gl-equal-earth) by
Pirmin Kalberer, whose [Equal Earth tile work](https://equal.bbox.earth/) established the
grid-factor approach this builds on. The backprojection technique is Development Seed's
[dirty-reprojectors](https://github.com/developmentseed/dirty-reprojectors).

Projection formulas from Šavrič, B., Patterson, T. & Jenny, B. (2019), "The Equal Earth map
projection", *International Journal of Geographical Information Science* 33(3), 454–465.

## License

MIT
