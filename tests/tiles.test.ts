import { describe, expect, it } from 'vitest';

import { geographicToMap, WORLD_Y_MAX, WORLD_Y_MIN } from '../src/math/backproject.js';
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

/* ------------------------------------------------------------------ helpers */

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
    // strongly curved in Equal Earth. This is the end-to-end guard that neither
    // geojson-vt's simplification nor the encoder discards the added vertices.
    const layers = lineLayer([
      [150, -80],
      [150, 80],
    ]);

    const flat = countVertices(buildTile(layers, output, { maxDepth: 0 }));
    const curved = countVertices(buildTile(layers, output));

    expect(flat).toBeGreaterThan(0);
    expect(curved).toBeGreaterThan(flat * 5);
  });

  it('geojson-vt simplification would otherwise erase the subdivision', () => {
    // Regression guard for the default: geojson-vt's own default tolerance of 3 removes
    // vertices within 3 tile units of the chord, i.e. everything a 1-tile-unit
    // subdivision target adds.
    const layers = lineLayer([
      [150, -80],
      [150, 80],
    ]);

    const withDefault = countVertices(buildTile(layers, output));
    const withGeojsonVtDefault = countVertices(
      buildTile(layers, output, { simplifyTolerance: 3 }),
    );

    expect(withDefault).toBeGreaterThan(withGeojsonVtDefault);
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
  });
});
