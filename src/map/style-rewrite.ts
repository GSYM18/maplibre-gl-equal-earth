/**
 * Rewrite a style into its banded form (spec §3).
 *
 * Pure: a function of the original style, the bands and the resolved tile templates. The
 * controller applies the result with `setStyle(…, { diff: true })` and restores the original.
 *
 * Two facts drive the shape of the output. MapLibre draws placeholder tiles from other zooms
 * of the *same* source only, so every band needs its own source. And the worker parses a
 * layer into a tile only when `floor(minzoom) <= z < maxzoom`, so a copy's zoom range is the
 * range over which it is *parsed* (the band widened by one spacing). Whether a copy is *shown*
 * is a runtime paint value, not an expression: the switcher sets each gated opacity property
 * to the layer's own value or to 0 through `setPaintProperty`, which does cross-fade through
 * the `*-transition` we add. A `global-state` expression would not: the transition's prior
 * value re-evaluates against the same live state, so the switch would be instant. Symbols
 * must really hide (`visibility: "none"`), because transparent labels still collide.
 *
 * Rules, in short:
 * 1. Every vector source with a template gets one source per band with blend < 1.
 * 2. Every layer of such a source gets one copy per band, ranged to the band's parse range
 *    intersected with the layer's own; the Mercator band keeps the original id and source.
 *    Copies with an empty range are dropped.
 * 3. In the initial band a copy keeps the layer's own paint; elsewhere gated opacity is 0 and
 *    symbols are `visibility: "none"`. `gates` records the own values for the switcher.
 * 4. Raster, hillshade and color-relief layers are kept once, in the Mercator band, or removed
 *    under pure Equal Earth. Background and layers of other sources are untouched.
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
  state?: Record<string, { default?: unknown }>;
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

export interface LayerGate {
  /** Id of the rewritten layer (`<id>__b<k>`, or `<id>` in the Mercator band). */
  layerId: string;
  band: number;
  /** The layer's own value of every gated paint property (`undefined` = unset). */
  paint: Readonly<Record<string, unknown>>;
  /** Symbol layers only: the layer's own `layout.visibility` (`undefined` = unset). */
  visibility?: unknown;
  symbol: boolean;
}

export type GatePhase = 'shown' | 'fading' | 'hidden';

export interface GateHost {
  setPaintProperty(layerId: string, name: string, value: unknown): unknown;
  setLayoutProperty(layerId: string, name: string, value: unknown): unknown;
}

export interface RewrittenStyle {
  style: StyleLike;
  bandedSources: string[];
  /**
   * Ids of layers that ended with no copy: relief layers when there is no Mercator band (or
   * their own zoom range never reaches it) and vector layers whose range reaches no band.
   */
  removedLayers: string[];
  /** One per rewritten copy with a gated property or a symbol, in output layer order. */
  gates: readonly LayerGate[];
  sourceIdsForBand(band: number): string[];
  gatesForBand(band: number): LayerGate[];
}

export const REWRITTEN_METADATA_KEY = 'equal-earth:rewritten';

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
  'color-relief': ['color-relief-opacity'],
};

const RELIEF = new Set(['raster', 'hillshade', 'color-relief']);

/**
 * Apply one gate through `setPaintProperty` / `setLayoutProperty`. `shown`: own visibility
 * (symbols) and own paint values, verbatim (`undefined` resets to the default); `fading`:
 * gated paint to 0, visibility untouched (the cross-fade); `hidden`: paint to 0 and, for
 * symbols, `visibility: "none"`.
 */
export function applyGate(host: GateHost, gate: LayerGate, phase: GatePhase): void {
  if (phase === 'shown') {
    if (gate.symbol) host.setLayoutProperty(gate.layerId, 'visibility', gate.visibility);
    for (const [name, value] of Object.entries(gate.paint)) {
      host.setPaintProperty(gate.layerId, name, value);
    }
    return;
  }
  for (const name of Object.keys(gate.paint)) host.setPaintProperty(gate.layerId, name, 0);
  if (phase === 'hidden' && gate.symbol) host.setLayoutProperty(gate.layerId, 'visibility', 'none');
}

/**
 * Turn `copy` (a clone of `layer`) into band `band`'s copy: hide it unless it is in the
 * initial band, add the fade transitions and describe it as a gate.
 */
function gateCopy(
  copy: StyleLayerLike,
  layer: StyleLayerLike,
  band: number,
  initial: number,
  fadeMs: number,
  symbolFadeMs: number,
): LayerGate | null {
  const props = OPACITY[layer.type] ?? [];
  const symbol = layer.type === 'symbol';
  const own: Record<string, unknown> = {};
  const paint = (copy.paint ??= {});
  for (const prop of props) {
    own[prop] = structuredClone(layer.paint?.[prop]);
    if (band !== initial) paint[prop] = 0;
    const transition = `${prop}-transition`;
    if (paint[transition] === undefined) {
      paint[transition] = { duration: symbol ? symbolFadeMs : fadeMs, delay: 0 };
    }
  }
  if (symbol && band !== initial) copy.layout = { ...copy.layout, visibility: 'none' };
  if (props.length === 0 && !symbol) return null;
  return {
    layerId: copy.id,
    band,
    paint: own,
    ...(symbol ? { visibility: structuredClone(layer.layout?.['visibility']) } : {}),
    symbol,
  };
}

export function rewriteStyle(original: StyleLike, options: RewriteOptions): RewrittenStyle {
  const { bands, transition, templates } = options;
  if (original.metadata?.[REWRITTEN_METADATA_KEY]) {
    throw new TypeError('rewriteStyle: style is already rewritten');
  }
  if (
    transition !== null &&
    (bands.length !== transition.bands.length ||
      bands.some((b, i) => b.blend !== transition.bands[i]!.blend))
  ) {
    throw new TypeError('rewriteStyle: options.bands does not match transition.bands');
  }
  const fadeMs = options.fadeMs ?? 250;
  const symbolFadeMs = options.symbolFadeMs ?? 300;
  const steps = bands.length - 1;
  const initial = bandIndexForZoom(bands, options.initialZoom);
  const style = structuredClone(original);

  const bandedSources = Object.keys(templates).filter(
    (id) => original.sources[id]?.['type'] === 'vector',
  );
  const banded = new Set(bandedSources);
  const layerIds = new Set(original.layers.map((l) => l.id));

  for (const id of bandedSources) {
    const template = templates[id]!;
    if (template.tiles.length === 0) {
      throw new TypeError(`rewriteStyle: the template for source "${id}" has no tiles.`);
    }
    for (let k = 0; k < bands.length; k++) {
      const { blend } = bands[k]!;
      if (blend >= 1) continue;
      const bandId = bandSourceId(id, bands, k);
      if (bandId in original.sources) {
        throw new TypeError(`rewriteStyle: source id "${bandId}" already exists in the style.`);
      }
      style.sources[bandId] = {
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
  const gates: LayerGate[] = [];

  const emit = (copy: StyleLayerLike, layer: StyleLayerLike, band: number): void => {
    const gate = gateCopy(copy, layer, band, initial, fadeMs, symbolFadeMs);
    if (gate) gates.push(gate);
    layers.push(copy);
  };

  for (const layer of original.layers) {
    if (RELIEF.has(layer.type)) {
      const lo = transition ? Math.max(layer.minzoom ?? 0, parseRange(transition, steps)[0]) : Infinity;
      if (transition === null || !(lo < (layer.maxzoom ?? 24))) {
        removedLayers.push(layer.id);
        continue;
      }
      const copy = structuredClone(layer);
      copy.minzoom = lo;
      emit(copy, layer, steps);
      continue;
    }
    if (!OPACITY[layer.type] || layer.source === undefined || !banded.has(layer.source)) {
      layers.push(structuredClone(layer));
      continue;
    }

    let copies = 0;
    for (let k = 0; k < bands.length; k++) {
      const [pLo, pHi] = transition ? parseRange(transition, k) : [-Infinity, Infinity];
      const lo = Math.max(pLo, layer.minzoom ?? -Infinity);
      const hi = Math.min(pHi, layer.maxzoom ?? Infinity);
      // Emptiness is judged against MapLibre's own default range, 0 to 24.
      if (!(Math.max(lo, 0) < Math.min(hi, 24))) continue;

      const copy = structuredClone(layer);
      if (bands[k]!.blend < 1) {
        copy.id = `${layer.id}__b${k}`;
        if (layerIds.has(copy.id)) {
          throw new TypeError(`rewriteStyle: layer id "${copy.id}" already exists in the style.`);
        }
        copy.source = bandSourceId(layer.source, bands, k);
      }
      // Bounds are clamped to MapLibre's 0 to 24; the layer's own bound (or none) stays otherwise.
      if (lo > 0) copy.minzoom = lo;
      if (hi < 24) copy.maxzoom = hi;
      emit(copy, layer, k);
      copies++;
    }
    if (copies === 0) removedLayers.push(layer.id);
  }
  style.layers = layers;
  style.metadata = {
    ...structuredClone(original.metadata),
    [REWRITTEN_METADATA_KEY]: { bands: bands.map((b) => b.blend), sources: [...bandedSources] },
  };

  return {
    style,
    bandedSources: [...bandedSources],
    removedLayers,
    gates,
    sourceIdsForBand: (band) => bandedSources.map((id) => bandSourceId(id, bands, band)),
    gatesForBand: (band) => gates.filter((g) => g.band === band),
  };
}
