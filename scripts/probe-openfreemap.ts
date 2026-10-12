/**
 * Phase 2 gate: run the real warp pipeline against live OpenFreeMap Liberty tiles.
 *
 * The plan calls for prototyping the reslice/clip step before committing to Phase 3, because
 * it is the main technical risk. This measures three things:
 *
 *   1. Does the output decode as a valid MVT, with plausible geometry?
 *   2. Is geometry actually curved after warping (i.e. is subdivision doing its job)?
 *   3. What does the warp cost per tile?
 *
 * Run with:  npx vite-node scripts/probe-openfreemap.ts
 *
 * `--budget` measures the cold world view instead (spec §6, Task 10): every output tile at z1 and
 * z2 inside the Equal Earth rows, blend 0, built by the real protocol handler at
 * `sourceZoomOffset` 0 and −1, one fresh handler per offset. It prints upstream bytes (body bytes
 * after Content-Encoding is undone) and requests, the decode + warp + encode time with the network
 * excluded (a second fresh handler replays the recorded bytes), and the output features of
 * `place`, `water`, `boundary` and
 * `transportation`:  npx vite-node scripts/probe-openfreemap.ts -- --budget
 */

import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';

import { geographicToMapWorld } from '../src/math/backproject.ts';
import { sourceTilesFor, tileWorldBounds, type TileId } from '../src/tiles/tile-cover.ts';
import { decodeToGeographic, mergeLayers, buildTile, type GeographicLayers } from '../src/tiles/mvt.ts';
import { createEqualEarthProtocol, encodeSourceUrl, type ProtocolHandler } from '../src/tiles/protocol.ts';

const TILE_URL = 'https://tiles.openfreemap.org/planet/latest';

const cache = new Map<string, ArrayBuffer | null>();

async function fetchTile(tile: TileId): Promise<ArrayBuffer | null> {
  const key = `${tile.z}/${tile.x}/${tile.y}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const response = await fetch(`${TILE_URL}/${key}.pbf`);
  if (response.status === 404 || response.status === 204) {
    cache.set(key, null);
    return null;
  }
  if (!response.ok) throw new Error(`${key}: HTTP ${response.status}`);
  const data = await response.arrayBuffer();
  cache.set(key, data);
  return data;
}

function summarise(label: string, data: Uint8Array): { layers: number; features: number } {
  if (data.byteLength === 0) {
    console.log(`  ${label}: empty`);
    return { layers: 0, features: 0 };
  }
  const decoded = new VectorTile(new PbfReader(data));
  const names = Object.keys(decoded.layers);
  let features = 0;
  for (const name of names) features += decoded.layers[name]!.length;
  console.log(
    `  ${label}: ${(data.byteLength / 1024).toFixed(1)} kB, ${names.length} layers, ${features} features`,
  );
  return { layers: names.length, features };
}

function layerNames(data: Uint8Array | ArrayBuffer): string[] {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength === 0) return [];
  return Object.keys(new VectorTile(new PbfReader(bytes)).layers).sort();
}

/** Total vertex count in a tile — the direct signal for whether subdivision fired. */
function vertexCount(data: Uint8Array): number {
  if (data.byteLength === 0) return 0;
  const decoded = new VectorTile(new PbfReader(data));
  let total = 0;
  for (const name of Object.keys(decoded.layers)) {
    const layer = decoded.layers[name]!;
    for (let i = 0; i < layer.length; i++) {
      for (const ring of layer.feature(i).loadGeometry()) total += ring.length;
    }
  }
  return total;
}

/**
 * When a layer produces no output, decide whether that is correct (its geometry warps to
 * somewhere outside this tile) or a bug (it overlaps but was lost anyway).
 */
function explainDrop(layers: GeographicLayers, name: string, output: TileId): void {
  const features = layers.get(name);
  if (!features) return;

  const [west, north, east, south] = tileWorldBounds(output);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let overlapping = 0;

  for (const feature of features) {
    let hit = false;
    forEachPosition(feature.geometry, ([lng, lat]) => {
      const [wx, wy] = geographicToMapWorld([lng!, lat!]);
      minX = Math.min(minX, wx);
      maxX = Math.max(maxX, wx);
      minY = Math.min(minY, wy);
      maxY = Math.max(maxY, wy);
      if (wx >= west && wx <= east && wy >= north && wy <= south) hit = true;
    });
    if (hit) overlapping++;
  }

  console.log(
    `        tile world box  x[${west.toFixed(4)}, ${east.toFixed(4)}] y[${north.toFixed(4)}, ${south.toFixed(4)}]`,
  );
  console.log(
    `        warped features x[${minX.toFixed(4)}, ${maxX.toFixed(4)}] y[${minY.toFixed(4)}, ${maxY.toFixed(4)}]`,
  );
  console.log(
    `        ${overlapping} of ${features.length} feature(s) have a vertex inside the tile` +
      (overlapping === 0 ? '  → drop is correct (outside the tile)' : '  → INVESTIGATE'),
  );
}

function forEachPosition(
  geometry: GeoJSON.Geometry,
  visit: (position: GeoJSON.Position) => void,
): void {
  const walk = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === 'number') {
      visit(value as GeoJSON.Position);
      return;
    }
    for (const child of value) walk(child);
  };
  if (geometry.type === 'GeometryCollection') return;
  walk(geometry.coordinates);
}

async function probeTile(output: TileId): Promise<void> {
  console.log(`\n── output tile ${output.z}/${output.x}/${output.y} ──`);

  const sources = sourceTilesFor(output, { sourceMaxZoom: 14 });
  if (sources.length === 0) {
    console.log('  outside the Equal Earth world — no source tiles, skipped');
    return;
  }
  console.log(
    `  source cover: ${sources.length} tile(s) ` +
      `[${sources.map((t) => `${t.z}/${t.x}/${t.y}`).join(', ')}]`,
  );

  const fetchStart = performance.now();
  const fetched = await Promise.all(
    sources.map(async (tile) => ({ tile, data: await fetchTile(tile) })),
  );
  const fetchMs = performance.now() - fetchStart;

  const present = fetched.filter((f) => f.data);
  const inputBytes = present.reduce((sum, f) => sum + (f.data?.byteLength ?? 0), 0);
  console.log(
    `  fetched ${present.length}/${sources.length} in ${fetchMs.toFixed(0)} ms ` +
      `(${(inputBytes / 1024).toFixed(1)} kB)`,
  );
  if (present.length === 0) return;

  // Decode separately so the warp itself can be timed without network or decode noise.
  const decodeStart = performance.now();
  const decoded = present.map((f) => decodeToGeographic(f.data!, f.tile));
  const decodeMs = performance.now() - decodeStart;
  const merged = mergeLayers(decoded);

  const warpStart = performance.now();
  const result = buildTile(merged, output);
  const warpMs = performance.now() - warpStart;

  console.log(`  decode: ${decodeMs.toFixed(1)} ms   warp+reslice+encode: ${warpMs.toFixed(1)} ms`);
  summarise('output', result);

  // Per-layer accounting: source feature count → output feature count.
  const sourceCounts = new Map<string, number>();
  for (const layers of decoded) {
    for (const [name, features] of layers) {
      sourceCounts.set(name, (sourceCounts.get(name) ?? 0) + features.length);
    }
  }
  const outDecoded =
    result.byteLength > 0 ? new VectorTile(new PbfReader(result)).layers : {};
  const rows = [...sourceCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  console.log(`  layers (source → output):`);
  for (const [name, inCount] of rows) {
    const outCount = outDecoded[name]?.length ?? 0;
    const flag = outCount === 0 ? '   ← DROPPED' : '';
    console.log(`    ${name.padEnd(14)} ${String(inCount).padStart(5)} → ${String(outCount).padStart(5)}${flag}`);
    if (outCount === 0) explainDrop(merged, name, output);
  }
  void layerNames;

  // Subdivision effect: same pipeline with refinement disabled.
  const flat = buildTile(merged, output, { maxDepth: 0 });
  const withSub = vertexCount(result);
  const withoutSub = vertexCount(flat);
  const ratio = withoutSub === 0 ? 0 : withSub / withoutSub;
  console.log(
    `  vertices: ${withoutSub} without subdivision → ${withSub} with (${ratio.toFixed(2)}×)`,
  );
}

/** Independent check that the warp puts a known place where it should. */
function sanityCheckGeometry(): void {
  console.log('\n── geometry sanity ──');
  const checks: [string, [number, number]][] = [
    ['null island', [0, 0]],
    ['Zürich', [8.54, 47.38]],
    ['north pole', [0, 90]],
    ['antimeridian @ equator', [180, 0]],
  ];
  for (const [name, lngLat] of checks) {
    const [wx, wy] = geographicToMapWorld(lngLat);
    console.log(`  ${name.padEnd(24)} world = ${wx.toFixed(5)}, ${wy.toFixed(5)}`);
  }
}

/* ------------------------------------------------------------------ --budget */

const BUDGET_LAYERS = ['place', 'water', 'boundary', 'transportation'] as const;

/** Every output tile at `z` inside the Equal Earth rows at blend 0. */
function worldViewTiles(z: number): TileId[] {
  const tiles: TileId[] = [];
  for (let y = 0; y < 2 ** z; y++) {
    for (let x = 0; x < 2 ** z; x++) {
      if (sourceTilesFor({ z, x, y }).length > 0) tiles.push({ z, x, y });
    }
  }
  return tiles;
}

interface BudgetRow {
  offset: number;
  zoom: string;
  tiles: number;
  bytes: number;
  requests: number;
  warpMs: number;
  features: Record<(typeof BUDGET_LAYERS)[number], number>;
}

const tileUrl = (offset: number, { z, x, y }: TileId): string =>
  encodeSourceUrl({
    url: `${TILE_URL}/{z}/{x}/{y}.pbf`,
    blend: 0,
    sourceMaxZoom: 14,
    sourceZoomOffset: offset,
    persistentCache: false,
  })
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));

/** A fresh handler: cold fetch, decode and persistent tiers (no Cache Storage in Node anyway). */
const freshHandler = (fetchImpl: typeof fetch): ProtocolHandler =>
  createEqualEarthProtocol({ fetchImpl, cacheStorage: undefined, version: 'probe' });

async function budgetRun(offset: number, zooms: readonly number[]): Promise<BudgetRow[]> {
  // Pass 1, over the network: what a cold page fetches. The bytes are kept for pass 2.
  const recorded = new Map<string, { status: number; body: ArrayBuffer }>();
  const counts = new Map<number, { bytes: number; requests: number }>();
  let zoomNow = zooms[0]!;
  // The handler always fetches a string URL.
  const networkFetch = (async (url: string, init?: RequestInit) => {
    const response = await fetch(url, init);
    const body = await response.arrayBuffer();
    recorded.set(url, { status: response.status, body });
    const count = counts.get(zoomNow) ?? { bytes: 0, requests: 0 };
    count.bytes += body.byteLength;
    count.requests++;
    counts.set(zoomNow, count);
    // A 204 must not carry a body, not even an empty one.
    return new Response(response.status === 204 ? null : body, { status: response.status });
  }) as unknown as typeof fetch;
  const network = freshHandler(networkFetch);
  for (const z of zooms) {
    zoomNow = z;
    await Promise.all(worldViewTiles(z).map((tile) => network({ url: tileUrl(offset, tile) }, new AbortController())));
  }

  // Pass 2, from memory: decode + warp + encode only, tile after tile.
  const replay = ((url: string) => {
    const hit = recorded.get(url);
    if (!hit) return Promise.reject(new Error(`budget: ${url} was not recorded`));
    const empty = hit.status === 204 || hit.status === 404;
    return Promise.resolve(new Response(empty ? null : hit.body.slice(0), { status: hit.status }));
  }) as unknown as typeof fetch;
  const offline = freshHandler(replay);
  const rows: BudgetRow[] = [];
  for (const z of zooms) {
    const tiles = worldViewTiles(z);
    const features = Object.fromEntries(BUDGET_LAYERS.map((name) => [name, 0])) as BudgetRow['features'];
    let warpMs = 0;
    for (const tile of tiles) {
      const start = performance.now();
      const { data } = await offline({ url: tileUrl(offset, tile) }, new AbortController());
      warpMs += performance.now() - start;
      if (data.byteLength === 0) continue;
      const layers = new VectorTile(new PbfReader(new Uint8Array(data))).layers;
      for (const name of BUDGET_LAYERS) features[name] += layers[name]?.length ?? 0;
    }
    const count = counts.get(z) ?? { bytes: 0, requests: 0 };
    rows.push({ offset, zoom: `z${z}`, tiles: tiles.length, ...count, warpMs, features });
  }
  return rows;
}

function total(rows: readonly BudgetRow[]): BudgetRow {
  const sum = (pick: (row: BudgetRow) => number) => rows.reduce((acc, row) => acc + pick(row), 0);
  return {
    offset: rows[0]!.offset,
    zoom: rows.map((row) => row.zoom).join('+'),
    tiles: sum((row) => row.tiles),
    bytes: sum((row) => row.bytes),
    requests: sum((row) => row.requests),
    warpMs: sum((row) => row.warpMs),
    features: Object.fromEntries(BUDGET_LAYERS.map((name) => [name, sum((row) => row.features[name])])) as BudgetRow['features'],
  };
}

async function budget(): Promise<void> {
  // A 1280×800 world view: z1 shows the whole world, z2 most of it.
  const zooms = [1, 2];
  const table: BudgetRow[] = [];
  for (const offset of [0, -1]) {
    const rows = await budgetRun(offset, zooms);
    table.push(...rows, total(rows));
  }
  // Body bytes after Content-Encoding is undone, not bytes on the wire.
  const header = ['offset', 'zoom', 'tiles', 'upstream kB (decoded)', 'requests', 'warp ms', ...BUDGET_LAYERS];
  console.log(`| ${header.join(' | ')} |`);
  console.log(`|${header.map(() => '---').join('|')}|`);
  for (const row of table) {
    const cells = [
      String(row.offset),
      row.zoom,
      String(row.tiles),
      (row.bytes / 1024).toFixed(0),
      String(row.requests),
      row.warpMs.toFixed(0),
      ...BUDGET_LAYERS.map((name) => String(row.features[name])),
    ];
    console.log(`| ${cells.join(' | ')} |`);
  }
}

if (process.argv.includes('--budget')) {
  await budget();
  console.log('\ndone.');
  process.exit();
}

sanityCheckGeometry();

const outputs: TileId[] = [
  { z: 0, x: 0, y: 0 },
  { z: 1, x: 0, y: 0 },
  { z: 1, x: 1, y: 1 },
  { z: 2, x: 1, y: 1 },
  { z: 2, x: 0, y: 0 }, // expected to be outside the Equal Earth world
  { z: 3, x: 4, y: 3 },
];

for (const output of outputs) {
  try {
    await probeTile(output);
  } catch (error) {
    console.error(`  FAILED: ${String(error)}`);
    process.exitCode = 1;
  }
}

console.log('\ndone.');
