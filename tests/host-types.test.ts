/**
 * Compile-time guard: real MapLibre maps must satisfy the structural host interfaces.
 *
 * `npm run typecheck` (tsc over tests/) is what enforces this — the runtime assertion only
 * keeps vitest from reporting an empty file. It exists because v6 moved the camera hook
 * behind a setter, and a v5-shaped `CameraHost` silently stopped matching a real v6 map.
 */
import type { Map as MapV6 } from 'maplibre-gl';
import type { Map as MapV5 } from 'maplibre-gl-v5';
import { describe, expect, it } from 'vitest';

import type { CameraHost } from '../src/map/camera.js';
import type { ConstrainHost } from '../src/map/constrain.js';
import type { ControllerHost } from '../src/map/controller.js';
import type { MapLibreModule } from '../src/install.js';

const acceptsV6 = (map: MapV6): [CameraHost, ConstrainHost] => [map, map];
const acceptsV5 = (map: MapV5): [CameraHost, ConstrainHost] => [map, map];
const acceptsV6Controller = (map: MapV6): ControllerHost => map;
const acceptsV5Controller = (map: MapV5): ControllerHost => map;
const acceptsV6Module = (module: typeof import('maplibre-gl')): MapLibreModule => module;
const acceptsV5Module = (module: typeof import('maplibre-gl-v5')): MapLibreModule => module;

describe('host interfaces', () => {
  it('accept real v5 and v6 maps (enforced by the type checker)', () => {
    const guards = [acceptsV5, acceptsV6, acceptsV5Controller, acceptsV6Controller, acceptsV5Module, acceptsV6Module];
    expect(guards.map((guard) => typeof guard)).toEqual(Array(6).fill('function'));
  });
});
