import { describe, expect, it } from 'vitest';

import { resolveTransition } from '../src/map/bands.js';
import type { LayerGate } from '../src/map/style-rewrite.js';
import { BandSwitcher, chooseBand, type SwitchEvent, type SwitcherOptions } from '../src/map/switcher.js';
import { FakeSwitcherHost } from './support/fake-maplibre.js';

const SIX = resolveTransition();
const idsFor = (band: number) => [band === 6 ? 'openmaptiles' : `openmaptiles__b${band}`];
const layerId = (id: string, band: number) => (band === 6 ? id : `${id}__b${band}`);
/** A fill and a symbol gate per band, the shape `rewriteStyle` produces. */
const gatesFor = (band: number): LayerGate[] => [
  { layerId: layerId('water', band), band, paint: { 'fill-opacity': 0.8 }, hideByVisibility: false },
  { layerId: layerId('place', band), band, paint: { 'text-opacity': 1, 'icon-opacity': undefined }, visibility: undefined, hideByVisibility: true },
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

function setup(initialBand = 1, zoom = 4.4, extra: Partial<SwitcherOptions> = {}) {
  const host = new FakeSwitcherHost();
  const c = clock();
  const events: SwitchEvent[] = [];
  let requested = zoom;
  const switcher = new BandSwitcher(host, {
    bands: SIX.bands, transition: SIX, sourceIdsForBand: idsFor, gatesForBand: gatesFor, initialBand,
    requestedZoom: () => requested, now: c.now, schedule: c.schedule, onSwitch: (e) => events.push(e), ...extra,
  });
  switcher.start();
  host.onJump = () => { switcher.decide(requested); };
  host.zoom = zoom;
  host.fire('render'); // the first frame: readiness is judged at the last rendered zoom
  return { host, c, events, switcher, zoomTo: (z: number) => { requested = z; host.zoom = z; const r = switcher.decide(z); host.fire('render'); return r; } };
}

describe('chooseBand (spec §4.3 rules)', () => {
  const base = { bands: SIX.bands, transition: SIX, hysteresis: 0.1 };

  it("stays when the zoom's band is the shown band", () => {
    expect(chooseBand({ ...base, shown: 2, requestedZoom: 5.0, isReady: () => true })).toMatchObject({ band: 2, forced: false });
  });

  it("moves to the zoom's band when it is ready", () => {
    expect(chooseBand({ ...base, shown: 2, requestedZoom: 5.7, isReady: (k) => k === 3 })).toMatchObject({ band: 3, forced: false });
  });

  it('holds when the next band is not ready and the shown band is still parsed', () => {
    expect(chooseBand({ ...base, shown: 2, requestedZoom: 5.7, isReady: () => false })).toMatchObject({ band: 2, forced: false });
  });

  it('takes the nearest ready band towards the target when several are crossed at once', () => {
    expect(chooseBand({ ...base, shown: 2, requestedZoom: 7.0, isReady: (k) => k === 4 })).toMatchObject({ band: 4, forced: true });
  });

  it('forces the target when nothing is ready and the shown band is no longer parsed', () => {
    expect(chooseBand({ ...base, shown: 2, requestedZoom: 7.0, isReady: () => false })).toMatchObject({ band: 4, forced: true });
  });

  it('never picks a band that is not parsed at the zoom', () => {
    expect(chooseBand({ ...base, shown: 2, requestedZoom: 7.0, isReady: (k) => k === 1 })).toMatchObject({ band: 4, forced: true });
  });

  it('applies hysteresis when zooming back down', () => {
    expect(chooseBand({ ...base, shown: 3, requestedZoom: 5.55, isReady: () => true })).toMatchObject({ band: 3, forced: false });
    expect(chooseBand({ ...base, shown: 3, requestedZoom: 5.45, isReady: () => true })).toMatchObject({ band: 2, forced: false });
  });

  it('picks an intermediate ready band when the target is not ready', () => {
    expect(chooseBand({ ...base, shown: 2, requestedZoom: 7.3, isReady: (k) => k === 4 })).toEqual({ band: 4, forced: true, target: 5 });
  });

  it('forces a switch when the rendered zoom left the held band even though the requested one has not', () => {
    // Band 3 is parsed on [4.8, 7.2); requested 6.45 (target 4, not ready) alone would hold it.
    expect(chooseBand({ ...base, shown: 3, requestedZoom: 6.45, isReady: () => false })).toMatchObject({ band: 3, forced: false });
    expect(chooseBand({ ...base, shown: 3, requestedZoom: 6.45, renderedZoom: 7.25, isReady: () => false })).toMatchObject({ band: 4, forced: true });
    // The mirror at the low end: band 2 is parsed on [4, 6.4); requested 4.55 holds, rendered 3.95 is out.
    expect(chooseBand({ ...base, shown: 2, requestedZoom: 4.55, renderedZoom: 3.95, isReady: () => false })).toMatchObject({ band: 1, forced: true });
  });

  it('pure Equal Earth (no transition) always returns band 0', () => {
    expect(chooseBand({ bands: [{ minZoom: -Infinity, blend: 0 }], transition: null, hysteresis: 0.1, shown: 0, requestedZoom: 12, isReady: () => false })).toMatchObject({ band: 0, forced: false });
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
    const { host, zoomTo, switcher } = setup(1, 4.4);
    expect(zoomTo(4.9)).toBe(1);
    host.fire('sourcedata');
    expect(host.jumps).toBe(0);
    host.loaded.add('openmaptiles__b2');
    host.fire('sourcedata');
    host.fire('sourcedata');
    expect(host.jumps).toBe(1); // the first wake's decide switched, so the second finds nothing to do
    expect(switcher.current()).toBe(2);
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

  it('cancels a pending symbol hide each time the band is shown again within the fade', () => {
    const { host, c, zoomTo } = setup(1, 4.4, { dwellMs: 0 });
    host.loaded.add('openmaptiles__b1').add('openmaptiles__b2');
    expect(zoomTo(4.9)).toBe(2); // t=0: hide of b1 due at 300
    c.advance(50);
    expect(zoomTo(4.5)).toBe(1); // t=50: b1 shown again, hide of b2 due at 350
    c.advance(50);
    expect(zoomTo(4.9)).toBe(2); // t=100: b2 shown again, hide of b1 due at 400
    c.advance(50);
    expect(zoomTo(4.5)).toBe(1); // t=150: b1 shown again, hide of b2 due at 450
    c.advance(1000);
    const noneWrites = (id: string) => host.writes.filter((w) => w.kind === 'layout' && w.layerId === id && w.value === 'none');
    expect(noneWrites('place__b1')).toHaveLength(0);
    expect(host.layout['place__b1']).toEqual({ visibility: undefined });
    expect(noneWrites('place__b2')).toHaveLength(1);
    expect(host.layout['place__b2']).toEqual({ visibility: 'none' });
    expect(host.paint['water__b1']).toEqual({ 'fill-opacity': 0.8 });
    expect(host.paint['water__b2']).toEqual({ 'fill-opacity': 0 });
  });

  it('does not take a band for ready merely because MapLibre reports an unused source as loaded', () => {
    const { host, zoomTo } = setup(2, 4.1);
    host.loadedWhenUnused = true;
    expect(zoomTo(6.3)).toBe(2); // band 3 was out of range at z4.1: no tile was ever requested
    host.loadedWhenUnused = false; // from here only real loading counts
    expect(zoomTo(6.3)).toBe(2);
    host.loaded.add('openmaptiles__b3');
    expect(zoomTo(6.3)).toBe(3);
  });

  it('forgets the wait when the zoom returns to the shown band', () => {
    const { host, c, zoomTo, events } = setup(1, 4.4);
    zoomTo(4.9);
    zoomTo(4.4);
    c.advance(600000);
    host.loaded.add('openmaptiles__b2');
    zoomTo(4.9);
    expect(events[0]!.waitedMs).toBe(0);
  });

  it('wakes once at the end of the dwell when the band becomes ready inside it', () => {
    const { host, c, zoomTo, switcher } = setup(1, 4.4);
    host.loaded.add('openmaptiles__b2');
    expect(zoomTo(4.9)).toBe(2); // switch at t=0
    expect(zoomTo(5.7)).toBe(2); // band 3 not ready
    c.advance(100);
    host.loaded.add('openmaptiles__b3');
    host.fire('sourcedata');
    host.fire('idle');
    expect(host.jumps).toBe(0);
    c.advance(199);
    expect(host.jumps).toBe(0);
    c.advance(1);
    expect(host.jumps).toBe(1);
    expect(switcher.current()).toBe(3);
  });

  it('does not trust a zoom that has not been rendered yet', () => {
    const { host, switcher } = setup(2, 4.1);
    host.loadedWhenUnused = true;
    expect(switcher.decide(6.3)).toBe(2);
    expect(switcher.decide(6.3)).toBe(2); // still no render: band 3's source is only vacuously loaded
    host.zoom = 6.3;
    host.fire('render');
    expect(switcher.decide(6.3)).toBe(3);
  });

  it('does not wake the camera for a zoom that has not been rendered yet', () => {
    const { host, switcher } = setup(2, 4.1, { requestedZoom: () => 6.3 });
    host.loadedWhenUnused = true;
    switcher.decide(6.3);
    host.fire('sourcedata');
    expect(host.jumps).toBe(0);
  });

  it('cancels the dwell wake on destroy and on an intervening switch', () => {
    for (const how of ['destroy', 'switch'] as const) {
      const { host, c, zoomTo, switcher } = setup(1, 4.4);
      host.loaded.add('openmaptiles__b2');
      zoomTo(4.9);
      zoomTo(5.7);
      host.loaded.add('openmaptiles__b3');
      host.fire('sourcedata'); // schedules the wake for the end of the dwell
      if (how === 'destroy') switcher.destroy();
      else expect(zoomTo(7.4)).toBe(5); // forced switch
      c.advance(1000);
      expect(host.jumps).toBe(0);
    }
  });

  it("forces the switch once the camera's zoom offset carries the held band out of its range", () => {
    let offset = 0;
    const { host, zoomTo } = setup(3, 6.0, { zoomOffset: () => offset });
    expect(zoomTo(6.55)).toBe(3); // target 4, not ready: held (band 3 parsed to 7.2)
    offset = 0.9; // rendered 7.45 is outside band 3's range
    expect(zoomTo(6.55)).toBe(4);
    expect(host.jumps).toBe(0);
  });

  it('rejects a hysteresis that reaches the band spacing', () => {
    const host = new FakeSwitcherHost();
    expect(() => new BandSwitcher(host, {
      bands: SIX.bands, transition: SIX, sourceIdsForBand: idsFor, gatesForBand: gatesFor, initialBand: 1,
      requestedZoom: () => 4.4, hysteresis: SIX.spacing,
    })).toThrow(TypeError);
  });

  it('under pure Equal Earth always shows band 0 and writes nothing', () => {
    const host = new FakeSwitcherHost();
    const switcher = new BandSwitcher(host, {
      bands: [{ minZoom: -Infinity, blend: 0 }], transition: null, sourceIdsForBand: () => [], gatesForBand: () => [],
      initialBand: 0, requestedZoom: () => 12,
    });
    switcher.start();
    for (const z of [0, 5, 12, 20]) expect(switcher.decide(z)).toBe(0);
    host.fire('sourcedata');
    expect(host.writes).toHaveLength(0);
    expect(host.jumps).toBe(0);
    switcher.destroy();
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
