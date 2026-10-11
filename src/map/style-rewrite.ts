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
 * must really hide (`visibility: "none"`), because transparent labels still collide, and so
 * must hillshade and color-relief: a `basic` or `multidirectional` hillshade at exaggeration 0
 * still draws a flat highlight tint (MapLibre 6.6's hillshade shader at zero derivative).
 *
 * Rules, in short:
 * 1. Every vector source with a template gets one source per band with blend < 1.
 * 2. Every layer of such a source gets one copy per band, ranged to the band's parse range
 *    intersected with the layer's own; the Mercator band keeps the original id and source.
 *    Copies with an empty range are dropped.
 * 3. In the initial band a copy keeps the layer's own paint; elsewhere gated opacity is 0 and
 *    symbol, hillshade and color-relief copies are `visibility: "none"`. `gates` records the
 *    own values for the switcher.
 * 4. Raster, hillshade and color-relief layers are kept once, in the Mercator band, or removed
 *    under pure Equal Earth. Layers of other sources are untouched.
 * 5. Cartography (spec §5; `options.cartography`). The style's first background layer `bg` gets
 *    one gated copy per band at its position: bands with blend < 1 paint `outsideColor`
 *    (default transparent) as `<bg.id>__b<k>`, the Mercator band keeps `bg`. Directly above,
 *    each such band gets a `fill` world polygon (source `equal-earth:world__b<k>`) in the
 *    paint of `bg`, so the world keeps the background and only the outside is recoloured.
 *    Without a background layer there is no polygon, and a non-transparent `outsideColor`
 *    becomes a background layer of its own (`equal-earth:background__b<k>`). Opt-in graticule
 *    (every band) and outline (bands with blend < 1) lines go directly before the first symbol
 *    layer. Generated layers are band copies like any other: gated, no zoom range, ids checked.
 */

import { bandIndexForZoom, bandSourceId, parseRange, type Band, type ResolvedTransition } from './bands.js';
import { encodeSourceUrl } from '../tiles/protocol.js';
import {
  CARTOGRAPHY_PREFIX,
  graticule,
  worldOutline,
  worldPolygon,
  type CartographyOptions,
} from './cartography.js';

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

/**
 * The resolved TileJSON of a vector source, and the source fields every band copy inherits.
 *
 * `bounds` is deliberately not carried: it is geographic, and a blended band's source is in
 * map space, so the upstream bounds would cut off tiles that do contain data.
 */
export interface SourceTemplate {
  tiles: string[];
  maxzoom?: number;
  /** Below it MapLibre requests no tiles, as for the upstream source. */
  minzoom?: number;
  /** The upstream credit (a licence requirement for OSM/OpenMapTiles); shown on every band. */
  attribution?: string;
  /** The source's own `promoteId`, so feature state keeps working on every band. */
  promoteId?: unknown;
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
  /** Outside colour, world polygon, outline and graticule (spec §5). */
  cartography?: CartographyOptions;
}

export interface LayerGate {
  /** Id of the rewritten layer (`<id>__b<k>`, or `<id>` in the Mercator band). */
  layerId: string;
  band: number;
  /** The layer's own value of every gated paint property (`undefined` = unset). */
  paint: Readonly<Record<string, unknown>>;
  /** With `hideByVisibility`: the layer's own `layout.visibility` (`undefined` = unset). */
  visibility?: unknown;
  /**
   * Hidden by `visibility: "none"`, not only by its paint: symbol layers (transparent labels
   * still collide), hillshade (no opacity property; see the module comment) and color-relief.
   */
  hideByVisibility: boolean;
  /**
   * A base layer (the background copies and the world polygon, R7): not cross-faded. On a
   * switch the old band's base stays fully shown while the new one fades in, and is hidden
   * (`applyGate(…, 'hidden')`) only once the fade is over. Two half-faded bases would let the
   * container colour through (coverage 1 - 0.5 * 0.5).
   */
  holdWhileFading?: boolean;
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
  /** One per rewritten copy with a gated property or a visibility gate, in output layer order. */
  gates: readonly LayerGate[];
  sourceIdsForBand(band: number): string[];
  gatesForBand(band: number): LayerGate[];
}

export const REWRITTEN_METADATA_KEY = 'equal-earth:rewritten';

/** Paint properties that fade a layer out at 0, per layer type. */
const OPACITY: Record<string, readonly string[]> = {
  fill: ['fill-opacity'],
  line: ['line-opacity'],
  'fill-extrusion': ['fill-extrusion-opacity'],
  circle: ['circle-opacity', 'circle-stroke-opacity'],
  heatmap: ['heatmap-opacity'],
  symbol: ['text-opacity', 'icon-opacity'],
  background: ['background-opacity'],
  raster: ['raster-opacity'],
  hillshade: [],
  'color-relief': ['color-relief-opacity'],
};

/** Layer types hidden by `visibility: "none"` once faded (see the module comment). */
const HIDE_BY_VISIBILITY = new Set(['symbol', 'hillshade', 'color-relief']);

const RELIEF = new Set(['raster', 'hillshade', 'color-relief']);

/**
 * Apply one gate through `setPaintProperty` / `setLayoutProperty`. `shown`: own visibility
 * (gates hidden by visibility) and own paint values, verbatim (`undefined` resets to the
 * default); `fading`: gated paint to 0, visibility untouched (the cross-fade); `hidden`: paint
 * to 0 and, for gates hidden by visibility, `visibility: "none"`. A `holdWhileFading` gate
 * ignores `fading` and stays as it is.
 */
export function applyGate(host: GateHost, gate: LayerGate, phase: GatePhase): void {
  if (phase === 'fading' && gate.holdWhileFading) return;
  if (phase === 'shown') {
    if (gate.hideByVisibility) host.setLayoutProperty(gate.layerId, 'visibility', gate.visibility);
    for (const [name, value] of Object.entries(gate.paint)) {
      host.setPaintProperty(gate.layerId, name, value);
    }
    return;
  }
  for (const name of Object.keys(gate.paint)) host.setPaintProperty(gate.layerId, name, 0);
  if (phase === 'hidden' && gate.hideByVisibility) host.setLayoutProperty(gate.layerId, 'visibility', 'none');
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
  hold = false,
): LayerGate | null {
  const props = OPACITY[layer.type] ?? [];
  const symbol = layer.type === 'symbol';
  const byVisibility = HIDE_BY_VISIBILITY.has(layer.type);
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
  if (byVisibility && band !== initial) copy.layout = { ...copy.layout, visibility: 'none' };
  if (props.length === 0 && !byVisibility) return null;
  return {
    layerId: copy.id,
    band,
    paint: own,
    ...(byVisibility ? { visibility: structuredClone(layer.layout?.['visibility']) } : {}),
    hideByVisibility: byVisibility,
    ...(hold ? { holdWhileFading: true } : {}),
  };
}

/**
 * `original`, ready to be restored over `live` with a diffed `setStyle`.
 *
 * MapLibre's diff turns a changed zoom range into `setLayerZoomRange(id, minzoom, maxzoom)`,
 * which skips an absent bound (`style/style.ts`: `if (minzoom != null)`), so it cannot take a
 * bound away. A layer the rewrite bounded under its own id (the Mercator band keeps the original
 * id, from its parse range up) would keep the band's `minzoom` after the restore, and draw
 * nothing below it. Such a layer gets MapLibre's default bound explicitly, `minzoom: 0` or
 * `maxzoom: 24`, which draws the same as none. Returns `original` itself when no layer needs it.
 */
export function restorableStyle(original: StyleLike, live: StyleLike | undefined): StyleLike {
  if (!live) return original;
  const bounded = new Map(live.layers.map((layer) => [layer.id, layer]));
  const needs = (layer: StyleLayerLike): { min: boolean; max: boolean } => {
    const now = bounded.get(layer.id);
    // A changed type, source or source layer is removed and re-added, not diffed.
    const diffed =
      now !== undefined &&
      now.type === layer.type &&
      now.source === layer.source &&
      now['source-layer'] === layer['source-layer'];
    return {
      min: diffed && layer.minzoom === undefined && now.minzoom !== undefined,
      max: diffed && layer.maxzoom === undefined && now.maxzoom !== undefined,
    };
  };
  if (!original.layers.some((layer) => Object.values(needs(layer)).some(Boolean))) return original;
  return {
    ...original,
    layers: original.layers.map((layer) => {
      const { min, max } = needs(layer);
      if (!min && !max) return layer;
      return { ...layer, ...(min ? { minzoom: 0 } : {}), ...(max ? { maxzoom: 24 } : {}) };
    }),
  };
}

/**
 * The application's style as captured from the map after it was diffed over our rewritten
 * style, without the zoom bounds the diff could not take away.
 *
 * The same `setLayerZoomRange` limit as in {@link restorableStyle}: a layer the Mercator band
 * kept under its own id keeps the band's `minzoom` when the application's new style leaves the
 * bound out. Captured as the new original, that bound would be intersected into every band copy
 * and empty all the bands below it. So a bound is dropped when `rewritten` put it on that id,
 * `original` (the application's style kept until now) had none there, and `captured` carries
 * exactly that value: its presence is our artefact. A bound the new style sets to the same value
 * on purpose is dropped too; it cannot be told apart. Works from what MapLibre serialised, so
 * URL styles are covered. Returns `captured` itself when nothing is dropped.
 */
export function withoutRewriteBounds(
  captured: StyleLike,
  rewritten: StyleLike | undefined,
  original: StyleLike | undefined,
): StyleLike {
  if (!rewritten || !original) return captured;
  const ours = new Map(rewritten.layers.map((layer) => [layer.id, layer]));
  const theirs = new Map(original.layers.map((layer) => [layer.id, layer]));
  const artefacts = (layer: StyleLayerLike): { min: boolean; max: boolean } => {
    const band = ours.get(layer.id);
    const before = theirs.get(layer.id);
    // A changed type, source or source layer was removed and re-added, not diffed.
    const diffed =
      band !== undefined &&
      before !== undefined &&
      band.type === layer.type &&
      band.source === layer.source &&
      band['source-layer'] === layer['source-layer'];
    return {
      min: diffed && before.minzoom === undefined && band.minzoom !== undefined && layer.minzoom === band.minzoom,
      max: diffed && before.maxzoom === undefined && band.maxzoom !== undefined && layer.maxzoom === band.maxzoom,
    };
  };
  if (!captured.layers.some((layer) => Object.values(artefacts(layer)).some(Boolean))) return captured;
  return {
    ...captured,
    layers: captured.layers.map((layer) => {
      const { min, max } = artefacts(layer);
      if (!min && !max) return layer;
      const copy = { ...layer };
      if (min) delete copy.minzoom;
      if (max) delete copy.maxzoom;
      return copy;
    }),
  };
}

interface ResolvedCartography {
  outsideColor: string;
  outline: { color: string; width: number } | null;
  graticule: { step: number; color: string; width: number } | null;
}

function resolveCartography(options: CartographyOptions = {}): ResolvedCartography {
  const outline = options.outline === true ? {} : options.outline;
  const grid = options.graticule === true ? {} : options.graticule;
  return {
    outsideColor: options.outsideColor ?? 'transparent',
    outline: outline ? { color: outline.color ?? '#9a9a9a', width: outline.width ?? 1 } : null,
    graticule: grid
      ? { step: grid.step ?? 30, color: grid.color ?? 'rgba(0,0,0,0.2)', width: grid.width ?? 0.75 }
      : null,
  };
}

interface GeneratedContext {
  original: StyleLike;
  style: StyleLike;
  bands: readonly Band[];
  layerIds: Set<string>;
  /** Gate `copy` as band `band`'s copy of `layer` (see {@link gateCopy}). */
  gate: (copy: StyleLayerLike, layer: StyleLayerLike, band: number, hold?: boolean) => LayerGate | null;
  /** `hold`: a base layer, see `LayerGate.holdWhileFading`. */
  emit: (copy: StyleLayerLike, layer: StyleLayerLike, band: number, hold?: boolean) => void;
}

function claimLayerId(context: GeneratedContext, id: string): string {
  if (context.layerIds.has(id)) throw new TypeError(`rewriteStyle: layer id "${id}" already exists in the style.`);
  context.layerIds.add(id);
  return id;
}

function addGeoJsonSource(context: GeneratedContext, id: string, data: unknown): void {
  if (id in context.original.sources || id in context.style.sources) {
    throw new TypeError(`rewriteStyle: source id "${id}" already exists in the style.`);
  }
  context.style.sources[id] = { type: 'geojson', data, buffer: 0, tolerance: 0 };
}

/** Without a background layer: the outside colour as a background layer of its own, at the bottom. */
function emitOutsideBackground(context: GeneratedContext, color: string): void {
  context.bands.forEach((band, k) => {
    if (band.blend >= 1) return;
    const id = claimLayerId(context, `${CARTOGRAPHY_PREFIX}background__b${k}`);
    const layer: StyleLayerLike = { id, type: 'background', paint: { 'background-color': color } };
    context.emit(structuredClone(layer), layer, k, true);
  });
}

/** Rule 5: the background copies, then each Equal Earth band's world polygon. */
function emitBackground(context: GeneratedContext, bg: StyleLayerLike, outsideColor: string): void {
  const { bands } = context;
  bands.forEach((band, k) => {
    const copy = structuredClone(bg);
    if (band.blend < 1) {
      copy.id = claimLayerId(context, `${bg.id}__b${k}`);
      copy.paint = { ...copy.paint, 'background-color': outsideColor };
      delete copy.paint['background-pattern'];
    }
    context.emit(copy, bg, k, true);
  });
  bands.forEach((band, k) => {
    if (band.blend >= 1) return;
    const id = `${CARTOGRAPHY_PREFIX}world__b${k}`;
    addGeoJsonSource(context, id, worldPolygon(band.blend));
    const paint: Record<string, unknown> = {};
    for (const [from, to] of [
      ['background-color', 'fill-color'],
      ['background-opacity', 'fill-opacity'],
      ['background-pattern', 'fill-pattern'],
    ] as const) {
      if (bg.paint?.[from] !== undefined) paint[to] = structuredClone(bg.paint[from]);
    }
    paint['fill-antialias'] = false;
    const layer: StyleLayerLike = { id: claimLayerId(context, id), type: 'fill', source: id, paint };
    context.emit(structuredClone(layer), layer, k, true);
  });
}

/**
 * Rule 5: graticule (every band), then outline (bands with blend < 1), spliced in directly
 * before the first symbol layer of `layers` (at the end without one).
 */
function emitLines(
  context: GeneratedContext,
  layers: StyleLayerLike[],
  gates: LayerGate[],
  cartography: ResolvedCartography,
): void {
  const { graticule: grid, outline } = cartography;
  if (!grid && !outline) return;
  const lines: StyleLayerLike[] = [];
  const lineGates: LayerGate[] = [];
  const emitLine = (name: string, k: number, data: unknown, color: string, width: number): void => {
    const id = `${CARTOGRAPHY_PREFIX}${name}__b${k}`;
    addGeoJsonSource(context, id, data);
    const layer: StyleLayerLike = {
      id: claimLayerId(context, id),
      type: 'line',
      source: id,
      layout: { 'line-cap': 'round' },
      paint: { 'line-color': color, 'line-width': width },
    };
    const copy = structuredClone(layer);
    const gate = context.gate(copy, layer, k);
    if (gate) lineGates.push(gate);
    lines.push(copy);
  };
  const { bands } = context;
  if (grid) bands.forEach((band, k) => emitLine('graticule', k, graticule(band.blend, grid.step), grid.color, grid.width));
  if (outline) {
    bands.forEach((band, k) => {
      if (band.blend < 1) emitLine('outline', k, worldOutline(band.blend), outline.color, outline.width);
    });
  }
  const at = layers.findIndex((l) => l.type === 'symbol');
  const gateAt = at < 0 ? -1 : gates.findIndex((g) => g.layerId === layers[at]!.id);
  layers.splice(at < 0 ? layers.length : at, 0, ...lines);
  gates.splice(gateAt < 0 ? gates.length : gateAt, 0, ...lineGates);
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
        ...(template.minzoom === undefined ? {} : { minzoom: template.minzoom }),
        ...(template.attribution === undefined ? {} : { attribution: template.attribution }),
        ...(template.promoteId === undefined ? {} : { promoteId: structuredClone(template.promoteId) }),
      };
    }
  }

  const removedLayers: string[] = [];
  const layers: StyleLayerLike[] = [];
  const gates: LayerGate[] = [];

  const gate = (copy: StyleLayerLike, layer: StyleLayerLike, band: number, hold = false): LayerGate | null =>
    gateCopy(copy, layer, band, initial, fadeMs, symbolFadeMs, hold);
  const emit = (copy: StyleLayerLike, layer: StyleLayerLike, band: number, hold = false): void => {
    const g = gate(copy, layer, band, hold);
    if (g) gates.push(g);
    layers.push(copy);
  };

  const cartography = resolveCartography(options.cartography);
  const generated: GeneratedContext = { original, style, bands, layerIds, gate, emit };
  const firstBackground = original.layers.find((l) => l.type === 'background');
  if (firstBackground === undefined && cartography.outsideColor !== 'transparent') {
    emitOutsideBackground(generated, cartography.outsideColor);
  }

  for (const layer of original.layers) {
    if (layer === firstBackground) {
      emitBackground(generated, layer, cartography.outsideColor);
      continue;
    }
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
  emitLines(generated, layers, gates, cartography);
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
