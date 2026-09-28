/**
 * Camera continuity across the Equal Earth ↔ Mercator zoom threshold.
 *
 * An adaptive Equal Earth map shows warped ("map space") coordinates below a switch zoom
 * and true geographic coordinates at or above it. The camera centre therefore means two
 * different things on either side of the threshold, and must be converted whenever the
 * camera crosses it — otherwise the view jumps.
 */

import { geographicToMap, mapToGeographic } from '../math/backproject.js';
import type { LngLatTuple } from '../math/equal-earth.js';

/**
 * The subset of `maplibre-gl`'s camera-update payload we care about.
 *
 * Declared structurally rather than imported so this module stays testable without a
 * WebGL context, and so the plugin does not break if MapLibre adds fields.
 */
export interface CameraUpdate {
  center: { lng: number; lat: number };
  zoom: number;
  [key: string]: unknown;
}

export type CameraUpdateResult = {
  center?: { lng: number; lat: number };
  [key: string]: unknown;
};

export type CameraUpdateFn = (next: CameraUpdate) => CameraUpdateResult;

/** Minimal structural view of the bits of `Map` this class touches. */
export interface CameraHost {
  getZoom(): number;
  transformCameraUpdate: CameraUpdateFn | null | undefined;
}

/** Constructs whatever `LngLat`-ish object the host expects. */
export type LngLatFactory = (lng: number, lat: number) => { lng: number; lat: number };

const defaultLngLatFactory: LngLatFactory = (lng, lat) => ({ lng, lat });

export interface ThresholdCameraOptions {
  /**
   * Zoom at which the map stops using Equal Earth and switches to plain Mercator tiles.
   * Below this the camera centre is in map space; at or above it, in geographic space.
   */
  switchZoom: number;
  /** Builds the center object handed back to MapLibre. Pass `maplibregl.LngLat`. */
  lngLatFactory?: LngLatFactory;
  /** Called when a conversion produces a non-finite coordinate. Defaults to a console warning. */
  onConversionFailure?: (reason: string, input: LngLatTuple) => void;
}

/**
 * Installs a `transformCameraUpdate` hook that converts the camera centre exactly once
 * per threshold crossing.
 *
 * Two bugs in the original implementation motivate the design here, and both are covered
 * by tests in `tests/camera.test.ts`:
 *
 * 1. **Edge-triggered, not level-triggered.** The original compared `next.zoom` against a
 *    `_zoomstart` captured on `movestart`, which stays frozen for the whole gesture. The
 *    predicate "started below, now above" therefore remained true for *every remaining
 *    frame*, re-converting an already-converted centre once per frame. For handler-driven
 *    gestures MapLibre feeds the returned centre back in as the next frame's baseline, so
 *    the error compounded and the camera accelerated away from the pointer. We instead
 *    compare against the zoom seen on the *previous camera update*, so a crossing fires once.
 *
 * 2. **Initialised in the constructor.** `_zoomstart` was only ever assigned in an event
 *    handler, so it was `undefined` until the user's first interaction — and `undefined`
 *    fails *both* `<` and `>=` comparisons, so an initial `flyTo`/`jumpTo` across the
 *    threshold was silently left unconverted, with no error.
 *
 * A consequence of (1) is that no `movestart`/`moveend` listeners are needed at all, which
 * removes the leak the original had (inline arrow handlers that could never be removed).
 */
export class ThresholdCamera {
  readonly #host: CameraHost;
  readonly #switchZoom: number;
  readonly #lngLatFactory: LngLatFactory;
  readonly #onConversionFailure: (reason: string, input: LngLatTuple) => void;

  /** Zoom observed on the previous camera update. Seeded from the live camera. */
  #lastZoom: number;
  /** The host's own hook, chained rather than clobbered. */
  #previousHook: CameraUpdateFn | null | undefined;
  #installed = false;

  constructor(host: CameraHost, options: ThresholdCameraOptions) {
    if (!host || typeof host.getZoom !== 'function') {
      throw new TypeError('ThresholdCamera requires a map-like host exposing getZoom().');
    }
    if (!Number.isFinite(options.switchZoom)) {
      throw new TypeError(
        `ThresholdCamera requires a finite switchZoom, received ${String(options.switchZoom)}.`,
      );
    }

    this.#host = host;
    this.#switchZoom = options.switchZoom;
    this.#lngLatFactory = options.lngLatFactory ?? defaultLngLatFactory;
    this.#onConversionFailure =
      options.onConversionFailure ??
      ((reason, input) => {
        console.warn(
          `[equal-earth] Skipped camera conversion (${reason}) for [${input[0]}, ${input[1]}]. ` +
            'The camera centre may be in the wrong coordinate space.',
        );
      });

    // Seed from the live camera so the very first update is evaluated against a real
    // zoom rather than `undefined`.
    this.#lastZoom = host.getZoom();

    this.#previousHook = host.transformCameraUpdate;
    host.transformCameraUpdate = this.handleCameraUpdate;
    this.#installed = true;
  }

  /** True while the camera is below the switch zoom, i.e. rendering Equal Earth. */
  get isEqualEarthActive(): boolean {
    return this.#lastZoom < this.#switchZoom;
  }

  get switchZoom(): number {
    return this.#switchZoom;
  }

  /**
   * Bound so it can be assigned to and compared against `map.transformCameraUpdate`
   * without a wrapper closure.
   */
  readonly handleCameraUpdate: CameraUpdateFn = (next) => {
    // Chain to whatever the host had installed, so we cooperate with bbox constraints,
    // map synchronisation, and anything else the application relies on.
    const upstream = this.#previousHook ? this.#previousHook(next) : {};
    const center = upstream.center ?? next.center;
    const upstreamZoom = upstream['zoom'];
    const zoom = typeof upstreamZoom === 'number' ? upstreamZoom : next.zoom;

    const previousZoom = this.#lastZoom;
    this.#lastZoom = zoom;

    const wasBelow = previousZoom < this.#switchZoom;
    const isBelow = zoom < this.#switchZoom;

    if (wasBelow === isBelow) {
      // No crossing on this update. Critically, this is the common case during a gesture
      // that has already crossed — the original code re-converted here every frame.
      return upstream;
    }

    const source: LngLatTuple = [center.lng, center.lat];
    // Crossing upward (Equal Earth → Mercator) recovers real coordinates; crossing
    // downward re-warps them into map space.
    const converted = wasBelow ? mapToGeographic(source) : geographicToMap(source);

    if (!Number.isFinite(converted[0]) || !Number.isFinite(converted[1])) {
      this.#onConversionFailure('non-finite result', source);
      return upstream;
    }

    return { ...upstream, center: this.#lngLatFactory(converted[0], converted[1]) };
  };

  /**
   * Uninstall. Restores the host's previous `transformCameraUpdate` rather than leaving
   * it null, so a map that had its own hook keeps working.
   *
   * Safe to call more than once.
   */
  destroy(): void {
    if (!this.#installed) return;
    this.#installed = false;
    // Only hand the property back if it is still ours; if the application replaced it
    // after we installed, stomping on that would be worse than leaving it alone.
    if (this.#host.transformCameraUpdate === this.handleCameraUpdate) {
      this.#host.transformCameraUpdate = this.#previousHook ?? null;
    }
    this.#previousHook = null;
  }
}
