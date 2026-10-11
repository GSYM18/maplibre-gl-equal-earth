import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { EqualEarthController } from '../src/map/controller.js';
import { REWRITTEN_METADATA_KEY, type StyleLike } from '../src/map/style-rewrite.js';
import { geographicToMap, mapToGeographic } from '../src/math/backproject.js';
import { FakeControllerHost } from './support/fake-maplibre.js';

const liberty = (): StyleLike => JSON.parse(readFileSync(new URL('./fixtures/liberty.json', import.meta.url), 'utf8')) as StyleLike;
const TILEJSON = { tiles: ['https://tiles.example/planet/{z}/{x}/{y}.pbf'], maxzoom: 14 };
const lngLatFactory = (lng: number, lat: number) => ({ lng, lat });
const TOKYO: [number, number] = [139.69, 35.69];

function setup(zoom = 4.6, style: StyleLike | undefined = liberty()) {
  const host = new FakeControllerHost(TOKYO, zoom);
  host.style = style;
  const fetchJson = vi.fn(async () => TILEJSON);
  const controller = new EqualEarthController(host, { lngLatFactory, fetchJson });
  return { host, controller, fetchJson };
}

describe('EqualEarthController', () => {
  it('activates: rewrites the style, converts the centre, disables world copies', async () => {
    const { host, controller, fetchJson } = setup();
    await controller.activate('equal');
    expect(controller.active).toBe(true);
    expect(controller.projection).toBe('equal');
    expect(fetchJson).toHaveBeenCalledWith(liberty().sources['openmaptiles']!['url']);
    expect(host.setStyleCalls.at(-1)).toMatchObject({ diff: true });
    expect(host.style!.metadata![REWRITTEN_METADATA_KEY]).toBeDefined();
    expect(host.style!.sources['openmaptiles__b1']).toBeDefined();
    expect(host.worldCopies).toBe(false);
    // z4.6 is band 1 (blend 1/6): the centre is now in that band's map space.
    const expected = geographicToMap(TOKYO, 1 / 6);
    expect(host.center.lng).toBeCloseTo(expected[0], 9);
    expect(host.center.lat).toBeCloseTo(expected[1], 9);
    expect(controller.blend).toBeCloseTo(1 / 6, 12);
    expect(controller.toGeographic([host.center.lng, host.center.lat])[0]).toBeCloseTo(TOKYO[0], 9);
    // C4: one camera update both converts the centre and settles the first offsets.
    expect(host.jumps).toBe(1);
  });

  it('waits for a style when activated before one is loaded (Review Focus 1)', async () => {
    const { host, controller } = setup(4.6, undefined);
    const pending = controller.activate('equal');
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    host.style = liberty();
    host.fireMapEvent('styledata');
    await pending;
    expect(controller.active).toBe(true);
  });

  it('rejects, and leaves the map untouched, when a TileJSON cannot be fetched', async () => {
    const host = new FakeControllerHost(TOKYO, 4.6);
    host.style = liberty();
    const controller = new EqualEarthController(host, { lngLatFactory, fetchJson: async () => { throw new Error('offline'); } });
    await expect(controller.activate('equal')).rejects.toThrow(/openmaptiles.*offline/);
    expect(host.setStyleCalls).toHaveLength(0);
    expect(controller.active).toBe(false);
    expect(host.worldCopies).toBe(true);
  });

  it('deactivates: restores the original style, the centre, world copies and the hooks', async () => {
    const { host, controller } = setup();
    const original = JSON.stringify(host.style);
    await controller.activate('equal');
    await controller.deactivate();
    expect(JSON.stringify(host.style)).toBe(original);
    expect(host.center.lng).toBeCloseTo(TOKYO[0], 9);
    expect(host.center.lat).toBeCloseTo(TOKYO[1], 9);
    expect(host.worldCopies).toBe(true);
    expect(host._camera.transformCameraUpdate).toBeNull();
    expect(host.constrain).toBeNull();
    expect(controller.active).toBe(false);
    expect(controller.blend).toBe(1);
  });

  it('re-applies when the application replaces the style while active', async () => {
    const { host, controller } = setup();
    await controller.activate('equal');
    const replacement = liberty();
    replacement.layers = replacement.layers.slice(0, 10);
    host.setStyle(replacement, {}); // the app's own call: no metadata → styledata → re-apply
    await vi.waitFor(() => expect(host.style!.metadata![REWRITTEN_METADATA_KEY]).toBeDefined());
    expect(host.style!.layers.length).toBeGreaterThan(10);
    await controller.deactivate();
    expect(host.style!.layers).toHaveLength(10); // the new original is what deactivate restores
  });

  it('equal-earth: one band, no compensation, raster relief removed', async () => {
    const { host, controller } = setup(2);
    await controller.activate('equal-earth');
    expect(host.style!.layers.some((l) => l.type === 'raster')).toBe(false);
    expect(controller.blend).toBe(0);
    host.applyFrame({ zoomDelta: 6 });
    expect(host.zoom).toBe(8);
    expect(host.bearing).toBe(0);
  });

  it('forwards switch events', async () => {
    const onSwitch = vi.fn();
    const host = new FakeControllerHost(TOKYO, 4.6);
    host.style = liberty();
    const controller = new EqualEarthController(host, { lngLatFactory, fetchJson: async () => TILEJSON, onSwitch });
    await controller.activate('equal');
    host.loaded.add('openmaptiles__b2');
    host.applyFrame({ zoomDelta: 0.4 }); // z5.0 → band 2
    expect(onSwitch).toHaveBeenCalledWith(expect.objectContaining({ from: 1, to: 2 }));
    expect(controller.toGeographic([host.center.lng, host.center.lat])[1]).toBeCloseTo(TOKYO[1], 6);
    void mapToGeographic;
  });

  it('installs nothing until the rewritten style has loaded (C7a)', async () => {
    const { host, controller } = setup();
    host.deferStyleData = true; // the full-rebuild path: styledata comes later
    host.loaded.add('openmaptiles__b2');
    const pending = controller.activate('equal');
    await vi.waitFor(() => expect(host.setStyleCalls).toHaveLength(1));
    host.applyFrame({ zoomDelta: 0.4 }); // a frame while the style is not loaded
    expect(host.writes).toHaveLength(0);
    expect(host.sourceChecks).toHaveLength(0);
    expect(host._camera.transformCameraUpdate).toBeNull();
    host.flushStyleData();
    await pending;
    expect(controller.active).toBe(true);
    expect(host._camera.transformCameraUpdate).not.toBeNull();
  });

  it('tears the switcher down before restoring the style, and no frame reads sources afterwards (C7b)', async () => {
    const { host, controller } = setup();
    await controller.activate('equal');
    const listenersAtSetStyle: number[] = [];
    const setStyle = host.setStyle.bind(host);
    host.setStyle = (style, options) => {
      listenersAtSetStyle.push(host.listenerCount('render'));
      return setStyle(style, options);
    };
    await controller.deactivate();
    expect(listenersAtSetStyle).toEqual([0]);
    host.loaded.add('openmaptiles__b2');
    const checks = host.sourceChecks.length;
    host.applyFrame({ zoomDelta: 0.4 });
    expect(host.sourceChecks).toHaveLength(checks);
  });

  it('keeps the centre fixed on a stale frame: a gesture interrupting an ease across a band (C5)', async () => {
    const { host, controller } = setup(); // z4.6, band 1, with compensation
    await controller.activate('equal');
    host.loaded.add('openmaptiles__b2');
    const geographic = () => controller.toGeographic([host.center.lng, host.center.lat]);
    // The ease crosses into band 2 on a requested state still in band 1's space.
    const ease = host.easeTo({ zooming: true });
    ease.frame({ zoomDelta: 0.3 });
    expect(controller.blend).toBeCloseTo(2 / 6, 12);
    expect(geographic()[0]).toBeCloseTo(TOKYO[0], 6);
    // The gesture takes the ease's state, then stops the ease: its moveend re-bases to band 2
    // and deletes the state, so this frame renders it detached, in band 1's space and offsets.
    host.applyFrame({ zoomDelta: 0.05 });
    expect(Math.abs(geographic()[0] - TOKYO[0])).toBeLessThan(1e-6);
    expect(Math.abs(geographic()[1] - TOKYO[1])).toBeLessThan(1e-6);
    // Read with the previous baseline's offsets: the rendered zoom is 4.95 plus at most half a step's offset.
    expect(Math.abs(host.zoom - 4.95)).toBeLessThan(0.07);
  });

  it('does nothing when activated twice with the same type, and switches type in place', async () => {
    const { host, controller } = setup();
    await controller.activate('equal');
    await controller.activate('equal');
    expect(host.setStyleCalls).toHaveLength(1);
    await controller.activate('equal-earth');
    expect(controller.projection).toBe('equal-earth');
    expect(controller.blend).toBe(0);
    expect(controller.toGeographic([host.center.lng, host.center.lat])[1]).toBeCloseTo(TOKYO[1], 9);
    await controller.deactivate();
    expect(host.worldCopies).toBe(true);
    expect(host.center.lat).toBeCloseTo(TOKYO[1], 9);
    expect(host.style!.metadata?.[REWRITTEN_METADATA_KEY]).toBeUndefined();
  });

  it('undoes the zoom and bearing offsets on deactivate', async () => {
    const { host, controller } = setup(4.5);
    await controller.activate('equal');
    // Mid-transition the rendered camera carries the compensation's offsets.
    expect(host.bearing).not.toBeCloseTo(0, 6);
    expect(host.zoom).not.toBeCloseTo(4.5, 6);
    await controller.deactivate();
    expect(host.bearing).toBeCloseTo(0, 9);
    expect(host.zoom).toBeCloseTo(4.5, 9);
  });

  it('maps coordinates through the shown band, and is the identity while inactive', async () => {
    const { controller } = setup();
    expect(controller.toMapSpace(TOKYO)).toEqual(TOKYO);
    expect(controller.toGeographic(TOKYO)).toEqual(TOKYO);
    await controller.activate('equal');
    const mapped = controller.toMapSpace(TOKYO);
    expect(mapped[0]).toBeCloseTo(geographicToMap(TOKYO, 1 / 6)[0], 12);
    expect(controller.toGeographic(mapped)[1]).toBeCloseTo(TOKYO[1], 9);
  });

  it('destroy deactivates and refuses to activate again', async () => {
    const { host, controller } = setup();
    await controller.activate('equal');
    await controller.destroy();
    expect(controller.active).toBe(false);
    expect(host.worldCopies).toBe(true);
    await expect(controller.activate('equal')).rejects.toThrow(/destroyed/);
  });

  describe('style events (I2)', () => {
    it("detaches inside an application's diffed setStyle: no frame reads sources or writes paint before the re-apply", async () => {
      const { host, controller } = setup();
      await controller.activate('equal');
      host.loaded.add('openmaptiles__b2');
      const replacement = liberty();
      replacement.layers = replacement.layers.slice(0, 10);
      const checks = host.sourceChecks.length;
      const writes = host.writes.length;
      host.setStyle(replacement, { diff: true }); // style.load fires inside the call
      host.applyFrame({ zoomDelta: 0.4 }); // the next frame, before the re-apply has finished
      expect(host.sourceChecks).toHaveLength(checks);
      expect(host.writes).toHaveLength(writes);
      await vi.waitFor(() => expect(host.style!.metadata?.[REWRITTEN_METADATA_KEY]).toBeDefined());
      expect(controller.active).toBe(true);
    });

    it('detaches on the styledataloading of a full rebuild, and re-applies on its style.load', async () => {
      const { host, controller } = setup();
      await controller.activate('equal');
      host.loaded.add('openmaptiles__b2');
      host.deferStyleData = true;
      const replacement = liberty();
      replacement.layers = replacement.layers.slice(0, 10);
      host.setStyle(replacement, { diff: false });
      expect(host._camera.transformCameraUpdate).toBeNull();
      const writes = host.writes.length;
      host.applyFrame({ zoomDelta: 0.4 }); // the style is unloaded: setPaintProperty would throw
      expect(host.writes).toHaveLength(writes);
      host.deferStyleData = false;
      host.flushStyleData();
      await vi.waitFor(() => expect(host.style!.metadata?.[REWRITTEN_METADATA_KEY]).toBeDefined());
      await controller.deactivate();
      expect(host.style!.layers).toHaveLength(10);
    });

    it('does not read the style on styledata (an app animating a paint property)', async () => {
      const { host, controller } = setup();
      await controller.activate('equal');
      const reads = host.getStyleCalls;
      for (let i = 0; i < 5; i++) host.fireMapEvent('styledata');
      expect(host.getStyleCalls).toBe(reads);
      expect(controller.active).toBe(true);
    });

    it('turns off and reports when a re-apply fails (I1)', async () => {
      const host = new FakeControllerHost(TOKYO, 4.6);
      host.style = liberty();
      const fetchJson = vi.fn(async (url: string) => {
        if (url.includes('offline')) throw new Error('offline');
        return TILEJSON;
      });
      const controller = new EqualEarthController(host, { lngLatFactory, fetchJson });
      await controller.activate('equal');
      host.on('error', () => {});
      const replacement = liberty();
      replacement.sources['openmaptiles']!['url'] = 'https://offline.example/planet';
      host.setStyle(replacement, {});
      await vi.waitFor(() => expect(controller.active).toBe(false));
      expect(host.errors).toEqual([expect.objectContaining({ message: expect.stringMatching(/openmaptiles.*offline/) as unknown })]);
      expect(host.worldCopies).toBe(true);
      expect(host.center.lat).toBeCloseTo(TOKYO[1], 9);
    });
  });

  it('starts again from a style the application set during the TileJSON fetch (I3)', async () => {
    const host = new FakeControllerHost(TOKYO, 4.6);
    host.style = liberty();
    let release!: (json: unknown) => void;
    const fetchJson = vi.fn(() => new Promise<unknown>((resolve) => { release = resolve; }));
    const controller = new EqualEarthController(host, { lngLatFactory, fetchJson });
    const pending = controller.activate('equal');
    await vi.waitFor(() => expect(fetchJson).toHaveBeenCalledOnce());
    const replacement = liberty();
    replacement.layers = replacement.layers.slice(0, 10);
    host.setStyle(replacement, {});
    release(TILEJSON);
    await pending;
    expect(host.style.layers.length).toBeGreaterThan(10);
    await controller.deactivate();
    expect(host.style.layers).toHaveLength(10);
  });

  it("draws with MapLibre's Mercator under a globe style, and restores the globe (I4)", async () => {
    const globe = liberty();
    globe['projection'] = { type: 'globe' };
    const { host, controller } = setup(4.6, globe);
    await controller.activate('equal');
    expect(host.style!['projection']).toEqual({ type: 'mercator' });
    await controller.deactivate();
    expect(host.style!['projection']).toEqual({ type: 'globe' });
  });

  describe('source fields (P14)', () => {
    it('carries the TileJSON attribution and minzoom, and the source promoteId, onto band sources', async () => {
      const style = liberty();
      style.sources['openmaptiles']!['promoteId'] = 'osm_id';
      const host = new FakeControllerHost(TOKYO, 4.6);
      host.style = style;
      const fetchJson = async () => ({ ...TILEJSON, minzoom: 0, attribution: '© OpenMapTiles © OpenStreetMap contributors' });
      await new EqualEarthController(host, { lngLatFactory, fetchJson }).activate('equal');
      expect(host.style.sources['openmaptiles__b1']).toMatchObject({
        attribution: '© OpenMapTiles © OpenStreetMap contributors',
        minzoom: 0,
        promoteId: 'osm_id',
      });
    });

    it('rejects a TMS source, inline or from its TileJSON, leaving the map untouched', async () => {
      const style = liberty();
      style.sources['openmaptiles']!['scheme'] = 'tms';
      const { host, controller } = setup(4.6, style);
      await expect(controller.activate('equal')).rejects.toThrow('Equal Earth: TMS tile schemes are not supported yet (source "openmaptiles").');
      expect(host.setStyleCalls).toHaveLength(0);
      const other = new FakeControllerHost(TOKYO, 4.6);
      other.style = liberty();
      const fromJson = new EqualEarthController(other, { lngLatFactory, fetchJson: async () => ({ ...TILEJSON, scheme: 'tms' }) });
      await expect(fromJson.activate('equal')).rejects.toThrow(/TMS/);
    });

    it('formats an inline source without tiles like an unresolvable TileJSON (M8)', async () => {
      const style = liberty();
      style.sources['openmaptiles'] = { type: 'vector', tiles: [] };
      const { controller } = setup(4.6, style);
      await expect(controller.activate('equal')).rejects.toThrow('Equal Earth: could not resolve TileJSON for source "openmaptiles": the source lists no tiles');
    });
  });

  it('rejects an activation that a deactivate superseded (M3)', async () => {
    const { controller } = setup();
    const pending = controller.activate('equal');
    await controller.deactivate();
    await expect(pending).rejects.toMatchObject({ name: 'EqualEarthSupersededError', message: 'Equal Earth: activation superseded' });
    expect(controller.active).toBe(false);
  });

  describe('rebuilds of our own style (N1)', () => {
    async function expectReinstalled(host: FakeControllerHost, controller: EqualEarthController) {
      await vi.waitFor(() => expect(host._camera.transformCameraUpdate).not.toBeNull());
      expect(host.constrain).not.toBeNull();
      expect(controller.toGeographic([host.center.lng, host.center.lat])[1]).toBeCloseTo(TOKYO[1], 9);
      // The switcher is back: the next frame crosses into band 2 as usual.
      host.loaded.add('openmaptiles__b2');
      host.applyFrame({ zoomDelta: 0.4 });
      expect(controller.blend).toBeCloseTo(2 / 6, 12);
      expect(controller.toGeographic([host.center.lng, host.center.lat])[1]).toBeCloseTo(TOKYO[1], 6);
    }

    it('re-installs after a WebGL context restore, with a diff that changes nothing (M4)', async () => {
      const { host, controller } = setup();
      await controller.activate('equal');
      host.restoreContext(); // styledataloading: everything is detached
      expect(host._camera.transformCameraUpdate).toBeNull();
      let loads = 0;
      host.on('style.load', () => { loads++; });
      host.render(); // the rebuild loads: styledata, style.load
      await expectReinstalled(host, controller);
      // Our re-apply's diff had no operations, so MapLibre fired nothing for it.
      expect(loads).toBe(1);
      expect(controller.active).toBe(true);
    });

    it("re-installs after the application's setStyle(getStyle(), { diff: false })", async () => {
      const { host, controller } = setup();
      await controller.activate('equal');
      host.setStyle(host.getStyle(), { diff: false });
      expect(host._camera.transformCameraUpdate).toBeNull();
      host.render();
      await expectReinstalled(host, controller);
      await controller.deactivate();
      expect(host.style!.metadata?.[REWRITTEN_METADATA_KEY]).toBeUndefined();
    });
  });

  it('starts again when the application changes only content during the TileJSON fetch (N2)', async () => {
    const host = new FakeControllerHost(TOKYO, 4.6);
    host.style = liberty();
    let release!: (json: unknown) => void;
    const fetchJson = vi.fn(() => new Promise<unknown>((resolve) => { release = resolve; }));
    const controller = new EqualEarthController(host, { lngLatFactory, fetchJson });
    const pending = controller.activate('equal');
    await vi.waitFor(() => expect(fetchJson).toHaveBeenCalledOnce());
    const dark = liberty(); // same sources and layer ids, different paint
    dark.layers[0]!.paint = { 'background-color': '#000' };
    host.setStyle(dark, {});
    release(TILEJSON);
    await pending;
    await controller.deactivate();
    expect(host.style.layers[0]!.paint).toEqual({ 'background-color': '#000' });
  });

  it('a type switch survives an application setStyle while it awaits its templates (N3)', async () => {
    const { host, controller } = setup();
    await controller.activate('equal');
    const switching = controller.activate('equal-earth');
    const replacement = liberty();
    replacement.layers = replacement.layers.slice(0, 10);
    host.setStyle(replacement, {}); // style.load while the switch has not committed
    await switching;
    expect(controller.projection).toBe('equal-earth');
    expect(controller.blend).toBe(0);
    expect(host._camera.transformCameraUpdate).not.toBeNull();
    await controller.deactivate();
    expect(host.style!.layers).toHaveLength(10);
  });

  it("does not install over a style an application style.load listener set inside our setStyle", async () => {
    const { host, controller } = setup();
    const appStyle = liberty();
    appStyle.layers = appStyle.layers.slice(0, 10);
    let swapped = false;
    host.on('style.load', () => {
      if (swapped || !host.style?.metadata?.[REWRITTEN_METADATA_KEY]) return;
      swapped = true;
      host.setStyle(appStyle, {});
    });
    await controller.activate('equal');
    expect(swapped).toBe(true);
    expect(host.style!.metadata?.[REWRITTEN_METADATA_KEY]).toBeDefined();
    expect(host.style!.layers.length).toBeGreaterThan(10);
    await controller.deactivate();
    expect(host.style!.layers).toHaveLength(10);
  });

  it('an activation a re-apply took over resolves only once that re-apply has installed (M3)', async () => {
    const host = new FakeControllerHost(TOKYO, 4.6);
    host.style = liberty();
    let release!: (json: unknown) => void;
    const fetchJson = vi.fn((url: string) =>
      url.includes('other') ? new Promise<unknown>((resolve) => { release = resolve; }) : Promise.resolve(TILEJSON),
    );
    const controller = new EqualEarthController(host, { lngLatFactory, fetchJson });
    host.deferStyleData = true; // our setStyle rebuilds: the activation waits for its load
    const pending = controller.activate('equal');
    let settled = false;
    void pending.then(() => { settled = true; });
    await vi.waitFor(() => expect(host.setStyleCalls).toHaveLength(1));
    // The application's rebuild overtakes ours; its re-apply must fetch another TileJSON.
    const replacement = liberty();
    replacement.sources['openmaptiles']!['url'] = 'https://tiles.example/other';
    host.deferStyleData = false;
    host.setStyle(replacement, { diff: false });
    host.render(); // the replacement loads: the re-apply starts and waits for its TileJSON
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    release(TILEJSON);
    await pending;
    expect(host._camera.transformCameraUpdate).not.toBeNull();
    expect(host.style.metadata?.[REWRITTEN_METADATA_KEY]).toBeDefined();
  });

  describe('failures of nested and overtaken applies', () => {
    /** Every listener the controller, camera or switcher may leave on the Map, plus the Camera's `moveend`. */
    const LISTENED = ['styledataloading', 'style.load', 'styledata', 'sourcedata', 'idle', 'render', 'moveend', 'dragend', 'zoomend', 'rotateend', 'pitchend', 'rollend'];
    const listeners = (host: FakeControllerHost) =>
      LISTENED.reduce((sum, type) => sum + host.listenerCount(type), 0) + host._camera.listenerCount('moveend');

    it("abandons and rejects when the style an application style.load listener swapped in cannot be resolved (F1)", async () => {
      const host = new FakeControllerHost(TOKYO, 4.6);
      host.style = liberty();
      const fetchJson = vi.fn(async (url: string) => {
        if (url.includes('offline')) throw new Error('offline');
        return TILEJSON;
      });
      const controller = new EqualEarthController(host, { lngLatFactory, fetchJson });
      const appStyle = liberty();
      appStyle.sources['openmaptiles']!['url'] = 'https://offline.example/planet';
      let swapped = false;
      host.on('style.load', () => {
        if (swapped || !host.style?.metadata?.[REWRITTEN_METADATA_KEY]) return;
        swapped = true;
        host.setStyle(appStyle, {});
      });
      const before = listeners(host);
      await expect(controller.activate('equal')).rejects.toThrow(/openmaptiles.*offline/);
      expect(swapped).toBe(true);
      expect(controller.active).toBe(false);
      expect(host._camera.transformCameraUpdate).toBeNull();
      expect(host.constrain).toBeNull();
      expect(host.style.metadata?.[REWRITTEN_METADATA_KEY]).toBeUndefined();
      expect(listeners(host)).toBe(before);
      // Nothing is left half-way: the next activation does the full work again.
      await expect(controller.activate('equal')).rejects.toThrow(/offline/);
      expect(controller.active).toBe(false);
    });

    it('falls back to re-applying the old type when a type switch fails during a stale re-apply (F2)', async () => {
      const host = new FakeControllerHost(TOKYO, 4.6);
      host.style = liberty();
      const held: ((json: unknown) => void)[] = [];
      let calls = 0;
      const fetchJson = vi.fn((url: string): Promise<unknown> => {
        if (!url.includes('other')) return Promise.resolve(TILEJSON);
        calls++;
        if (calls === 1) return new Promise((resolve) => { held.push(resolve); }); // the re-apply
        if (calls === 2) return Promise.reject(new Error('offline')); // the type switch
        return Promise.resolve(TILEJSON); // the fallback re-apply
      });
      const controller = new EqualEarthController(host, { lngLatFactory, fetchJson });
      await controller.activate('equal');
      const replacement = liberty();
      replacement.sources['openmaptiles']!['url'] = 'https://tiles.example/other';
      host.setStyle(replacement, {}); // the re-apply starts and waits for its TileJSON
      await vi.waitFor(() => expect(held).toHaveLength(1));
      await expect(controller.activate('equal-earth')).rejects.toThrow(/offline/);
      // The switch failed before committing: the old type is re-applied on the new original.
      await vi.waitFor(() => expect(host._camera.transformCameraUpdate).not.toBeNull());
      expect(controller.active).toBe(true);
      expect(controller.projection).toBe('equal');
      expect(host.style.metadata?.[REWRITTEN_METADATA_KEY]).toBeDefined();
      expect(calls).toBe(3); // the fallback fetched the new original's TileJSON itself
      // The overtaken re-apply resolves stale and changes nothing.
      const setStyles = host.setStyleCalls.length;
      held[0]!(TILEJSON);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(host.setStyleCalls).toHaveLength(setStyles);
      expect(controller.projection).toBe('equal');
    });

    /**
     * An activation that a re-apply took over (M3): our rebuild is overtaken by the
     * application's, whose re-apply waits for a TileJSON (`release` resolves it).
     */
    async function overtaken() {
      const host = new FakeControllerHost(TOKYO, 4.6);
      host.style = liberty();
      const held: { resolve: (json: unknown) => void; reject: (error: unknown) => void }[] = [];
      const fetchJson = vi.fn((url: string): Promise<unknown> =>
        url.includes('other') ? new Promise((resolve, reject) => { held.push({ resolve, reject }); }) : Promise.resolve(TILEJSON),
      );
      const controller = new EqualEarthController(host, { lngLatFactory, fetchJson });
      const before = listeners(host);
      host.deferStyleData = true;
      const pending = controller.activate('equal');
      await vi.waitFor(() => expect(host.setStyleCalls).toHaveLength(1));
      const replacement = liberty();
      replacement.sources['openmaptiles']!['url'] = 'https://tiles.example/other';
      host.deferStyleData = false;
      host.setStyle(replacement, { diff: false });
      host.render();
      await vi.waitFor(() => expect(held).toHaveLength(1));
      return { host, controller, pending, held, before };
    }

    it('rejects the overtaken activation when the re-apply fails (M3)', async () => {
      const { host, controller, pending, held, before } = await overtaken();
      host.on('error', () => {});
      held[0]!.reject(new Error('offline'));
      await expect(pending).rejects.toThrow(/openmaptiles.*offline/);
      expect(controller.active).toBe(false);
      expect(host.errors).toHaveLength(1);
      expect(host._camera.transformCameraUpdate).toBeNull();
      expect(listeners(host)).toBe(before);
    });

    it('rejects the overtaken activation when a type switch fails after committing (F3)', async () => {
      const { host, controller, pending, held, before } = await overtaken();
      // The switch's TileJSON resolves; the map then rejects its rewritten style (as on a
      // validation error), leaving the application's style in place.
      await vi.waitFor(() => expect(held).toHaveLength(1));
      const setStyle = host.setStyle.bind(host);
      host.setStyle = (style, options) => {
        if (style.metadata?.[REWRITTEN_METADATA_KEY] !== undefined) {
          host.setStyleCalls.push({ layers: style.layers.length, diff: options?.diff });
          return host;
        }
        return setStyle(style, options);
      };
      const switching = controller.activate('equal-earth');
      await vi.waitFor(() => expect(held).toHaveLength(2));
      held[1]!.resolve(TILEJSON);
      await expect(switching).rejects.toThrow(/did not accept/);
      await expect(pending).rejects.toThrow(/did not accept/);
      expect(controller.active).toBe(false);
      expect(host._camera.transformCameraUpdate).toBeNull();
      expect(host.center.lat).toBeCloseTo(TOKYO[1], 9);
      expect(listeners(host)).toBe(before);
    });

    it('deactivate during the pending re-apply restores the original and rejects the waiter', async () => {
      const { host, controller, pending, held, before } = await overtaken();
      await controller.deactivate();
      await expect(pending).rejects.toMatchObject({ name: 'EqualEarthSupersededError' });
      expect(controller.active).toBe(false);
      expect(host.style!.metadata?.[REWRITTEN_METADATA_KEY]).toBeUndefined();
      expect(host.style!.sources['openmaptiles']).toMatchObject({ url: 'https://tiles.example/other' });
      expect(host._camera.transformCameraUpdate).toBeNull();
      expect(host.worldCopies).toBe(true);
      expect(host.center.lat).toBeCloseTo(TOKYO[1], 9);
      expect(listeners(host)).toBe(before);
      // The re-apply resolves stale and touches nothing.
      const setStyles = host.setStyleCalls.length;
      held[0]!.resolve(TILEJSON);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(host.setStyleCalls).toHaveLength(setStyles);
      expect(controller.active).toBe(false);
    });

    it('dispose during the pending re-apply touches nothing and rejects the waiter', async () => {
      const { host, controller, pending, held, before } = await overtaken();
      const setStyles = host.setStyleCalls.length;
      const jumps = host.jumps;
      controller.dispose();
      await expect(pending).rejects.toMatchObject({ name: 'EqualEarthSupersededError' });
      expect(controller.active).toBe(false);
      expect(listeners(host)).toBe(before);
      held[0]!.resolve(TILEJSON);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(host.setStyleCalls).toHaveLength(setStyles);
      expect(host.jumps).toBe(jumps);
      expect(host._camera.transformCameraUpdate).toBeNull();
      await expect(controller.activate('equal')).rejects.toThrow(/destroyed/);
    });
  });
});
