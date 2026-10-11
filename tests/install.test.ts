import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { installEqualEarth, parseVersion } from '../src/install.js';
import type { StyleLike } from '../src/map/style-rewrite.js';
import { FakeControllerHost } from './support/fake-maplibre.js';

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

const liberty = (): StyleLike =>
  JSON.parse(readFileSync(new URL('./fixtures/liberty.json', import.meta.url), 'utf8')) as StyleLike;

/** A module whose `Map` is a controller host with MapLibre's own projection methods. */
function hostModule() {
  class Host extends FakeControllerHost {
    own: unknown = { type: 'mercator' };
    setProjection(p: unknown) { this.own = p; return this; }
    getProjection() { return this.own; }
  }
  const { module } = fakeModule();
  return { module: { ...module, Map: Host }, Host };
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
    try {
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
    } finally {
      vi.unstubAllGlobals();
    }
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

  it('falls back to the main thread when the worker script never loads (spec §8 timeout)', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { module } = fakeModule('6.6.0', new Promise<unknown>(() => {}));
      let settled = false;
      const pending = installEqualEarth(module).finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const install = await pending;
      expect(install.workerPath).toBe('main-thread');
      expect(module.addProtocol).toHaveBeenCalledWith('eqearth', expect.any(Function));
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]![0]).toMatch(/timed out after 10000 ms/);
      // The timeout is an option.
      const other = fakeModule('6.6.0', new Promise<unknown>(() => {}));
      const quick = installEqualEarth(other.module, { workerTimeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(50);
      expect((await quick).workerPath).toBe('main-thread');
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('clears its timer once the worker script has loaded', async () => {
    vi.useFakeTimers();
    try {
      const install = await installEqualEarth(fakeModule().module);
      expect(install.workerPath).toBe('worker');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('polyfills setProjection/getProjection on the prototype and restores them on uninstall', async () => {
    const { module, FakeMap } = fakeModule();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- compared by identity
    const originalSet = FakeMap.prototype.setProjection;
    const install = await installEqualEarth(module);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- compared by identity
    expect(FakeMap.prototype.setProjection).not.toBe(originalSet);
    const map = new FakeMap();
    // A plain Mercator projection passes straight through.
    map.setProjection({ type: 'mercator' });
    expect(map.getProjection()).toEqual({ type: 'mercator' });
    install.uninstall();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- compared by identity
    expect(FakeMap.prototype.setProjection).toBe(originalSet);
  });

  it('routes the Equal Earth types to the controller and fires a failed activation to error listeners (I1)', async () => {
    const { module, FakeMap } = fakeModule();
    const install = await installEqualEarth(module);
    const fired: { type: string; error: unknown }[] = [];
    const map = Object.assign(new FakeMap(), {
      listens: (type: string) => type === 'error',
      fire: (event: { type: string; error: unknown }) => { fired.push(event); },
    });
    const controller = install.controllerFor(map as never);
    const activate = vi.spyOn(controller, 'activate').mockRejectedValue(new Error('boom'));
    expect(map.setProjection({ type: 'equal' })).toBe(map);
    expect(activate).toHaveBeenCalledWith('equal');
    expect(map.projection).toBeUndefined(); // MapLibre's own setProjection was not called
    await vi.waitFor(() => expect(fired).toHaveLength(1));
    expect(fired[0]).toMatchObject({ type: 'error', error: new Error('boom') });
    install.uninstall();
  });

  it("logs a failed activation when nothing listens for errors, as MapLibre's Evented would not (I1)", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { module, FakeMap } = fakeModule();
      const install = await installEqualEarth(module);
      const fire = vi.fn();
      const map = Object.assign(new FakeMap(), { listens: () => false, fire });
      vi.spyOn(install.controllerFor(map as never), 'activate').mockRejectedValue(new Error('offline'));
      map.setProjection({ type: 'equal' });
      await vi.waitFor(() => expect(error).toHaveBeenCalledWith(new Error('offline')));
      expect(fire).not.toHaveBeenCalled();
      install.uninstall();
    } finally {
      error.mockRestore();
    }
  });

  it('does not report an activation a later setProjection superseded (M3)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { module, FakeMap } = fakeModule();
      const install = await installEqualEarth(module);
      const map = new FakeMap();
      const superseded = Object.assign(new Error('Equal Earth: activation superseded'), { name: 'EqualEarthSupersededError' });
      vi.spyOn(install.controllerFor(map as never), 'activate').mockRejectedValue(superseded);
      map.setProjection({ type: 'equal' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(error).not.toHaveBeenCalled();
      install.uninstall();
    } finally {
      error.mockRestore();
    }
  });

  it('getProjection falls back to MapLibre after a failed activation', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { module, Host } = hostModule();
      const install = await installEqualEarth(module, {
        fetchJson: async () => { throw new Error('offline'); },
      });
      const map = new Host([139.69, 35.69], 4.6);
      map.style = liberty();
      map.setProjection({ type: 'equal' });
      await vi.waitFor(() => expect(error).toHaveBeenCalled());
      expect(map.getProjection()).toEqual({ type: 'mercator' });
      install.uninstall();
    } finally {
      error.mockRestore();
    }
  });

  it('getProjection reports an Equal Earth type from setProjection on, before the activation commits (M3)', async () => {
    const { module, Host } = hostModule();
    let release!: (json: unknown) => void;
    const install = await installEqualEarth(module, {
      fetchJson: () => new Promise<unknown>((resolve) => { release = resolve; }),
    });
    const map = new Host([139.69, 35.69], 4.6);
    map.style = liberty();
    map.setProjection({ type: 'equal' });
    expect(install.controllerFor(map).projection).toBeUndefined(); // the TileJSON is still pending
    expect(map.getProjection()).toEqual({ type: 'equal' });
    release({ tiles: ['https://tiles.example/{z}/{x}/{y}.pbf'] });
    await vi.waitFor(() => expect(install.controllerFor(map).projection).toBe('equal'));
    map.setProjection({ type: 'equal-earth' });
    expect(map.getProjection()).toEqual({ type: 'equal-earth' });
    map.setProjection({ type: 'mercator' });
    expect(map.getProjection()).toEqual({ type: 'mercator' });
    install.uninstall();
  });

  it('a second install returns the first instead of chaining a second polyfill (M4)', async () => {
    const { module, FakeMap } = fakeModule();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- compared by identity
    const original = FakeMap.prototype.setProjection;
    const first = installEqualEarth(module);
    const concurrent = installEqualEarth(module, { workers: 2 });
    expect(concurrent).toBe(first);
    const install = await first;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- compared by identity
    const polyfill = FakeMap.prototype.setProjection;
    expect(await installEqualEarth(module)).toBe(install); // e.g. a Vite HMR re-run
    // eslint-disable-next-line @typescript-eslint/unbound-method -- compared by identity
    expect(FakeMap.prototype.setProjection).toBe(polyfill);
    expect(module.importScriptInWorkers).toHaveBeenCalledOnce();
    expect(module.setWorkerCount).toHaveBeenCalledOnce();
    // After uninstall the next install is a fresh one, over the original methods.
    install.uninstall();
    const again = await installEqualEarth(module);
    expect(again).not.toBe(install);
    again.uninstall();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- compared by identity
    expect(FakeMap.prototype.setProjection).toBe(original);
    // A failed install leaves nothing behind.
    const old = fakeModule('5.0.0');
    await expect(installEqualEarth(old.module)).rejects.toThrow(/>= 5\.24/);
    old.module.getVersion = () => '6.6.0';
    await expect(installEqualEarth(old.module)).resolves.toMatchObject({ version: '6.6.0' });
  });

  it('forgets a removed map: uninstall does not restore its style (I5)', async () => {
    const { module } = fakeModule();
    const install = await installEqualEarth(module, {
      fetchJson: async () => ({ tiles: ['https://tiles.example/{z}/{x}/{y}.pbf'] }),
    });
    const host = new FakeControllerHost([139.69, 35.69], 4.6);
    host.style = JSON.parse(readFileSync(new URL('./fixtures/liberty.json', import.meta.url), 'utf8')) as StyleLike;
    await install.controllerFor(host).activate('equal');
    const calls = host.setStyleCalls.length;
    host.fireMapEvent('remove');
    install.uninstall();
    expect(host.setStyleCalls).toHaveLength(calls);
    // A fresh controller is created for it after removal: the old one was dropped.
    expect(install.controllerFor(host).active).toBe(false);
  });
});
