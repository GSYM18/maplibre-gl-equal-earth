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
});
