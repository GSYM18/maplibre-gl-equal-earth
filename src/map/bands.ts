/**
 * Zoom bands: the unit the adaptive `equal` projection is built from.
 *
 * A band is a zoom range drawn with one fixed blend between Equal Earth (0) and Web
 * Mercator (1). Band `i` covers `[bands[i].minZoom, bands[i + 1].minZoom)`; the first band
 * also covers every zoom below its own `minZoom`, and the last extends upward without end.
 *
 * Tiles are warped per band and MapLibre draws tiles per integer zoom, so a blend varying
 * continuously with zoom is not achievable with backprojection — the design spec (§2–§4)
 * measures what a hard switch would cost and why three steps were chosen instead.
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
