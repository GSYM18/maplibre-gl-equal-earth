import { describe, expect, it } from 'vitest';

import { resolveTransition } from '../src/map/bands.js';
import type { LayerGate } from '../src/map/style-rewrite.js';
import { BandSwitcher, chooseBand, type SwitchEvent } from '../src/map/switcher.js';
import { FakeSwitcherHost } from './support/fake-maplibre.js';

const SIX = resolveTransition();
const idsFor = (band: number) => [band === 6 ? 'openmaptiles' : `openmaptiles__b${band}`];
const layerId = (id: string, band: number) => (band === 6 ? id : `${id}__b${band}`);
/** A fill and a symbol gate per band, the shape `rewriteStyle` produces. */
const gatesFor = (band: number): LayerGate[] => [
  { layerId: layerId('water', band), band, paint: { 'fill-opacity': 0.8 }, symbol: false },
  { layerId: layerId('place', band), band, paint: { 'text-opacity': 1, 'icon-opacity': undefined }, visibility: undefined, symbol: true },
];

/** Manual clock and timer queue so the dwell and fade are deterministic. */
function clock() {
  let now = 0;
  const timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
  return {
    now: () => now,
    schedule: (fn: () => void, ms: number) => { const t = { at: now + ms, fn, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; },
    advance(ms: number) { now += ms; for (const t of timers.splice(0)) { if (!t.cancelled && t.at <= now) t.fn(); else if (!t.cancelled) timers.push(t); } },
  };
}

function setup(initialBand = 1, zoom = 4.4) {
  const host = new FakeSwitcherHost();
  const c = clock();
  const events: SwitchEvent[] = [];
  let requested = zoom;
  const switcher = new BandSwitcher(host, {
    bands: SIX.bands, transition: SIX, sourceIdsForBand: idsFor, gatesForBand: gatesFor, initialBand,
    requestedZoom: () => requested, now: c.now, schedule: c.schedule, onSwitch: (e) => events.push(e),
  });
  switcher.start();
  return { host, c, events, switcher, zoomTo: (z: number) => { requested = z; return switcher.decide(z); } };
}

describe('chooseBand (spec §4.3 rules)', () => {
  const base = { bands: SIX.bands, transition: SIX, hysteresis: 0.1 };

  it("stays when the zoom's band is the shown band", () => {
    expect(chooseBand({ ...base, shown: 2, requestedZoom: 5.0, isReady: () => true })).toEqual({ band: 2, forced: false });
  });

  it("moves to the zoom's band when it is ready", () => {
    expect(chooseBand({ ...base, shown: 2, requestedZoom: 5.7, isReady: (k) => k === 3 })).toEqual({ band: 3, forced: false });
  });

  it('holds when the next band is not ready and the shown band is still parsed', () => {
    expect(chooseBand({ ...base, shown: 2, requestedZoom: 5.7, isReady: () => false })).toEqual({ band: 2, forced: false });
  });

  it('takes the nearest ready band towards the target when several are crossed at once', () => {
    expect(chooseBand({ ...base, shown: 2, requestedZoom: 7.0, isReady: (k) => k === 4 })).toEqual({ band: 4, forced: true });
  });

  it('forces the target when nothing is ready and the shown band is no longer parsed', () => {
    expect(chooseBand({ ...base, shown: 2, requestedZoom: 7.0, isReady: () => false })).toEqual({ band: 4, forced: true });
  });

  it('never picks a band that is not parsed at the zoom', () => {
    expect(chooseBand({ ...base, shown: 2, requestedZoom: 7.0, isReady: (k) => k === 1 })).toEqual({ band: 4, forced: true });
  });

  it('applies hysteresis when zooming back down', () => {
    expect(chooseBand({ ...base, shown: 3, requestedZoom: 5.55, isReady: () => true })).toEqual({ band: 3, forced: false });
    expect(chooseBand({ ...base, shown: 3, requestedZoom: 5.45, isReady: () => true })).toEqual({ band: 2, forced: false });
  });

  it('pure Equal Earth (no transition) always returns band 0', () => {
    expect(chooseBand({ bands: [{ minZoom: -Infinity, blend: 0 }], transition: null, hysteresis: 0.1, shown: 0, requestedZoom: 12, isReady: () => false })).toEqual({ band: 0, forced: false });
  });
});

describe('BandSwitcher', () => {
  it('shows the new band, fades the old one at once and hides its symbols after one fade', () => {
    const { host, c, zoomTo, events } = setup(1, 4.4);
    host.loaded.add('openmaptiles__b2');
    expect(zoomTo(4.9)).toBe(2);
    expect(host.paint['water__b2']).toEqual({ 'fill-opacity': 0.8 });
    expect(host.paint['place__b2']).toEqual({ 'text-opacity': 1, 'icon-opacity': undefined });
    expect(host.layout['place__b2']).toEqual({ visibility: undefined });
    expect(host.paint['water__b1']).toEqual({ 'fill-opacity': 0 });
    expect(host.paint['place__b1']).toEqual({ 'text-opacity': 0, 'icon-opacity': 0 });
    expect(host.layout['place__b1']).toBeUndefined();
    c.advance(299);
    expect(host.layout['place__b1']).toBeUndefined();
    c.advance(1);
    expect(host.layout['place__b1']).toEqual({ visibility: 'none' });
    expect(host.writes.filter((w) => w.layerId === 'water__b1')).toHaveLength(1);
    expect(events).toEqual([{ from: 1, to: 2, requestedZoom: 4.9, target: 2, forced: false, waitedMs: 0 }]);
  });

  it('holds while the next band loads, then wakes the camera once when it is ready', () => {
    const { host, zoomTo, c } = setup(1, 4.4);
    expect(zoomTo(4.9)).toBe(1);
    host.fire('sourcedata');
    expect(host.jumps).toBe(0);
    host.loaded.add('openmaptiles__b2');
    host.fire('sourcedata');
    host.fire('sourcedata');
    expect(host.jumps).toBe(1);
    c.advance(400);
    expect(zoomTo(4.9)).toBe(2);
  });

  it('does not wake the camera while the map is moving (the next frame decides anyway)', () => {
    const { host, zoomTo } = setup(1, 4.4);
    zoomTo(4.9);
    host.moving = true;
    host.loaded.add('openmaptiles__b2');
    host.fire('sourcedata');
    expect(host.jumps).toBe(0);
  });

  it('refuses a second voluntary switch inside the dwell, but not a forced one', () => {
    const { host, c, zoomTo } = setup(1, 4.4);
    host.loaded.add('openmaptiles__b2').add('openmaptiles__b3');
    expect(zoomTo(4.9)).toBe(2);
    c.advance(100);
    expect(zoomTo(5.7)).toBe(2);
    c.advance(250);
    expect(zoomTo(5.7)).toBe(3);
    expect(zoomTo(7.4)).toBe(5);
  });

  it('cancels a pending symbol hide when the band is shown again within the fade', () => {
    const { host, c, zoomTo } = setup(1, 4.4);
    host.loaded.add('openmaptiles__b2').add('openmaptiles__b1');
    zoomTo(4.9);
    c.advance(350);
    zoomTo(4.5);
    c.advance(300);
    expect(host.layout['place__b1']).toEqual({ visibility: undefined });
    expect(host.layout['place__b2']).toEqual({ visibility: 'none' });
    expect(host.paint['water__b1']).toEqual({ 'fill-opacity': 0.8 });
    expect(host.paint['water__b2']).toEqual({ 'fill-opacity': 0 });
  });

  it('reports the hold time of a switch', () => {
    const { host, c, zoomTo, events } = setup(1, 4.4);
    zoomTo(4.9);
    c.advance(1200);
    host.loaded.add('openmaptiles__b2');
    zoomTo(4.9);
    expect(events[0]!.waitedMs).toBe(1200);
  });

  it('unsubscribes and cancels timers on destroy', () => {
    const { host, c, zoomTo, switcher } = setup(1, 4.4);
    host.loaded.add('openmaptiles__b2');
    zoomTo(4.9);
    switcher.destroy();
    c.advance(1000);
    expect(host.layout['place__b1']).toBeUndefined();
    expect(host.listenerCount('sourcedata')).toBe(0);
    expect(host.listenerCount('idle')).toBe(0);
  });
});
