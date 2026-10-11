import { VectorTile } from '@mapbox/vector-tile';
import geojsonvt from 'geojson-vt';
import { PbfReader } from 'pbf';
import { fromGeojsonVt } from 'vt-pbf';
import { describe, expect, it } from 'vitest';

import { toleranceForZoom } from '../src/math/subdivide.js';
import { clipFeatureToTile } from '../src/tiles/clip.js';
import { buildTile, warpFeature, type GeographicLayers } from '../src/tiles/mvt.js';
import type { TileId } from '../src/tiles/tile-cover.js';

const OUT: TileId = { z: 3, x: 4, y: 3 }; // mid-latitude Europe/Africa at blend 0
const EXTENT = 4096, BUFFER = 64;

/** The old pipeline, kept here as the reference: warp (blend 0) then geojson-vt. */
function referenceTile(layers: GeographicLayers): Uint8Array {
  const tolerance = toleranceForZoom(OUT.z, 1);
  const encoded: Record<string, { features: unknown[] }> = {};
  for (const [name, features] of layers) {
    const warped = features.map((f) => warpFeature(f, tolerance, 8, 0)).filter((f): f is GeoJSON.Feature => f !== null);
    const index = geojsonvt({ type: 'FeatureCollection', features: warped }, { maxZoom: Math.max(OUT.z, 1), indexMaxZoom: 0, tolerance: 0, extent: EXTENT, buffer: BUFFER, debug: 0 });
    const tile = index.getTile(OUT.z, OUT.x, OUT.y);
    if (tile && tile.features.length > 0) encoded[name] = tile;
  }
  return fromGeojsonVt(encoded, { version: 2, extent: EXTENT });
}

/**
 * `polygons`/`holes` come from `toGeoJSON`, which classifies rings by winding relative to the
 * feature's first ring, as MapLibre does: a hole wound like its shell counts as a polygon.
 */
type Summary = { count: number; area: number; length: number; points: Set<string>; polygons: number; holes: number };
function decode(bytes: Uint8Array): Record<string, Summary> {
  const out: Record<string, Summary> = {};
  if (bytes.byteLength === 0) return out;
  const tile = new VectorTile(new PbfReader(bytes));
  for (const name of Object.keys(tile.layers)) {
    const layer = tile.layers[name]!;
    const s: Summary = { count: layer.length, area: 0, length: 0, points: new Set(), polygons: 0, holes: 0 };
    for (let i = 0; i < layer.length; i++) {
      const feature = layer.feature(i);
      if (feature.type === 3) {
        const geometry = feature.toGeoJSON(OUT.x, OUT.y, OUT.z).geometry;
        const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
        s.polygons += polygons.length;
        for (const polygon of polygons) s.holes += polygon.length - 1;
      }
      for (const ring of feature.loadGeometry()) {
        if (feature.type === 1) for (const p of ring) s.points.add(`${p.x},${p.y}`);
        if (feature.type === 2) for (let k = 1; k < ring.length; k++) s.length += Math.hypot(ring[k]!.x - ring[k - 1]!.x, ring[k]!.y - ring[k - 1]!.y);
        if (feature.type === 3) {
          let a = 0;
          for (let k = 0; k < ring.length; k++) { const p = ring[k]!, q = ring[(k + 1) % ring.length]!; a += p.x * q.y - q.x * p.y; }
          s.area += Math.abs(a) / 2;
        }
      }
    }
    out[name] = s;
  }
  return out;
}

const feature = (geometry: GeoJSON.Geometry, id?: number): GeoJSON.Feature => ({ type: 'Feature', id, properties: { kind: geometry.type }, geometry });
/** Tile 3/4/3 at blend 0 covers roughly lng 0…45°, lat 0…40° in map space; these straddle its edges. */
function world(): GeographicLayers {
  return new Map([
    ['poly', [feature({ type: 'Polygon', coordinates: [
      [[-20, 5], [30, 5], [30, 35], [-20, 35], [-20, 5]],           // outer, crosses the west edge
      [[0, 15], [10, 15], [10, 25], [0, 25], [0, 15]],              // hole, inside
    ] }, 1)]],
    ['multi', [feature({ type: 'MultiPolygon', coordinates: [
      [[[5, 10], [20, 10], [20, 20], [5, 20], [5, 10]]],            // inside
      [[[100, 10], [120, 10], [120, 20], [100, 20], [100, 10]]],    // far outside: dropped
    ] }, 2)]],
    ['line', [feature({ type: 'LineString', coordinates: [[-30, -10], [60, 50]] }, 3)]],   // diagonal through the tile
    ['points', [feature({ type: 'MultiPoint', coordinates: [[20, 20], [-0.4, 20], [80, 20]] }, 4)]], // inside, in the buffer, outside
    // These cross all four edges of the tile, in map space and once warped from geographic.
    ['frame', [feature({ type: 'Polygon', coordinates: [
      [[-20, -20], [60, -20], [60, 60], [-20, 60], [-20, -20]],     // outer, around the whole tile
      [[5, 10], [5, 20], [15, 20], [15, 10], [5, 10]],              // hole, wound against it
    ] }, 5)]],
    ['cross', [
      feature({ type: 'LineString', coordinates: [[-20, 20], [60, 20]] }, 6),  // west to east
      feature({ type: 'LineString', coordinates: [[20, 60], [20, -20]] }, 7),  // north to south
    ]],
  ]);
}

/** Every vertex of every feature in an encoded tile, in tile units. */
function vertices(bytes: Uint8Array): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  if (bytes.byteLength === 0) return out;
  const tile = new VectorTile(new PbfReader(bytes));
  for (const name of Object.keys(tile.layers)) {
    const layer = tile.layers[name]!;
    for (let i = 0; i < layer.length; i++) for (const ring of layer.feature(i).loadGeometry()) out.push(...ring);
  }
  return out;
}

const withinBuffer = (x: number, y: number): void => {
  expect(x).toBeGreaterThanOrEqual(-BUFFER);
  expect(x).toBeLessThanOrEqual(EXTENT + BUFFER);
  expect(y).toBeGreaterThanOrEqual(-BUFFER);
  expect(y).toBeLessThanOrEqual(EXTENT + BUFFER);
};

describe('clipFeatureToTile', () => {
  it('drops geometry entirely outside the buffered tile', () => {
    expect(clipFeatureToTile(feature({ type: 'Polygon', coordinates: [[[100, 10], [120, 10], [120, 20], [100, 10]]] }), OUT, EXTENT, BUFFER)).toBeNull();
    expect(clipFeatureToTile(feature({ type: 'Point', coordinates: [80, 20] }), OUT, EXTENT, BUFFER)).toBeNull();
  });

  it('keeps rings closed and oriented', () => {
    const result = clipFeatureToTile(world().get('poly')![0]!, OUT, EXTENT, BUFFER)!;
    expect(result.type).toBe(3);
    const rings = result.geometry as number[][][];
    expect(rings).toHaveLength(2);
    for (const ring of rings) expect(ring[0]).toEqual(ring[ring.length - 1]);
    const signedArea = (ring: number[][]) => ring.reduce((a, p, k) => { const q = ring[(k + 1) % ring.length]!; return a + p[0]! * q[1]! - q[0]! * p[1]!; }, 0);
    // The outer ring is CCW in lng/lat (y up), so clockwise (negative here, y down) in tile units; the hole is the opposite.
    expect(Math.sign(signedArea(rings[0]!))).toBe(-1);
    expect(Math.sign(signedArea(rings[1]!))).toBe(1);
    for (const [x, y] of rings[0]!) { expect(x).toBeGreaterThanOrEqual(-BUFFER); expect(y).toBeGreaterThanOrEqual(-BUFFER); expect(x).toBeLessThanOrEqual(EXTENT + BUFFER); expect(y).toBeLessThanOrEqual(EXTENT + BUFFER); }
  });

  it('clips a ring on all four edges of the buffered tile', () => {
    const result = clipFeatureToTile(world().get('frame')![0]!, OUT, EXTENT, BUFFER)!;
    const [outer, hole] = result.geometry as number[][][];
    for (const [x, y] of outer!) withinBuffer(x!, y!);
    // The shell covers the whole buffered tile: its corners are exactly the four buffer corners.
    const corners = new Set(outer!.map(([x, y]) => `${x},${y}`));
    for (const [x, y] of [[-BUFFER, -BUFFER], [EXTENT + BUFFER, -BUFFER], [EXTENT + BUFFER, EXTENT + BUFFER], [-BUFFER, EXTENT + BUFFER]]) {
      expect(corners.has(`${x},${y}`)).toBe(true);
    }
    expect(hole!.length).toBe(5);
  });

  it('clips segments on all four edges of the buffered tile', () => {
    for (const line of world().get('cross')!) {
      const runs = clipFeatureToTile(line, OUT, EXTENT, BUFFER)!.geometry as number[][][];
      expect(runs).toHaveLength(1);
      for (const [x, y] of runs[0]!) withinBuffer(x!, y!);
      // Each line enters on one edge and leaves on the opposite one.
      const onEdge = (p: number[]) => p.some((v) => v === -BUFFER || v === EXTENT + BUFFER);
      expect(onEdge(runs[0]![0]!)).toBe(true);
      expect(onEdge(runs[0]!.at(-1)!)).toBe(true);
    }
  });

  it('keeps a point exactly on the buffer edge and drops one a unit beyond it', () => {
    // Map-space lng to Mercator world x is linear: x = 0.5 + lng / 360, so these land on whole
    // tile units: the buffer edges of 3/4/3 and one unit beyond them.
    const lngAt = (tileX: number) => ((OUT.x + tileX / EXTENT) / 2 ** OUT.z - 0.5) * 360;
    const at = (tileX: number) => clipFeatureToTile(feature({ type: 'Point', coordinates: [lngAt(tileX), 20] }), OUT, EXTENT, BUFFER);
    expect((at(EXTENT + BUFFER)!.geometry as number[][])[0]![0]).toBe(EXTENT + BUFFER);
    expect((at(-BUFFER)!.geometry as number[][])[0]![0]).toBe(-BUFFER);
    expect(at(EXTENT + BUFFER + 1)).toBeNull();
    expect(at(-BUFFER - 1)).toBeNull();
  });

  it('splits a line that leaves and re-enters into two runs', () => {
    // Out through the north edge and back in: a "V" whose apex is far above the tile.
    const v = feature({ type: 'LineString', coordinates: [[5, 20], [15, 80], [25, 20]] });
    const result = clipFeatureToTile(v, OUT, EXTENT, BUFFER)!;
    expect(result.type).toBe(2);
    expect((result.geometry as number[][][]).length).toBe(2);
  });

  it('keeps a line wholly inside the tile as one run with every vertex', () => {
    const line = feature({ type: 'LineString', coordinates: [[10, 20], [12, 22], [14, 21], [16, 25]] });
    const result = clipFeatureToTile(line, OUT, EXTENT, BUFFER)!;
    expect(result.geometry).toHaveLength(1);
    expect((result.geometry as number[][][])[0]).toHaveLength(4);
  });

  it('keeps tags and a numeric id, and omits a non-numeric one', () => {
    const point: GeoJSON.Point = { type: 'Point', coordinates: [20, 20] };
    const numbered = clipFeatureToTile(feature(point, 9), OUT, EXTENT, BUFFER)!;
    expect(numbered.id).toBe(9);
    expect(numbered.tags).toEqual({ kind: 'Point' });
    const named = clipFeatureToTile({ type: 'Feature', id: 'x', properties: null, geometry: point }, OUT, EXTENT, BUFFER)!;
    expect('id' in named).toBe(false);
    expect(named.tags).toEqual({});
  });

  it('winds every outer ring like the first and every hole against it', () => {
    const signedArea = (ring: number[][]) => ring.reduce((a, p, k) => { const q = ring[(k + 1) % ring.length]!; return a + p[0]! * q[1]! - q[0]! * p[1]!; }, 0);
    const ccw = (x: number, y: number, s: number) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]];
    const cw = (x: number, y: number, s: number) => [...ccw(x, y, s)].reverse();
    // The second polygon's shell and the first polygon's hole are both wound the wrong way.
    const multi = feature({ type: 'MultiPolygon', coordinates: [[ccw(5, 10, 10), ccw(8, 13, 2)], [cw(25, 10, 10)]] });
    const rings = clipFeatureToTile(multi, OUT, EXTENT, BUFFER)!.geometry as number[][][];
    expect(rings.map((ring) => Math.sign(signedArea(ring)))).toEqual([-1, 1, -1]);
  });

  it('keeps a point inside the buffer and drops one beyond it', () => {
    const result = clipFeatureToTile(world().get('points')![0]!, OUT, EXTENT, BUFFER)!;
    expect(result.type).toBe(1);
    expect((result.geometry as number[][]).length).toBe(2);
  });
});

describe('buildTile (direct clip) against geojson-vt', () => {
  it('produces the same features, areas and lengths within 0.1 %', () => {
    const ours = decode(buildTile(world(), OUT, { blend: 0 }));
    const reference = decode(referenceTile(world()));
    expect(Object.keys(ours).sort()).toEqual(Object.keys(reference).sort());
    for (const name of Object.keys(reference)) {
      expect(ours[name]!.count).toBe(reference[name]!.count);
      expect(ours[name]!.area).toBeCloseTo(reference[name]!.area, -Math.log10(Math.max(1, reference[name]!.area * 1e-3)));
      expect(ours[name]!.length).toBeCloseTo(reference[name]!.length, -Math.log10(Math.max(1, reference[name]!.length * 1e-3)));
      expect(ours[name]!.points).toEqual(reference[name]!.points);
      // Winding: the same rings must classify as shells and holes in both.
      expect([ours[name]!.polygons, ours[name]!.holes]).toEqual([reference[name]!.polygons, reference[name]!.holes]);
    }
    expect(reference['frame']!.holes).toBe(1);
    expect(reference['poly']!.holes).toBe(1);
  });

  it('keeps every vertex within the buffered tile on all four edges', () => {
    const all = vertices(buildTile(world(), OUT, { blend: 0 }));
    for (const { x, y } of all) withinBuffer(x, y);
    // ...and the fixture really reaches every edge, so each edge's clip is exercised.
    expect(all.some((p) => p.x === -BUFFER)).toBe(true);
    expect(all.some((p) => p.x === EXTENT + BUFFER)).toBe(true);
    expect(all.some((p) => p.y === -BUFFER)).toBe(true);
    expect(all.some((p) => p.y === EXTENT + BUFFER)).toBe(true);
  });
});

describe('buildTile pre-warp reject', () => {
  const lone = (geometry: GeoJSON.Geometry): GeographicLayers => new Map([['lone', [feature(geometry, 1)]]]);

  it('keeps a lone point whose warped position lies in the west buffer', () => {
    const all = vertices(buildTile(lone({ type: 'Point', coordinates: [-0.4, 20] }), OUT, { blend: 0 }));
    expect(all).toHaveLength(1);
    expect(all[0]!.x).toBeLessThan(0);
    expect(all[0]!.x).toBeGreaterThanOrEqual(-BUFFER);
  });

  it('keeps a short line lying wholly in the west buffer', () => {
    const all = vertices(buildTile(lone({ type: 'LineString', coordinates: [[-0.6, 25], [-0.3, 25]] }), OUT, { blend: 0 }));
    expect(all.length).toBeGreaterThanOrEqual(2);
    for (const { x } of all) {
      expect(x).toBeLessThan(0);
      expect(x).toBeGreaterThanOrEqual(-BUFFER);
    }
  });

  it('keeps a lone point in the south buffer at an intermediate blend', () => {
    // 3/4/3's south edge is the equator at every blend.
    const all = vertices(buildTile(lone({ type: 'Point', coordinates: [20, -0.5] }), OUT, { blend: 1 / 3 }));
    expect(all).toHaveLength(1);
    expect(all[0]!.y).toBeGreaterThan(EXTENT);
    expect(all[0]!.y).toBeLessThanOrEqual(EXTENT + BUFFER);
  });
});
