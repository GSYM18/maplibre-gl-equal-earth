import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { resolveTransition } from '../src/map/bands.js';
import {
  REWRITTEN_METADATA_KEY,
  gateByState,
  rewriteStyle,
  showKey,
  symKey,
  type StyleLike,
} from '../src/map/style-rewrite.js';
import { parseTileUrl } from '../src/tiles/protocol.js';

const liberty = (): StyleLike =>
  JSON.parse(readFileSync(new URL('./fixtures/liberty.json', import.meta.url), 'utf8')) as StyleLike;
const TEMPLATES = { openmaptiles: { tiles: ['https://tiles.example/planet/{z}/{x}/{y}.pbf'], maxzoom: 14 } };
const SIX = resolveTransition();

function rewrite(style = liberty(), transition = SIX, initialZoom = 4.6) {
  return rewriteStyle(style, { bands: transition.bands, transition, templates: TEMPLATES, initialZoom });
}

describe('rewriteStyle', () => {
  it('does not mutate the original', () => {
    const style = liberty();
    const snapshot = JSON.stringify(style);
    rewrite(style);
    expect(JSON.stringify(style)).toBe(snapshot);
  });

  it('adds one eqearth source per non-Mercator band and keeps the original', () => {
    const result = rewrite();
    const { style, bandedSources } = result;
    expect(bandedSources).toEqual(['openmaptiles']);
    for (let k = 0; k < 6; k++) {
      const source = style.sources[`openmaptiles__b${k}`]!;
      expect(source['type']).toBe('vector');
      const { config } = parseTileUrl((source['tiles'] as string[])[0]!.replace('{z}/{x}/{y}', '3/4/2'));
      expect(config.blend).toBeCloseTo(k / 6, 12);
      expect(config.sourceMaxZoom).toBe(14);
      expect(config.url).toBe(TEMPLATES.openmaptiles.tiles[0]);
    }
    expect(style.sources['openmaptiles']).toEqual(liberty().sources['openmaptiles']);
    expect(style.sources['openmaptiles__b6']).toBeUndefined();
    expect(result.sourceIdsForBand(6)).toEqual(['openmaptiles']);
    expect(result.sourceIdsForBand(2)).toEqual(['openmaptiles__b2']);
  });

  it("gives every copy its band's parse range, clipped to the layer's own", () => {
    const { style } = rewrite();
    const water = style.layers.filter((l) => l.id === 'water' || l.id.startsWith('water__b'));
    expect(water.map((l) => l.id)).toEqual(['water__b0', 'water__b1', 'water__b2', 'water__b3', 'water__b4', 'water__b5', 'water']);
    expect(water[0]!.minzoom).toBeUndefined(); // -Infinity → the layer's own (none)
    expect(water[0]!.maxzoom).toBeCloseTo(4.8, 12);
    expect(water[1]!.minzoom).toBeCloseTo(3.2, 12);
    expect(water[1]!.maxzoom).toBeCloseTo(5.6, 12);
    expect(water[6]!.minzoom).toBeCloseTo(7.2, 12);
    expect(water[6]!.source).toBe('openmaptiles');
  });

  it("skips bands a layer's own zoom range never reaches", () => {
    const { style } = rewrite();
    // Liberty's building layer starts at z13: only the Mercator band keeps it.
    const building = style.layers.filter((l) => l.id === 'building' || l.id.startsWith('building__b'));
    expect(building.map((l) => l.id)).toEqual(['building']);
    expect(building[0]!.minzoom).toBe(13);
  });

  it('gates paint by global state and adds a transition', () => {
    const { style } = rewrite();
    const copy = style.layers.find((l) => l.id === 'water__b2')!;
    expect(copy.paint!['fill-opacity']).toEqual(['case', ['global-state', showKey(2)], 1, 0]);
    expect(copy.paint!['fill-opacity-transition']).toEqual({ duration: 250, delay: 0 });
    const line = style.layers.find((l) => l.type === 'line' && l.id.endsWith('__b2'))!;
    expect(JSON.stringify(line.paint!['line-opacity'])).toContain(`["global-state","${showKey(2)}"]`);
  });

  it('hides symbol copies through a visibility expression and fades their opacity', () => {
    const { style } = rewrite();
    const symbol = style.layers.find((l) => l.type === 'symbol' && l.id.endsWith('__b3'))!;
    expect(symbol.layout!['visibility']).toEqual(['case', ['global-state', symKey(3)], 'visible', 'none']);
    expect(JSON.stringify(symbol.paint!['text-opacity'])).toContain(showKey(3));
    expect(symbol.paint!['text-opacity-transition']).toEqual({ duration: 300, delay: 0 });
  });

  it("keeps raster relief only from the Mercator band's parse range, gated", () => {
    const { style } = rewrite();
    const raster = style.layers.filter((l) => l.type === 'raster');
    expect(raster).toHaveLength(1);
    expect(raster[0]!.minzoom).toBeCloseTo(7.2, 12);
    expect(JSON.stringify(raster[0]!.paint!['raster-opacity'])).toContain(showKey(6));
  });

  it("declares state defaults for the initial zoom's band only", () => {
    const { style } = rewrite(liberty(), SIX, 5.0); // band 2
    for (let k = 0; k <= 6; k++) {
      expect(style.state![showKey(k)]).toEqual({ default: k === 2 });
      expect(style.state![symKey(k)]).toEqual({ default: k === 2 });
    }
    expect(style.metadata![REWRITTEN_METADATA_KEY]).toEqual({ bands: SIX.bands.map((b) => b.blend), sources: ['openmaptiles'] });
  });

  it('leaves background and non-banded sources alone', () => {
    const { style } = rewrite();
    expect(style.layers[0]).toEqual(liberty().layers[0]);
    expect(style.layers[0]!.type).toBe('background');
  });

  it('pure Equal Earth: one band, no transition, raster removed', () => {
    const bands = [{ minZoom: -Infinity, blend: 0 }];
    const { style, removedLayers } = rewriteStyle(liberty(), { bands, transition: null, templates: TEMPLATES, initialZoom: 2 });
    expect(style.layers.some((l) => l.type === 'raster')).toBe(false);
    expect(removedLayers).toEqual(['natural_earth']);
    expect(style.layers.filter((l) => l.id === 'water' || l.id.startsWith('water__b')).map((l) => l.id)).toEqual(['water__b0']);
    expect(style.sources['openmaptiles__b0']).toBeDefined();
  });

  it('matches the committed snapshot (layer ids, ranges and sources)', async () => {
    const { style } = rewrite();
    const summary = style.layers.map((l) => `${l.id} ${l.source ?? '-'} [${l.minzoom ?? ''},${l.maxzoom ?? ''})`).join('\n');
    await expect(summary).toMatchFileSnapshot('./__snapshots__/liberty-six-steps.txt');
  });
});

describe('gateByState', () => {
  const KEY = showKey(1);
  const on = (v: unknown) => ['case', ['global-state', KEY], v, 0];

  it('wraps constants and undefined', () => {
    expect(gateByState(undefined, KEY)).toEqual(on(1));
    expect(gateByState(0.6, KEY)).toEqual(on(0.6));
  });

  it('keeps zoom at the top level of interpolate and step', () => {
    expect(gateByState(['interpolate', ['linear'], ['zoom'], 5, 0.2, 10, 1], KEY)).toEqual(['interpolate', ['linear'], ['zoom'], 5, on(0.2), 10, on(1)]);
    expect(gateByState(['step', ['zoom'], 0.1, 8, 0.9], KEY)).toEqual(['step', ['zoom'], on(0.1), 8, on(0.9)]);
  });

  it('converts legacy stop functions', () => {
    expect(gateByState({ stops: [[5, 0.2], [10, 1]] }, KEY)).toEqual(['interpolate', ['exponential', 1], ['zoom'], 5, on(0.2), 10, on(1)]);
    expect(gateByState({ stops: [[5, 0.2], [10, 1]], base: 1.5 }, KEY)).toEqual(['interpolate', ['exponential', 1.5], ['zoom'], 5, on(0.2), 10, on(1)]);
    expect(gateByState({ type: 'interval', stops: [[5, 0.2], [10, 1]] }, KEY)).toEqual(['step', ['zoom'], on(0.2), 10, on(1)]);
  });

  it('wraps data expressions whole', () => {
    expect(gateByState(['get', 'opacity'], KEY)).toEqual(on(['get', 'opacity']));
  });
});
