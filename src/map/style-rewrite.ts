/**
 * Rewrite a style into its banded form (spec §3).
 *
 * Pure: a function of the original style, the bands and the resolved tile templates. The
 * controller applies the result with `setStyle(…, { diff: true })` and restores the original.
 *
 * Two facts drive the shape of the output. MapLibre draws placeholder tiles from other zooms
 * of the *same* source only, so every band needs its own source. And the worker parses a
 * layer into a tile only when `floor(minzoom) <= z < maxzoom`, so a copy's zoom range is the
 * range over which it is *parsed* (the band widened by one spacing), and whether it is *shown*
 * is global state flipped at runtime by the switcher (`eqe-show-<k>` for paint, `eqe-sym-<k>`
 * for symbol visibility — transparent labels would still collide, so they must really hide).
 *
 * Rules, in short:
 * 1. Every vector source with a template gets one source per band with blend < 1.
 * 2. Every layer of such a source gets one copy per band, ranged to the band's parse range
 *    intersected with the layer's own; the Mercator band keeps the original id and source.
 * 3. Paint opacity is gated by `["global-state", "eqe-show-<k>"]`, symbol visibility by
 *    `eqe-sym-<k>`. Zoom stays at the top level of every curve.
 * 4. Raster and hillshade layers are kept once, in the Mercator band, or removed under pure
 *    Equal Earth. Background and layers of other sources are untouched.
 */

import { bandIndexForZoom, bandSourceId, parseRange, type Band, type ResolvedTransition } from './bands.js';
import { encodeSourceUrl } from '../tiles/protocol.js';

export interface StyleLayerLike {
  id: string;
  type: string;
  source?: string;
  'source-layer'?: string;
  minzoom?: number;
  maxzoom?: number;
  layout?: Record<string, unknown>;
  paint?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface StyleLike {
  version: number;
  sources: Record<string, Record<string, unknown>>;
  layers: StyleLayerLike[];
  state?: Record<string, { default: unknown }>;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

/** The resolved TileJSON of a vector source. */
export interface SourceTemplate {
  tiles: string[];
  maxzoom?: number;
}

export interface RewriteOptions {
  bands: readonly Band[];
  transition: ResolvedTransition | null;
  templates: Record<string, SourceTemplate>;
  initialZoom: number;
  /** @defaultValue 250 */
  fadeMs?: number;
  /** @defaultValue 300 */
  symbolFadeMs?: number;
}

export interface RewrittenStyle {
  style: StyleLike;
  bandedSources: string[];
  /** Ids of raster/hillshade layers dropped because there is no Mercator band. */
  removedLayers: string[];
  sourceIdsForBand(band: number): string[];
}

export const REWRITTEN_METADATA_KEY = 'equal-earth:rewritten';
export const showKey = (band: number): string => `eqe-show-${band}`;
export const symKey = (band: number): string => `eqe-sym-${band}`;

/** Paint properties that hide a layer at 0, per layer type. */
const OPACITY: Record<string, readonly string[]> = {
  fill: ['fill-opacity'],
  line: ['line-opacity'],
  'fill-extrusion': ['fill-extrusion-opacity'],
  circle: ['circle-opacity', 'circle-stroke-opacity'],
  heatmap: ['heatmap-opacity'],
  symbol: ['text-opacity', 'icon-opacity'],
  raster: ['raster-opacity'],
  hillshade: ['hillshade-exaggeration'],
};

type Stop = [number, unknown];

const isZoomCurve = (value: unknown, head: string, zoomAt: number): value is unknown[] =>
  Array.isArray(value) && value[0] === head && JSON.stringify(value[zoomAt]) === '["zoom"]';

/**
 * Make `value` (a paint property) evaluate to 0 unless global state `key` is truthy. A zoom
 * curve keeps `["zoom"]` at the top level (MapLibre requires it), so the gate wraps each
 * stop output instead of the whole expression.
 */
export function gateByState(value: unknown, key: string): unknown {
  const on = (v: unknown): unknown => ['case', ['global-state', key], v, 0];
  if (value === undefined) return on(1);
  if (isZoomCurve(value, 'interpolate', 2)) {
    return value.map((v, i) => (i >= 4 && i % 2 === 0 ? on(v) : v));
  }
  if (isZoomCurve(value, 'step', 1)) {
    return value.map((v, i) => (i >= 2 && i % 2 === 0 ? on(v) : v));
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && 'stops' in value) {
    const legacy = value as { stops: Stop[]; base?: number; type?: string };
    if (legacy.type && legacy.type !== 'exponential' && legacy.type !== 'interval') return value;
    if (legacy.type === 'interval') {
      const [first, ...rest] = legacy.stops;
      return ['step', ['zoom'], on(first![1]), ...rest.flatMap(([z, v]) => [z, on(v)])];
    }
    return [
      'interpolate',
      ['exponential', legacy.base ?? 1],
      ['zoom'],
      ...legacy.stops.flatMap(([z, v]) => [z, on(v)]),
    ];
  }
  return on(value);
}

function gatePaint(layer: StyleLayerLike, key: string, ms: number): void {
  const paint = (layer.paint ??= {});
  for (const prop of OPACITY[layer.type] ?? []) {
    paint[prop] = gateByState(paint[prop], key);
    const transition = `${prop}-transition`;
    if (paint[transition] === undefined) paint[transition] = { duration: ms, delay: 0 };
  }
}

/** Write a zoom bound when finite; an infinite one leaves the layer's own bound (or none). */
function setBound(layer: StyleLayerLike, prop: 'minzoom' | 'maxzoom', value: number): void {
  if (Number.isFinite(value)) layer[prop] = value;
}

export function rewriteStyle(original: StyleLike, options: RewriteOptions): RewrittenStyle {
  const { bands, transition, templates } = options;
  const fadeMs = options.fadeMs ?? 250;
  const symbolFadeMs = options.symbolFadeMs ?? 300;
  const steps = bands.length - 1;
  const style = structuredClone(original);

  const bandedSources = Object.keys(templates).filter(
    (id) => original.sources[id]?.['type'] === 'vector',
  );
  const banded = new Set(bandedSources);

  for (const id of bandedSources) {
    const template = templates[id]!;
    for (let k = 0; k < bands.length; k++) {
      const { blend } = bands[k]!;
      if (blend >= 1) continue;
      style.sources[bandSourceId(id, bands, k)] = {
        type: 'vector',
        tiles: [
          encodeSourceUrl({
            url: template.tiles[0]!,
            blend,
            ...(template.maxzoom === undefined ? {} : { sourceMaxZoom: template.maxzoom }),
          }),
        ],
        ...(template.maxzoom === undefined ? {} : { maxzoom: template.maxzoom }),
      };
    }
  }

  const removedLayers: string[] = [];
  const layers: StyleLayerLike[] = [];

  for (const layer of original.layers) {
    if (layer.type === 'raster' || layer.type === 'hillshade') {
      if (transition === null) {
        removedLayers.push(layer.id);
        continue;
      }
      const copy = structuredClone(layer);
      copy.minzoom = Math.max(layer.minzoom ?? 0, parseRange(transition, steps)[0]);
      gatePaint(copy, showKey(steps), fadeMs);
      layers.push(copy);
      continue;
    }
    if (!OPACITY[layer.type] || layer.source === undefined || !banded.has(layer.source)) {
      layers.push(structuredClone(layer));
      continue;
    }

    for (let k = 0; k < bands.length; k++) {
      const [pLo, pHi] = transition ? parseRange(transition, k) : [-Infinity, Infinity];
      const lo = Math.max(pLo, layer.minzoom ?? -Infinity);
      const hi = Math.min(pHi, layer.maxzoom ?? Infinity);
      // Emptiness is judged against MapLibre's own default range, 0 to 24.
      if (!(Math.max(lo, 0) < Math.min(hi, 24))) continue;

      const copy = structuredClone(layer);
      if (bands[k]!.blend < 1) {
        copy.id = `${layer.id}__b${k}`;
        copy.source = bandSourceId(layer.source, bands, k);
      }
      setBound(copy, 'minzoom', lo);
      setBound(copy, 'maxzoom', hi);
      gatePaint(copy, showKey(k), layer.type === 'symbol' ? symbolFadeMs : fadeMs);
      if (layer.type === 'symbol' && copy.layout?.['visibility'] !== 'none') {
        copy.layout = {
          ...copy.layout,
          visibility: ['case', ['global-state', symKey(k)], 'visible', 'none'],
        };
      }
      layers.push(copy);
    }
  }
  style.layers = layers;

  const initial = bandIndexForZoom(bands, options.initialZoom);
  const state: Record<string, { default: unknown }> = { ...original.state };
  for (let k = 0; k < bands.length; k++) {
    state[showKey(k)] = { default: k === initial };
    state[symKey(k)] = { default: k === initial };
  }
  style.state = state;
  style.metadata = {
    ...original.metadata,
    [REWRITTEN_METADATA_KEY]: { bands: bands.map((b) => b.blend), sources: bandedSources },
  };

  return {
    style,
    bandedSources,
    removedLayers,
    sourceIdsForBand: (band) => bandedSources.map((id) => bandSourceId(id, bands, band)),
  };
}
