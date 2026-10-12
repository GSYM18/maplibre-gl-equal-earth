# @yellowmap/maplibre-gl-equal-earth

Equal Earth projection support for [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/)
v6, and v5 from 5.24.

The [Equal Earth projection](https://equal-earth.com/) (Šavrič, Patterson & Jenny, 2018) is an
equal-area pseudocylindrical projection — countries appear at their true relative size, unlike
Web Mercator, while still looking like a world map rather than a sinusoid.

> **Status: `1.0.0-alpha.1`.** `installEqualEarth` and `map.setProjection({ type: 'equal' })`
> work end to end on MapLibre 5.24 and 6.6: the style rewrite, the `eqearth://` tile pipeline
> in the worker pool, the camera, the [adaptive transition](#adaptive-transition), the
> [cartographic finish](#cartography), the [projection control](#the-projection-control), a
> [geographic API](#data-in-geo-out) over the map-space one, [GeoJSON](#geojson) and
> [live style edits](#editing-the-style-while-equal-earth-is-on), and a
> [persistent tile cache](#tile-throughput). Open: the first-paint budget
> ([First paint](#first-paint)) and the stepped transition's ceiling, both product decisions.

## Install

```sh
npm install @yellowmap/maplibre-gl-equal-earth maplibre-gl
```

ESM only. The peer range is `maplibre-gl >=5.24 <7`. The demo runs on v6; the browser test
suite runs every scenario on MapLibre 5.24 and 6.6.

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

Three consequences you should know about:

- **The renderer works in "map space", not geographic coordinates.** The plugin wraps the map's
  coordinate API so that you keep speaking geographic coordinates: `getCenter`, `project`,
  `unproject`, `getBounds`, the camera methods, Marker, Popup and mouse events all convert
  ([Data in, geo out](#data-in-geo-out)). What still exposes map space is listed there;
  `queryRenderedFeatures` geometry and `getStyle()` contents are the two you will meet.
- **Equal Earth and globe cannot be shown at once.** Globe interprets lng/lat as real geodetic
  coordinates, so warped values would render as a distorted sphere.
- **Labels stay upright.** Because MapLibre still believes it is rendering Mercator, text layout
  and collision detection work normally — an advantage no raster-reprojection approach has.

## Usage

### Turning it on

```js
import * as maplibregl from 'maplibre-gl';
import { EqualEarthControl, installEqualEarth } from '@yellowmap/maplibre-gl-equal-earth';

// Once, before creating any map: MapLibre sizes its worker pool with the first map.
const eqe = await installEqualEarth(maplibregl);

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: [10, 20],
  zoom: 1.3,
});
map.setProjection({ type: 'equal' });   // or 'equal-earth'; 'mercator' turns it off
map.addControl(new EqualEarthControl());

map.flyTo({ center: [8.54, 47.37], zoom: 9 });   // geographic, as always
```

`{ type: 'equal' }` is the adaptive projection: Equal Earth at world zoom, plain Mercator from
`transition.to`, stepped in between. `{ type: 'equal-earth' }` is Equal Earth at every zoom.
The names follow [style-spec#1623](https://github.com/maplibre/maplibre-style-spec/pull/1623).

`setProjection` may be called right after `new Map(…)`: the plugin waits for the style and
the vector sources' TileJSON, then rewrites the style. That is faster than waiting for `load`,
which first loads every tile of the Mercator view. `map.getProjection()` reports the type from
the `setProjection` call on; the map shows Equal Earth once the activation has committed, which
it announces with `projectiontransition` (`{ newProjection: 'equal' }`), as MapLibre does for
its own projections. Leaving Equal Earth fires it as well. A failed activation (a TileJSON or
GeoJSON URL that cannot be fetched, a TMS source) is reported as an `error` event (on the
console when nothing listens) and leaves the map as it was.

A second `installEqualEarth` on the same MapLibre module (e.g. a Vite HMR re-run) returns the
first install, its options included; call `uninstall()` first to change them.

`installEqualEarth` loads its worker bundle from `new URL('./worker.mjs', import.meta.url)`,
which bundlers (Vite, webpack, Rollup, Parcel) emit as an asset. A plain dev server that serves
the library from source may have no file there: pass `workerUrl`, pointing at the built
`dist/worker.mjs` (v6) or `dist/worker.iife.js` (v5). Without the worker bundle the tiles are
warped on the main thread, 100–450 ms per tile; `eqe.workerPath` says which path is in use.
A worker bundle that has not loaded after `workerTimeoutMs` (default 10 000; `Infinity` waits
without a bound) gets the same fallback, so a stalled CDN cannot hold up your first map.

### The projection control

`EqualEarthControl` is a button in the style of MapLibre's `GlobeControl` that switches between
Equal Earth and Mercator (top right by default):

```js
map.addControl(new EqualEarthControl());                                  // equal ↔ mercator
map.addControl(new EqualEarthControl({ on: 'equal-earth', off: 'globe' }), 'top-left');
```

| Option | Default | |
| --- | --- | --- |
| `on` | `'equal'` | The projection the button turns on: `'equal'` or `'equal-earth'`. |
| `off` | `'mercator'` | The projection it turns off to: `'mercator'` or `'globe'`. |

It reads `map.getProjection()` and follows `projectiontransition`, so it stays right whoever
changes the projection. It can sit next to MapLibre's own `GlobeControl`, with one quirk of
that control: it treats every projection other than Mercator as "globe on", so pressing it
while Equal Earth is shown switches to **Mercator**, and pressing it again to globe. The
Equal Earth button follows either way.

### Cartography

In every band with Equal Earth in it (blend < 1), the world is drawn as a shape:

- The style's first `background` layer is recoloured with `outsideColor` (default
  `'transparent'`, so the map container's CSS shows through), and a generated **world polygon**
  in the original background colour is drawn right above it. A style without a background
  layer gets `outsideColor` as its background.
- **Polar areas reach ±90°.** Mercator data ends at ±85.05°; polygon vertices on that edge are
  snapped to the poles, so Antarctica and the Arctic Ocean meet the outline.
- **Outline and graticule** are opt-in. The outline is drawn in the Equal Earth bands; the
  graticule in every band, the Mercator one included.
- **World copies** are off while Equal Earth is shown, and restored afterwards.
- **Raster, hillshade and color-relief layers** cannot be warped. They are drawn only in the
  Mercator band, announced once per page with a `console.info`. For OpenFreeMap Liberty this
  means no `ne2_shaded` relief at world zoom.

```js
await installEqualEarth(maplibregl, {
  outsideColor: '#dfe6ec',
  outline: { color: '#9a9a9a', width: 1 },                        // or true for these defaults
  graticule: { step: 30, color: 'rgba(0,0,0,0.2)', width: 0.75 },  // or true; step must divide 180
});
```

### Data in, geo out

While Equal Earth is shown, the plugin wraps the map's coordinate methods **on the map
instance** (other maps on the page are untouched, and everything passes through unchanged under
Mercator and globe), so that values go in and come out geographic:

| Methods | Converted with |
| --- | --- |
| `getCenter`, `project`, `unproject`, `getBounds` | the band **shown** now: what is on screen |
| `jumpTo`, `easeTo`, `flyTo` (`center`, `around`), `setCenter`, `panTo`, and the `around` option of `panBy`, `zoomTo`, `zoomIn`, `zoomOut`, `rotateTo`, `resetNorth`, `resetNorthPitch`, `snapToNorth` | the band the camera request starts from, read after the method's own `stop()` |
| `fitBounds`, `cameraForBounds` | solved across the bands, for the band the fitted zoom lands in |

Because MapLibre's own components call the same methods, they come out right as well: **Marker**
and **Popup** positions, `lngLat` of **mouse and touch events**, **`Hash`** (it stores
geographic values), **`ScaleControl`** (true distances) and **`GeolocateControl`** (centre and
accuracy circle). `getBounds()` is the geographic bounding box of the view; with the whole
world in view that is `[-180, -90, 180, 90]`.

A few rules follow from there being only one world:

- `project` maps every longitude onto that world: `project([-181, 0])` is `project([179, 0])`.
  Camera targets beyond ±180° wrap the same way. World copies are off while Equal Earth is shown.
- **Zoom and bearing are not converted.** `getZoom()`/`getBearing()` return MapLibre's values,
  which in the transition carry the camera's compensation offsets (≤ 0.07 zoom, ≤ 3°; see
  [Adaptive transition](#adaptive-transition)). A `setZoom(getZoom())` round trip is still
  exact.
- `fitBounds` and `cameraForBounds` account for that compensation, so the fitted bounds touch
  the padding as they do in Mercator. A `cameraForBounds` result is valid for the camera state
  at the time of the call: apply it before the camera moves on.

**Not converted** (map space in and out): `queryRenderedFeatures` and `querySourceFeatures`
geometry, `getStyle()` contents (sources' data, layer coordinates), `getMaxBounds`/`setMaxBounds`,
`calculateCameraOptionsFromTo`/`calculateCameraOptionsFromCameraLngLatAltRotation`, and deck.gl
overlays. For those, convert by hand:

```js
const controller = eqe.controllerFor(map);

controller.toGeographic([9.92, 42.09]);  // map space of the band shown now → real lng/lat
controller.toMapSpace([8.54, 47.38]);    // and back
```

Under `{ type: 'equal' }` the shown band changes as the zoom crosses the transition, so a
position converted earlier belongs to the band shown then; re-convert in `onSwitch`. While
Equal Earth is off, both are the identity.

The bare functions take the blend explicitly: `geographicUnder(mapLngLat, blend)` and
`mapSpaceOf(lngLat, blend)` are what the wrappers use (the first clamps to the world's outline,
so it is always finite with |lat| ≤ 90; the second keeps world copies), and
`mapToGeographic`/`geographicToMap` are the unclamped pair, with blend 0 (pure Equal Earth) by
default. `controllerFor(map).blend` is the blend of the band shown.

To keep the map-space API instead, pass `geographicApi: false` to `installEqualEarth`: nothing
is wrapped, and every method above speaks map space while Equal Earth is shown.

### GeoJSON

A GeoJSON source is drawn in every band: the style rewrite fans it out into one copy per
Equal Earth band (`<id>__b<k>`), each holding the data clipped at ±180°, densified and warped
into that band's map space. Inline data and data by URL both work; a URL is fetched with
`fetchJson` (see [Limitations](#limitations)).

```js
map.addSource('cities', { type: 'geojson', data: citiesFeatureCollection });   // geographic
map.addLayer({ id: 'cities', type: 'circle', source: 'cities' });
map.getSource('cities').setData(updated);   // every band copy follows
```

`setData` and `updateData` on the source keep the copies in step: `setData` warps the new data
into every copy, `updateData` re-warps the source's full data once MapLibre has applied the
diff. The warp runs on the main thread, once per band for every `setData` (see Limitations).
**Clustering** happens in map space, on the warped points: the cluster radius is in pixels, and
pixels are what the map shows.

### Editing the style while Equal Earth is on

`addSource`, `removeSource`, `addLayer`, `removeLayer`, `setPaintProperty`, `setLayoutProperty`
and `setFilter` reach every band: address your own ids, and the plugin fans the change out to
the band copies (`<id>__b<k>`) and keeps it for deactivation. A layer or source you add is drawn
warped in each band from the next microtask on (several edits in one task cost one style diff; a
GeoJSON or TileJSON given by URL is fetched first). An opacity the transition gates, or a symbol
layer's `visibility`, becomes the value its band shows.

Like a native `addLayer`, none of this fires `style.load`, and neither does switching the
projection on or off, as with a native `setProjection`: a `style.load` listener that re-adds its
layers runs once for each `setStyle` of yours and for nothing else.

**Layer ids work in every band.** Id-scoped queries and events reach every layer that draws
your id, under `equal` and `equal-earth` alike: the `layers` of `queryRenderedFeatures`, and
with them layer-scoped listeners (`map.on('click', id, …)`, `mouseenter`, `mouseleave`). The
features they return carry the id of the layer that drew them, which in an Equal Earth band is
the copy, `feature.layer.id === '<id>__b<k>'` (and `feature.source` is `<source>__b<k>`).
Compare through `originalLayerId`, which strips the copy suffix and is the identity for any
other id, rather than relying on the naming:

```js
import { originalLayerId } from '@yellowmap/maplibre-gl-equal-earth';

map.on('click', (e) => {
  const hit = map.queryRenderedFeatures(e.point).find((f) => originalLayerId(f.layer.id) === 'poi');
});
```

Under pure Equal Earth only the copies exist; `getLayer(id)`, `getPaintProperty`,
`getLayoutProperty` and `getFilter` then read your id as the copy the shown band draws, so the
usual `if (!map.getLayer(id)) map.addLayer(…)` guard keeps working. The layer `getLayer`
returns is that copy: its `id` is `<id>__b<k>`. Under `equal` your id itself is the Mercator
band's layer (when that band draws it), which `getLayer` returns.

**Feature state works in every band.** `setFeatureState` and `removeFeatureState` on one of your
sources reach it and every band's copy of it, so a hover or selection highlight
(`['feature-state', 'hover']` in a paint property) shows in whichever band is drawn and survives
band switches, re-applies and toggling Equal Earth. Address the source by your id or by a
copy's: the `feature.source` of a rendered feature (`<source>__b<k>`) works as it is, so the
usual `map.setFeatureState(e.features[0], { hover: true })` keeps working. `getFeatureState`
reads the band shown. A call MapLibre refuses (a vector source without `sourceLayer`, say) is
refused once, as without the plugin.

`querySourceFeatures(id)` with one of your source ids reads the band shown, whose tiles are
loaded (under `equal` the source under your id belongs to the Mercator band, which loads no tiles
below its zoom range). Its geometry is that band's map space, as `queryRenderedFeatures`' is; a
copy's id (`<source>__b<k>`) reads that copy.

`setLayerZoomRange` and `moveLayer` are not fanned out: they reach only the layer under your id
(the Mercator band's), and the next such diff or the deactivation undoes them.

A new style passed to `setStyle` is followed: it becomes the new original and is rewritten.

### Tile throughput

Every Equal Earth tile is built in a worker from the source tiles under it: fetched, decoded,
densified, warped, clipped and encoded again. Four settings bear on it:

```js
await installEqualEarth(maplibregl, {
  workers: 4,                                       // or false to leave MapLibre's pool alone
  persistentCache: { maxZoom: 3, ttlDays: 7 },      // the default; false keeps none
  sourceZoomOffset: 0,                              // the default; -1 reads one zoom coarser
});
```

- **`workers`.** MapLibre's default pool is one worker, which serialises every warp. While the
  count is still 1 it is raised to `clamp(hardwareConcurrency / 2, 2, 4)`, or to the number
  given. Any other count, Safari's default of up to 3 included, is treated as the application's
  own setting. Each worker keeps its own in-memory caches: up to 64 MB of raw source tiles and
  32 decoded source tiles (a decoded tile takes about 4.4× its raw size, a few MB at low zoom on
  OpenMapTiles data), so the memory they can take grows with the pool size.
- **`persistentCache`.** Warped tiles up to `maxZoom` are kept in the browser's Cache Storage
  for `ttlDays`, so a reload draws the world view without fetching or warping its source
  tiles again. The cache is named `equal-earth-<version>+<build id>`; a plugin build that
  could produce different tiles uses a new name, and the first worker to open it deletes every
  other `equal-earth-*` cache. Entries are keyed by a hash of the source's configuration,
  tile URL template and API key included, so a rotated key starts afresh rather than serving
  tiles fetched with the old one. Expired entries are deleted in the background, at most once a
  day, and the cache is capped at 2000 tiles. It needs a secure context (`https:` or `localhost`); without Cache
  Storage it is skipped silently. To clear it:

  ```js
  for (const name of await caches.keys()) {
    if (name.startsWith('equal-earth-')) await caches.delete(name);
  }
  ```

- **`sourceZoomOffset`.** Reads source tiles this many zooms from the output zoom (clamped to
  the tileset's zooms). `-1` fetches about a quarter of the bytes and warps faster, at the cost
  of coarser geometry and far fewer labels: OpenMapTiles tiles carry many fewer places one zoom
  down. Measured at OpenFreeMap Liberty's world view, `-1` placed 26 place labels instead of 64.
  The default stays 0 ([First paint](#first-paint)).

### Raw projection

```js
import { toEqualEarth, fromEqualEarth } from '@yellowmap/maplibre-gl-equal-earth';

toEqualEarth([180, 0]);   // → [17243963.37, 0] metres (EPSG:8857)
fromEqualEarth([0, 8392929.69]);   // → [0, 90]
```

### Camera continuity across a zoom threshold

> **Lower level — only without `installEqualEarth`, which installs this for you.** Adding a
> camera on top of it chains a second `transformCameraUpdate` hook and converts the centre
> twice.

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

`ThresholdCamera` is the two-band form of `BandCamera`. For the adaptive projection's
intermediate steps, `BandCamera` takes a list of zoom bands,
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

> **Lower level — only without `installEqualEarth`, which installs this for you.**

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
  before the outgoing band's symbols are hidden. The world's base (background and world
  polygon) is not cross-faded: the incoming band's base fades in over the outgoing one, which
  fades out only after that, so the container never shows through. Hillshade does not cross-fade:
  a hillshade at zero exaggeration still draws a flat highlight, so it is hidden by visibility
  like a symbol and simply disappears when the hide fires. Because hidden relief is also not
  parsed, relief pops in once its DEM tiles load when you zoom into the Mercator band.

```js
await installEqualEarth(maplibregl, {
  transition: { from: 4, to: 8, steps: 6 },   // the defaults: steps at z4, 4.8 … 7.2, Mercator from z8
  compensation: 'zoom+bearing',               // the default; or 'zoom', or 'none'
  onSwitch: (e) => console.log(`b${e.from}→b${e.to} at z${e.requestedZoom}`, e.forced, e.waitedMs),
});
```

Behaviours to expect:

- Mid-transition, `map.getZoom()` and `map.getBearing()` return the **rendered** values. While
  the shown band is the zoom's own, they differ from the requested ones by at most half a
  step's offset (≤ 0.07 zoom, ≤ 3° at Anchorage with six steps), and a `jumpTo({ zoom })`
  lands within that of what it asked for. While the gate holds a band `j` steps behind the
  zoom, the offset grows to about `j + ½` steps' worth. `controllerFor(map).requestedZoom` is
  the zoom without the offset.
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

## Demo and probes

Run `npm run build:js` (the demo loads the built `dist/worker.mjs`), then `npm run dev` and
open <http://localhost:5173/demo/transition.html>. The page starts on the whole world, with the
`EqualEarthControl` top right, buttons that jump to five cities, and presets in the panel. Its
URL parameters:

| Parameter | |
| --- | --- |
| `style=<url>` | Any EPSG:3857 vector style whose sources are TileJSON (`url`) or `tiles` templates. Default: OpenFreeMap Liberty. |
| `projection=equal\|equal-earth\|mercator` | The initial projection (default `equal`), set right after the map is created. |
| `steps=`, `from=`, `to=` | The transition. |
| `compensate=none\|zoom\|zoom+bearing` | The camera compensation. |
| `workers=<n>` | The worker pool size. |
| `control=0` | Leaves out the `EqualEarthControl`. |
| `outside=<colour>`, `outline=1`, `graticule=<step>\|1` | The cartography options. |
| `persist=0` | `persistentCache: false`. |
| `zoomOffset=<n>` | `sourceZoomOffset`. |

The readout logs every band switch, how long it was held, the geographic centre, any error
(a style or TileJSON that cannot be loaded shows there, key elided), and
`first paint: <ms> ms`: the time from the page's module starting to the first `idle` with the
initial projection shown, recorded as the `performance` marks `eqe:start`, `eqe:installed`,
`eqe:active` and `eqe:first-idle` and exposed as `window.__eqe.firstPaintMs`. It starts at the
module, not at navigation: loading the HTML and the page's own code comes before it.

**SmartMaps, or your own style.** Paste the style URL, its `?key=` included, into the panel's
"your style" field, or put it in the address URL-encoded:
`/demo/transition.html?style=<SmartMaps style URL including ?key=…, URL-encoded>`. The readout
and its error lines show URLs with the key elided, and so does the probes' output. No style
URL or key is part of this repository.

`npm run probe:transition` and `npm run probe:first-paint` are developer tools, not part of
`npm run verify`. Both drive the demo in headless Chrome and need Node ≥ 22, local Chrome
(`--chrome <path>` or `CHROME_PATH`), the network and the running dev server (`--url` for
another port).

- `probe:transition` zooms in and out through the transition with real wheel events and fails
  on a centre drift above 0.001°, any map error or an uncaught page exception. `--anchor 300,0`
  wheels at a point 300 px off-centre and reports how far the place under the pointer snaps at
  each step:

  ```sh
  node scripts/probe-transition.mjs --city "San Francisco"
  node scripts/probe-transition.mjs --city "Zürich" --steps 9
  ```

- `probe:first-paint` measures the demo's first paint at 1280×800 and 50 Mbit/s (20 ms
  latency) in a fresh profile, cold (HTTP cache disabled, Cache Storage cleared), warm
  (reloaded with both caches), and cold again with only the page's code cached. It prints each
  against the budgets (4 s cold, 1.5 s warm), with the marks' times, the first idle's time
  after navigation start, the place labels placed and the bytes received by kind. `--style
  <url>` and `--zoom-offset=<n>` pass `style` and `zoomOffset` on.

  ```sh
  npm run probe:first-paint
  node scripts/probe-transition.mjs --first-paint --zoom-offset=-1
  ```

Headless Chrome renders through SwiftShader, on the CPU: the timings are indicative of the
pipeline, not of a user's GPU, and the switch hold times say nothing about real latency.

### First paint

The spec's budget is the world view at 1280×800 in ≤ 4 s cold at 50 Mbit/s and ≤ 1.5 s warm.
Measured with `probe:first-paint` against `npm run dev` on OpenFreeMap Liberty (medians of three
runs, SwiftShader; `firstPaintMs`, from the module's start):

| `sourceZoomOffset` | cold | warm | cold, code cached | place labels placed |
| --- | --- | --- | --- | --- |
| 0 (default) | 7.9 s | 3.2 s | 3.3 s | 64 |
| −1 | 7.6 s | 2.9 s | 2.7 s | 26 |

The plain cold run misses at either offset, but mostly on the dev server's account: it serves
MapLibre's worker modules unminified with inline source maps, once per worker with the cache
off, about 23 MB that arrive before the plugin is even installed. With that code cached, the
cold world view is drawn within budget at the default offset: 3.3 s from the module's start,
and in a later run 2.8 s from it and 3.2 s from navigation start (the HTML and the page's code
took 0.4 s from the cache). From navigation start the plain cold run took 11 s, 3.6 s of it
before the module started. The warm run misses on
SwiftShader with almost nothing fetched: style parsing, the rewrite and rendering on the CPU
take most of it. `-1` would cut the tile bytes but more than halves the labels, so the default
stays 0; whether to revisit the budget is an open product decision.

## Limitations

- **Map space where the API is not wrapped.** `queryRenderedFeatures` and `querySourceFeatures`
  geometry, `getStyle()` contents, `getMaxBounds`/`setMaxBounds`, `calculateCameraOptionsFrom*`
  and deck.gl overlays are in the shown band's map space ([Data in, geo out](#data-in-geo-out)).
  Positions you converted belong to the band shown at the time; re-convert on `onSwitch`. With
  `geographicApi: false` this applies to everything. `GeolocateControl` checks a geographic
  position against `getMaxBounds()`, which is map space: with `maxBounds` set, its
  out-of-bounds test is wrong.
- **Feature state on clusters.** State on your features (by `id` or `promoteId`) reaches every
  band. A cluster's id is not yours: each band copy of a clustered GeoJSON source clusters on its
  own, so state set on a cluster id lands on whatever cluster has that id in the other bands.
- **`fitBounds` and the gate.** `fitBounds` chooses the band its fitted zoom lands in without
  the switcher's hysteresis. Arriving from above at a zoom just under a band boundary, the
  switcher may keep the upper band for that frame, and the fit overshoots the padding by a few
  pixels.
- **`cameraForBounds`** returns a camera for the camera state at the time of the call. Applied
  after the map has moved across a band, it is off by that band's compensation.
- **`GlobeControl`** treats `{ type: 'equal' }` as "not Mercator": pressing it while Equal Earth
  is shown switches to Mercator. Use `EqualEarthControl` to switch Equal Earth on and off.
- **GeoJSON.**
  - A GeoJSON source given by URL is fetched with `fetchJson` (plain `fetch` unless you pass
    one), not through MapLibre's `transformRequest`; an activation whose GeoJSON URL cannot be
    fetched rejects and leaves the map in Mercator.
  - Each `setData` (and `updateData`) warps the whole source on the main thread once per Equal
    Earth band: a large GeoJSON stalls the page for that long.
  - Each band copy of a clustered source clusters on its own. The cluster API
    (`getClusterExpansionZoom`, `getClusterLeaves`) must therefore be called on the copy the
    clicked cluster came from, `map.getSource(feature.source)`, not on `getSource(id)` (under
    `equal` that is the Mercator band's source, whose cluster ids differ). Its leaves are in
    map space.
- **Style changes while active.** A new style passed to `setStyle` is followed: it becomes the
  new original and is rewritten. But `getStyle()` → modify → `setStyle()` hands back our
  rewritten style, which still counts as ours: the change is not captured as the original and
  is dropped on deactivation, and layers added against the original source id find no band
  source. Change such a style before activating, or deactivate first, or use the
  [live edit methods](#editing-the-style-while-equal-earth-is-on).
- **`setStyle(url)` while active.** The plugin never cancels it. While MapLibre fetches it, the
  plugin's own style updates wait (edits made meanwhile are kept if the fetch fails, and
  dropped with the old style, as in MapLibre, when it arrives). A layer added while such a
  style is still loading shows unwarped until that style arrives. A deactivation meanwhile
  puts your original style back and requests the URL again, so that MapLibre diffs your style
  in as it would have without the plugin. When the live style is no longer ours (an activation
  still waiting for your fetch), the deactivation leaves the live style and the fetch alone; it
  only takes away, with `setLayerZoomRange`, any zoom bound the rewrite left on its layers.
- **`minzoom: 0` after deactivation.** MapLibre's style diff cannot take a zoom bound away, so a
  layer the Mercator band bounded under its own id is restored with an explicit `minzoom: 0`.
  It draws exactly as without the bound, but `getStyle()` then reports `minzoom: 0` on layers
  that had none.
- **Sources.** Band sources inherit `attribution`, `minzoom` and `promoteId` from the original
  source, but not `bounds` (geographic bounds would cut off map-space tiles). TMS sources are
  rejected on activation.
- **TileJSON** given by `url` is fetched with plain `fetch`, without MapLibre's
  `transformRequest`, and relative tile URLs in it are not resolved. Pass
  `fetchJson: (url) => …` for authenticated endpoints or `pmtiles://` sources.
- **Persistent cache.**
  - Two tabs running different plugin builds delete each other's cache on first use, because
    each deletes every `equal-earth-*` cache but its own. They lose cache hits, never get wrong
    tiles: the build is in the name.
  - An entry's lifetime is fixed when it is stored; changing `ttlDays` affects only new entries.
- **Failed switches.** A switch between `equal` and `equal-earth` that fails after the old type
  was torn down leaves Equal Earth off, with the original style restored.
- **Raster layers** (relief) cannot be warped: they are drawn only in the Mercator band.

## API

| Export | Description |
| --- | --- |
| `installEqualEarth(maplibregl, opts)` | Checks the version, sizes the worker pool, loads the worker bundle, polyfills `setProjection`/`getProjection`. Resolves to `{ version, workerPath, controllerFor(map), uninstall() }`. Options: `workerUrl`, `workerTimeoutMs`, `workers`, `transition`, `compensation`, `onSwitch`, `fetchJson`, `outsideColor`, `outline`, `graticule`, `geographicApi`, `persistentCache`, `sourceZoomOffset`. |
| `EqualEarthControl` | The projection toggle button; options `on`, `off`. |
| `EqualEarthController` | Per map, from `controllerFor(map)`: `active`, `projection`, `pendingProjection`, `blend`, `requestedZoom`, `toMapSpace(lngLat)`, `toGeographic(lngLat)`. |
| `toEqualEarth(lngLat)` | Geographic degrees → Equal Earth metres (EPSG:8857). |
| `fromEqualEarth(point)` | Equal Earth metres → geographic degrees. Newton inverse. |
| `geographicUnder(mapLngLat, blend)` | Map space of a band at `blend` → geographic, clamped to the world's outline. |
| `mapSpaceOf(lngLat, blend)` | Geographic → map space of a band at `blend`, world copies kept. |
| `geographicToMap(lngLat, blend = 0)` | Geographic degrees → the map space of a band at `blend` (0 = pure Equal Earth). |
| `mapToGeographic(lngLat, blend = 0)` | Map space of a band at `blend` → geographic degrees. |
| `originalLayerId(id)` | The application's layer id behind a rendered one: `water__b2` → `water`. |
| `graticule`, `worldOutline`, `worldPolygon` | The cartography's GeoJSON at a blend, in map space. |
| `warpGeoJSON(data, blend, zoom)` | Clip, densify and warp GeoJSON into a band's map space. |
| `BandCamera` | Lower level: the `transformCameraUpdate` hook across zoom bands, with compensation. `installEqualEarth` installs it. |
| `ThresholdCamera` | Lower level: the two-band form of `BandCamera` (Equal Earth ↔ Mercator). |
| `installEqualEarthConstrain(map, opts)` | Lower level, installed by `installEqualEarth`: clamps the camera to the Equal Earth world; returns a teardown function. |
| `createEqualEarthConstrain(opts)` | The bare `TransformConstrainFunction`, if you want to compose it yourself. |
| `createEqualEarthProtocol(opts)` | The `eqearth://` tile handler, for the main thread or a custom worker. |
| `CACHE_NAME_PREFIX` | `'equal-earth-'`, the prefix of the persistent cache's name. |
| `GRID_FACTOR` | ≈1.162, the Equal Earth → Mercator grid scale. |
| `EQUAL_EARTH_X_MAX` / `EQUAL_EARTH_Y_MAX` | Half-extents in metres, derived from `EARTH_RADIUS`. |
| `MAP_SPACE_MAX_LATITUDE` | Map-space latitude of the geographic pole (≈65.54°). |
| `MERCATOR_MAX_LATITUDE` | 85.051128779806589. |

Full TypeScript declarations ship with the package; the lower-level building blocks (bands,
style rewrite, switcher, tile pipeline) are exported too.

## Contributing

```sh
npm run verify   # lint, typecheck, unit tests, build, export guards, browser tests
```

`npm test` runs the unit tests (vitest, no browser). `npm run test:browser` runs the Playwright
suite in headless Chromium with software WebGL, each spec against MapLibre 6.6 and 5.24 (a few
are v6 only), on fixture tiles generated in memory: no network. It takes about six and a half
minutes and needs a fresh build (`verify` builds first). `npm run build:js` refreshes only the
bundles the demo and the browser tests load.

## Roadmap

The plugin is complete against its spec; the open items are product decisions: whether the
stepped transition is good enough ([the ceiling](#adaptive-transition)) and whether to revisit
the first-paint budget ([First paint](#first-paint)).

MapLibre is working on a native adaptive Equal Earth
([maplibre-gl-js#8330](https://github.com/maplibre/maplibre-gl-js/issues/8330)). This package is
deliberately shaped as a polyfill of the pending spec so that it can simply be removed once that
ships; until then a `native: 'auto'` option that hands over to it is planned.

## Credits

A rewrite of [pka/maplibre-gl-equal-earth](https://github.com/pka/maplibre-gl-equal-earth) by
Pirmin Kalberer, whose [Equal Earth tile work](https://equal.bbox.earth/) established the
grid-factor approach this builds on. The backprojection technique is Development Seed's
[dirty-reprojectors](https://github.com/developmentseed/dirty-reprojectors).

Projection formulas from Šavrič, B., Patterson, T. & Jenny, B. (2019), "The Equal Earth map
projection", *International Journal of Geographical Information Science* 33(3), 454–465.

## License

MIT
