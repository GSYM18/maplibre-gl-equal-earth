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

type Summary = { count: number; area: number; length: number; points: Set<string> };
function decode(bytes: Uint8Array): Record<string, Summary> {
  const out: Record<string, Summary> = {};
  if (bytes.byteLength === 0) return out;
  const tile = new VectorTile(new PbfReader(bytes));
  for (const name of Object.keys(tile.layers)) {
    const layer = tile.layers[name]!;
    const s: Summary = { count: layer.length, area: 0, length: 0, points: new Set() };
    for (let i = 0; i < layer.length; i++) {
      const feature = layer.feature(i);
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
  ]);
}

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
    }
  });
});
