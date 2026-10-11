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
 *
 * The HandlerManager takes `R` *before* calling `stop(true)` (v6 21867/21873, v5 67195/67202).
 * When a gesture interrupts a running ease, `stop` fires the Camera's `moveend` and deletes
 * `R`, yet that first frame still renders the detached `R` it took.
 *
 * Three more mechanisms are modelled because bugs hid in their absence:
 *
 * - **Gesture end and the inertia handover** (v6 21992-22025, v5 68680-68718). The
 *   HandlerManager fires each finished gesture's `*end` event (`zoomend`, `dragend`, ...) on the
 *   Map, and only then either fires the Map's `moveend` (no inertia) or calls `easeTo` with
 *   options computed from the *rendered* transform (`handlePanInertia(..., camera.transform)`,
 *   v6 19637).
 * - **The Camera's own `*end` events.** `_afterEase` (v6 22478-22495, v5 69668) fires `zoomend`
 *   before `moveend` when the ease was zooming, and `jumpTo` (v6 22283-22288) fires `zoomend`
 *   before `moveend` when the zoom changed. Both bubble up to the Map.
 * - **The constraint on `R`.** `R` is a `transform.clone()` and carries the constrain override;
 *   every `setZoom`/`setCenter` on it runs `constrainInternal()` (v6 9286, 9298, 9441), so a
 *   frame's delta is constrained before the hook ever sees it. The hook's result is applied
 *   with `setCenter`/`setZoom` on a clone too (v6 22459-22462), and constrained again.
 */
import type { CameraUpdate, CameraUpdateFn, CameraUpdateResult } from '../../src/map/camera.js';
import type { StyleLike } from '../../src/map/style-rewrite.js';

export interface LngLat {
  lng: number;
  lat: number;
}

interface CameraState {
  center: LngLat;
  zoom: number;
  bearing: number;
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

const copy = (state: CameraState): CameraState => ({
  center: { ...state.center },
  zoom: state.zoom,
  bearing: state.bearing,
});

/** The MapLibre `Camera`: rendered transform `T`, requested state `R`, and the hook. */
export class FakeCamera extends Emitter {
  /** `T`: what is rendered, and what `getZoom()` and `getCenter()` report. */
  transform: CameraState;
  /** `R`: the requested state, absent between moves. Named as in MapLibre. */
  _requestedCameraState?: CameraState;
  transformCameraUpdate: CameraUpdateFn | null = null;
  /** The `transformConstrain` override, applied wherever MapLibre's setters would apply it. */
  constrain: ((center: LngLat, zoom: number) => { center: LngLat; zoom: number }) | null = null;
  /** Stands in for `_easeFrameId`: set while an ease is running. */
  #ease: object | undefined;
  /** Stands in for `_zooming` during an ease: `_afterEase` fires `zoomend` when it is set. */
  #easeZooming = false;

  constructor(center: readonly [number, number], zoom: number) {
    super();
    this.transform = { center: { lng: center[0], lat: center[1] }, zoom, bearing: 0 };
    // v6 22072 / v5 67377: registered in the Camera constructor, so it runs first.
    this.on('moveend', () => {
      delete this._requestedCameraState;
    });
  }

  getTransformForUpdate(): CameraState {
    this._requestedCameraState ??= copy(this.transform);
    return this._requestedCameraState;
  }

  applyUpdatedTransform(requested: CameraState): void {
    const next: CameraUpdate = {
      center: { ...requested.center },
      zoom: requested.zoom,
      bearing: requested.bearing,
    };
    const result: CameraUpdateResult = this.transformCameraUpdate?.(next) ?? {};
    const final = copy(requested);
    // Store the returned object by reference, as `setCenter(center)` does.
    if (result.center) final.center = result.center;
    if (typeof result.zoom === 'number') final.zoom = result.zoom;
    if (typeof result.bearing === 'number') final.bearing = result.bearing;
    // v6 22459-22462: the result goes through `setCenter`/`setZoom`, which constrain.
    if (result.center || typeof result.zoom === 'number') this.#constrainState(final);
    this.transform = final;
  }

  /**
   * Apply one frame's delta to a state, then constrain it as MapLibre's `setZoom`/`setCenter`
   * do (`constrainInternal`, v6 9441-9449).
   */
  applyTo(state: CameraState, frame: Frame): void {
    if (frame.center) state.center = { lng: frame.center[0], lat: frame.center[1] };
    if (frame.zoom !== undefined) state.zoom = frame.zoom;
    if (frame.zoomDelta !== undefined) state.zoom += frame.zoomDelta;
    if (frame.bearing !== undefined) state.bearing = frame.bearing;
    if (frame.panDelta) {
      state.center = {
        lng: state.center.lng + frame.panDelta[0],
        lat: state.center.lat + frame.panDelta[1],
      };
    }
    this.#constrainState(state);
  }

  #constrainState(state: CameraState): void {
    if (!this.constrain) return;
    const { center, zoom } = this.constrain(state.center, state.zoom);
    state.center = center;
    state.zoom = zoom;
  }

  /** v6 22611: `!!this._easeFrameId`. */
  isEasing(): boolean {
    return this.#ease !== undefined;
  }

  /** Mark an ease as running; returns its token. `zooming` as `easeTo` sets `_zooming`. */
  startEase(zooming = false): object {
    this.#ease = {};
    this.#easeZooming = zooming;
    return this.#ease;
  }

  /** An ease frame changed the zoom, so `_afterEase` will fire `zoomend`. */
  markEaseZooming(): void {
    this.#easeZooming = true;
  }

  isCurrentEase(token: object): boolean {
    return this.#ease === token;
  }

  /**
   * `stop()` (v6 22617-22627): `_easeFrameId` is deleted first, so `isEasing()` is already
   * false when `_afterEase` fires `zoomend` (if the ease was zooming) and then the Camera's
   * `moveend` (v6 22478-22495). With no ease running it does nothing.
   */
  stop(): void {
    if (this.#ease === undefined) return;
    this.#ease = undefined;
    const zooming = this.#easeZooming;
    this.#easeZooming = false;
    if (zooming) this.fire('zoomend');
    this.fire('moveend');
  }
}

export interface Frame {
  /**
   * Absolute centre in map space, as `jumpTo`/`easeTo` options give it: it overwrites
   * `R.center` (v6 `handleJumpToCenterZoom`, 22258-22265, and the ease interpolation).
   */
  center?: readonly [number, number];
  /** Absolute zoom, as an animation frame interpolates it. */
  zoom?: number;
  /** Zoom change, as a scroll or pinch frame produces it. */
  zoomDelta?: number;
  /** Pan in map-space degrees. */
  panDelta?: readonly [number, number];
  /** Absolute bearing in degrees, as `jumpTo`/`easeTo` options or a rotate frame set it. */
  bearing?: number;
}

/** A running `easeTo`/`flyTo`, including a double-click zoom. */
export interface FakeEase {
  /** One animation frame, applied to the `R` captured when the ease started (v6 22368). */
  frame(frame: Frame): void;
  /** Run to completion: `_afterEase` fires the Camera's `moveend` (v6 22478-22495). */
  finish(): void;
}

/** Driving logic shared by the v5 and v6 shapes; they differ only in their event wiring. */
export abstract class FakeMapBase {
  protected readonly camera: FakeCamera;

  /**
   * Whether the current gesture zoomed / panned: which `*end` events `endGesture` fires.
   * TS-private rather than `#`, because `FakeV5Map` is wrapped in a Proxy.
   */
  private gestureZoomed = false;
  private gesturePanned = false;

  constructor(center: readonly [number, number], zoom: number) {
    this.camera = new FakeCamera(center, zoom);
  }

  /** `map.setTransformConstrain(fn)` (v6 24448): the override on the camera's transform. */
  setTransformConstrain(
    constrain: ((center: LngLat, zoom: number) => { center: LngLat; zoom: number }) | null,
  ): void {
    this.camera.constrain = constrain;
  }

  /** `T.center`: the rendered centre. */
  get center(): LngLat {
    return this.camera.transform.center;
  }

  /** `T.zoom`. */
  get zoom(): number {
    return this.camera.transform.zoom;
  }

  /** `T.bearing`. */
  get bearing(): number {
    return this.camera.transform.bearing;
  }

  /** `R.center`, or `undefined` when there is no requested state. */
  get requestedCenter(): LngLat | undefined {
    return this.camera._requestedCameraState?.center;
  }

  getZoom(): number {
    return this.camera.transform.zoom;
  }

  getBearing(): number {
    return this.camera.transform.bearing;
  }

  /**
   * One HandlerManager gesture frame, in its real order (v6 21865-21896, v5 67193-67202): take
   * `R` with `getTransformForUpdate()`, *then* `stop(true)`, which ends a running ease and so
   * fires the Camera's `moveend`, deleting `R`. The frame still applies its delta to the
   * now-detached `R` it took, and renders that.
   */
  applyFrame(frame: Frame): void {
    const requested = this.camera.getTransformForUpdate();
    this.camera.stop();
    if (frame.zoom !== undefined || frame.zoomDelta !== undefined) this.gestureZoomed = true;
    if (frame.center || frame.panDelta) this.gesturePanned = true;
    this.camera.applyTo(requested, frame);
    this.camera.applyUpdatedTransform(requested);
  }

  /**
   * End a gesture (v6 21992-22025, v5 68680-68718). The HandlerManager first fires the finished
   * gesture's `*end` events on the Map: `zoomend` if it zoomed, `dragend` if it panned.
   *
   * - Without inertia it then fires `moveend` on the Map (v6 22022); scroll zoom always ends
   *   that way. Returns `undefined`.
   * - With inertia it calls `easeTo` (v6 22018) and returns that ease. Like any `easeTo` it
   *   works on whatever `getTransformForUpdate()` returns at that moment: the surviving `R`, or
   *   a fresh clone of `T` if something deleted it. Its options are computed from the rendered
   *   transform, so the caller passes `center: [T.center.lng, T.center.lat]` in the first
   *   frame, as `handlePanInertia(finalPan, camera.transform)` does (v6 19637). The ease is
   *   zooming (its end fires `zoomend`) if the gesture zoomed, unless `inertialZoom` says
   *   otherwise: inertia measures only the last ~160 ms of deltas, which may hold no zoom.
   */
  endGesture({
    inertia = false,
    inertialZoom,
  }: { inertia?: boolean; inertialZoom?: boolean } = {}): FakeEase | undefined {
    const zoomed = this.gestureZoomed;
    const panned = this.gesturePanned;
    this.gestureZoomed = false;
    this.gesturePanned = false;
    if (zoomed) this.fireOnMap('zoomend');
    if (panned) this.fireOnMap('dragend');
    if (!inertia) {
      this.fireMapMoveEnd();
      return undefined;
    }
    return this.easeTo({ zooming: inertialZoom ?? zoomed });
  }

  /**
   * A `moveend` the Map fires itself: a gesture ending without inertia (v6 22022), `resize`
   * (v6 24099), `setMinZoom` and friends (v6 24243). On v5 the Map is the Camera, so this
   * deletes `R`; on v6 it does not reach the Camera.
   */
  fireMapMoveEnd(): void {
    this.fireOnMap('moveend');
  }

  /**
   * `jumpTo` (v6 22257-22288): `stop()` first, then one frame, then the Camera's own `zoomend`
   * (when the zoom changed) and `moveend`.
   */
  jumpTo(frame: Frame): void {
    this.camera.stop();
    const requested = this.camera.getTransformForUpdate();
    const oldZoom = requested.zoom;
    this.camera.applyTo(requested, frame);
    this.camera.applyUpdatedTransform(requested);
    if (requested.zoom !== oldZoom) this.camera.fire('zoomend');
    this.camera.fire('moveend');
  }

  /**
   * `easeTo`/`flyTo` (v6 22321-22330): `stop()` first, then capture `R` for every frame.
   * `zooming` sets `_zooming` up front, as `easeTo` does for a zoom target and `flyTo` always
   * does (v6 22583); a frame that changes the zoom sets it too.
   */
  easeTo({ zooming = false }: { zooming?: boolean } = {}): FakeEase {
    this.camera.stop();
    const requested = this.camera.getTransformForUpdate();
    const ease = this.camera.startEase(zooming);
    const assertRunning = () => {
      if (!this.camera.isCurrentEase(ease)) throw new Error('This ease was stopped.');
    };
    return {
      frame: (frame) => {
        assertRunning();
        if (frame.zoom !== undefined || frame.zoomDelta !== undefined) {
          this.camera.markEaseZooming();
        }
        this.camera.applyTo(requested, frame);
        this.camera.applyUpdatedTransform(requested);
      },
      finish: () => {
        assertRunning();
        this.camera.stop();
      },
    };
  }

  /** Fire an event on the Map itself, not the Camera. */
  protected abstract fireOnMap(type: string): void;

  /** {@link fireOnMap}, for tests: an event the Map fires itself (`styledata`, `render`, ...). */
  fireMapEvent(type: string): void {
    this.fireOnMap(type);
  }
}

/** MapLibre v5: `Map extends Camera`, so the Map and the Camera are one emitter. */
export class FakeV5Map extends FakeMapBase {
  constructor(center: readonly [number, number], zoom: number) {
    super(center, zoom);
    // On v5 `_requestedCameraState` is an own property of the Map (dev.js 69587), and
    // `delete map._requestedCameraState` removes it (68763). A getter alone would make that
    // `delete` a silent no-op, so forward it to the camera.
    return new Proxy(this, {
      deleteProperty: (target, key) => {
        if (key === '_requestedCameraState') {
          delete target.camera._requestedCameraState;
          return true;
        }
        return Reflect.deleteProperty(target, key);
      },
    });
  }

  get transformCameraUpdate(): CameraUpdateFn | null {
    return this.camera.transformCameraUpdate;
  }

  set transformCameraUpdate(hook: CameraUpdateFn | null) {
    this.camera.transformCameraUpdate = hook;
  }

  /** On v5 the requested state lives on the Map, which is the Camera. */
  get _requestedCameraState(): object | undefined {
    return this.camera._requestedCameraState;
  }

  /** v5 `Map` inherits it from `Camera`. (A v6 `Map` has no `isEasing`; its `_camera` does.) */
  isEasing(): boolean {
    return this.camera.isEasing();
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

  /** Listeners on the Map's own emitter. */
  listenerCount(type: string): number {
    return this.#events.listenerCount(type);
  }

  protected fireOnMap(type: string): void {
    this.#events.fire(type);
  }
}

/** A host for the switcher: scripted readiness, recorded paint/layout writes and wake-ups. */
export class FakeSwitcherHost {
  readonly loaded = new Set<string>();
  /** MapLibre reports a source no layer used at the last render as loaded. */
  loadedWhenUnused = false;
  /** Last value written per layer and paint property. */
  readonly paint: Record<string, Record<string, unknown>> = {};
  /** Last value written per layer and layout property. */
  readonly layout: Record<string, Record<string, unknown>> = {};
  /** Every write, in order. */
  readonly writes: { kind: 'paint' | 'layout'; layerId: string; name: string; value: unknown }[] = [];
  jumps = 0;
  moving = false;
  readonly #listeners = new Map<string, (() => void)[]>();

  isSourceLoaded(id: string): boolean { return this.loaded.has(id) || this.loadedWhenUnused; }
  setPaintProperty(layerId: string, name: string, value: unknown): void {
    (this.paint[layerId] ??= {})[name] = value;
    this.writes.push({ kind: 'paint', layerId, name, value });
  }
  setLayoutProperty(layerId: string, name: string, value: unknown): void {
    (this.layout[layerId] ??= {})[name] = value;
    this.writes.push({ kind: 'layout', layerId, name, value });
  }
  zoom = 0;
  getZoom(): number { return this.zoom; }
  isMoving(): boolean { return this.moving; }
  /** Called by `jumpTo`, as MapLibre runs the camera hook synchronously inside it. */
  onJump?: () => void;
  jumpTo(): void { this.jumps++; this.onJump?.(); }
  on(type: string, listener: () => void): void { this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]); }
  off(type: string, listener: () => void): void { this.#listeners.set(type, (this.#listeners.get(type) ?? []).filter((l) => l !== listener)); }
  fire(type: string): void { for (const l of this.#listeners.get(type) ?? []) l(); }
  listenerCount(type: string): number { return (this.#listeners.get(type) ?? []).length; }
}

/**
 * A GeoJSON source object as `map.getSource(id)` returns it (v6 `source/geojson_source.ts`, v5
 * alike). `setData` takes effect at once here; `updateData` models the worker round trip: the
 * diff reaches the source's data, `loaded()` turns true and `data` fires only on
 * {@link settleUpdate} (`_dispatchWorkerUpdate` applies the diff once the worker has answered,
 * v6 `geojson_source.ts:505`), so a `getData()` right after `updateData` still reads the old data.
 */
export class FakeGeoJSONSource {
  readonly type = 'geojson';
  readonly calls: { method: 'setData' | 'updateData' | 'getData'; arg?: unknown }[] = [];
  #updating = false;
  #onData: (() => void)[] = [];

  constructor(readonly id: string, readonly spec: () => Record<string, unknown> | undefined) {}

  setData(data: unknown): this {
    this.calls.push({ method: 'setData', arg: data });
    const spec = this.spec();
    if (spec) spec['data'] = data;
    return this;
  }

  updateData(diff: unknown): this {
    this.calls.push({ method: 'updateData', arg: diff });
    this.#updating = true;
    return this;
  }

  /** The worker answers the pending `updateData`: the data becomes `data`, then `data` fires. */
  settleUpdate(data: unknown): void {
    const spec = this.spec();
    if (spec) spec['data'] = data;
    this.#updating = false;
    const listeners = this.#onData;
    this.#onData = [];
    for (const listener of listeners) listener();
  }

  loaded(): boolean {
    return !this.#updating;
  }

  once(type: string, listener: () => void): this {
    if (type === 'data') this.#onData.push(listener);
    return this;
  }

  getData(): Promise<unknown> {
    this.calls.push({ method: 'getData' });
    return Promise.resolve(structuredClone(this.spec()?.['data']));
  }

  /** The calls of one method, by argument. */
  argsOf(method: 'setData' | 'updateData'): unknown[] {
    return this.calls.filter((call) => call.method === method).map((call) => call.arg);
  }
}

/** What `jumpTo` accepts on a controller host: a `LngLat`-like centre as well as a tuple. */
export type ControllerJump = Omit<Frame, 'center'> & { center?: readonly [number, number] | LngLat };

/**
 * A v6 map with the style machinery the controller drives: `getStyle`/`setStyle`, the
 * switcher's paint and readiness surface, world copies, and a render after every camera frame.
 *
 * The style events follow MapLibre (v6 `src/`):
 *
 * - **Diff path** (a loaded style, `diff` not `false`): `setStyle` swaps the style synchronously
 *   and fires `style.load` inside the call (`Style.setState`, `style/style.ts:870`). A diff with
 *   no operations fires nothing (`setState` returns `false`, 857-859). `styledata` comes only
 *   from `Style.update` on the next render (`style.ts:784`), which `_render` runs *after* the
 *   camera frames (`ui/map.ts:4250` before `4279`).
 * - **Full rebuild** (`diff: false`, no loaded style, or `deferStyleData` standing in for a diff
 *   MapLibre cannot apply): `setStyle` fires `styledataloading` synchronously (`Style.loadJSON`,
 *   `style.ts:452`) and the style is not loaded (`getStyle()` throws) until the next render, or
 *   with `deferStyleData` until {@link flushStyleData}; then `styledata` and `style.load` fire
 *   (`Style._load`, 499-500).
 *
 * A render ({@link render}, and after every `applyFrame`, `jumpTo` and ease frame) completes a
 * pending rebuild (unless deferred), fires a pending `styledata`, then `render`.
 */
export class FakeControllerHost extends FakeV6Map {
  /** The loaded style; `undefined` while none is (then `getStyle()` throws). */
  style: StyleLike | undefined;
  readonly setStyleCalls: { layers: number; diff: boolean | undefined }[] = [];
  /** Model a diff MapLibre cannot apply: every `setStyle` rebuilds, loading only on {@link flushStyleData}. */
  deferStyleData = false;
  #pendingStyle: StyleLike | undefined;
  /** A style change awaits the next render's `Style.update`, which fires `styledata`. */
  #styleChanged = false;
  /** `getStyle()` calls: each is a full serialisation on a real map. */
  getStyleCalls = 0;
  readonly loaded = new Set<string>();
  /** Every `isSourceLoaded` call's source id, in order. */
  readonly sourceChecks: string[] = [];
  readonly paint: Record<string, Record<string, unknown>> = {};
  readonly layout: Record<string, Record<string, unknown>> = {};
  readonly writes: { kind: 'paint' | 'layout'; layerId: string; name: string; value: unknown }[] = [];
  /** Error events fired while something listened for `error`. */
  readonly errors: unknown[] = [];
  worldCopies = true;
  moving = false;
  /** `jumpTo` calls, including the switcher's `jumpTo({})`. */
  jumps = 0;
  /** A v5-style transform with MapLibre's default constraint: the identity here. */
  readonly transform = {
    defaultConstrain: (center: LngLat, zoom: number) => ({ center, zoom }),
  };

  get constrain(): FakeCamera['constrain'] {
    return this.camera.constrain;
  }

  getStyle(): StyleLike {
    this.getStyleCalls++;
    if (!this.style) throw new Error('Style is not done loading.');
    return structuredClone(this.style);
  }

  setStyle(style: StyleLike, options?: { diff?: boolean }): this {
    this.setStyleCalls.push({ layers: style.layers.length, diff: options?.diff });
    if (this.deferStyleData || options?.diff === false || !this.style) {
      this.#pendingStyle = structuredClone(style);
      this.style = undefined;
      this.#sources.clear(); // a rebuild creates every source object anew
      this.fireMapEvent('styledataloading');
      return this;
    }
    // A diff with no operations changes nothing and fires nothing.
    if (JSON.stringify(this.style) === JSON.stringify(style)) return this;
    const before = new Map(this.style.layers.map((layer) => [layer.id, layer]));
    const sourcesBefore = this.style.sources;
    this.style = structuredClone(style);
    // A source whose only change is its GeoJSON `data` keeps its object and gets `setData`
    // (`diffSources` → `setGeoJSONSourceData`, `style/style_diff.ts`); any other change removes
    // it and adds a new one.
    for (const [id, source] of [...this.#sources]) {
      const next = this.style.sources[id];
      const { data: oldData, ...oldRest } = sourcesBefore[id] ?? {};
      const { data: newData, ...newRest } = next ?? {};
      if (!next || JSON.stringify(oldRest) !== JSON.stringify(newRest)) {
        this.#sources.delete(id);
      } else if (source instanceof FakeGeoJSONSource && JSON.stringify(oldData) !== JSON.stringify(newData)) {
        next['data'] = oldData; // as before the operation; `setData` writes the new data
        source.setData(newData);
      }
    }
    // A changed zoom range diffs to `setLayerZoomRange(id, minzoom, maxzoom)`, which skips an
    // absent bound (`style/style.ts` `setLayerZoomRange`: `if (minzoom != null)`): a layer kept
    // under its id keeps the bound the new style leaves out.
    for (const layer of this.style.layers) {
      const old = before.get(layer.id);
      const replaced = !old || old.type !== layer.type || old.source !== layer.source || old['source-layer'] !== layer['source-layer'];
      if (replaced) continue; // removed and re-added, not diffed
      if (layer.minzoom === undefined && old.minzoom !== undefined) layer.minzoom = old.minzoom;
      if (layer.maxzoom === undefined && old.maxzoom !== undefined) layer.maxzoom = old.maxzoom;
    }
    this.#styleChanged = true;
    this.fireMapEvent('style.load');
    return this;
  }

  /** Source objects handed out, by id: kept while the style keeps the source unchanged. */
  readonly #sources = new Map<string, FakeGeoJSONSource | { type: string }>();

  /** As `Map.getSource`: the style's source object, the same one until the source is replaced. */
  getSource(id: string): FakeGeoJSONSource | { type: string } | undefined {
    const spec = this.style?.sources[id];
    if (!spec) return undefined;
    let source = this.#sources.get(id);
    if (!source) {
      source = spec['type'] === 'geojson' ? new FakeGeoJSONSource(id, () => this.style?.sources[id]) : { type: String(spec['type']) };
      this.#sources.set(id, source);
    }
    return source;
  }

  /** {@link getSource} for a GeoJSON source, which must exist. */
  geojsonSource(id: string): FakeGeoJSONSource {
    const source = this.getSource(id);
    if (!(source instanceof FakeGeoJSONSource)) throw new Error(`No GeoJSON source "${id}".`);
    return source;
  }

  /** Finish a pending rebuild: the style loads, `styledata` and `style.load` fire. */
  flushStyleData(): void {
    if (!this.#pendingStyle) throw new Error('No pending setStyle to flush.');
    this.style = this.#pendingStyle;
    this.#pendingStyle = undefined;
    this.fireMapEvent('styledata');
    this.fireMapEvent('style.load');
  }

  /**
   * WebGL context loss and restore (`ui/map.ts:4125`, `4153`): the style is serialised and
   * destroyed, then set again with `diff: false`, a full rebuild that keeps its metadata.
   */
  restoreContext(): void {
    const saved = this.getStyle();
    this.style = undefined;
    this.setStyle(saved, { diff: false });
  }

  /**
   * One render: a pending rebuild completes (unless deferred), `Style.update` fires a pending
   * `styledata`, then the Map fires `render`.
   */
  render(): void {
    if (this.#pendingStyle && !this.deferStyleData) this.flushStyleData();
    if (this.#styleChanged) {
      this.#styleChanged = false;
      this.fireMapEvent('styledata');
    }
    this.fireMapEvent('render');
  }

  /** Wrappers by listener, so that `off(type, listener)` removes a one-time listener too. */
  readonly #onceWrappers = new Map<() => void, () => void>();

  once(type: string, listener: () => void): this {
    const once = () => {
      this.off(type, listener);
      listener();
    };
    this.#onceWrappers.set(listener, once);
    return this.on(type, once);
  }

  /** As `Evented.off`: removes the listener whether it was added with `on` or `once`. */
  override off(type: string, listener: () => void): this {
    const once = this.#onceWrappers.get(listener);
    if (once) {
      this.#onceWrappers.delete(listener);
      super.off(type, once);
    }
    return super.off(type, listener);
  }

  listens(type: string): boolean {
    return this.listenerCount(type) > 0;
  }

  getCenter(): LngLat {
    return { lng: this.center.lng, lat: this.center.lat };
  }

  isMoving(): boolean {
    return this.moving;
  }

  isSourceLoaded(id: string): boolean {
    this.sourceChecks.push(id);
    return this.loaded.has(id);
  }

  setPaintProperty(layerId: string, name: string, value: unknown): this {
    (this.paint[layerId] ??= {})[name] = value;
    this.writes.push({ kind: 'paint', layerId, name, value });
    return this;
  }

  setLayoutProperty(layerId: string, name: string, value: unknown): this {
    (this.layout[layerId] ??= {})[name] = value;
    this.writes.push({ kind: 'layout', layerId, name, value });
    return this;
  }

  getRenderWorldCopies(): boolean {
    return this.worldCopies;
  }

  setRenderWorldCopies(value: boolean): this {
    this.worldCopies = value;
    return this;
  }

  /** As `Evented.fire`: delivered only if something listens (the payload is recorded). */
  fire(event: { type: string; error?: unknown }): this {
    if (event.type === 'error' && this.listens('error')) this.errors.push(event.error);
    return this;
  }

  /** A gesture frame, then a render. */
  override applyFrame(frame: Frame): void {
    super.applyFrame(frame);
    this.render();
  }

  /** `jumpTo` with a `LngLat`-like or tuple centre, then a render. */
  override jumpTo(options: ControllerJump): void {
    this.jumps++;
    const { center, ...rest } = options;
    const frame: Frame = { ...rest };
    if (center) frame.center = 'lng' in center ? [center.lng, center.lat] : center;
    super.jumpTo(frame);
    this.render();
  }

  /** `easeTo`, whose every frame is followed by a render. */
  override easeTo(options?: { zooming?: boolean }): FakeEase {
    const ease = super.easeTo(options);
    return {
      frame: (frame) => {
        ease.frame(frame);
        this.render();
      },
      finish: () => ease.finish(),
    };
  }
}
