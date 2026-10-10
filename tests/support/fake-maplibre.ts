/**
 * Test doubles for MapLibre's camera pipeline, modelled on the real code rather than on what
 * would be convenient. Line references are to `maplibre-gl` 6.6.0
 * (`dist/maplibre-gl-dev.mjs`) and `maplibre-gl` 5.24.0 (`dist/maplibre-gl-csp-dev.js`).
 *
 * The Camera holds two transforms:
 *
 * - `T`, the rendered transform (`this.transform`).
 * - `R`, the requested state (`_requestedCameraState`). `getTransformForUpdate()` creates it
 *   lazily as a clone of `T` and then keeps returning it (v6 22415, v5 68202). Every gesture
 *   frame (HandlerManager `_updateMapTransform`, v6 21865) and every animation frame
 *   (`easeTo`/`flyTo`, v6 22368) applies its delta to `R`, then calls
 *   `applyUpdatedTransform(R)`.
 *
 * `applyUpdatedTransform` (v6 22452) runs `transformCameraUpdate` on a *clone* of `R` and
 * applies the result to `T` only. `R` never sees the hook's output. So the hook's input on
 * every frame is `R` plus that frame's delta, not the centre it returned last frame.
 *
 * `R` is deleted only by the Camera's own `moveend` listener (v6 22072, v5 67377). In v5 the
 * Map *is* the Camera, so every `moveend` deletes it. In v6 the Camera is a separate `Evented`
 * whose events bubble up to the Map (v6 23247; `Evented.fire` only bubbles upward). The
 * HandlerManager fires a gesture's `moveend` on the *Map* when there is no inertia (v6 22022),
 * which always happens for scroll zoom (`noInertia: true`, v6 20979). That `moveend` never
 * reaches the Camera, so `R` survives into the next gesture.
 */
import type { CameraUpdate, CameraUpdateFn, CameraUpdateResult } from '../../src/map/camera.js';

export interface LngLat {
  lng: number;
  lat: number;
}

interface CameraState {
  center: LngLat;
  zoom: number;
}

type Listener = () => void;

/** A minimal `Evented`: listeners plus upward bubbling, as in MapLibre. */
class Emitter {
  readonly #listeners = new Map<string, Listener[]>();
  #parent: Emitter | null = null;

  on(type: string, listener: Listener): this {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
    return this;
  }

  off(type: string, listener: Listener): this {
    this.#listeners.set(
      type,
      (this.#listeners.get(type) ?? []).filter((l) => l !== listener),
    );
    return this;
  }

  fire(type: string): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener();
    this.#parent?.fire(type);
  }

  listenerCount(type: string): number {
    return this.#listeners.get(type)?.length ?? 0;
  }

  setEventedParent(parent: Emitter): void {
    this.#parent = parent;
  }
}

const copy = (state: CameraState): CameraState => ({ center: { ...state.center }, zoom: state.zoom });

/** The MapLibre `Camera`: rendered transform `T`, requested state `R`, and the hook. */
export class FakeCamera extends Emitter {
  /** `T`: what is rendered, and what `getZoom()` and `getCenter()` report. */
  transform: CameraState;
  /** `R`: the requested state, or `undefined` between moves. */
  requested: CameraState | undefined;
  transformCameraUpdate: CameraUpdateFn | null = null;

  constructor(center: readonly [number, number], zoom: number) {
    super();
    this.transform = { center: { lng: center[0], lat: center[1] }, zoom };
    // v6 22072 / v5 67377: registered in the Camera constructor, so it runs first.
    this.on('moveend', () => {
      this.requested = undefined;
    });
  }

  getTransformForUpdate(): CameraState {
    this.requested ??= copy(this.transform);
    return this.requested;
  }

  applyUpdatedTransform(requested: CameraState): void {
    const next: CameraUpdate = { center: { ...requested.center }, zoom: requested.zoom };
    const result: CameraUpdateResult = this.transformCameraUpdate?.(next) ?? {};
    const final = copy(requested);
    // Store the returned object by reference, as `setCenter(center)` does.
    if (result.center) final.center = result.center;
    if (typeof result['zoom'] === 'number') final.zoom = result['zoom'];
    this.transform = final;
  }
}

export interface Frame {
  /** Absolute zoom, as an animation frame interpolates it. */
  zoom?: number;
  /** Zoom change, as a scroll or pinch frame produces it. */
  zoomDelta?: number;
  /** Pan in map-space degrees. */
  panDelta?: readonly [number, number];
}

/** Driving logic shared by the v5 and v6 shapes; they differ only in their event wiring. */
export abstract class FakeMapBase {
  protected readonly camera: FakeCamera;

  constructor(center: readonly [number, number], zoom: number) {
    this.camera = new FakeCamera(center, zoom);
  }

  /** `T.center`: the rendered centre. */
  get center(): LngLat {
    return this.camera.transform.center;
  }

  /** `T.zoom`. */
  get zoom(): number {
    return this.camera.transform.zoom;
  }

  /** `R.center`, or `undefined` when there is no requested state. */
  get requestedCenter(): LngLat | undefined {
    return this.camera.requested?.center;
  }

  getZoom(): number {
    return this.camera.transform.zoom;
  }

  /** One gesture or animation frame: mutate `R`, then render it through the hook. */
  applyFrame(frame: Frame): void {
    const requested = this.camera.getTransformForUpdate();
    if (frame.zoom !== undefined) requested.zoom = frame.zoom;
    if (frame.zoomDelta !== undefined) requested.zoom += frame.zoomDelta;
    if (frame.panDelta) {
      requested.center = {
        lng: requested.center.lng + frame.panDelta[0],
        lat: requested.center.lat + frame.panDelta[1],
      };
    }
    this.camera.applyUpdatedTransform(requested);
  }

  /**
   * End a gesture. With inertia the HandlerManager hands over to `easeTo`, whose `moveend` the
   * Camera fires (v6 22495). Without it, the HandlerManager fires `moveend` on the Map
   * (v6 22022); scroll zoom always ends that way.
   */
  endGesture({ inertia = false }: { inertia?: boolean } = {}): void {
    if (inertia) this.camera.fire('moveend');
    else this.fireOnMap('moveend');
  }

  /** `jumpTo`: one frame, then the Camera's own `moveend` (v6 22287). */
  jumpTo(frame: Frame): void {
    this.applyFrame(frame);
    this.camera.fire('moveend');
  }

  /** Fire an event on the Map itself, not the Camera. */
  protected abstract fireOnMap(type: string): void;
}

/** MapLibre v5: `Map extends Camera`, so the Map and the Camera are one emitter. */
export class FakeV5Map extends FakeMapBase {
  get transformCameraUpdate(): CameraUpdateFn | null {
    return this.camera.transformCameraUpdate;
  }

  set transformCameraUpdate(hook: CameraUpdateFn | null) {
    this.camera.transformCameraUpdate = hook;
  }

  on(type: string, listener: Listener): this {
    this.camera.on(type, listener);
    return this;
  }

  off(type: string, listener: Listener): this {
    this.camera.off(type, listener);
    return this;
  }

  /** Listeners on the single Map/Camera emitter, including the Camera's own. */
  listenerCount(type: string): number {
    return this.camera.listenerCount(type);
  }

  protected fireOnMap(type: string): void {
    this.camera.fire(type);
  }
}

/**
 * MapLibre v6: the hook is set through `setTransformCameraUpdate`, which writes to the
 * private `_camera`. The Camera's events bubble up to the Map, never down.
 */
export class FakeV6Map extends FakeMapBase {
  readonly #events = new Emitter();

  constructor(center: readonly [number, number], zoom: number) {
    super(center, zoom);
    this.camera.setEventedParent(this.#events);
  }

  get _camera(): FakeCamera {
    return this.camera;
  }

  setTransformCameraUpdate(hook: CameraUpdateFn | null): void {
    this.camera.transformCameraUpdate = hook;
  }

  on(type: string, listener: Listener): this {
    this.#events.on(type, listener);
    return this;
  }

  off(type: string, listener: Listener): this {
    this.#events.off(type, listener);
    return this;
  }

  /** Listeners on the Map's own emitter. */
  listenerCount(type: string): number {
    return this.#events.listenerCount(type);
  }

  protected fireOnMap(type: string): void {
    this.#events.fire(type);
  }
}

/** A v6-shaped host whose `_camera` cannot be read at all: a future MapLibre, say. */
export class OpaqueV6Map extends FakeMapBase {
  readonly #events = new Emitter();

  constructor(center: readonly [number, number], zoom: number) {
    super(center, zoom);
    this.camera.setEventedParent(this.#events);
  }

  setTransformCameraUpdate(hook: CameraUpdateFn | null): void {
    this.camera.transformCameraUpdate = hook;
  }

  on(type: string, listener: Listener): this {
    this.#events.on(type, listener);
    return this;
  }

  off(type: string, listener: Listener): this {
    this.#events.off(type, listener);
    return this;
  }

  protected fireOnMap(type: string): void {
    this.#events.fire(type);
  }
}
