/**
 * Zoom bands: the unit the adaptive `equal` projection is built from.
 *
 * A band is a zoom range drawn with one fixed blend between Equal Earth (0) and Web
 * Mercator (1). Band `i` covers `[bands[i].minZoom, bands[i + 1].minZoom)`; the first band
 * also covers every zoom below its own `minZoom`, and the last extends upward without end.
 *
 * Tiles are warped per band and MapLibre draws tiles per integer zoom, so a blend varying
 * continuously with zoom is not achievable with backprojection. The step layout and its
 * costs are in the design spec, §3 (the transition table).
 */

export interface Band {
  /** Lowest zoom of the band. Only the first band may use `-Infinity`. */
  readonly minZoom: number;
  /** 0 = Equal Earth, 1 = Web Mercator. */
  readonly blend: number;
}

/** Throw a `TypeError` describing the first thing wrong with `bands`. */
export function validateBands(bands: readonly Band[]): void {
  const list: unknown = bands;
  if (!Array.isArray(list) || list.length === 0) {
    throw new TypeError('Equal Earth bands must be a non-empty array.');
  }
  for (let i = 0; i < bands.length; i++) {
    const { minZoom, blend } = bands[i]!;
    if (typeof blend !== 'number' || !(blend >= 0 && blend <= 1)) {
      throw new TypeError(`Band ${i} has blend ${String(blend)}; expected a number in [0, 1].`);
    }
    const validZoom =
      typeof minZoom === 'number' && (i === 0 ? !Number.isNaN(minZoom) : Number.isFinite(minZoom));
    if (!validZoom) {
      throw new TypeError(`Band ${i} has minZoom ${String(minZoom)}; expected a finite number.`);
    }
    if (i > 0 && !(minZoom > bands[i - 1]!.minZoom)) {
      throw new TypeError(
        `Band ${i} minZoom ${minZoom} must exceed band ${i - 1}'s ${bands[i - 1]!.minZoom}.`,
      );
    }
  }
}

/**
 * Index of the band a zoom falls in. A zoom exactly on a boundary belongs to the upper band.
 * `bands` must already be valid; a NaN zoom lands in the first band.
 */
export function bandIndexForZoom(bands: readonly Band[], zoom: number): number {
  for (let i = bands.length - 1; i > 0; i--) {
    if (zoom >= bands[i]!.minZoom) return i;
  }
  return 0;
}

/** The adaptive `equal` transition, as the user configures it (spec §3). */
export interface Transition {
  /** Zoom of the first step. @defaultValue 4 */
  from?: number;
  /** Zoom from which plain Mercator is drawn. @defaultValue 8 */
  to?: number;
  /** Number of steps, i.e. boundaries, including the one into Mercator. @defaultValue 6 */
  steps?: number;
}

export interface ResolvedTransition {
  readonly from: number;
  readonly to: number;
  readonly steps: number;
  /** Zoom between consecutive boundaries: `(to − from) / (steps − 1)`. */
  readonly spacing: number;
  /** Band 0 is Equal Earth from `−Infinity`; band `steps` is Mercator from `to`. */
  readonly bands: readonly Band[];
}

/** Pure Equal Earth at every zoom. */
export const EQUAL_EARTH_BANDS: readonly Band[] = [{ minZoom: -Infinity, blend: 0 }];

/**
 * Lay out the bands of a transition. Boundary `k` (1-based) sits at `from + (k − 1)·spacing`
 * and starts the band drawn at blend `k / steps`, so the last boundary, at `to`, starts the
 * Mercator band.
 */
export function resolveTransition(options: Transition = {}): ResolvedTransition {
  const from = options.from ?? 4;
  const to = options.to ?? 8;
  const steps = options.steps ?? 6;
  if (!Number.isFinite(from) || !Number.isFinite(to) || !(from < to)) {
    throw new TypeError(
      `Equal Earth transition needs finite from < to; received ${String(from)} and ${String(to)}.`,
    );
  }
  if (!Number.isInteger(steps) || steps < 2) {
    throw new TypeError(
      `Equal Earth transition needs an integer steps >= 2; received ${String(steps)}.`,
    );
  }
  const spacing = (to - from) / (steps - 1);
  const bands: Band[] = [{ minZoom: -Infinity, blend: 0 }];
  for (let k = 1; k <= steps; k++) {
    // The last boundary is `to` exactly, not `from + (steps − 1) · spacing`, which can differ
    // in the last bit and would put a zoom of exactly `to` in the wrong band.
    bands.push({ minZoom: k === steps ? to : from + (k - 1) * spacing, blend: k / steps });
  }
  validateBands(bands);
  return { from, to, steps, spacing, bands };
}

/**
 * The blend a per-vertex renderer would use at `zoom`: linear through the band midpoints,
 * 0 below `from − spacing/2`, 1 above `to + spacing/2`. The camera compensation steers the
 * rotation and scale at the centre towards this (spec §4.2).
 */
export function continuousBlend(transition: ResolvedTransition, zoom: number): number {
  const { from, spacing, steps } = transition;
  const raw = (zoom - from) / spacing + 0.5;
  return Math.min(steps, Math.max(0, raw)) / steps;
}

/**
 * Zoom range over which band `band`'s layers are parsed: the band widened by one spacing on
 * each side. A band may be shown anywhere inside it (spec §3 "parse early, show late").
 */
export function parseRange(transition: ResolvedTransition, band: number): [lo: number, hi: number] {
  const { bands, spacing } = transition;
  const lo = band === 0 ? -Infinity : bands[band]!.minZoom - spacing;
  const next = bands[band + 1];
  const hi = next === undefined ? Infinity : next.minZoom + spacing;
  return [lo, hi];
}

/**
 * `bandIndexForZoom`, except that a zoom less than `hysteresis` below the boundary of the
 * `previous` band stays in it. Crossing upward switches at the boundary; crossing back
 * switches only `hysteresis` lower, so a zoom hovering at a boundary does not flip.
 */
export function bandIndexWithHysteresis(
  bands: readonly Band[],
  zoom: number,
  previous: number,
  hysteresis: number,
): number {
  const target = bandIndexForZoom(bands, zoom);
  if (target === previous - 1 && zoom >= bands[previous]!.minZoom - hysteresis) return previous;
  return target;
}

/**
 * The application's layer id behind a rendered layer id: a band copy `<id>__b<k>` names `<id>`,
 * any other id names itself. For comparing `feature.layer.id` from `queryRenderedFeatures` or a
 * layer listener against your own ids without depending on the copies' naming.
 */
export function originalLayerId(id: string): string {
  return id.replace(/__b\d+$/, '');
}

/** Source id for band `band` of source `sourceId`: the original for Mercator, a suffix otherwise. */
export function bandSourceId(sourceId: string, bands: readonly Band[], band: number): string {
  return bands[band]!.blend === 1 ? sourceId : `${sourceId}__b${band}`;
}
