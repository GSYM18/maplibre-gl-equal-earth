import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { EqualEarthController } from '../src/map/controller.js';
import { REWRITTEN_METADATA_KEY, type StyleLike } from '../src/map/style-rewrite.js';
import { geographicToMap, mapToGeographic } from '../src/math/backproject.js';
import { FakeControllerHost } from './support/fake-maplibre.js';
import { resolveTransition } from '../src/map/bands.js';
import { GEOJSON_MAX_DENSIFY_ZOOM, geojsonZoomForBand, warpGeoJSON } from '../src/map/geojson.js';

const liberty = (): StyleLike => JSON.parse(readFileSync(new URL('./fixtures/liberty.json', import.meta.url), 'utf8')) as StyleLike;
const TILEJSON = { tiles: ['https://tiles.example/planet/{z}/{x}/{y}.pbf'], maxzoom: 14 };
const lngLatFactory = (lng: number, lat: number) => ({ lng, lat });
const lngLatBoundsFactory = (sw: [number, number], ne: [number, number]) => ({ sw, ne });
const TOKYO: [number, number] = [139.69, 35.69];

function setup(zoom = 4.6, style: StyleLike | undefined = liberty()) {
  const host = new FakeControllerHost(TOKYO, zoom);
  host.style = style;
  const fetchJson = vi.fn(async () => TILEJSON);
  const controller = new EqualEarthController(host, { lngLatFactory, lngLatBoundsFactory, fetchJson });
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
    const controller = new EqualEarthController(host, { lngLatFactory, lngLatBoundsFactory, fetchJson: async () => { throw new Error('offline'); } });
    await expect(controller.activate('equal')).rejects.toThrow(/openmaptiles.*offline/);
    expect(host.setStyleCalls).toHaveLength(0);
    expect(controller.active).toBe(false);
    expect(host.worldCopies).toBe(true);
  });

  it('requestedZoom is the zoom without the band offset, and getZoom() while inactive', async () => {
    const { host, controller } = setup();
    expect(controller.requestedZoom).toBe(4.6);
    await controller.activate('equal');
    // The rendered zoom carries band 1's compensation offset; the requested one does not.
    expect(host.getZoom()).not.toBeCloseTo(4.6, 6);
    expect(controller.requestedZoom).toBeCloseTo(4.6, 9);
    await controller.deactivate();
    expect(controller.requestedZoom).toBe(host.getZoom());
  });

  it('dispose releases the camera hook and the constraint as well as the switcher', async () => {
    const { host, controller } = setup();
    await controller.activate('equal');
    expect(host._camera.transformCameraUpdate).not.toBeNull();
    expect(host.constrain).not.toBeNull();
    controller.dispose();
    expect(host._camera.transformCameraUpdate).toBeNull();
    expect(host.constrain).toBeNull();
  });

  it('deactivates: restores the original style, the centre, world copies and the hooks', async () => {
    const { host, controller } = setup();
    const original = structuredClone(host.style!);
    await controller.activate('equal');
    await controller.deactivate();
    // The diff cannot take away the minzoom the Mercator band put on the layers it kept under
    // their own ids (the fake models `setLayerZoomRange`), so those are restored at an explicit
    // 0: they draw from zoom 0 again, as before.
    const lifted = host.style!.layers.filter((l, i) => l.minzoom === 0 && original.layers[i]!.minzoom === undefined);
    expect(lifted.length).toBeGreaterThan(0);
    for (const layer of lifted) delete layer.minzoom;
    expect(host.style).toEqual(original);
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

  it("does not capture the Mercator band's zoom bounds from the application's diffed style", async () => {
    const { host, controller } = setup();
    await controller.activate('equal');
    const bandMin = host.style!.layers.find((l) => l.id === 'park')!.minzoom;
    expect(bandMin).toBeGreaterThan(0); // the Mercator band keeps the id, bounded in place
    const replacement = liberty();
    replacement.layers.find((l) => l.id === 'park')!.paint = { 'fill-color': '#4477aa' };
    host.setStyle(replacement, {}); // diffed: the fake, like MapLibre, keeps `park`'s minzoom
    await vi.waitFor(() => expect(host.style!.metadata![REWRITTEN_METADATA_KEY]).toBeDefined());
    // Every band below the Mercator one still has its copy, in the new colour.
    expect(host.style!.layers.find((l) => l.id === 'park__b0')).toMatchObject({ paint: { 'fill-color': '#4477aa' } });
    expect(host.style!.layers.find((l) => l.id === 'park__b0')!.minzoom).toBeUndefined();
    await controller.deactivate();
    expect(host.style!.layers.find((l) => l.id === 'park')!.minzoom ?? 0).toBe(0);
    // A bound the application's style really has is kept.
    expect(host.style!.layers.find((l) => l.id === 'landcover_wetland')!.minzoom).toBe(12);
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
    const controller = new EqualEarthController(host, { lngLatFactory, lngLatBoundsFactory, fetchJson: async () => TILEJSON, onSwitch });
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
    host.beforeSetStyle = () => {
      listenersAtSetStyle.push(host.listenerCount('render'));
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

  it('wraps a world-copy centre into [-180, 180] before converting it (M6)', async () => {
    const at = (center: [number, number]) => {
      const host = new FakeControllerHost(center, 4.6); // a world copy, with renderWorldCopies on
      host.style = liberty();
      return { host, controller: new EqualEarthController(host, { lngLatFactory, lngLatBoundsFactory, fetchJson: async () => TILEJSON }) };
    };
    const { host, controller } = at([TOKYO[0] + 360, TOKYO[1]]);
    await controller.activate('equal');
    const expected = geographicToMap(TOKYO, 1 / 6);
    expect(host.center.lng).toBeCloseTo(expected[0], 9);
    expect(host.center.lat).toBeCloseTo(expected[1], 9);
    const west = at([190, 10]);
    await west.controller.activate('equal');
    const geographic = west.controller.toGeographic([west.host.center.lng, west.host.center.lat]);
    expect(geographic[0]).toBeCloseTo(-170, 9);
    expect(geographic[1]).toBeCloseTo(10, 9);
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
      const controller = new EqualEarthController(host, { lngLatFactory, lngLatBoundsFactory, fetchJson });
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
    const controller = new EqualEarthController(host, { lngLatFactory, lngLatBoundsFactory, fetchJson });
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
      await new EqualEarthController(host, { lngLatFactory, lngLatBoundsFactory, fetchJson }).activate('equal');
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
      const fromJson = new EqualEarthController(other, { lngLatFactory, lngLatBoundsFactory, fetchJson: async () => ({ ...TILEJSON, scheme: 'tms' }) });
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
    const controller = new EqualEarthController(host, { lngLatFactory, lngLatBoundsFactory, fetchJson });
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
    const controller = new EqualEarthController(host, { lngLatFactory, lngLatBoundsFactory, fetchJson });
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
      const controller = new EqualEarthController(host, { lngLatFactory, lngLatBoundsFactory, fetchJson });
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
      const controller = new EqualEarthController(host, { lngLatFactory, lngLatBoundsFactory, fetchJson });
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
      const controller = new EqualEarthController(host, { lngLatFactory, lngLatBoundsFactory, fetchJson });
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
      host.beforeSetStyle = (style) => style.metadata?.[REWRITTEN_METADATA_KEY] !== undefined;
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

    it('settles an activation whose rebuild never loads because the map was removed (M2)', async () => {
      const { host, controller } = setup();
      host.deferStyleData = true; // our setStyle rebuilds; this rebuild will never load
      const pending = controller.activate('equal');
      await vi.waitFor(() => expect(host.setStyleCalls).toHaveLength(1));
      controller.dispose();
      await expect(pending).rejects.toMatchObject({ name: 'EqualEarthSupersededError' });
      expect(host.listenerCount('style.load')).toBe(0);
    });

    it('settles an activation whose rebuild a deactivate abandoned, and activates afresh (M2)', async () => {
      const { host, controller } = setup();
      host.deferStyleData = true;
      const pending = controller.activate('equal');
      await vi.waitFor(() => expect(host.setStyleCalls).toHaveLength(1));
      await controller.deactivate(); // the original's rebuild is pending too: no style.load yet
      await expect(pending).rejects.toMatchObject({ name: 'EqualEarthSupersededError' });
      host.deferStyleData = false;
      host.flushStyleData();
      await controller.activate('equal');
      expect(controller.active).toBe(true);
      expect(host._camera.transformCameraUpdate).not.toBeNull();
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

  describe('geographic API (Task 6)', () => {
    const own = (host: object, name: string): boolean => Object.prototype.hasOwnProperty.call(host, name);

    it('getCenter reads geographically while active, and after deactivate', async () => {
      const { host, controller } = setup();
      await controller.activate('equal');
      // T's centre is band 1's map space; the wrapped read is the geographic centre.
      expect(host.center.lng).not.toBeCloseTo(TOKYO[0], 3);
      const active = host.getCenter();
      expect(active.lng).toBeCloseTo(TOKYO[0], 9);
      expect(active.lat).toBeCloseTo(TOKYO[1], 9);
      await controller.deactivate();
      const after = host.getCenter();
      expect(after.lng).toBeCloseTo(TOKYO[0], 9);
      expect(after.lat).toBeCloseTo(TOKYO[1], 9);
    });

    it('offsetsAt is what the camera renders, and the baseline carries it (Ruling R11)', async () => {
      const { host, controller } = setup();
      expect(controller.offsetsAt(TOKYO, 1, 4.6)).toEqual({ deltaZoom: 0, deltaBearing: 0 }); // inactive
      await controller.activate('equal');
      const band = controller.bands.findIndex((b) => b.blend === controller.blend);
      const rendered = host.getZoom() - controller.requestedZoom;
      const offsets = controller.offsetsAt(TOKYO, band, controller.requestedZoom);
      expect(Math.abs(rendered)).toBeGreaterThan(1e-3); // compensation is on by default
      expect(offsets.deltaZoom).toBeCloseTo(rendered, 9);
      expect(controller.baselineOffsets.deltaZoom).toBeCloseTo(rendered, 9); // idle: the baseline is what rendered

      const none = new FakeControllerHost(TOKYO, 4.6);
      none.style = liberty();
      const plain = new EqualEarthController(none, { lngLatFactory, lngLatBoundsFactory, fetchJson: async () => TILEJSON, compensation: 'none' });
      await plain.activate('equal');
      expect(plain.offsetsAt(TOKYO, band, 4.6)).toEqual({ deltaZoom: 0, deltaBearing: 0 });
    });

    it('requires lngLatBoundsFactory unless geographicApi is false', () => {
      const host = new FakeControllerHost(TOKYO, 4.6);
      const fetchJson = async () => TILEJSON;
      // @ts-expect-error -- the type requires it too
      expect(() => new EqualEarthController(host, { lngLatFactory, fetchJson })).toThrow(/lngLatBoundsFactory/);
      // @ts-expect-error -- `true` is the default, and needs it as well
      expect(() => new EqualEarthController(host, { lngLatFactory, fetchJson, geographicApi: true })).toThrow(/lngLatBoundsFactory/);
      expect(() => new EqualEarthController(host, { lngLatFactory, fetchJson, geographicApi: false })).not.toThrow();
    });

    it('touches nothing on the map until the first activation', () => {
      const { host } = setup();
      expect(own(host, 'getCenter')).toBe(false);
    });

    it('with geographicApi: false, reads stay map space and nothing is wrapped', async () => {
      const host = new FakeControllerHost(TOKYO, 4.6);
      host.style = liberty();
      const controller = new EqualEarthController(host, { lngLatFactory, fetchJson: async () => TILEJSON, geographicApi: false });
      await controller.activate('equal');
      const expected = controller.toMapSpace(TOKYO);
      const centre = host.getCenter();
      expect(centre.lng).toBeCloseTo(expected[0], 9);
      expect(centre.lat).toBeCloseTo(expected[1], 9);
      expect(own(host, 'getCenter')).toBe(false);
    });

    it('dispose and destroy restore the wrapped methods', async () => {
      const a = setup();
      await a.controller.activate('equal');
      expect(own(a.host, 'getCenter')).toBe(true);
      a.controller.dispose();
      expect(own(a.host, 'getCenter')).toBe(false);
      const b = setup();
      await b.controller.activate('equal');
      await b.controller.destroy();
      expect(own(b.host, 'getCenter')).toBe(false);
    });

    it('toGeographic is finite for a point above the world', async () => {
      const { controller } = setup();
      await controller.activate('equal');
      const [lng, lat] = controller.toGeographic([0, 89]);
      expect(Number.isFinite(lng) && Number.isFinite(lat)).toBe(true);
      expect(lat).toBe(90);
    });

    it('exposes the bands and the baseline blend', async () => {
      const { controller } = setup();
      expect(controller.baselineBlend).toBe(1);
      await controller.activate('equal');
      expect(controller.bands).toHaveLength(7);
      expect(controller.baselineBlend).toBeCloseTo(1 / 6, 12);
      await controller.activate('equal-earth');
      expect(controller.bands).toHaveLength(1);
      expect(controller.baselineBlend).toBe(0);
    });
  });

  describe('unwarped layers notice', () => {
    async function fresh() {
      vi.resetModules();
      const mod = await import('../src/map/controller.js');
      const make = (style: StyleLike) => {
        const host = new FakeControllerHost(TOKYO, 4.6);
        host.style = style;
        return new mod.EqualEarthController(host, { lngLatFactory, lngLatBoundsFactory, fetchJson: async () => TILEJSON });
      };
      return make;
    }

    it('logs once per page when the style has raster layers', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      try {
        const make = await fresh();
        await make(liberty()).activate('equal');
        const raster = info.mock.calls.filter((c) => String(c[0]).includes('raster'));
        expect(raster).toHaveLength(1);
        await make(liberty()).activate('equal');
        expect(info.mock.calls.filter((c) => String(c[0]).includes('raster'))).toHaveLength(1);
      } finally {
        info.mockRestore();
      }
    });

    it('under pure equal-earth says the layers are hidden, without a Mercator band', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      try {
        const make = await fresh();
        await make(liberty()).activate('equal-earth');
        expect(info).toHaveBeenCalledTimes(1);
        const message = String(info.mock.calls[0]![0]);
        expect(message).toContain('hidden under pure Equal Earth');
        expect(message).not.toContain('Mercator band');
      } finally {
        info.mockRestore();
      }
    });

    it('logs nothing for a style without raster, hillshade or color-relief', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      try {
        const make = await fresh();
        const style = liberty();
        style.layers = style.layers.filter((l) => !['raster', 'hillshade', 'color-relief'].includes(l.type));
        await make(style).activate('equal');
        expect(info).not.toHaveBeenCalled();
      } finally {
        info.mockRestore();
      }
    });
  });
});

describe('GeoJSON sources (spec §7)', () => {
  const SIX = resolveTransition();
  const CITIES_URL = 'https://data.example/cities.json';
  const LATER_URL = 'https://data.example/later.json';
  const point = (id: number, coordinates: [number, number]): GeoJSON.Feature => ({ type: 'Feature', id, properties: { id }, geometry: { type: 'Point', coordinates } });
  const cities = (): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features: [point(1, [8.54, 47.37]), point(2, TOKYO)] });
  const onlyTokyo = (): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features: [point(2, TOKYO)] });
  const warped = (data: GeoJSON.GeoJSON, k: number) => warpGeoJSON(data, k / 6, geojsonZoomForBand(SIX, k));
  const BANDS = [0, 1, 2, 3, 4, 5];

  /** Liberty plus GeoJSON source `pts` (`data`) and a circle layer on it; `fetched` answers fetchJson by URL. */
  function geoSetup(data: unknown = cities(), fetched: Record<string, () => Promise<unknown>> = {}) {
    const style = liberty();
    style.sources['pts'] = { type: 'geojson', data };
    style.layers.push({ id: 'dots', type: 'circle', source: 'pts', paint: { 'circle-color': '#0000ff' } });
    const host = new FakeControllerHost(TOKYO, 4.6);
    host.style = style;
    const fetchJson = vi.fn(async (url: string) => (fetched[url] ? fetched[url]() : TILEJSON));
    const controller = new EqualEarthController(host, { lngLatFactory, lngLatBoundsFactory, fetchJson });
    return { host, controller, fetchJson };
  }
  const bandIds = (host: FakeControllerHost): string[] => [
    ...Object.keys(host.style!.sources).filter((id) => id.includes('__b')),
    ...host.style!.layers.map((l) => l.id).filter((id) => id.includes('__b')),
  ];

  it('resolves a GeoJSON source given by URL and fans it out warped to every band', async () => {
    const { host, controller, fetchJson } = geoSetup(CITIES_URL, { [CITIES_URL]: async () => cities() });
    await controller.activate('equal');
    expect(fetchJson).toHaveBeenCalledWith(CITIES_URL);
    for (const k of BANDS) expect(host.style!.sources[`pts__b${k}`]!['data']).toEqual(warped(cities(), k));
    expect(host.style!.sources['pts']!['data']).toBe(CITIES_URL); // the Mercator band keeps it
    expect(host.style!.layers.some((l) => l.id === 'dots__b1' && l.source === 'pts__b1')).toBe(true);
  });

  it('fetches a GeoJSON URL afresh on each activation, and once for the re-applies within one', async () => {
    let feed = cities();
    const { host, controller, fetchJson } = geoSetup(CITIES_URL, { [CITIES_URL]: async () => feed });
    const fetches = () => fetchJson.mock.calls.filter(([url]) => url === CITIES_URL).length;
    await controller.activate('equal');
    expect(fetches()).toBe(1);
    host.restoreContext(); // a re-apply within the activation: served from the cache
    host.render();
    await vi.waitFor(() => expect(host._camera.transformCameraUpdate).not.toBeNull());
    expect(fetches()).toBe(1);
    await controller.deactivate();
    feed = onlyTokyo(); // a live feed, polled meanwhile in Mercator
    await controller.activate('equal');
    expect(fetches()).toBe(2);
    expect(host.style!.sources['pts__b2']!['data']).toEqual(warped(onlyTokyo(), 2));
  });

  it('takes an application setData made in the same tick as activate (before the wrappers exist)', async () => {
    const { host, controller } = geoSetup();
    const pending = controller.activate('equal'); // e.g. setProjection({ type: 'equal' })
    host.geojsonSource('pts').setData(onlyTokyo());
    await pending;
    expect(host.style!.sources['pts']!['data']).toEqual(onlyTokyo());
    for (const k of BANDS) expect(host.style!.sources[`pts__b${k}`]!['data']).toEqual(warped(onlyTokyo(), k));
  });

  it('takes an application setData made in the same tick as its setStyle while active', async () => {
    const { host, controller } = geoSetup();
    await controller.activate('equal');
    const replacement = liberty();
    replacement.sources['pts'] = { type: 'geojson', data: cities() };
    replacement.layers.push({ id: 'dots', type: 'circle', source: 'pts', paint: { 'circle-color': '#0000ff' } });
    host.setStyle(replacement, {});
    host.geojsonSource('pts').setData(onlyTokyo()); // the wrappers are down until the re-apply installs
    await vi.waitFor(() => expect(host._camera.transformCameraUpdate).not.toBeNull());
    expect(host.style!.sources['pts']!['data']).toEqual(onlyTokyo());
    for (const k of BANDS) expect(host.style!.sources[`pts__b${k}`]!['data']).toEqual(warped(onlyTokyo(), k));
    await controller.deactivate();
    expect(host.style!.sources['pts']!['data']).toEqual(onlyTokyo());
  });

  it('resolves a URL set in the same tick as activate before rewriting', async () => {
    const { host, controller, fetchJson } = geoSetup(cities(), { [LATER_URL]: async () => onlyTokyo() });
    const pending = controller.activate('equal');
    host.geojsonSource('pts').setData(LATER_URL);
    await pending;
    expect(fetchJson).toHaveBeenCalledWith(LATER_URL);
    expect(host.style!.sources['pts']!['data']).toBe(LATER_URL);
    for (const k of BANDS) expect(host.style!.sources[`pts__b${k}`]!['data']).toEqual(warped(onlyTokyo(), k));
  });

  it('drops a URL fetch of an earlier activation that arrives after a re-activation', async () => {
    let arrive!: (data: unknown) => void;
    const { host, controller } = geoSetup(cities(), { [LATER_URL]: () => new Promise((resolve) => { arrive = resolve; }) });
    await controller.activate('equal');
    host.geojsonSource('pts').setData(LATER_URL);
    await controller.deactivate();
    host.geojsonSource('pts').setData(onlyTokyo()); // in Mercator: not wrapped
    await controller.activate('equal');
    arrive(cities());
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const k of BANDS) expect(host.style!.sources[`pts__b${k}`]!['data']).toEqual(warped(onlyTokyo(), k));
  });

  it('drops the fan-out of an updateData that a later setData overtook', async () => {
    const { host, controller } = geoSetup();
    await controller.activate('equal');
    const source = host.geojsonSource('pts');
    source.updateData({ add: [point(3, [-122.42, 37.77])] });
    source.setData(onlyTokyo());
    source.settleUpdate(onlyTokyo());
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const k of BANDS) expect(host.geojsonSource(`pts__b${k}`).argsOf('setData')).toEqual([warped(onlyTokyo(), k)]);
  });

  it('a fan-out arriving after deactivate touches nothing', async () => {
    let arrive!: (data: unknown) => void;
    const { host, controller } = geoSetup(cities(), { [LATER_URL]: () => new Promise((resolve) => { arrive = resolve; }) });
    await controller.activate('equal');
    const copies = BANDS.map((k) => host.geojsonSource(`pts__b${k}`));
    host.geojsonSource('pts').setData(LATER_URL);
    await controller.deactivate();
    const style = JSON.stringify(host.style);
    arrive(onlyTokyo());
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const copy of copies) expect(copy.argsOf('setData')).toEqual([]);
    expect(JSON.stringify(host.style)).toBe(style);
    expect(host.errors).toEqual([]);
  });

  it('rejects, and leaves the map untouched, when a GeoJSON fetch fails', async () => {
    const { host, controller } = geoSetup(CITIES_URL, { [CITIES_URL]: async () => { throw new Error('offline'); } });
    await expect(controller.activate('equal')).rejects.toThrow('Equal Earth: could not load GeoJSON for source "pts": offline');
    expect(host.setStyleCalls).toHaveLength(0);
    expect(controller.active).toBe(false);
    expect(host.worldCopies).toBe(true);
  });

  it("fans the application's setData out to every band; deactivate restores the new data and unwraps", async () => {
    const { host, controller } = geoSetup();
    await controller.activate('equal');
    const source = host.geojsonSource('pts');
    source.setData(onlyTokyo());
    expect(source.argsOf('setData')).toEqual([onlyTokyo()]);
    for (const k of BANDS) expect(host.geojsonSource(`pts__b${k}`).argsOf('setData')).toEqual([warped(onlyTokyo(), k)]);
    await controller.deactivate();
    expect(host.style!.sources['pts']!['data']).toEqual(onlyTokyo());
    expect(bandIds(host)).toEqual([]);
    expect(host.geojsonSource('pts')).toBe(source);
    expect(Object.hasOwn(source, 'setData')).toBe(false);
    expect(Object.hasOwn(source, 'updateData')).toBe(false);
  });

  it('fans out under pure Equal Earth to the one band', async () => {
    const { host, controller } = geoSetup();
    await controller.activate('equal-earth');
    expect(host.style!.sources['pts__b0']!['data']).toEqual(warpGeoJSON(cities(), 0, GEOJSON_MAX_DENSIFY_ZOOM));
    host.geojsonSource('pts').setData(onlyTokyo());
    expect(host.geojsonSource('pts__b0').argsOf('setData')).toEqual([warpGeoJSON(onlyTokyo(), 0, GEOJSON_MAX_DENSIFY_ZOOM)]);
  });

  it('keeps the data set while active through a re-apply, and wraps the new source objects', async () => {
    const { host, controller } = geoSetup();
    await controller.activate('equal');
    const before = host.geojsonSource('pts');
    before.setData(onlyTokyo());
    host.restoreContext(); // a full rebuild of our style: new source objects, re-applied from the original
    host.render();
    await vi.waitFor(() => expect(host._camera.transformCameraUpdate).not.toBeNull());
    expect(host.style!.sources['pts']!['data']).toEqual(onlyTokyo());
    expect(host.style!.sources['pts__b2']!['data']).toEqual(warped(onlyTokyo(), 2));
    const after = host.geojsonSource('pts');
    expect(after).not.toBe(before);
    after.setData(cities());
    expect(host.geojsonSource('pts__b3').argsOf('setData')).toEqual([warped(cities(), 3)]);
  });

  it('setData with a URL fans out what fetchJson returns once it arrives; the original keeps the URL', async () => {
    let arrive!: (data: unknown) => void;
    const { host, controller, fetchJson } = geoSetup(cities(), { [LATER_URL]: () => new Promise((resolve) => { arrive = resolve; }) });
    await controller.activate('equal');
    host.geojsonSource('pts').setData(LATER_URL);
    expect(fetchJson).toHaveBeenCalledWith(LATER_URL);
    expect(host.geojsonSource('pts__b1').argsOf('setData')).toEqual([]);
    arrive(onlyTokyo());
    await vi.waitFor(() => expect(host.geojsonSource('pts__b1').argsOf('setData')).toEqual([warped(onlyTokyo(), 1)]));
    await controller.deactivate();
    expect(host.style!.sources['pts']!['data']).toBe(LATER_URL);
  });

  it('drops a URL that arrives after a later setData', async () => {
    let arrive!: (data: unknown) => void;
    const { host, controller } = geoSetup(cities(), { [LATER_URL]: () => new Promise((resolve) => { arrive = resolve; }) });
    await controller.activate('equal');
    const source = host.geojsonSource('pts');
    source.setData(LATER_URL);
    source.setData(onlyTokyo());
    arrive(cities());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.geojsonSource('pts__b4').argsOf('setData')).toEqual([warped(onlyTokyo(), 4)]);
    await controller.deactivate();
    expect(host.style!.sources['pts']!['data']).toEqual(onlyTokyo());
  });

  it('fans the full data out after an updateData has landed, not before', async () => {
    const { host, controller } = geoSetup();
    await controller.activate('equal');
    const source = host.geojsonSource('pts');
    const merged: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [...cities().features, point(3, [-122.42, 37.77])] };
    source.updateData({ add: [point(3, [-122.42, 37.77])] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.geojsonSource('pts__b2').argsOf('setData')).toEqual([]); // the worker has not answered yet
    source.settleUpdate(merged);
    await vi.waitFor(() => expect(host.geojsonSource('pts__b2').argsOf('setData')).toEqual([warped(merged, 2)]));
    for (const k of BANDS) expect(host.geojsonSource(`pts__b${k}`).argsOf('setData')).toEqual([warped(merged, k)]);
    await controller.deactivate();
    expect(host.style!.sources['pts']!['data']).toEqual(merged);
  });

  it("captures an application's setStyle while active without band copies or warped data", async () => {
    const { host, controller } = geoSetup();
    await controller.activate('equal');
    host.geojsonSource('pts').setData(onlyTokyo());
    const replacement = liberty();
    replacement.sources['pts'] = { type: 'geojson', data: cities() };
    replacement.layers.push({ id: 'dots', type: 'circle', source: 'pts', paint: { 'circle-color': '#ff0000' } });
    host.setStyle(replacement, {}); // diffed: `pts` keeps its object and gets setData(cities)
    await vi.waitFor(() => expect(host._camera.transformCameraUpdate).not.toBeNull());
    expect(host.style!.sources['pts__b2']!['data']).toEqual(warped(cities(), 2));
    expect(host.style!.layers.find((l) => l.id === 'dots__b0')).toMatchObject({ paint: { 'circle-color': '#ff0000' } });
    expect(host.style!.layers.find((l) => l.id === 'dots__b0')!.minzoom).toBeUndefined();
    await controller.deactivate();
    expect(bandIds(host)).toEqual([]);
    expect(host.style!.sources['pts']!['data']).toEqual(cities());
    expect(host.style!.layers.find((l) => l.id === 'dots')!.minzoom ?? 0).toBe(0);
  });

  it('reports a failing fan-out instead of throwing into the application', async () => {
    const { host, controller } = geoSetup();
    await controller.activate('equal');
    host.on('error', () => undefined);
    expect(() => host.geojsonSource('pts').setData({ type: 'FeatureCollection' })).not.toThrow();
    expect(host.errors).toHaveLength(1);
    expect(String(host.errors[0])).toContain('pts');
  });

  it('an amend after a setData keeps the new data in every band copy', async () => {
    const { host, controller } = geoSetup();
    await controller.activate('equal');
    host.geojsonSource('pts').setData(onlyTokyo());
    host.addLayer({ id: 'dots2', type: 'circle', source: 'pts' });
    await Promise.resolve();
    expect(host.style!.layers.some((l) => l.id === 'dots2__b1')).toBe(true);
    for (const k of BANDS) {
      expect(host.style!.sources[`pts__b${k}`]!['data']).toEqual(warped(onlyTokyo(), k));
      // The amend's diff set no data on the copies: nothing stale was pushed back.
      expect(host.geojsonSource(`pts__b${k}`).argsOf('setData')).toEqual([warped(onlyTokyo(), k)]);
    }
  });

  it('re-warps an object the application mutated and set again', async () => {
    const { host, controller } = geoSetup();
    await controller.activate('equal');
    const data = cities();
    host.geojsonSource('pts').setData(data);
    data.features.pop();
    host.geojsonSource('pts').setData(data);
    expect(host.geojsonSource('pts__b2').argsOf('setData').at(-1)).toEqual(warped(data, 2));
    host.addLayer({ id: 'dots2', type: 'circle', source: 'pts' });
    await Promise.resolve();
    for (const k of BANDS) expect(host.style!.sources[`pts__b${k}`]!['data']).toEqual(warped(data, k));
  });

  it('bands a GeoJSON source the application adds by URL once fetched, in one amend, and follows its setData', async () => {
    let arrive!: (data: unknown) => void;
    const { host, controller, fetchJson } = geoSetup(cities(), { [LATER_URL]: () => new Promise((resolve) => { arrive = resolve; }) });
    await controller.activate('equal');
    const styles = host.setStyleCalls.length;
    host.addSource('more', { type: 'geojson', data: LATER_URL });
    host.addLayer({ id: 'more-dots', type: 'circle', source: 'more' });
    await Promise.resolve();
    expect(fetchJson).toHaveBeenCalledWith(LATER_URL);
    expect(host.setStyleCalls.length).toBe(styles); // waiting for the data
    host.addLayer({ id: 'more-dots-2', type: 'circle', source: 'more' }); // joins the waiting amend
    arrive(onlyTokyo());
    await vi.waitFor(() => expect(host.setStyleCalls.length).toBe(styles + 1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.setStyleCalls.length).toBe(styles + 1);
    for (const k of BANDS) expect(host.style!.sources[`more__b${k}`]!['data']).toEqual(warped(onlyTokyo(), k));
    expect(host.style!.layers.some((l) => l.id === 'more-dots-2__b3')).toBe(true);
    host.geojsonSource('more').setData(cities());
    expect(host.geojsonSource('more__b2').argsOf('setData')).toEqual([warped(cities(), 2)]);
    await controller.deactivate();
    expect(host.style!.sources['more']).toEqual({ type: 'geojson', data: cities() });
  });

  it('reports a GeoJSON source added by URL that cannot be loaded, and still amends the rest', async () => {
    const { host, controller } = geoSetup(cities(), { [LATER_URL]: async () => { throw new Error('offline'); } });
    await controller.activate('equal');
    host.on('error', () => undefined);
    expect(() => host.addSource('more', { type: 'geojson', data: LATER_URL })).not.toThrow();
    host.addLayer({ id: 'more-dots', type: 'circle', source: 'more' });
    host.addLayer({ id: 'extra', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation' });
    await vi.waitFor(() => expect(host.style!.layers.some((l) => l.id === 'extra__b1')).toBe(true));
    expect(host.errors).toHaveLength(1);
    expect(String(host.errors[0])).toContain('Equal Earth: could not load GeoJSON for source "more": offline');
    expect(host.style!.sources['more__b1']).toBeUndefined();
    expect(controller.active).toBe(true);
  });

  it('removeLayer and removeSource of a GeoJSON source remove its copies and unwrap it', async () => {
    const { host, controller } = geoSetup();
    await controller.activate('equal');
    host.on('error', () => undefined);
    host.removeSource('pts'); // `dots` still uses it: refused as MapLibre refuses it
    expect(String(host.errors[0])).toContain('Source "pts" cannot be removed while layer "dots" is using it.');
    const source = host.geojsonSource('pts');
    host.removeLayer('dots');
    host.removeSource('pts');
    await Promise.resolve();
    expect(bandIds(host).filter((id) => id.startsWith('pts') || id.startsWith('dots'))).toEqual([]);
    expect(Object.hasOwn(source, 'setData')).toBe(false);
    expect(host.styleErrors).toEqual([]);
    await controller.deactivate();
    expect(host.style!.sources['pts']).toBeUndefined();
  });
});

describe('live style edits (Task 9)', () => {
  const layerOf = (host: FakeControllerHost, id: string) => host.style!.layers.find((l) => l.id === id);
  const indexOf = (host: FakeControllerHost, id: string) => host.style!.layers.findIndex((l) => l.id === id);
  const copiesOf = (host: FakeControllerHost, id: string) =>
    host.style!.layers.filter((l) => l.id === id || (l.id.startsWith(`${id}__b`) && /^\d+$/.test(l.id.slice(id.length + 3)))).map((l) => l.id);
  const extra = (id: string, paint?: Record<string, unknown>) => ({
    id,
    type: 'line',
    source: 'openmaptiles',
    'source-layer': 'transportation',
    ...(paint ? { paint } : {}),
  });
  const LABEL = 'water_name_point_label';
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('coalesces ten addLayer calls into one amend that neither re-installs nor moves the camera', async () => {
    const { host, controller } = setup();
    await controller.activate('equal');
    const styles = host.setStyleCalls.length;
    const jumps = host.jumps;
    const hook = host._camera.transformCameraUpdate;
    for (let i = 0; i < 10; i++) {
      host.addLayer({ id: `extra${i}`, type: 'line', source: 'openmaptiles', 'source-layer': 'transportation' });
    }
    await Promise.resolve();
    expect(host.setStyleCalls.length).toBe(styles + 1);
    expect(host.jumps).toBe(jumps);
    expect(host._camera.transformCameraUpdate).toBe(hook);
    for (let i = 0; i < 10; i++) {
      expect(host.style!.layers.some((l) => l.id === `extra${i}__b1`)).toBe(true);
    }
    expect(host.styleErrors).toEqual([]);
  });

  it("starts added copies in the band that is shown, not the zoom's band", async () => {
    const { host, controller } = setup();
    await controller.activate('equal');
    host.applyFrame({ zoomDelta: 0.4 }); // z5.0 is band 2's, but band 2 has not loaded: band 1 is held
    expect(controller.blend).toBeCloseTo(1 / 6, 12);
    host.addLayer(extra('extra', { 'line-opacity': 0.7 }));
    await Promise.resolve();
    expect(layerOf(host, 'extra__b1')!.paint!['line-opacity']).toBe(0.7);
    expect(layerOf(host, 'extra__b2')!.paint!['line-opacity']).toBe(0);
    // MapLibre's diff touched nothing else: the shown band's copies keep their own values.
    expect(layerOf(host, 'water__b1')!.paint!['fill-opacity']).toBeUndefined();
    expect(layerOf(host, 'water__b2')!.paint!['fill-opacity']).toBe(0);
  });

  it('fans a paint change out to every copy and keeps gated values gated', async () => {
    const { host, controller } = setup(); // z4.6: band 1 shown
    await controller.activate('equal');
    host.setPaintProperty('water', 'fill-color', '#123456');
    for (const id of ['water__b0', 'water__b1', 'water__b5', 'water']) {
      expect(host.paint[id]?.['fill-color'], id).toBe('#123456');
    }
    host.setPaintProperty('water', 'fill-opacity', 0.5);
    expect(host.paint['water__b1']?.['fill-opacity']).toBe(0.5);
    expect(host.paint['water__b0']?.['fill-opacity'] ?? 0).toBe(0);
    // ...and a later band switch shows 0.5, not Liberty's own value:
    host.loaded.add('openmaptiles__b2');
    host.applyFrame({ zoomDelta: 0.4 });
    expect(host.paint['water__b2']?.['fill-opacity']).toBe(0.5);
    expect(host.styleErrors).toEqual([]);
    await controller.deactivate();
    expect(layerOf(host, 'water')!.paint).toEqual({ 'fill-color': '#123456', 'fill-opacity': 0.5 });
  });

  it('removeLayer removes every copy; edits pass through while inactive', async () => {
    const { host, controller } = setup();
    await controller.activate('equal');
    expect(copiesOf(host, 'water')).toHaveLength(7);
    host.removeLayer('water');
    expect(layerOf(host, 'water')).toBeUndefined(); // MapLibre's own call ran: the id is gone at once
    await Promise.resolve();
    expect(copiesOf(host, 'water')).toEqual([]);
    expect(host.styleErrors).toEqual([]);
    await controller.deactivate();
    expect(layerOf(host, 'water')).toBeUndefined(); // the restore keeps the removal
    const styles = host.setStyleCalls.length;
    const writes = host.writes.length;
    host.setPaintProperty('road_minor', 'line-color', '#ff0000');
    expect(host.writes.slice(writes)).toEqual([{ kind: 'paint', layerId: 'road_minor', name: 'line-color', value: '#ff0000' }]);
    host.addLayer(extra('later'));
    await tick();
    expect(host.setStyleCalls.length).toBe(styles);
    expect(copiesOf(host, 'later')).toEqual(['later']);
  });

  it("the switcher's gate writes on the Mercator band's ids are not application edits (rule 4)", async () => {
    const { host, controller } = setup(8.2);
    await controller.activate('equal');
    expect(controller.blend).toBe(1);
    const styles = host.setStyleCalls.length;
    host.loaded.add('openmaptiles__b5');
    host.applyFrame({ zoomDelta: -0.5 }); // z7.7: band 5 fades in, the Mercator band's `water` out
    expect(controller.blend).toBeCloseTo(5 / 6, 12);
    expect(host.writes).toContainEqual({ kind: 'paint', layerId: 'water', name: 'fill-opacity', value: 0 });
    expect(layerOf(host, 'water__b5')!.paint!['fill-opacity']).toBeUndefined(); // its own: unset
    for (const k of [0, 1, 2, 3, 4]) expect(layerOf(host, `water__b${k}`)!.paint!['fill-opacity'], `water__b${k}`).toBe(0);
    expect(layerOf(host, 'water')!.paint!['fill-opacity']).toBe(0);
    await tick();
    expect(host.setStyleCalls.length).toBe(styles); // no amend
    await controller.deactivate();
    expect(layerOf(host, 'water')!.paint).toEqual(liberty().layers.find((l) => l.id === 'water')!.paint);
  });

  it("keeps a symbol layer's visibility gated and fans other layout and filter edits out", async () => {
    const { host, controller } = setup();
    await controller.activate('equal');
    const filter = ['==', ['get', 'class'], 'lake'];
    host.setFilter('water', filter);
    for (const id of copiesOf(host, 'water')) expect(layerOf(host, id)!['filter'], id).toEqual(filter);
    host.setLayoutProperty(LABEL, 'text-size', 20);
    for (const id of copiesOf(host, LABEL)) expect(layerOf(host, id)!.layout!['text-size'], id).toBe(20);
    host.setLayoutProperty(LABEL, 'visibility', 'none');
    expect(layerOf(host, `${LABEL}__b1`)!.layout!['visibility']).toBe('none');
    host.setLayoutProperty(LABEL, 'visibility', 'visible');
    expect(layerOf(host, `${LABEL}__b1`)!.layout!['visibility']).toBe('visible');
    for (const id of [`${LABEL}__b0`, `${LABEL}__b2`, LABEL]) expect(layerOf(host, id)!.layout!['visibility'], id).toBe('none');
    expect(host.styleErrors).toEqual([]);
    await controller.deactivate();
    expect(layerOf(host, LABEL)!.layout).toMatchObject({ 'text-size': 20, visibility: 'visible' });
    expect(layerOf(host, 'water')!['filter']).toEqual(filter);
  });

  it('a value MapLibre refuses reaches neither the other copies nor the original', async () => {
    const { host, controller } = setup();
    await controller.activate('equal');
    const colour = liberty().layers.find((l) => l.id === 'water')!.paint!['fill-color'];
    host.setPaintProperty('water', 'fill-color', 'invalid');
    expect(host.styleErrors).toHaveLength(1); // one error, as without the plugin
    for (const id of copiesOf(host, 'water')) expect(layerOf(host, id)!.paint!['fill-color'], id).toBe(colour);
    host.addLayer(extra('extra'));
    await Promise.resolve();
    expect(layerOf(host, 'extra__b1')).toBeDefined(); // the amend is not poisoned
    await controller.deactivate();
    expect(layerOf(host, 'water')!.paint!['fill-color']).toBe(colour);
  });

  it('refuses a duplicate layer id and an unknown source as MapLibre does, without amending', async () => {
    const { host, controller } = setup();
    await controller.activate('equal');
    const styles = host.setStyleCalls.length;
    host.addLayer(extra('water'));
    host.addLayer({ id: 'nowhere', type: 'line', source: 'missing' });
    await tick();
    expect(host.styleErrors).toEqual(['Layer "water" already exists on this map.', 'Source "missing" not found']);
    expect(host.setStyleCalls.length).toBe(styles);
    expect(() => host.addSource('openmaptiles', { type: 'vector', tiles: ['x'] })).toThrow(/already exists/);
  });

  it('under pure Equal Earth, edits address the original ids although only band copies exist', async () => {
    const { host, controller } = setup(2);
    await controller.activate('equal-earth');
    expect(layerOf(host, 'water')).toBeUndefined();
    host.addLayer(extra('extra'), 'water');
    host.setPaintProperty('water', 'fill-color', '#123456');
    await Promise.resolve();
    expect(host.styleErrors).toEqual([]);
    expect(layerOf(host, 'extra')).toBeUndefined(); // no Mercator band
    expect(indexOf(host, 'extra__b0')).toBe(indexOf(host, 'water__b0') - 1);
    expect(layerOf(host, 'water__b0')!.paint!['fill-color']).toBe('#123456');
    host.removeLayer('extra');
    await Promise.resolve();
    expect(layerOf(host, 'extra__b0')).toBeUndefined();
    expect(host.styleErrors).toEqual([]);
    await controller.deactivate();
    expect(indexOf(host, 'extra')).toBe(-1);
    expect(layerOf(host, 'water')!.paint!['fill-color']).toBe('#123456');
  });

  it('inserts before the copies of beforeId, and the restore keeps the order', async () => {
    const { host, controller } = setup();
    await controller.activate('equal');
    host.addLayer(extra('extra'), 'water');
    await Promise.resolve();
    expect(indexOf(host, 'extra__b0')).toBeLessThan(indexOf(host, 'water__b0'));
    expect(indexOf(host, 'extra')).toBeLessThan(indexOf(host, 'water__b0'));
    await controller.deactivate();
    expect(indexOf(host, 'extra')).toBe(indexOf(host, 'water') - 1);
  });

  it('keeps edits the application makes while the activation fetches its TileJSON', async () => {
    const host = new FakeControllerHost(TOKYO, 4.6);
    host.style = liberty();
    let release!: (json: unknown) => void;
    const fetchJson = vi.fn(() => new Promise<unknown>((resolve) => { release = resolve; }));
    const controller = new EqualEarthController(host, { lngLatFactory, lngLatBoundsFactory, fetchJson });
    const pending = controller.activate('equal'); // e.g. setProjection, then addLayer in the same tick
    host.addLayer(extra('extra'));
    host.setPaintProperty('water', 'fill-color', '#123456');
    release(TILEJSON);
    await pending;
    expect(layerOf(host, 'extra__b1')).toBeDefined();
    expect(layerOf(host, 'water__b0')!.paint!['fill-color']).toBe('#123456');
    await controller.deactivate();
    expect(layerOf(host, 'extra')).toBeDefined();
  });

  it('an edit while a re-apply is in flight reaches the re-applied style', async () => {
    const { host, controller } = setup();
    await controller.activate('equal');
    const replacement = liberty();
    replacement.layers = replacement.layers.slice(0, 10);
    host.setStyle(replacement, {}); // the re-apply starts
    host.addLayer(extra('extra'));
    await vi.waitFor(() => expect(host._camera.transformCameraUpdate).not.toBeNull());
    await tick();
    expect(layerOf(host, 'extra__b1')).toBeDefined();
    await controller.deactivate();
    expect(host.style!.layers.map((l) => l.id)).toEqual([...replacement.layers.map((l) => l.id), 'extra']);
  });

  it("keeps what the application changed on the map's style outside the seven methods", async () => {
    const { host, controller } = setup();
    await controller.activate('equal');
    const light = { anchor: 'map', intensity: 0.7 };
    host.style!['light'] = light; // as `map.setLight(light)`
    host.addLayer(extra('extra'));
    await Promise.resolve();
    expect(host.style!['light']).toEqual(light);
    await controller.deactivate();
    expect(host.style!['light']).toEqual(light);
  });

  it('an amend leaves a band that is fading out as it is; its pending hide reads the new gates', async () => {
    const { host, controller } = setup();
    await controller.activate('equal');
    host.loaded.add('openmaptiles__b2');
    host.applyFrame({ zoomDelta: 0.4 }); // band 1 → 2: band 1's labels are hidden 300 ms later
    expect(controller.blend).toBeCloseTo(2 / 6, 12);
    expect(layerOf(host, `${LABEL}__b1`)!.layout?.['visibility']).toBeUndefined();
    host.addLayer({ id: 'more_labels', type: 'symbol', source: 'openmaptiles', 'source-layer': 'water_name', layout: { 'text-field': 'x' } });
    host.removeLayer('water_name_line_label');
    await Promise.resolve();
    // The diff neither hid the fading labels early nor dropped the held background.
    expect(layerOf(host, `${LABEL}__b1`)!.layout?.['visibility']).toBeUndefined();
    expect(layerOf(host, 'background__b1')!.paint!['background-opacity']).toBeUndefined();
    expect(layerOf(host, 'more_labels__b1')!.layout!['visibility']).toBe('none');
    expect(layerOf(host, 'more_labels__b2')!.layout?.['visibility']).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(layerOf(host, `${LABEL}__b1`)!.layout!['visibility']).toBe('none');
    expect(layerOf(host, 'background__b1')!.paint!['background-opacity']).toBe(0);
    expect(host.styleErrors).toEqual([]); // the removed layer's copies were not written
  });

  it('a paint edit on the background goes through the rewrite: the outside keeps its colour', async () => {
    const host = new FakeControllerHost(TOKYO, 4.6);
    host.style = liberty();
    const controller = new EqualEarthController(host, { lngLatFactory, lngLatBoundsFactory, fetchJson: async () => TILEJSON, outsideColor: '#000000' });
    await controller.activate('equal');
    host.setPaintProperty('background', 'background-color', '#eeeeee');
    await Promise.resolve();
    expect(layerOf(host, 'background__b1')!.paint!['background-color']).toBe('#000000');
    expect(layerOf(host, 'equal-earth:world__b1')!.paint!['fill-color']).toBe('#eeeeee');
    // A gated value is not written to the hidden Mercator background; the rewrite gates it.
    host.setPaintProperty('background', 'background-opacity', 0.5);
    expect(host.writes).not.toContainEqual({ kind: 'paint', layerId: 'background', name: 'background-opacity', value: 0.5 });
    await Promise.resolve();
    expect(layerOf(host, 'equal-earth:world__b1')!.paint!['fill-opacity']).toBe(0.5);
    expect(layerOf(host, 'background')!.paint!['background-opacity']).toBe(0);
    await controller.deactivate();
    expect(layerOf(host, 'background')!.paint!['background-color']).toBe('#eeeeee');
  });

  it('re-applies when MapLibre rebuilds an amended style instead of diffing it', async () => {
    const { host, controller } = setup();
    await controller.activate('equal');
    host.deferStyleData = true; // the amend's setStyle rebuilds
    host.addLayer(extra('extra'));
    await Promise.resolve();
    expect(host._camera.transformCameraUpdate).toBeNull(); // detached before any frame runs on the unloaded style
    host.deferStyleData = false;
    host.flushStyleData();
    await vi.waitFor(() => expect(host._camera.transformCameraUpdate).not.toBeNull());
    expect(layerOf(host, 'extra__b1')).toBeDefined();
    expect(controller.toGeographic([host.center.lng, host.center.lat])[1]).toBeCloseTo(TOKYO[1], 9);
  });

  describe('review fixes (R15–R18)', () => {
    const MINE = { id: 'mine', type: 'circle', source: 'minesrc' };
    const MINE_SOURCE = { type: 'geojson', data: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: TOKYO } }] } };
    /** The common "replace my layer" `style.load` listener; counts its calls (capped, so a loop ends). */
    const replacing = (host: FakeControllerHost) => {
      const counter = { calls: 0 };
      const listener = () => {
        if (++counter.calls > 50) return;
        if (host.getLayer('mine')) host.removeLayer('mine');
        if (host.getSource('minesrc')) host.removeSource('minesrc');
        host.addSource('minesrc', structuredClone(MINE_SOURCE));
        host.addLayer(structuredClone(MINE));
      };
      return { counter, listener };
    };
    /** The guarded `style.load` listener: adds its layer only when `getLayer` says it is missing. */
    const guarding = (host: FakeControllerHost) => () => {
      if (!host.getSource('minesrc')) host.addSource('minesrc', structuredClone(MINE_SOURCE));
      if (!host.getLayer('mine')) host.addLayer(structuredClone(MINE));
    };
    const withMine = () => {
      const style = liberty();
      style.sources['minesrc'] = structuredClone(MINE_SOURCE);
      style.layers.push(structuredClone(MINE));
      return style;
    };

    it('an amend fires no style.load: a replace-my-layer listener does not run, and one addLayer is one setStyle (R15)', async () => {
      const { host, controller } = setup();
      await controller.activate('equal');
      const { counter, listener } = replacing(host);
      host.on('style.load', listener);
      const styles = host.setStyleCalls.length;
      host.addLayer(extra('extra'));
      await tick();
      await tick();
      expect(counter.calls).toBe(0);
      expect(host.setStyleCalls.length).toBe(styles + 1);
      expect(layerOf(host, 'extra__b1')).toBeDefined();
    });

    it("an edit inside the plugin's own setStyle amends in a new macrotask, once (R15)", async () => {
      const { host, controller } = setup();
      const { counter, listener } = replacing(host);
      host.on('style.load', listener); // runs inside the activation's setStyle
      await controller.activate('equal');
      expect(counter.calls).toBe(1);
      await vi.waitFor(() => expect(layerOf(host, 'mine__b1')).toBeDefined());
      await tick();
      expect(counter.calls).toBe(1);
      expect(host.setStyleCalls).toHaveLength(2); // the activation, then one amend
      expect(host.styleErrors).toEqual([]);
    });

    it('a guarded listener re-adding its layer on a basemap switch is not refused (R16)', async () => {
      const { host, controller } = setup(4.6, withMine());
      host.on('error', () => undefined);
      host.on('style.load', guarding(host)); // registered before the controller's own listener
      await controller.activate('equal');
      host.setStyle(liberty(), {}); // a new basemap, without the application's layer
      await vi.waitFor(() => expect(host._camera.transformCameraUpdate).not.toBeNull());
      await vi.waitFor(() => expect(layerOf(host, 'mine__b1')).toBeDefined());
      expect(host.errors).toEqual([]);
      expect(host.styleErrors).toEqual([]);
      await controller.deactivate();
      expect(layerOf(host, 'mine')).toBeDefined();
    });

    it("the plugin's own setStyle bypasses the setStyle wrapper (R16)", async () => {
      const { host, controller } = setup();
      expect(Object.hasOwn(host, 'setStyle')).toBe(true);
      await controller.activate('equal');
      await controller.deactivate();
      await controller.destroy();
      expect(Object.hasOwn(host, 'setStyle')).toBe(false);
      expect(Object.hasOwn(host, 'fire')).toBe(false);
      for (const name of ['getLayer', 'getPaintProperty', 'getLayoutProperty', 'getFilter']) expect(Object.hasOwn(host, name), name).toBe(false);
    });

    it('a layer added from style.load during the activation ends up banded (R17)', async () => {
      const { host, controller } = setup();
      host.once('style.load', () => host.addLayer(extra('late')));
      await controller.activate('equal');
      await vi.waitFor(() => expect(layerOf(host, 'late__b1')).toBeDefined());
      expect(layerOf(host, 'late')!.minzoom).toBeGreaterThan(0); // the Mercator band's copy, ranged
    });

    it("a layer added from the rebuilt style's style.load ends up banded (R17)", async () => {
      const { host, controller } = setup();
      host.deferStyleData = true; // the activation's setStyle rebuilds; style.load comes on flush
      const pending = controller.activate('equal');
      await vi.waitFor(() => expect(host.setStyleCalls).toHaveLength(1));
      host.once('style.load', () => host.addLayer(extra('late'))); // after the rewrite, before the install
      host.deferStyleData = false;
      host.flushStyleData();
      await pending;
      await vi.waitFor(() => expect(layerOf(host, 'late__b1')).toBeDefined());
    });

    for (const [name, make] of [
      ['guarded', (host: FakeControllerHost) => guarding(host)],
      ['replace-my-layer', (host: FakeControllerHost) => replacing(host).listener],
    ] as const) {
      it(`a ${name} style.load listener raises no error under pure Equal Earth, across activation and an amend (R18)`, async () => {
        const { host, controller } = setup(2, withMine());
        host.on('error', () => undefined);
        host.on('style.load', make(host));
        await controller.activate('equal-earth');
        host.addLayer(extra('extra'));
        await tick();
        await tick();
        expect(host.errors).toEqual([]);
        expect(host.styleErrors).toEqual([]);
        expect(layerOf(host, 'mine__b0')).toBeDefined();
        expect(layerOf(host, 'extra__b0')).toBeDefined();
        expect(host.style!.layers.filter((l) => l.id === 'mine' || l.id.startsWith('mine__'))).toHaveLength(1);
      });
    }

    it('getLayer and the property getters resolve an id that is not live to the copy shown (R18)', async () => {
      const { host, controller } = setup(2);
      await controller.activate('equal-earth');
      expect((host.getLayer('water') as { id: string } | undefined)?.id).toBe('water__b0');
      host.setPaintProperty('water', 'fill-color', '#123456');
      expect(host.getPaintProperty('water', 'fill-color')).toBe('#123456');
      expect(host.getFilter('water')).toEqual(liberty().layers.find((l) => l.id === 'water')!['filter']);
      expect(host.getLayoutProperty(LABEL, 'visibility')).toBeUndefined();
      expect(host.getLayer('nowhere')).toBeUndefined();
      await controller.deactivate();
      expect((host.getLayer('water') as { id: string }).id).toBe('water');
    });

    it("queryRenderedFeatures's layers resolve as getLayer does, so a delegated layer listener raises no error (R18)", async () => {
      const { host, controller } = setup(2);
      await controller.activate('equal-earth');
      // MapLibre's `on('click', 'water', …)` filters its ids with `getLayer`, then queries them.
      const existing = ['water', 'nowhere'].filter((id) => host.getLayer(id));
      host.queryRenderedFeatures({ layers: existing });
      host.queryRenderedFeatures([0, 0], { layers: ['water'] });
      expect(host.styleErrors).toEqual([]);
      expect(host.queriedLayers).toEqual([['water__b0'], ['water__b0']]);
    });

    it("refuses a layer id a plugin layer holds, without keeping it (R18)", async () => {
      const { host, controller } = setup();
      host.on('error', () => undefined);
      await controller.activate('equal');
      host.addLayer(extra('water__b1'));
      host.addLayer({ id: 'equal-earth:world__b1', type: 'line', source: 'openmaptiles', 'source-layer': 'water' });
      expect(host.styleErrors).toEqual(['Layer "water__b1" already exists on this map.', 'Layer "equal-earth:world__b1" already exists on this map.']);
      host.addLayer(extra('extra'));
      await tick();
      expect(host.errors).toEqual([]); // the amend's rewrite does not collide
      expect(layerOf(host, 'extra__b1')).toBeDefined();
    });

    for (const [type, zoom, copy] of [['equal', 4.6, 'mine__b1'], ['equal-earth', 2, 'mine__b0']] as const) {
      it(`a basemap switch by URL (an async diff) is followed: a guarded listener registered first is neither refused nor thrown into, under ${type} (R19)`, async () => {
        const { host, controller } = setup(zoom, withMine());
        host.on('error', () => undefined);
        host.on('style.load', guarding(host)); // before the controller's own listener
        await controller.activate(type);
        // `setStyle(url)`: MapLibre fetches the style, then diffs it in through `Style.setState`,
        // which fires `style.load` from inside MapLibre, not from the application's call.
        const basemap = liberty();
        basemap.layers = basemap.layers.slice(0, 20);
        expect(() => FakeControllerHost.prototype.setStyle.call(host, basemap, {})).not.toThrow();
        await vi.waitFor(() => expect(host._camera.transformCameraUpdate).not.toBeNull());
        await vi.waitFor(() => expect(layerOf(host, copy)).toBeDefined());
        await tick();
        expect(host.errors).toEqual([]);
        expect(host.styleErrors).toEqual([]);
        expect(controller.active).toBe(true);
        expect(host.style!.metadata?.[REWRITTEN_METADATA_KEY]).toBeDefined();
        await controller.deactivate();
        expect(host.style!.layers.map((l) => l.id)).toEqual([...basemap.layers.map((l) => l.id), 'mine']); // captured
      });
    }

    it('a guarded listener registered after the controller re-adds its layer to a new basemap, banded (R19)', async () => {
      const { host, controller } = setup(4.6, withMine());
      host.on('error', () => undefined);
      await controller.activate('equal');
      host.on('style.load', guarding(host)); // after the controller's own: runs once the basemap is captured
      const basemap = liberty();
      basemap.layers = basemap.layers.slice(0, 20);
      host.setStyle(basemap, {});
      await vi.waitFor(() => expect(layerOf(host, 'mine__b1')).toBeDefined());
      await tick();
      expect(host.errors).toEqual([]);
      expect(host.styleErrors).toEqual([]);
      await controller.deactivate();
      expect(layerOf(host, 'mine')).toBeDefined();
    });

    it('an edit right after a basemap switch, while the re-apply resolves, is kept (R19)', async () => {
      const { host, controller } = setup();
      host.on('error', () => undefined);
      await controller.activate('equal');
      const basemap = liberty();
      basemap.layers = basemap.layers.slice(0, 20);
      host.setStyle(basemap, {}); // captured inside the call; the re-apply now awaits its templates
      host.addSource('minesrc', structuredClone(MINE_SOURCE)); // the live style is the application's
      host.addLayer(structuredClone(MINE));
      await vi.waitFor(() => expect(host._camera.transformCameraUpdate).not.toBeNull());
      await tick();
      expect(layerOf(host, 'mine__b1')).toBeDefined();
      expect(host.errors).toEqual([]);
      expect(host.styleErrors).toEqual([]);
    });

    it('removeSource and addSource of an original source that is not live behave as natively (R18)', async () => {
      const { host, controller } = setup(4.6, withMine());
      host.on('error', () => undefined);
      await controller.activate('equal-earth');
      host.removeLayer('mine');
      delete host.style!.sources['minesrc']; // stands in for an original source the live style lacks
      expect(() => host.removeSource('minesrc')).not.toThrow();
      await tick();
      expect(host.errors).toEqual([]);
      host.addSource('minesrc', structuredClone(MINE_SOURCE));
      delete host.style!.sources['minesrc'];
      expect(() => host.addSource('minesrc', structuredClone(MINE_SOURCE))).toThrow('Source "minesrc" already exists.');
    });
  });

  it('destroy and dispose restore the seven methods', async () => {
    const own = (host: object, name: string): boolean => Object.prototype.hasOwnProperty.call(host, name);
    const methods = ['addSource', 'removeSource', 'addLayer', 'removeLayer', 'setPaintProperty', 'setLayoutProperty', 'setFilter'];
    const a = setup();
    for (const name of methods) expect(own(a.host, name), name).toBe(true);
    await a.controller.activate('equal');
    a.controller.dispose();
    for (const name of methods) expect(own(a.host, name), name).toBe(false);
    const b = setup();
    await b.controller.destroy();
    for (const name of methods) expect(own(b.host, name), name).toBe(false);
  });
});
