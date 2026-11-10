/**
 * Compile-time guard: real MapLibre maps must satisfy the structural host interfaces.
 *
 * `npm run typecheck` (tsc over tests/) is what enforces this — the runtime assertion only
 * keeps vitest from reporting an empty file. It exists because v6 moved the camera hook
 * behind a setter, and a `CameraHost` shaped for MapLibre 5 silently stopped matching a real
 * v6 map. (MapLibre 5 is no longer supported, so only v6 is checked.)
 */
import type { Map as MapV6 } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';

import type { CameraHost } from '../src/map/camera.js';
import type { ConstrainHost } from '../src/map/constrain.js';
import type { ControllerHost } from '../src/map/controller.js';
import type { ControlHost } from '../src/map/control.js';
import type { GeoApiHost, GeoCameraMethods } from '../src/map/geo-api.js';
import type { MapLibreModule } from '../src/install.js';

const acceptsV6 = (map: MapV6): [CameraHost, ConstrainHost] => [map, map];
const acceptsV6Controller = (map: MapV6): ControllerHost => map;
const acceptsV6Control = (map: MapV6): ControlHost => map;
const acceptsV6Geo = (map: MapV6): GeoApiHost => map;
// The camera targets the controller wraps when present (ControllerHost has them optional).
const acceptsV6GeoCamera = (map: MapV6): GeoCameraMethods => map;
const acceptsV6Module = (module: typeof import('maplibre-gl')): MapLibreModule => module;

describe('host interfaces', () => {
  it('accept real v6 maps (enforced by the type checker)', () => {
    const guards = [acceptsV6, acceptsV6Controller, acceptsV6Module, acceptsV6Control, acceptsV6Geo, acceptsV6GeoCamera];
    expect(guards.map((guard) => typeof guard)).toEqual(Array(6).fill('function'));
  });
});
