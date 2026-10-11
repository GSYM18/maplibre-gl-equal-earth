# @yellowmap/maplibre-gl-equal-earth

Equal Earth projection support for [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/) v6.

The [Equal Earth projection](https://equal-earth.com/) (Šavrič, Patterson & Jenny, 2018) is an
equal-area pseudocylindrical projection — countries appear at their true relative size, unlike
Web Mercator, while still looking like a world map rather than a sinusoid.

> **Status: `1.0.0-alpha.1`.** The coordinate math, camera handling and the tile pipeline (the
> `eqearth://` protocol and its worker bundles) are implemented and tested. The projection
> polyfill is not — see [Roadmap](#roadmap). Until then you wire the protocol, camera and
> constraint up yourself rather than calling `map.setProjection(...)`.

## Install

```sh
npm install @yellowmap/maplibre-gl-equal-earth maplibre-gl
```

ESM only. MapLibre v6 is the peer dependency today; v5 support is experimental until the peer
range widens to `>=5.24 <7`.

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
  isActive: () => equalEarthEnabled,   // inert under Mercator and globe
  latitudeMargin: 2,
});
```

This uses `transformConstrain` rather than `transformCameraUpdate`, because it survives a
projection switch — `migrateProjection` replaces the transform wholesale.

## API

| Export | Description |
| --- | --- |
| `toEqualEarth(lngLat)` | Geographic degrees → Equal Earth metres (EPSG:8857). |
| `fromEqualEarth(point)` | Equal Earth metres → geographic degrees. Newton inverse. |
| `geographicToMap(lngLat)` | Geographic degrees → map space. |
| `mapToGeographic(lngLat)` | Map space → geographic degrees. |
| `ThresholdCamera` | `transformCameraUpdate` hook for the Equal Earth ↔ Mercator switch. |
| `installEqualEarthConstrain(map, opts)` | Clamps the camera to the Equal Earth world; returns a teardown function. |
| `createEqualEarthConstrain(opts)` | The bare `TransformConstrainFunction`, if you want to compose it yourself. |
| `GRID_FACTOR` | ≈1.162, the Equal Earth → Mercator grid scale. |
| `EQUAL_EARTH_X_MAX` / `EQUAL_EARTH_Y_MAX` | Half-extents in metres, derived from `EARTH_RADIUS`. |
| `MAP_SPACE_MAX_LATITUDE` | Map-space latitude of the geographic pole (≈65.54°). |
| `MERCATOR_MAX_LATITUDE` | 85.051128779806589. |

Full TypeScript declarations ship with the package.

## Roadmap

- **Phase 3** — projection polyfill: `map.setProjection({type: 'equal-earth'})` and
  `{type: 'equal'}`, matching the names proposed in
  [style-spec#1623](https://github.com/maplibre/maplibre-style-spec/pull/1623).
- **Phase 4** — OpenFreeMap demos and deck.gl overlay integration.

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
