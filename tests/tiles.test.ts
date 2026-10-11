import { describe, expect, it } from 'vitest';
import geojsonvt from 'geojson-vt';

import {
  geographicToMap,
  geographicToMapWorld,
  mapToGeographic,
  MERCATOR_MAX_LATITUDE,
  WORLD_Y_MAX,
  WORLD_Y_MIN,
  worldYRange,
} from '../src/math/backproject.js';
import { densify, toleranceForZoom } from '../src/math/subdivide.js';
import {
  buildTile,
  decodeToGeographic,
  mergeLayers,
  warpFeature,
  type GeographicLayers,
} from '../src/tiles/mvt.js';
import {
  preimageBBox,
  sourceTilesFor,
  tilesForBBox,
  tileWorldBounds,
  type TileId,
} from '../src/tiles/tile-cover.js';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { fromGeojsonVt } from 'vt-pbf';

/* ------------------------------------------------------------------ helpers */

/** Encode geographic GeoJSON geometries, per layer, into the MVT of `tile` (extent 4096, buffer 64). */
function encodeTile(layers: Record<string, GeoJSON.Geometry[]>, tile: TileId): Uint8Array {
  const encoded: Record<string, unknown> = {};
  for (const [name, geometries] of Object.entries(layers)) {
    const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: geometries.map((geometry) => ({ type: 'Feature', properties: {}, geometry })) };
    const index = geojsonvt(fc, { maxZoom: Math.max(tile.z, 1), indexMaxZoom: 0, tolerance: 0, extent: 4096, buffer: 64, debug: 0 });
    const t = index.getTile(tile.z, tile.x, tile.y);
    if (t && t.features.length > 0) encoded[name] = t;
  }
  return fromGeojsonVt(encoded as Parameters<typeof fromGeojsonVt>[0], { version: 2, extent: 4096 });
}

function countVertices(encoded: Uint8Array): number {
  if (encoded.byteLength === 0) return 0;
  const tile = new VectorTile(new PbfReader(encoded));
  let total = 0;
  for (const name of Object.keys(tile.layers)) {
    const layer = tile.layers[name]!;
    for (let i = 0; i < layer.length; i++) {
      for (const ring of layer.feature(i).loadGeometry()) total += ring.length;
    }
  }
  return total;
}

function lineLayer(coordinates: [number, number][]): GeographicLayers {
  return new Map([
    [
      'test',
      [
        {
          type: 'Feature',
          properties: { name: 'probe' },
          geometry: { type: 'LineString', coordinates },
        } satisfies GeoJSON.Feature,
      ],
    ],
  ]);
}

/* --------------------------------------------------------------- tile cover */

describe('tile cover', () => {
  it('covers the whole world with one source tile at z0', () => {
    expect(sourceTilesFor({ z: 0, x: 0, y: 0 })).toEqual([{ z: 0, x: 0, y: 0 }]);
  });

  it('returns nothing for tiles in the empty bands above and below the world', () => {
    // Equal Earth occupies only the middle ~49% of the Mercator grid vertically.
    expect(sourceTilesFor({ z: 2, x: 0, y: 0 })).toEqual([]);
    expect(sourceTilesFor({ z: 2, x: 1, y: 3 })).toEqual([]);
    expect(preimageBBox({ z: 2, x: 0, y: 0 })).toBeNull();
  });

  it('agrees with the world band constants', () => {
    // A tile straddling the north edge must not be skipped.
    const z = 4;
    const scale = 2 ** z;
    const straddling = Math.floor(WORLD_Y_MIN * scale);
    expect(preimageBBox({ z, x: 0, y: straddling })).not.toBeNull();
    expect(preimageBBox({ z, x: 0, y: straddling - 1 })).toBeNull();

    expect(WORLD_Y_MIN).toBeGreaterThan(0.25);
    expect(WORLD_Y_MIN).toBeLessThan(0.26);
    expect(WORLD_Y_MAX).toBeCloseTo(1 - WORLD_Y_MIN, 12);
  });

  it('produces a bbox inside geographic limits', () => {
    for (const tile of [
      { z: 1, x: 0, y: 0 },
      { z: 2, x: 1, y: 1 },
      { z: 3, x: 4, y: 3 },
    ] satisfies TileId[]) {
      const bbox = preimageBBox(tile);
      expect(bbox).not.toBeNull();
      const [west, south, east, north] = bbox!;
      expect(south).toBeGreaterThanOrEqual(-90.000001);
      expect(north).toBeLessThanOrEqual(90.000001);
      expect(west).toBeLessThan(east);
      expect(south).toBeLessThan(north);
    }
  });

  it('expands longitude at high latitude, where Equal Earth narrows', () => {
    // The same column of output tiles: the poleward one must reach further east/west
    // in geographic terms, because the projection squeezes longitude there.
    const equatorial = preimageBBox({ z: 3, x: 5, y: 4 })!;
    const poleward = preimageBBox({ z: 3, x: 5, y: 2 })!;
    const widthOf = (b: [number, number, number, number]) => b[2] - b[0];
    expect(widthOf(poleward)).toBeGreaterThan(widthOf(equatorial));
  });

  it('clamps the source zoom to the tileset maximum', () => {
    const tiles = sourceTilesFor({ z: 14, x: 8000, y: 6000 }, { sourceZoom: 20, sourceMaxZoom: 14 });
    for (const tile of tiles) expect(tile.z).toBe(14);
  });

  it('respects an explicit source zoom', () => {
    const tiles = sourceTilesFor({ z: 1, x: 0, y: 1 }, { sourceZoom: 3 });
    expect(tiles.length).toBeGreaterThan(0);
    for (const tile of tiles) expect(tile.z).toBe(3);
  });

  it('keeps tile indices in range', () => {
    for (const tile of sourceTilesFor({ z: 2, x: 0, y: 1 })) {
      expect(tile.x).toBeGreaterThanOrEqual(0);
      expect(tile.x).toBeLessThan(4);
      expect(tile.y).toBeGreaterThanOrEqual(0);
      expect(tile.y).toBeLessThan(4);
    }
  });

  it('tilesForBBox covers a known box', () => {
    expect(tilesForBBox([-180, -85, 180, 85], 0)).toEqual([{ z: 0, x: 0, y: 0 }]);
    expect(tilesForBBox([-180, -85, 180, 85], 1)).toHaveLength(4);
  });

  it('tileWorldBounds is consistent with the zoom', () => {
    expect(tileWorldBounds({ z: 1, x: 1, y: 0 })).toEqual([0.5, 0, 1, 0.5]);
  });
});

/* ------------------------------------------------------------ warp pipeline */

describe('warpFeature', () => {
  it('warps each geometry type', () => {
    const types: GeoJSON.Geometry[] = [
      { type: 'Point', coordinates: [10, 20] },
      { type: 'MultiPoint', coordinates: [[10, 20]] },
      {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [10, 10],
        ],
      },
      {
        type: 'MultiLineString',
        coordinates: [
          [
            [0, 0],
            [10, 10],
          ],
        ],
      },
      {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 0],
          ],
        ],
      },
      {
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [0, 0],
              [10, 0],
              [10, 10],
              [0, 0],
            ],
          ],
        ],
      },
    ];

    for (const geometry of types) {
      const result = warpFeature(
        { type: 'Feature', properties: null, geometry },
        toleranceForZoom(2),
        8,
      );
      expect(result?.geometry.type).toBe(geometry.type);
    }
  });

  it('returns null for a GeometryCollection rather than mangling it', () => {
    const result = warpFeature(
      {
        type: 'Feature',
        properties: null,
        geometry: { type: 'GeometryCollection', geometries: [] },
      },
      toleranceForZoom(2),
      8,
    );
    expect(result).toBeNull();
  });

  it('preserves properties and id', () => {
    const result = warpFeature(
      {
        type: 'Feature',
        id: 42,
        properties: { name: 'x' },
        geometry: { type: 'Point', coordinates: [1, 2] },
      },
      toleranceForZoom(2),
      8,
    );
    expect(result?.id).toBe(42);
    expect(result?.properties).toEqual({ name: 'x' });
  });

  it('leaves the equator unbent but bends a meridian', () => {
    const tolerance = toleranceForZoom(0);
    const equator = warpFeature(
      {
        type: 'Feature',
        properties: null,
        geometry: {
          type: 'LineString',
          coordinates: [
            [-180, 0],
            [180, 0],
          ],
        },
      },
      tolerance,
      10,
    );
    const meridian = warpFeature(
      {
        type: 'Feature',
        properties: null,
        geometry: {
          type: 'LineString',
          coordinates: [
            [150, -80],
            [150, 80],
          ],
        },
      },
      tolerance,
      10,
    );

    expect((equator!.geometry as GeoJSON.LineString).coordinates).toHaveLength(2);
    expect(
      (meridian!.geometry as GeoJSON.LineString).coordinates.length,
    ).toBeGreaterThan(20);
  });
});

describe('buildTile', () => {
  const output: TileId = { z: 0, x: 0, y: 0 };

  it('subdivision measurably survives the full pipeline', () => {
    // A long meridian is the worst case for backprojection: straight in Mercator,
    // strongly curved in Equal Earth. This is the end-to-end guard that neither the
    // clip nor the encoder discards the added vertices.
    const layers = lineLayer([
      [150, -80],
      [150, 80],
    ]);

    const flat = countVertices(buildTile(layers, output, { maxDepth: 0 }));
    const curved = countVertices(buildTile(layers, output));

    expect(flat).toBeGreaterThan(0);
    expect(curved).toBeGreaterThan(flat * 5);
  });

  it('keeps subdivision vertices through the clip of a partial tile', () => {
    // The old pipeline's geojson-vt simplification (default tolerance 3) deleted exactly the
    // vertices a 1-tile-unit subdivision adds. The direct clip simplifies nothing; this pins
    // that on a tile which cuts the meridian, so the clip path itself is exercised.
    const layers = lineLayer([
      [150, -80],
      [150, 80],
    ]);
    const northEast: TileId = { z: 1, x: 1, y: 0 };

    const flat = countVertices(buildTile(layers, northEast, { maxDepth: 0 }));
    const curved = countVertices(buildTile(layers, northEast));

    expect(flat).toBeGreaterThan(0);
    expect(curved).toBeGreaterThan(flat * 5);
    const decoded = new VectorTile(new PbfReader(buildTile(layers, northEast))).layers['test']!;
    for (const ring of decoded.feature(0).loadGeometry()) {
      for (const p of ring) {
        expect(p.x).toBeGreaterThanOrEqual(-64);
        expect(p.x).toBeLessThanOrEqual(4096 + 64);
        expect(p.y).toBeGreaterThanOrEqual(-64);
        expect(p.y).toBeLessThanOrEqual(4096 + 64);
      }
    }
  });

  it('emits an empty buffer when nothing survives clipping', () => {
    // Geometry far outside the requested tile.
    const layers = lineLayer([
      [-170, -80],
      [-160, -80],
    ]);
    const encoded = buildTile(layers, { z: 4, x: 15, y: 7 }, {});
    expect(encoded.byteLength).toBe(0);
  });

  it('round-trips through encode and decode', () => {
    const layers = lineLayer([
      [-40, -20],
      [40, 20],
    ]);
    const encoded = buildTile(layers, output);
    expect(encoded.byteLength).toBeGreaterThan(0);

    const decoded = new VectorTile(new PbfReader(encoded));
    expect(Object.keys(decoded.layers)).toContain('test');
    const layer = decoded.layers['test']!;
    expect(layer.length).toBe(1);
    expect(layer.feature(0).properties['name']).toBe('probe');
    expect(layer.extent).toBe(4096);
  });

  it('honours a layer filter at decode time', () => {
    const encoded = buildTile(lineLayer([[0, 0], [10, 10]]), output);
    const roundTripped = decodeToGeographic(encoded, output, ['nonexistent']);
    expect(roundTripped.size).toBe(0);
  });
});

describe('mergeLayers', () => {
  it('concatenates features from the same layer', () => {
    const a: GeographicLayers = new Map([['x', [1 as unknown as GeoJSON.Feature]]]);
    const b: GeographicLayers = new Map([
      ['x', [2 as unknown as GeoJSON.Feature]],
      ['y', [3 as unknown as GeoJSON.Feature]],
    ]);
    const merged = mergeLayers([a, b]);
    expect(merged.get('x')).toHaveLength(2);
    expect(merged.get('y')).toHaveLength(1);
  });

  it('does not mutate its inputs', () => {
    const a: GeographicLayers = new Map([['x', [1 as unknown as GeoJSON.Feature]]]);
    mergeLayers([a, new Map([['x', [2 as unknown as GeoJSON.Feature]]])]);
    expect(a.get('x')).toHaveLength(1);
  });

  const point = (id: number | undefined, coordinates: [number, number]): GeoJSON.Feature => ({
    type: 'Feature',
    id,
    properties: { name: 'label' },
    geometry: { type: 'Point', coordinates },
  });

  it('drops a point repeated with the same id and coordinates by another source tile', () => {
    const merged = mergeLayers([
      new Map([['place', [point(7, [10, 20])]]]),
      new Map([['place', [point(7, [10, 20])]]]),
    ]);
    expect(merged.get('place')).toHaveLength(1);
  });

  it('keeps two different points with the same id, and points without an id', () => {
    const merged = mergeLayers([
      new Map([['place', [point(7, [10, 20]), point(undefined, [1, 1])]]]),
      new Map([['place', [point(7, [10, 21]), point(undefined, [1, 1])]]]),
    ]);
    expect(merged.get('place')).toHaveLength(4);
  });

  it('drops a label repeated as a MultiPoint with a world copy in another source tile', () => {
    // OpenFreeMap z1: Algeria is a MultiPoint [[2.99, 27.99], [-357.01, 27.99]] in the western
    // source tiles and a Point [2.99, 27.99] in the eastern ones.
    const withCopy: GeoJSON.Feature = {
      type: 'Feature',
      id: 7,
      properties: { name: 'label' },
      geometry: { type: 'MultiPoint', coordinates: [[10, 20], [-350, 20]] },
    };
    const merged = mergeLayers([
      new Map([['place', [withCopy]]]),
      new Map([['place', [point(7, [10, 20])]]]),
      new Map([['place', [withCopy]]]),
    ]);
    expect(merged.get('place')).toEqual([withCopy]);
  });

  it('drops only the already-seen positions of a MultiPoint, leaving its input untouched', () => {
    const multi: GeoJSON.Feature<GeoJSON.MultiPoint> = {
      type: 'Feature',
      id: 7,
      properties: { name: 'label' },
      geometry: { type: 'MultiPoint', coordinates: [[10, 20], [30, 40], [-350, 20]] },
    };
    const merged = mergeLayers([
      new Map([['place', [point(7, [10, 20])]]]),
      new Map([['place', [multi]]]),
    ]).get('place')!;

    expect(merged).toHaveLength(2);
    expect(merged[1]!.id).toBe(7);
    expect(merged[1]!.properties).toEqual({ name: 'label' });
    // The seen position goes, and so does the world copy, which the warp would drop anyway.
    expect(merged[1]!.geometry).toEqual({ type: 'MultiPoint', coordinates: [[30, 40]] });
    expect(multi.geometry.coordinates).toHaveLength(3);
  });

  it('dedupes per layer, not across layers', () => {
    const merged = mergeLayers([
      new Map([['a', [point(7, [10, 20])]]]),
      new Map([['b', [point(7, [10, 20])]]]),
    ]);
    expect(merged.get('a')).toHaveLength(1);
    expect(merged.get('b')).toHaveLength(1);
  });

  it("emits a label in two source tiles' buffers once in the output tile", () => {
    // Global tile-unit position 4096 + 10 at z1: inside 1/1/0 near its west edge, and in
    // the east buffer of 1/0/0. MVT encodes both as the same integer global position.
    const label = (x: number, y: number) =>
      fromGeojsonVt(
        { place: { features: [{ type: 1, id: 42, geometry: [[x, y]], tags: { name: 'twice' } }] } },
        { version: 2, extent: 4096 },
      );
    const west = { z: 1, x: 0, y: 0 };
    const east = { z: 1, x: 1, y: 0 };
    const merged = mergeLayers([
      decodeToGeographic(label(4096 + 10, 3000), west),
      decodeToGeographic(label(10, 3000), east),
    ]);

    const out = new VectorTile(new PbfReader(buildTile(merged, { z: 0, x: 0, y: 0 })));
    const layer = out.layers['place']!;
    expect(layer.length).toBe(1);
    expect(layer.feature(0).id).toBe(42);
  });
});

describe('blended warp in the tile pipeline', () => {
  it('warps a point to its blended map-space position', () => {
    const feature: GeoJSON.Feature = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'Point', coordinates: [139.7, 35.7] },
    };
    const warped = warpFeature(feature, toleranceForZoom(5), 8, 1 / 3)!;
    const expected = geographicToMap([139.7, 35.7], 1 / 3);
    const coordinates = (warped.geometry as GeoJSON.Point).coordinates;
    expect(coordinates[0]).toBeCloseTo(expected[0], 12);
    expect(coordinates[1]).toBeCloseTo(expected[1], 12);
  });

  it('covers grid rows that are empty in pure Equal Earth once blended towards Mercator', () => {
    expect(sourceTilesFor({ z: 2, x: 0, y: 0 })).toEqual([]);
    expect(sourceTilesFor({ z: 2, x: 0, y: 0 }, { blend: 2 / 3 }).length).toBeGreaterThan(0);
  });

  it('keeps every pre-image a valid geographic box at intermediate blends', () => {
    for (const blend of [1 / 3, 2 / 3]) {
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const bbox = preimageBBox({ z: 3, x, y }, { blend });
          if (!bbox) continue;
          const [west, south, east, north] = bbox;
          expect(west).toBeLessThanOrEqual(east);
          expect(south).toBeLessThanOrEqual(north);
          expect(south).toBeGreaterThanOrEqual(-90 - 1e-9);
          expect(north).toBeLessThanOrEqual(90 + 1e-9);
        }
      }
    }
  });

  it('subdivides against the blend it will be drawn with', () => {
    const meridian: [number, number][] = [
      [150, -60],
      [150, 60],
    ];
    const options = { tolerance: toleranceForZoom(4) };
    expect(densify(meridian, { ...options, blend: 2 / 3 })).not.toEqual(densify(meridian, options));

    // Every chord the densified line keeps is within the tolerance of the blended warp at
    // its midpoint, measured in the blended world space it will be drawn in.
    const blend = 1 / 2;
    const deviation = (a: [number, number], b: [number, number]): number => {
      const aw = geographicToMapWorld(a, blend);
      const bw = geographicToMapWorld(b, blend);
      const mw = geographicToMapWorld([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], blend);
      return Math.hypot(mw[0] - (aw[0] + bw[0]) / 2, mw[1] - (aw[1] + bw[1]) / 2);
    };
    const densified = densify(meridian, { ...options, blend });
    expect(densified.length).toBeGreaterThan(2);
    let worst = 0;
    for (let i = 1; i < densified.length; i++) {
      worst = Math.max(worst, deviation(densified[i - 1]!, densified[i]!));
    }
    expect(worst).toBeLessThanOrEqual(options.tolerance);
    // ...and the bound is not trivially loose: the unrefined chord exceeds it.
    expect(deviation(meridian[0]!, meridian[1]!)).toBeGreaterThan(options.tolerance);
  });
});

describe('geometry beyond the antimeridian', () => {
  it('places a world-copy label once, at its real position', () => {
    const layers: GeographicLayers = new Map([
      [
        'place',
        [
          {
            type: 'Feature',
            properties: { class: 'country', name: 'United Kingdom' },
            geometry: {
              type: 'MultiPoint',
              coordinates: [
                [-2.58, 54.72],
                [357.42, 54.72],
                [-362.58, 54.72],
              ],
            },
          },
        ],
      ],
    ]);
    const out = buildTile(layers, { z: 0, x: 0, y: 0 }, { blend: 0 });
    const layer = new VectorTile(new PbfReader(out)).layers['place']!;
    const positions: number[][] = [];
    for (let i = 0; i < layer.length; i++) {
      const g = layer.feature(i).toGeoJSON(0, 0, 0).geometry;
      if (g.type === 'Point') positions.push(g.coordinates);
      else if (g.type === 'MultiPoint') positions.push(...g.coordinates);
    }
    expect(positions).toHaveLength(1);
    const [lng, lat] = mapToGeographic([positions[0]![0]!, positions[0]![1]!], 0);
    expect(Math.abs(lng - -2.58)).toBeLessThan(0.1);
    expect(Math.abs(lat - 54.72)).toBeLessThan(0.1);
  });

  it('does not fold a polygon overhanging +180 back into the western half', () => {
    const layers: GeographicLayers = new Map([
      [
        'water',
        [
          {
            type: 'Feature',
            properties: {},
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [170, -10],
                  [185.6, -10],
                  [185.6, 10],
                  [170, 10],
                  [170, -10],
                ],
              ],
            },
          },
        ],
      ],
    ]);
    const out = buildTile(layers, { z: 0, x: 0, y: 0 }, { blend: 0 });
    const layer = new VectorTile(new PbfReader(out)).layers['water']!;
    const xs: number[] = [];
    for (let i = 0; i < layer.length; i++) {
      for (const ring of layer.feature(i).loadGeometry()) for (const p of ring) xs.push(p.x);
    }
    expect(xs.length).toBeGreaterThan(0);
    // The overhang must stay at the east edge: anything in (0, 2048) would be visible in the
    // western half. (geojson-vt also copied it into the undrawn western buffer at x <= 0; the
    // direct clip does not wrap at all.)
    expect(xs.filter((x) => x > 0 && x < 2048)).toEqual([]);
  });
});

describe('pole snapping', () => {
  const top = MERCATOR_MAX_LATITUDE;
  const polar = (): Uint8Array =>
    encodeTile({
      water: [{ type: 'Polygon', coordinates: [[[-180, 80], [180, 80], [180, top], [-180, top], [-180, 80]]] }],
      boundary: [{ type: 'LineString', coordinates: [[-10, top], [10, top]] }],
    }, { z: 0, x: 0, y: 0 });

  it('snaps polygon vertices on the Mercator edge of a z0 tile to the pole, and leaves lines alone', () => {
    const layers = decodeToGeographic(polar(), { z: 0, x: 0, y: 0 });
    const ring = (layers.get('water')![0]!.geometry as GeoJSON.Polygon).coordinates[0]!;
    expect(Math.max(...ring.map((p) => p[1]!))).toBe(90);
    expect(ring.filter((p) => p[1] === 90)).toHaveLength(2);
    const line = (layers.get('boundary')![0]!.geometry as GeoJSON.LineString).coordinates;
    expect(line.every((p) => p[1]! < 90)).toBe(true);
  });

  it('warps a snapped polygon to the top of the Equal Earth world', () => {
    const layers = decodeToGeographic(polar(), { z: 0, x: 0, y: 0 });
    const out = buildTile(layers, { z: 0, x: 0, y: 0 }, { blend: 0 });
    const layer = new VectorTile(new PbfReader(out)).layers['water']!;
    const ys: number[] = [];
    for (let i = 0; i < layer.length; i++) {
      for (const ring of layer.feature(i).loadGeometry()) for (const p of ring) ys.push(p.y);
    }
    expect(ys.length).toBeGreaterThan(0);
    const poleY = worldYRange(0)[0] * 4096;
    expect(Math.abs(Math.min(...ys) - poleY)).toBeLessThanOrEqual(2);
  });
});
