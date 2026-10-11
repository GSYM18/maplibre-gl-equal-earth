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

/** A 512 × 384 Mercator viewport. `project`/`unproject` are exact; `T` is exposed v5-style as `transform`. */
export class FakeGeoHost {
  readonly width = 512;
  readonly height = 384;
  zoom = 3;
  center = new FakeLngLat(0, 0); // map space
  calls: { name: string; args: unknown[] }[] = [];
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

  jumpTo(options: { center?: unknown; zoom?: number }): this {
    this.calls.push({ name: 'jumpTo', args: [options] });
    if (options.center !== undefined) this.center = new FakeLngLat(...toTuple(options.center));
    if (options.zoom !== undefined) this.zoom = options.zoom;
    return this;
  }

  lastCall(name: string): unknown[] {
    const call = this.calls.filter((c) => c.name === name).at(-1);
    if (!call) throw new Error(`no ${name} call`);
    return call.args;
  }
}
