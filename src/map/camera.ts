/**
 * Camera continuity across zoom bands.
 *
 * An adaptive Equal Earth map divides the zoom range into bands (see `bands.ts`), each drawn
 * with a fixed blend between Equal Earth and Mercator. The camera centre is expressed in the
 * current band's map space, so it means something different on either side of every band
 * boundary and must be converted whenever the camera crosses one — otherwise the view jumps.
 */

import { geographicToMap, mapSpaceMaxLatitude, mapToGeographic } from '../math/backproject.js';
import type { LngLatTuple } from '../math/equal-earth.js';
import { bandIndexForZoom, validateBands, type Band } from './bands.js';

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

/**
 * A `transformCameraUpdate` callback.
 *
 * Declared *bivariant* in its parameter (method-signature syntax) so MapLibre's own
 * `CameraUpdateTransformFunction` — whose payload carries a `LngLat` class instance — and
 * this type are assignable to each other. With a plain function type `strictFunctionTypes`
 * rejects that, and a real `maplibregl.Map` would not satisfy {@link CameraHost}.
 */
export type CameraUpdateFn = {
  bivarianceHack(next: CameraUpdate): CameraUpdateResult;
}['bivarianceHack'];

/**
 * Minimal structural view of the bits of `Map` this module touches.
 *
 * The camera hook moved between MapLibre majors. v5's `Map` inherits a public
 * `transformCameraUpdate` property from `Camera`. v6's `Map` no longer extends `Camera`:
 * assigning that property on a v6 map does nothing, and the hook can only be set through
 * `setTransformCameraUpdate()`. Both shapes are accepted — see {@link cameraHookAccess}.
 */
export interface CameraHost {
  getZoom(): number;
  /** MapLibre v5, and test doubles: the hook is a plain property. */
  transformCameraUpdate?: CameraUpdateFn | null;
  /** MapLibre v6: the hook can only be set through this method. */
  setTransformCameraUpdate?(value: CameraUpdateFn | null): void;
}

/** Constructs whatever `LngLat`-ish object the host expects. */
export type LngLatFactory = (lng: number, lat: number) => { lng: number; lat: number };

const defaultLngLatFactory: LngLatFactory = (lng, lat) => ({ lng, lat });

/** Reads and writes a host's camera hook across MapLibre majors. */
export interface CameraHookAccess {
  /** The installed hook; `undefined` when this MapLibre version offers no way to read it. */
  get(): CameraUpdateFn | null | undefined;
  set(hook: CameraUpdateFn | null): void;
}

type V6Host = CameraHost & { setTransformCameraUpdate(value: CameraUpdateFn | null): void };

function hasHookSetter(host: CameraHost): host is V6Host {
  return typeof (host as { setTransformCameraUpdate?: unknown }).setTransformCameraUpdate === 'function';
}

/**
 * Access a host's camera hook, whichever major it is.
 *
 * v6 has a public setter but no getter. The previous hook is read from the private
 * `_camera` the setter writes to, because without it an application's own hook could only
 * be silently replaced rather than chained. If a future release moves that field, `get()`
 * reports `undefined` ("unknown") rather than guessing.
 */
export function cameraHookAccess(host: CameraHost): CameraHookAccess {
  if (hasHookSetter(host)) {
    const internals = host as unknown as {
      _camera?: { transformCameraUpdate?: CameraUpdateFn | null };
    };
    return {
      get: () => (internals._camera ? (internals._camera.transformCameraUpdate ?? null) : undefined),
      set: (hook) => host.setTransformCameraUpdate(hook),
    };
  }
  return {
    get: () => host.transformCameraUpdate ?? null,
    set: (hook) => {
      host.transformCameraUpdate = hook;
    },
  };
}

export interface BandCameraOptions {
  /** Zoom bands, validated with `validateBands`. */
  bands: readonly Band[];
  /** Builds the center object handed back to MapLibre. Pass `maplibregl.LngLat`. */
  lngLatFactory?: LngLatFactory;
  /** Called when a conversion produces a non-finite coordinate. Defaults to a console warning. */
  onConversionFailure?: (reason: string, input: LngLatTuple) => void;
}

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
 * Installs a `transformCameraUpdate` hook that converts the camera centre exactly once per
 * band crossing.
 *
 * Two bugs in the original implementation motivate the design here, and both are covered
 * by tests in `tests/camera.test.ts`:
 *
 * - **Edge-triggered, not level-triggered.** The original compared against a zoom frozen at
 *   `movestart`, so "started below, now above" stayed true for every remaining frame of a
 *   gesture and re-converted an already-converted centre each frame. Here the comparison is
 *   against the band seen on the previous camera update.
 * - **State initialised in the constructor**, from the live camera, so an initial `flyTo`
 *   across a boundary is converted even before any interaction.
 */
export class BandCamera {
  readonly #access: CameraHookAccess;
  readonly #bands: readonly Band[];
  readonly #lngLatFactory: LngLatFactory;
  readonly #onConversionFailure: (reason: string, input: LngLatTuple) => void;

  /** Band of the zoom observed on the previous camera update. Seeded from the live camera. */
  #lastBand: number;

  /** The host's own hook, chained rather than clobbered. */
  #previousHook: CameraUpdateFn | null;

  #installed = false;

  constructor(host: CameraHost, options: BandCameraOptions) {
    if (!host || typeof host.getZoom !== 'function') {
      throw new TypeError('BandCamera requires a map-like host exposing getZoom().');
    }
    validateBands(options.bands);

    this.#bands = [...options.bands];
    this.#lngLatFactory = options.lngLatFactory ?? defaultLngLatFactory;
    this.#onConversionFailure =
      options.onConversionFailure ??
      ((reason, input) => {
        console.warn(
          `[equal-earth] Skipped camera conversion (${reason}) for [${input[0]}, ${input[1]}]. ` +
            'The camera centre may be in the wrong coordinate space.',
        );
      });

    this.#lastBand = bandIndexForZoom(this.#bands, host.getZoom());
    this.#access = cameraHookAccess(host);

    const previous = this.#access.get();
    if (previous === undefined) {
      console.warn(
        '[equal-earth] Cannot read the existing transformCameraUpdate on this MapLibre ' +
          'version; a hook installed before the camera will be replaced, not chained.',
      );
    }
    this.#previousHook = previous ?? null;
    this.#access.set(this.handleCameraUpdate);
    this.#installed = true;
  }

  get bands(): readonly Band[] {
    return this.#bands;
  }

  /** Blend of the band the camera was in at the last update. */
  get blend(): number {
    return this.#bands[this.#lastBand]!.blend;
  }

  /**
   * The `transformCameraUpdate` implementation. Exposed for testing; MapLibre calls it
   * once per camera change, including every frame of an animation or gesture.
   */
  readonly handleCameraUpdate: CameraUpdateFn = (next) => {
    // Chain to whatever the host had installed, so we cooperate with bbox constraints,
    // map synchronisation, and anything else the application relies on.
    const upstream = this.#previousHook ? this.#previousHook(next) : {};
    const center = upstream.center ?? next.center;
    const upstreamZoom = upstream['zoom'];
    const zoom = typeof upstreamZoom === 'number' ? upstreamZoom : next.zoom;

    const previous = this.#lastBand;
    const current = bandIndexForZoom(this.#bands, zoom);
    this.#lastBand = current;

    const fromBlend = this.#bands[previous]!.blend;
    const toBlend = this.#bands[current]!.blend;

    // No crossing (or adjacent bands sharing a blend). Critically, this is the common case
    // during a gesture that has already crossed — the original code re-converted here.
    if (fromBlend === toBlend) return upstream;

    const source: LngLatTuple = [center.lng, center.lat];
    // Bring the centre into the old band's world first: a centre panned into the empty
    // space beyond the world edge has no geographic meaning, and would convert to NaN.
    const inWorld: LngLatTuple = [
      wrapLongitude(center.lng),
      clampLatitude(center.lat, mapSpaceMaxLatitude(fromBlend)),
    ];
    // One conversion straight from the old band to the new, however many bands a single
    // update skipped — chaining through each would accumulate error.
    const converted = geographicToMap(mapToGeographic(inWorld, fromBlend), toBlend);

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
    // Only hand the hook back if it is still ours; if the application replaced it after we
    // installed, stomping on that would be worse than leaving it alone. When the host gives
    // no way to read the hook, restoring is the better guess.
    const current = this.#access.get();
    if (current === this.handleCameraUpdate || current === undefined) {
      this.#access.set(this.#previousHook);
    }
    this.#previousHook = null;
  }
}

/**
 * The single-switch form: Equal Earth below `switchZoom`, Mercator at or above it.
 *
 * Equivalent to a two-band {@link BandCamera}; kept because it is the simplest correct API
 * for a map that switches once.
 */
export class ThresholdCamera extends BandCamera {
  constructor(host: CameraHost, options: ThresholdCameraOptions) {
    super(host, thresholdBands(options));
  }

  get switchZoom(): number {
    return this.bands[1]!.minZoom;
  }

  /** True while the camera is below the switch zoom, i.e. rendering Equal Earth. */
  get isEqualEarthActive(): boolean {
    return this.blend < 1;
  }
}

function thresholdBands(options: ThresholdCameraOptions): BandCameraOptions {
  const { switchZoom, ...rest } = options;
  if (!Number.isFinite(switchZoom)) {
    throw new TypeError(`ThresholdCamera requires a finite switchZoom, received ${String(switchZoom)}.`);
  }
  return {
    ...rest,
    bands: [
      { minZoom: -Infinity, blend: 0 },
      { minZoom: switchZoom, blend: 1 },
    ],
  };
}

/**
 * Bring a longitude beyond ±180° back into range. ±180° itself is left alone: on Equal
 * Earth those are opposite edges of the map, not one meridian.
 */
function wrapLongitude(lng: number): number {
  if (!Number.isFinite(lng)) return lng;
  let wrapped = lng;
  while (wrapped > 180) wrapped -= 360;
  while (wrapped < -180) wrapped += 360;
  return wrapped;
}

/** Clamp to ±limit. NaN passes through, so a genuinely broken centre is still reported. */
function clampLatitude(lat: number, limit: number): number {
  return lat < -limit ? -limit : lat > limit ? limit : lat;
}
