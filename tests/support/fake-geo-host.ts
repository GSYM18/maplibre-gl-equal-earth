import { geographicToMapWorld, mapWorldToGeographic } from '../../src/math/backproject.js';
// At blend 1 these are plain Web Mercator: lng/lat → world [0, 1]² and back.

export class FakeLngLat { constructor(readonly lng: number, readonly lat: number) {} }
export class FakeLngLatBounds { constructor(readonly sw: [number, number], readonly ne: [number, number]) {} }

type Point = { x: number; y: number };
const toPoint = (p: unknown): Point => (Array.isArray(p) ? { x: p[0] as number, y: p[1] as number } : (p as Point));
const toTuple = (l: unknown): [number, number] => {
  if (Array.isArray(l)) return [l[0] as number, l[1] as number];
  const o = l as { lng?: number; lon?: number; lat: number };
  return [o.lng ?? o.lon!, o.lat];
};
/** A centre as the fake stores it: a `FakeLngLat` is kept by identity, as MapLibre's `LngLat.convert` does. */
const toLngLat = (l: unknown): FakeLngLat => (l instanceof FakeLngLat ? l : new FakeLngLat(...toTuple(l)));

export type FakeCameraOptions = {
  center?: unknown; zoom?: number; around?: unknown; easeId?: string; padding?: number; bearing?: number;
  [option: string]: unknown;
};

/**
 * MapLibre's `TransformProvider` in miniature: what the handlers read the camera through. Both
 * `unproject` and the `center` getter hand out fresh map-space objects, as the real one does.
 */
export class FakeTransformProvider {
  constructor(readonly host: FakeGeoHost) {}

  get center(): { lng: number; lat: number } {
    return { lng: this.host.transform.center.lng, lat: this.host.transform.center.lat };
  }

  unproject(point: unknown): FakeLngLat {
    return this.host.transform.screenPointToLocation(toPoint(point));
  }
}

/**
 * A 512 × 384 Mercator viewport. `project`/`unproject` are exact; `T` is exposed v5-style as
 * `transform`, and `R` as `_requestedCameraState`. Each camera method records its call and
 * applies `center`/`zoom`; none dispatches to another through the instance (v6's `Map`, whose
 * Camera chains never reach a Map-level wrapper). {@link FakeV5GeoHost} does.
 */
export class FakeGeoHost {
  readonly width = 512;
  readonly height = 384;
  zoom = 3;
  center = new FakeLngLat(0, 0); // map space
  calls: { name: string; args: unknown[] }[] = [];
  /** `R`, which v5 keeps on the map. */
  _requestedCameraState?: { center: unknown };
  /** Runs inside `stop()`: say, a stop's `moveend` that re-bases the camera. */
  onStop?: () => void;
  readonly keyboard = { _tr: new FakeTransformProvider(this) };
  readonly transform: {
    readonly width: number; readonly height: number; readonly center: FakeLngLat;
    screenPointToLocation(p: Point): FakeLngLat; isPointOnMapSurface(p: Point): boolean;
  };

  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const host = this;
    this.transform = {
      width: this.width,
      height: this.height,
      get center() { return host.center; },
      screenPointToLocation: (p) => host.#unproject(p),
      isPointOnMapSurface: () => true,
    };
  }

  get worldSize(): number { return 512 * 2 ** this.zoom; }

  #centreWorld(): [number, number] {
    const [x, y] = geographicToMapWorld([this.center.lng, this.center.lat], 1);
    return [x * this.worldSize, y * this.worldSize];
  }

  #unproject(p: Point): FakeLngLat {
    const [cx, cy] = this.#centreWorld();
    const wx = (cx + p.x - this.width / 2) / this.worldSize;
    const wy = (cy + p.y - this.height / 2) / this.worldSize;
    const [lng, lat] = mapWorldToGeographic([wx, wy], 1);
    return new FakeLngLat(lng, lat);
  }

  #apply(options: FakeCameraOptions | undefined): void {
    if (options?.center !== undefined) this.center = toLngLat(options.center);
    if (options?.zoom !== undefined) this.zoom = options.zoom;
  }

  project(lngLat: unknown): Point {
    this.calls.push({ name: 'project', args: [lngLat] });
    const [x, y] = geographicToMapWorld(toTuple(lngLat), 1);
    const [cx, cy] = this.#centreWorld();
    return { x: x * this.worldSize - cx + this.width / 2, y: y * this.worldSize - cy + this.height / 2 };
  }

  unproject(point: unknown): FakeLngLat {
    this.calls.push({ name: 'unproject', args: [point] });
    return this.#unproject(toPoint(point));
  }

  getCenter(): FakeLngLat {
    this.calls.push({ name: 'getCenter', args: [] });
    return new FakeLngLat(this.center.lng, this.center.lat);
  }

  getBounds(): FakeLngLatBounds {
    this.calls.push({ name: 'getBounds', args: [] });
    const nw = this.#unproject({ x: 0, y: 0 });
    const se = this.#unproject({ x: this.width, y: this.height });
    return new FakeLngLatBounds([nw.lng, se.lat], [se.lng, nw.lat]);
  }

  jumpTo(options: FakeCameraOptions, eventData?: unknown): this {
    this.calls.push({ name: 'jumpTo', args: [options, eventData] });
    this.#apply(options);
    return this;
  }

  setCenter(center: unknown, eventData?: unknown): this {
    this.calls.push({ name: 'setCenter', args: [center, eventData] });
    this.#apply({ center });
    return this;
  }

  easeTo(options: FakeCameraOptions, eventData?: unknown): this {
    this.calls.push({ name: 'easeTo', args: [options, eventData] });
    this.#apply(options);
    return this;
  }

  flyTo(options: FakeCameraOptions, eventData?: unknown): this {
    this.calls.push({ name: 'flyTo', args: [options, eventData] });
    this.#apply(options);
    return this;
  }

  panTo(lngLat: unknown, options?: FakeCameraOptions, eventData?: unknown): this {
    this.calls.push({ name: 'panTo', args: [lngLat, options, eventData] });
    this.#apply({ ...options, center: lngLat });
    return this;
  }

  panBy(offset: unknown, options?: FakeCameraOptions, eventData?: unknown): this {
    this.calls.push({ name: 'panBy', args: [offset, options, eventData] });
    this.#apply(options);
    return this;
  }

  zoomTo(zoom: number, options?: FakeCameraOptions, eventData?: unknown): this {
    this.calls.push({ name: 'zoomTo', args: [zoom, options, eventData] });
    this.#apply({ ...options, zoom });
    return this;
  }

  zoomIn(options?: FakeCameraOptions, eventData?: unknown): this {
    this.calls.push({ name: 'zoomIn', args: [options, eventData] });
    this.#apply({ ...options, zoom: this.zoom + 1 });
    return this;
  }

  zoomOut(options?: FakeCameraOptions, eventData?: unknown): this {
    this.calls.push({ name: 'zoomOut', args: [options, eventData] });
    this.#apply({ ...options, zoom: this.zoom - 1 });
    return this;
  }

  rotateTo(bearing: number, options?: FakeCameraOptions, eventData?: unknown): this {
    this.calls.push({ name: 'rotateTo', args: [bearing, options, eventData] });
    this.#apply(options);
    return this;
  }

  resetNorth(options?: FakeCameraOptions, eventData?: unknown): this {
    this.calls.push({ name: 'resetNorth', args: [options, eventData] });
    this.#apply(options);
    return this;
  }

  resetNorthPitch(options?: FakeCameraOptions, eventData?: unknown): this {
    this.calls.push({ name: 'resetNorthPitch', args: [options, eventData] });
    this.#apply(options);
    return this;
  }

  snapToNorth(options?: FakeCameraOptions, eventData?: unknown): this {
    this.calls.push({ name: 'snapToNorth', args: [options, eventData] });
    this.#apply(options);
    return this;
  }

  /**
   * Fit a map-space bbox `[[w, s], [e, n]]` to the viewport less a numeric `padding`:
   * `zoom = log2(min(w / dxWorld, h / dyWorld) / 512)`, world coordinates in [0, 1].
   */
  cameraForBounds(bounds: unknown, options?: FakeCameraOptions): { center: FakeLngLat; zoom: number; bearing: number } | undefined {
    this.calls.push({ name: 'cameraForBounds', args: [bounds, options] });
    const [sw, ne] = bounds as [unknown, unknown];
    return this.fitBox(sw, ne, options);
  }

  /** The fit itself: what v5's `_cameraForBoxAndBearing` computes. */
  protected fitBox(sw: unknown, ne: unknown, options?: FakeCameraOptions): { center: FakeLngLat; zoom: number; bearing: number } | undefined {
    const [x0, y1] = geographicToMapWorld(toTuple(sw), 1);
    const [x1, y0] = geographicToMapWorld(toTuple(ne), 1);
    const padding = options?.padding ?? 0;
    const scale = Math.min((this.width - 2 * padding) / (x1 - x0), (this.height - 2 * padding) / (y1 - y0));
    if (!(scale > 0) || !Number.isFinite(scale)) return undefined;
    const [lng, lat] = mapWorldToGeographic([(x0 + x1) / 2, (y0 + y1) / 2], 1);
    return { center: new FakeLngLat(lng, lat), zoom: Math.log2(scale / 512), bearing: options?.bearing ?? 0 };
  }

  /** Records only: the geographic API never calls the original. */
  fitBounds(bounds: unknown, options?: object, eventData?: unknown): this {
    this.calls.push({ name: 'fitBounds', args: [bounds, options, eventData] });
    return this;
  }

  stop(): this {
    this.calls.push({ name: 'stop', args: [] });
    this.onStop?.();
    return this;
  }

  lastCall(name: string): unknown[] {
    const call = this.calls.filter((c) => c.name === name).at(-1);
    if (!call) throw new Error(`no ${name} call`);
    return call.args;
  }
}

/** v5's `Map extends Camera`: the Camera chains dispatch through the instance, so they reach its wrappers. */
export class FakeV5GeoHost extends FakeGeoHost {
  override setCenter(center: unknown, eventData?: unknown): this {
    this.calls.push({ name: 'setCenter', args: [center, eventData] });
    return this.jumpTo({ center }, eventData);
  }

  /** As v5's Camera: `cameraForBounds` runs the box fit through the instance. */
  override cameraForBounds(bounds: unknown, options?: FakeCameraOptions): { center: FakeLngLat; zoom: number; bearing: number } | undefined {
    this.calls.push({ name: 'cameraForBounds', args: [bounds, options] });
    const [sw, ne] = bounds as [unknown, unknown];
    return this._cameraForBoxAndBearing(sw, ne, options?.bearing ?? 0, options);
  }

  _cameraForBoxAndBearing(p0: unknown, p1: unknown, bearing: number, options?: FakeCameraOptions): { center: FakeLngLat; zoom: number; bearing: number } | undefined {
    this.calls.push({ name: '_cameraForBoxAndBearing', args: [p0, p1, bearing, options] });
    return this.fitBox(p0, p1, { ...options, bearing });
  }

  override panBy(offset: unknown, options?: FakeCameraOptions, eventData?: unknown): this {
    this.calls.push({ name: 'panBy', args: [offset, options, eventData] });
    return this.panTo(this.transform.center, { ...options, offset }, eventData);
  }
}
