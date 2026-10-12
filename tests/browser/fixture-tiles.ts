/**
 * In-memory fixture tiles for the browser tests: synthetic GeoJSON, tiled with geojson-vt and
 * encoded with vt-pbf, served by a Vite middleware. Deterministic, offline, nothing committed.
 *
 * The data is shaped to exercise the warp, not to look like a map: land boxes that straddle
 * source-tile boundaries at z1–z4 (fill seams), one reaching Mercator's ±85.0511° edge (pole
 * snapping), lines along parallels and meridians, and points with numeric ids.
 */
import geojsonvt from 'geojson-vt';
import { fromGeojsonVt } from 'vt-pbf';
import type { Plugin } from 'vite';

const ring = (w: number, s: number, e: number, n: number, step = 1): number[][] => {
  const pts: number[][] = [];
  for (let x = w; x < e; x += step) pts.push([x, s]);
  for (let y = s; y < n; y += step) pts.push([e, y]);
  for (let x = e; x > w; x -= step) pts.push([x, n]);
  for (let y = n; y > s; y -= step) pts.push([w, y]);
  pts.push([w, s]);
  return pts;
};

const box = (id: number, w: number, s: number, e: number, n: number): GeoJSON.Feature => ({
  type: 'Feature', id, properties: { kind: 'land' },
  geometry: { type: 'Polygon', coordinates: [ring(w, s, e, n)] },
});

export const FIXTURE: Record<string, GeoJSON.FeatureCollection> = {
  land: { type: 'FeatureCollection', features: [
    box(1, -20, -35, 50, 35),     // straddles lng 0 and lat 0: four z1 source tiles
    box(2, -125, 25, -65, 60),
    box(3, 100, -45, 155, -10),
    box(4, -60, 70, 60, 85.0511287798066), // touches Mercator's northern edge
    box(5, 170, 50, 180, 70),     // touches the antimeridian
  ] },
  lines: { type: 'FeatureCollection', features: [
    ...[-60, -30, 0, 30, 60].map((lat, i): GeoJSON.Feature => ({
      type: 'Feature', id: 100 + i, properties: { kind: 'parallel' },
      geometry: { type: 'LineString', coordinates: Array.from({ length: 361 }, (_, k) => [-180 + k, lat]) },
    })),
  ] },
  places: { type: 'FeatureCollection', features: [
    [8.54, 47.37], [139.69, 35.69], [-122.42, 37.77], [-149.9, 61.22], [103.82, 1.35], [179.5, 0],
  ].map((c, i): GeoJSON.Feature => ({ type: 'Feature', id: 200 + i, properties: { kind: 'place' }, geometry: { type: 'Point', coordinates: c } })) },
};

const indexes = Object.fromEntries(
  Object.entries(FIXTURE).map(([name, data]) => [name, geojsonvt(data, { maxZoom: 14, indexMaxZoom: 4, tolerance: 0, buffer: 64, extent: 4096 })]),
);

/** One fixture tile as MVT bytes, or `null` when every layer is empty. */
export function fixtureTile(z: number, x: number, y: number): Uint8Array | null {
  const layers: Record<string, { features: readonly unknown[] }> = {};
  for (const [name, index] of Object.entries(indexes)) {
    const tile = index.getTile(z, x, y);
    if (tile && tile.features.length > 0) layers[name] = tile;
  }
  if (Object.keys(layers).length === 0) return null;
  return fromGeojsonVt(layers, { version: 2, extent: 4096 });
}

/**
 * Serves `/fixture-tiles/{z}/{x}/{y}.pbf` (204 when empty, as tile servers do). Every answer is
 * `Cache-Control: no-store` (Ruling R1): the browser's HTTP cache must never hide an upstream
 * request from a test that counts them.
 *
 * It counts the tile requests it answers: `GET /fixture-tiles/__count` returns `{ count }`,
 * `POST /fixture-tiles/__reset` sets it to 0. The count is per server, and the browser tests run
 * one spec at a time (`workers: 1`).
 */
export function fixtureTilesPlugin(): Plugin {
  let count = 0;
  return {
    name: 'equal-earth:fixture-tiles',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === '/fixture-tiles/__count' && req.method === 'GET') {
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ count }));
          return;
        }
        if (req.url === '/fixture-tiles/__reset' && req.method === 'POST') {
          count = 0;
          res.setHeader('Cache-Control', 'no-store');
          res.statusCode = 204;
          res.end();
          return;
        }
        const match = /^\/fixture-tiles\/(\d+)\/(\d+)\/(\d+)\.pbf$/.exec(req.url ?? '');
        if (!match) return next();
        count++;
        const bytes = fixtureTile(Number(match[1]), Number(match[2]), Number(match[3]));
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-store');
        if (!bytes) { res.statusCode = 204; res.end(); return; }
        res.setHeader('Content-Type', 'application/x-protobuf');
        res.end(Buffer.from(bytes));
      });
    },
  };
}
