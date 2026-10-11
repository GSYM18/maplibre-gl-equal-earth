/* eslint-disable @typescript-eslint/unbound-method -- prototype methods are compared by identity */
import { describe, expect, it, vi } from 'vitest';

import { installEqualEarth, parseVersion } from '../src/install.js';

function fakeModule(version = '6.6.0', importResult: Promise<unknown> = Promise.resolve()) {
  class FakeMap {
    projection: unknown = undefined;
    setProjection(p: unknown) { this.projection = p; return this; }
    getProjection() { return this.projection; }
  }
  return {
    module: {
      getVersion: () => version,
      importScriptInWorkers: vi.fn<(url: string) => Promise<unknown>>(() => importResult),
      addProtocol: vi.fn(),
      getWorkerCount: vi.fn(() => 1),
      setWorkerCount: vi.fn(),
      LngLat: class { constructor(public lng: number, public lat: number) {} },
      Map: FakeMap,
    },
    FakeMap,
  };
}

describe('parseVersion', () => {
  it('reads major and minor', () => {
    expect(parseVersion('6.6.0')).toEqual({ major: 6, minor: 6 });
    expect(parseVersion('5.24.0-pre.1')).toEqual({ major: 5, minor: 24 });
  });
});

describe('installEqualEarth', () => {
  it('rejects MapLibre older than 5.24', async () => {
    await expect(installEqualEarth(fakeModule('5.23.1').module)).rejects.toThrow(/>= 5\.24.*5\.23\.1/);
    await expect(installEqualEarth(fakeModule('4.7.0').module)).rejects.toThrow(/>= 5\.24/);
  });

  it('loads the ESM worker on v6 and the classic one on v5', async () => {
    const v6 = fakeModule('6.6.0');
    await installEqualEarth(v6.module);
    expect(String(v6.module.importScriptInWorkers.mock.calls[0]![0])).toMatch(/worker\.mjs$/);
    const v5 = fakeModule('5.24.0');
    await installEqualEarth(v5.module);
    expect(String(v5.module.importScriptInWorkers.mock.calls[0]![0])).toMatch(/worker\.iife\.js$/);
  });

  it("raises the worker count from MapLibre's default of 1, but respects an app's own setting", async () => {
    vi.stubGlobal('navigator', { hardwareConcurrency: 12 });
    const a = fakeModule();
    await installEqualEarth(a.module);
    expect(a.module.setWorkerCount).toHaveBeenCalledWith(4);
    const b = fakeModule();
    b.module.getWorkerCount.mockReturnValue(3);
    await installEqualEarth(b.module);
    expect(b.module.setWorkerCount).not.toHaveBeenCalled();
    const c = fakeModule();
    await installEqualEarth(c.module, { workers: false });
    expect(c.module.setWorkerCount).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('falls back to a main-thread protocol when the worker script fails to load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { module } = fakeModule('6.6.0', Promise.reject(new Error('404')));
    const install = await installEqualEarth(module);
    expect(install.workerPath).toBe('main-thread');
    expect(module.addProtocol).toHaveBeenCalledWith('eqearth', expect.any(Function));
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('polyfills setProjection/getProjection on the prototype and restores them on uninstall', async () => {
    const { module, FakeMap } = fakeModule();
    const originalSet = FakeMap.prototype.setProjection;
    const install = await installEqualEarth(module);
    expect(FakeMap.prototype.setProjection).not.toBe(originalSet);
    const map = new FakeMap();
    // A plain Mercator projection passes straight through.
    map.setProjection({ type: 'mercator' });
    expect(map.getProjection()).toEqual({ type: 'mercator' });
    install.uninstall();
    expect(FakeMap.prototype.setProjection).toBe(originalSet);
  });

  it('routes the Equal Earth types to the controller and reports a failed activation on the map', async () => {
    const { module, FakeMap } = fakeModule();
    const install = await installEqualEarth(module);
    const map = new FakeMap() as InstanceType<typeof FakeMap> & { fire: (event: { type: string; error: unknown }) => void };
    const fired: { type: string; error: unknown }[] = [];
    map.fire = (event) => { fired.push(event); };
    const controller = install.controllerFor(map as never);
    const activate = vi.spyOn(controller, 'activate').mockRejectedValue(new Error('boom'));
    expect(map.setProjection({ type: 'equal' })).toBe(map);
    expect(activate).toHaveBeenCalledWith('equal');
    expect(map.projection).toBeUndefined(); // MapLibre's own setProjection was not called
    await vi.waitFor(() => expect(fired).toHaveLength(1));
    expect(fired[0]).toMatchObject({ type: 'error', error: new Error('boom') });
    install.uninstall();
  });
});
