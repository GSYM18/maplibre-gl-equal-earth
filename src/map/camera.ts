/**
 * Camera continuity across zoom bands.
 *
 * An adaptive Equal Earth map divides the zoom range into bands (see `bands.ts`), each drawn
 * with a fixed blend between Equal Earth and Mercator. The camera centre is expressed in the
 * current band's map space, so it means something different on either side of every band
 * boundary and must be converted whenever the camera crosses one — otherwise the view jumps.
 *
 * MapLibre does not feed the hook its own previous output. Gestures and animations accumulate
 * into a *requested* camera state, cloned from the rendered one and kept until the Camera's
 * own `moveend`; every frame runs the hook on a copy of it and renders only the result. So
 * within one move the hook keeps seeing an unconverted centre, in the map space of the band
 * the move started in — see {@link BandCamera}.
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

/** Something that emits `moveend`: a v5 `Map`, or the `Camera` inside a v6 `Map`. */
export interface MoveEndEmitter {
  on(type: 'moveend', listener: () => void): unknown;
  off(type: 'moveend', listener: () => void): unknown;
}

/**
 * Minimal structural view of the bits of `Map` this module touches.
 *
 * The camera hook moved between MapLibre majors. v5's `Map` inherits a public
 * `transformCameraUpdate` property from `Camera`. v6's `Map` no longer extends `Camera`:
 * assigning that property on a v6 map does nothing, and the hook can only be set through
 * `setTransformCameraUpdate()`. Both shapes are accepted — see {@link cameraHookAccess}.
 */
export interface CameraHost extends MoveEndEmitter {
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
  /**
   * The emitter whose `moveend` deletes MapLibre's requested camera state, i.e. the Camera
   * itself; `undefined` when this MapLibre version offers no way to reach it.
   */
  readonly requestOwner: MoveEndEmitter | undefined;
  /**
   * Whether MapLibre currently holds a requested camera state; `undefined` when this MapLibre
   * version offers no way to tell (and whenever {@link requestOwner} is unknown).
   */
  hasRequestedState(): boolean | undefined;
  /**
   * Delete the requested state if there is one and no ease is running, as v5 does on every
   * `moveend`; returns whether it did. Only v6 needs this (see {@link cameraHookAccess}). It
   * does nothing, and returns `false`, on v5 or when the internals cannot be read.
   */
  discardRequestedState(): boolean;
}

/** The private members this module reads, wherever they live. */
interface CameraInternals {
  transformCameraUpdate?: CameraUpdateFn | null;
  _requestedCameraState?: unknown;
  isEasing?(): boolean;
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
 *
 * The same `_camera` is the v6 {@link CameraHookAccess.requestOwner}. The requested camera
 * state is deleted only by the Camera's own `moveend` listener, and a v6 Camera's events
 * bubble up to the Map but never down: a `moveend` the Map fires itself (a gesture ending
 * without inertia, which includes every scroll zoom) leaves that state in place. On v5 the
 * Map *is* the Camera, so every `moveend` deletes it.
 *
 * The requested state itself is `_requestedCameraState`, on the same object as
 * `requestOwner`: the v6 `_camera`, or the v5 Map.
 *
 * `discardRequestedState` closes that v6 gap from the Map's own `moveend`. Without it, an `R`
 * left behind by a scroll keeps the old band's map space, and a centre the application then
 * passes to `jumpTo`/`easeTo` (in the rendered band's space) would be read in the wrong one.
 * A running ease is left alone: its `R` is still in use. A v6 `Map` has no `isEasing()`; its
 * Camera does.
 */
export function cameraHookAccess(host: CameraHost): CameraHookAccess {
  if (hasHookSetter(host)) {
    const camera = (host as unknown as { _camera?: Partial<MoveEndEmitter> & CameraInternals })
      ._camera;
    const owner =
      typeof camera?.on === 'function' && typeof camera.off === 'function'
        ? (camera as MoveEndEmitter & CameraInternals)
        : undefined;
    return {
      get: () => (camera ? (camera.transformCameraUpdate ?? null) : undefined),
      set: (hook) => host.setTransformCameraUpdate(hook),
      requestOwner: owner,
      hasRequestedState: () => (owner ? owner._requestedCameraState !== undefined : undefined),
      discardRequestedState: () => {
        if (owner?._requestedCameraState === undefined) return false;
        if (typeof owner.isEasing !== 'function' || owner.isEasing()) return false;
        delete owner._requestedCameraState;
        return true;
      },
    };
  }
  const internals = host as unknown as CameraInternals;
  return {
    get: () => host.transformCameraUpdate ?? null,
    set: (hook) => {
      host.transformCameraUpdate = hook;
    },
    requestOwner: host,
    hasRequestedState: () => internals._requestedCameraState !== undefined,
    // MapLibre v5 already deletes it on every `moveend`.
    discardRequestedState: () => false,
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
 * Installs a `transformCameraUpdate` hook that keeps the geographic point under the camera
 * centre fixed across band crossings.
 *
 * - **Relative to a baseline band.** Every frame of a move hands the hook the requested
 *   state, whose centre is still in the map space of the band that state was created in: the
 *   *baseline*. The hook converts from the baseline's blend to the blend of the frame's zoom
 *   and is a pure function of the two, so the same requested state converts the same way on
 *   every frame, and a move that crosses up and back down returns to the identity. The
 *   baseline is reset from the rendered zoom on the `moveend` that deletes the requested
 *   state, because the next one is cloned from what is rendered. On v6 that is the Camera's
 *   own `moveend`, not the Map's — see {@link cameraHookAccess}.
 * - **State initialised in the constructor**, from the live camera, so an initial `flyTo`
 *   across a boundary is converted even before any interaction.
 *
 * Both are covered by `tests/band-camera.test.ts` and `tests/camera.test.ts`.
 */
export class BandCamera {
  readonly #host: CameraHost;
  readonly #access: CameraHookAccess;
  readonly #moveEndSource: MoveEndEmitter;
  /** v6 only: the Map, whose own `moveend`s the Camera never hears. */
  readonly #mapMoveEndSource: MoveEndEmitter | undefined;
  readonly #bands: readonly Band[];
  readonly #lngLatFactory: LngLatFactory;
  readonly #onConversionFailure: (reason: string, input: LngLatTuple) => void;

  /**
   * Band whose map space the requested camera state is in: the rendered band when that state
   * was created. Seeded from the live camera, reset on the `moveend` that deletes the state.
   */
  #baseline: number;

  /**
   * The baseline the last reset replaced: the space of a requested state that was deleted
   * while still in use — see {@link handleCameraUpdate}.
   */
  #previousBaseline: number;

  /** The host's own hook, chained rather than clobbered. */
  #previousHook: CameraUpdateFn | null;

  #installed = false;

  constructor(host: CameraHost, options: BandCameraOptions) {
    if (
      !host ||
      typeof host.getZoom !== 'function' ||
      typeof host.on !== 'function' ||
      typeof host.off !== 'function'
    ) {
      throw new TypeError('BandCamera requires a map-like host exposing getZoom(), on() and off().');
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

    this.#host = host;
    this.#baseline = bandIndexForZoom(this.#bands, host.getZoom());
    this.#previousBaseline = this.#baseline;
    this.#access = cameraHookAccess(host);

    const previous = this.#access.get();
    const owner = this.#access.requestOwner;
    const consequences: string[] = [];
    if (previous === undefined) {
      consequences.push(
        'a transformCameraUpdate installed before the camera will be replaced, not chained',
      );
    }
    if (owner === undefined) {
      consequences.push('the view may jump when a gesture follows a scroll zoom');
    }
    if (consequences.length > 0) {
      console.warn(
        '[equal-earth] Cannot reach the camera internals of this MapLibre version; ' +
          `${consequences.join(', and ')}.`,
      );
    }
    this.#previousHook = previous ?? null;
    // Without the Camera, the Map's `moveend` is the closest available approximation.
    this.#moveEndSource = owner ?? host;
    this.#moveEndSource.on('moveend', this.#onMoveEnd);
    // v5 deletes the requested state on every `moveend`; v6 only on Camera-fired ones. Close
    // that gap, so a centre the application supplies is always read in the rendered band.
    this.#mapMoveEndSource = owner !== undefined && owner !== host ? host : undefined;
    this.#mapMoveEndSource?.on('moveend', this.#onMapMoveEnd);
    this.#access.set(this.handleCameraUpdate);
    this.#installed = true;
  }

  get bands(): readonly Band[] {
    return this.#bands;
  }

  /** Blend of the band the rendered camera is in. */
  get blend(): number {
    return this.#bands[bandIndexForZoom(this.#bands, this.#host.getZoom())]!.blend;
  }

  /**
   * The `transformCameraUpdate` implementation. Exposed for testing; MapLibre calls it
   * once per camera change, including every frame of an animation or gesture, each time with
   * the requested state rather than with what this returned the time before.
   */
  readonly handleCameraUpdate: CameraUpdateFn = (next) => {
    // Chain to whatever the host had installed, so we cooperate with bbox constraints,
    // map synchronisation, and anything else the application relies on.
    const upstream = this.#previousHook ? this.#previousHook(next) : {};
    const center = upstream.center ?? next.center;
    const upstreamZoom = upstream['zoom'];
    const zoom = typeof upstreamZoom === 'number' ? upstreamZoom : next.zoom;

    const current = bandIndexForZoom(this.#bands, zoom);

    // With this hook installed, `getTransformForUpdate()` creates the requested state before
    // anything applies a change to it, so an absent one means this frame renders a state that
    // a `moveend` deleted while it was still in use. That happens when a gesture interrupts
    // an ease: the HandlerManager takes the state *before* calling `stop(true)` (v6
    // 21867/21873, v5 67195/67202), and stopping the ease fires the Camera's `moveend`. It
    // also happens to an ease whose state a mid-ease `moveend` deleted: on v6 from
    // `setVerticalFieldOfView` (22131), on v5 from any Map `moveend`. Either way the state is
    // in the space of the baseline that reset replaced, and the next one will be cloned from
    // what this frame renders, so this frame's band becomes the baseline.
    let baseline = this.#baseline;
    if (this.#access.hasRequestedState() === false) {
      baseline = this.#previousBaseline;
      this.#baseline = current;
    }

    // Otherwise no state change here: the baseline moves only on `moveend`, so every frame of
    // a move converts its requested state the same way.
    const fromBlend = this.#bands[baseline]!.blend;
    const toBlend = this.#bands[current]!.blend;

    // Still in the baseline band (or one sharing its blend), including after a move crossed
    // out and back: the requested centre is already in the right space.
    if (fromBlend === toBlend) return upstream;

    const source: LngLatTuple = [center.lng, center.lat];
    // Bring the centre into the old band's world first: a centre panned into the empty
    // space beyond the world edge has no geographic meaning, and would convert to NaN.
    const inWorld: LngLatTuple = [
      wrapLongitude(center.lng),
      clampLatitude(center.lat, mapSpaceMaxLatitude(fromBlend)),
    ];
    // One conversion straight from the baseline band to the current one, however many bands
    // lie between — chaining through each would accumulate error.
    const converted = geographicToMap(mapToGeographic(inWorld, fromBlend), toBlend);

    if (!Number.isFinite(converted[0]) || !Number.isFinite(converted[1])) {
      this.#onConversionFailure('non-finite result', source);
      return upstream;
    }

    return { ...upstream, center: this.#lngLatFactory(converted[0], converted[1]) };
  };

  /** The requested state is gone; the next one is cloned from what is rendered. */
  readonly #onMoveEnd = (): void => {
    this.#previousBaseline = this.#baseline;
    this.#baseline = bandIndexForZoom(this.#bands, this.#host.getZoom());
  };

  /**
   * v6: a `moveend` reached the Map. Camera-fired ones have already deleted the requested
   * state and re-based through {@link #onMoveEnd}; for the Map's own, do what v5 would.
   */
  readonly #onMapMoveEnd = (): void => {
    if (this.#access.discardRequestedState()) this.#onMoveEnd();
  };

  /**
   * Uninstall. Restores the host's previous `transformCameraUpdate` rather than leaving
   * it null, so a map that had its own hook keeps working, and stops listening for `moveend`.
   *
   * Safe to call more than once.
   */
  destroy(): void {
    if (!this.#installed) return;
    this.#installed = false;
    this.#moveEndSource.off('moveend', this.#onMoveEnd);
    this.#mapMoveEndSource?.off('moveend', this.#onMapMoveEnd);
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
  // Closed form, not a loop: beyond 2^53 `lng - 360` is `lng`, so a loop never terminates.
  if (lng > 180) return lng - 360 * Math.ceil((lng - 180) / 360);
  if (lng < -180) return lng + 360 * Math.ceil((-180 - lng) / 360);
  return lng;
}

/** Clamp to ±limit. NaN passes through, so a genuinely broken centre is still reported. */
function clampLatitude(lat: number, limit: number): number {
  return lat < -limit ? -limit : lat > limit ? limit : lat;
}
