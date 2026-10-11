import { readFileSync } from 'node:fs';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { describe, expect, it } from 'vitest';

import type { CartographyOptions } from '../src/map/cartography.js';
import { EQUAL_EARTH_BANDS, resolveTransition } from '../src/map/bands.js';
import {
  REWRITTEN_METADATA_KEY,
  applyGate,
  restorableStyle,
  withoutRewriteBounds,
  rewriteStyle,
  type GateHost,
  type LayerGate,
  type StyleLayerLike,
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

/** A small style over the `openmaptiles` source, with the given layers appended. */
function tiny(...layers: StyleLayerLike[]): StyleLike {
  return {
    version: 8,
    sources: {
      openmaptiles: { type: 'vector', url: 'https://tiles.example/planet' },
      geo: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    },
    layers,
  };
}
const vec = (id: string, type: string, extra: Record<string, unknown> = {}): StyleLayerLike => ({
  id,
  type,
  source: 'openmaptiles',
  'source-layer': id,
  ...extra,
});

class FakeGateHost implements GateHost {
  readonly calls: unknown[][] = [];
  setPaintProperty(layerId: string, name: string, value: unknown): void {
    this.calls.push(['paint', layerId, name, value]);
  }
  setLayoutProperty(layerId: string, name: string, value: unknown): void {
    this.calls.push(['layout', layerId, name, value]);
  }
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

  it('copies attribution, minzoom and promoteId onto every band source, but not bounds (P14)', () => {
    const template = { ...TEMPLATES.openmaptiles, minzoom: 2, attribution: '© OSM', promoteId: { water: 'id' } };
    const { style } = rewriteStyle(liberty(), {
      bands: SIX.bands, transition: SIX, templates: { openmaptiles: template }, initialZoom: 4.6,
    });
    for (let k = 0; k < 6; k++) {
      expect(style.sources[`openmaptiles__b${k}`]).toMatchObject({ minzoom: 2, attribution: '© OSM', promoteId: { water: 'id' } });
      expect(style.sources[`openmaptiles__b${k}`]!['bounds']).toBeUndefined();
    }
    // Absent fields stay absent.
    expect(rewrite().style.sources['openmaptiles__b1']).not.toHaveProperty('attribution');
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

  it("intersects the layer's own maxzoom with the parse range", () => {
    const { style } = rewrite(tiny(vec('a', 'fill', { minzoom: 5, maxzoom: 6 })));
    const copies = style.layers.filter((l) => l.id.startsWith('a'));
    expect(copies.map((l) => l.id)).toEqual(['a__b1', 'a__b2', 'a__b3', 'a__b4']);
    expect(copies.map((l) => l.maxzoom)).toEqual([5.6, 6, 6, 6]);
    expect(copies[0]!.minzoom).toBe(5);
    expect(copies[3]!.minzoom).toBeCloseTo(5.6, 12);
  });

  it("skips bands a layer's own zoom range never reaches", () => {
    const { style } = rewrite();
    // Liberty's building layer starts at z13: only the Mercator band keeps it.
    const building = style.layers.filter((l) => l.id === 'building' || l.id.startsWith('building__b'));
    expect(building.map((l) => l.id)).toEqual(['building']);
    expect(building[0]!.minzoom).toBe(13);
  });

  it('keeps the own paint in the initial band, 0 elsewhere, and adds a transition', () => {
    const { style } = rewrite(tiny(vec('a', 'fill', { paint: { 'fill-opacity': 0.4 } })), SIX, 4.6);
    const byId = (id: string) => style.layers.find((l) => l.id === id)!;
    expect(byId('a__b1').paint!['fill-opacity']).toBe(0.4); // band 1 is the initial band
    expect(byId('a__b2').paint!['fill-opacity']).toBe(0);
    expect(byId('a__b2').paint!['fill-opacity-transition']).toEqual({ duration: 250, delay: 0 });
    expect(JSON.stringify(style)).not.toContain('global-state');
  });

  it('absent opacity stays absent in the initial band and is 0 elsewhere', () => {
    const { style } = rewrite(tiny(vec('a', 'line')), SIX, 4.6);
    expect(style.layers.find((l) => l.id === 'a__b1')!.paint!['line-opacity']).toBeUndefined();
    expect(style.layers.find((l) => l.id === 'a__b3')!.paint!['line-opacity']).toBe(0);
  });

  it('keeps an own opacity transition and honours the fade overrides', () => {
    const own = { duration: 77, delay: 5 };
    const style = tiny(
      vec('a', 'fill', { paint: { 'fill-opacity-transition': own } }),
      vec('b', 'fill'),
      vec('c', 'symbol'),
    );
    const out = rewriteStyle(style, {
      bands: SIX.bands,
      transition: SIX,
      templates: TEMPLATES,
      initialZoom: 4.6,
      fadeMs: 111,
      symbolFadeMs: 222,
    }).style;
    const byId = (id: string) => out.layers.find((l) => l.id === id)!;
    expect(byId('a__b2').paint!['fill-opacity-transition']).toEqual(own);
    expect(byId('b__b2').paint!['fill-opacity-transition']).toEqual({ duration: 111, delay: 0 });
    expect(byId('c__b2').paint!['text-opacity-transition']).toEqual({ duration: 222, delay: 0 });
    expect(byId('c__b2').paint!['icon-opacity-transition']).toEqual({ duration: 222, delay: 0 });
  });

  it('gates both circle opacities', () => {
    const { style } = rewrite(tiny(vec('p', 'circle')), SIX, 4.6);
    const copy = style.layers.find((l) => l.id === 'p__b2')!;
    expect(copy.paint!['circle-opacity']).toBe(0);
    expect(copy.paint!['circle-stroke-opacity']).toBe(0);
  });

  it('passes a legacy property function through verbatim in the initial band', () => {
    const legacy = { property: 'rank', stops: [[1, 0.2], [5, 0.9]] };
    const { style } = rewrite(tiny(vec('a', 'fill', { paint: { 'fill-opacity': legacy } })), SIX, 4.6);
    expect(style.layers.find((l) => l.id === 'a__b1')!.paint!['fill-opacity']).toEqual(legacy);
    expect(style.layers.find((l) => l.id === 'a__b2')!.paint!['fill-opacity']).toBe(0);
  });

  it('marks symbol, hillshade and color-relief copies hideByVisibility, and no others', () => {
    const style = liberty();
    style.sources['dem'] = { type: 'raster-dem', url: 'https://example.invalid/dem.json' };
    style.layers.push(
      { id: 'shade', type: 'hillshade', source: 'dem' },
      { id: 'relief', type: 'color-relief', source: 'dem' },
    );
    const { gates } = rewrite(style, SIX, 4.4);
    const byType = new Map(style.layers.map((l) => [l.id, l.type]));
    for (const gate of gates) {
      const id = gate.layerId.replace(/__b\d+$/, '');
      const type = byType.get(id);
      expect(gate.hideByVisibility, `${gate.layerId} (${type})`).toBe(
        type === 'symbol' || type === 'hillshade' || type === 'color-relief',
      );
      expect('symbol' in gate).toBe(false);
    }
  });

  it('shows symbol copies in the initial band only, keeping their own visibility', () => {
    const { style, gates } = rewrite(tiny(vec('s', 'symbol'), vec('h', 'symbol', { layout: { visibility: 'none' } })), SIX, 4.6);
    const byId = (id: string) => style.layers.find((l) => l.id === id)!;
    expect(byId('s__b1').layout?.['visibility']).toBeUndefined();
    expect(byId('s__b3').layout!['visibility']).toBe('none');
    expect(byId('h__b1').layout!['visibility']).toBe('none');
    expect(byId('h__b3').layout!['visibility']).toBe('none');
    expect(byId('s__b3').paint!['text-opacity']).toBe(0);
    expect(byId('s__b3').paint!['text-opacity-transition']).toEqual({ duration: 300, delay: 0 });
    expect(gates.find((g) => g.layerId === 'h__b1')!.visibility).toBe('none');
  });

  it('keeps raster relief once, from the Mercator parse range, hidden unless initial', () => {
    const style = tiny(
      { id: 'r', type: 'raster', source: 'geo' },
      { id: 'hs', type: 'hillshade', source: 'geo', minzoom: 3 },
      vec('a', 'fill'),
    );
    const { style: out, gates, removedLayers } = rewrite(style, SIX, 4.6);
    for (const id of ['r', 'hs']) {
      const layer = out.layers.filter((l) => l.id === id);
      expect(layer).toHaveLength(1);
      expect(layer[0]!.minzoom).toBeCloseTo(7.2, 12);
    }
    expect(out.layers.find((l) => l.id === 'r')!.paint!['raster-opacity']).toBe(0);
    expect(gates.find((g) => g.layerId === 'r')).toMatchObject({ band: 6, paint: { 'raster-opacity': undefined }, hideByVisibility: false });
    expect(removedLayers).toEqual([]);
    const atMercator = rewrite(tiny({ id: 'r', type: 'raster', source: 'geo', paint: { 'raster-opacity': 0.5 } }), SIX, 9).style;
    expect(atMercator.layers[0]!.paint!['raster-opacity']).toBe(0.5);
  });

  it('hides a hillshade by visibility, not by a zero exaggeration (a basic hillshade still tints at 0)', () => {
    const basic = { 'hillshade-method': 'basic', 'hillshade-exaggeration': 0.6 };
    const { style, gates } = rewrite(tiny({ id: 'hs', type: 'hillshade', source: 'geo', paint: basic }), SIX, 4.6);
    const layer = style.layers.find((l) => l.id === 'hs')!;
    expect(layer.layout!['visibility']).toBe('none');
    expect(layer.paint!['hillshade-exaggeration']).toBe(0.6);
    expect(gates.find((g) => g.layerId === 'hs')).toEqual({ layerId: 'hs', band: 6, paint: {}, visibility: undefined, hideByVisibility: true });
    // In the initial band it keeps its own visibility.
    const shown = rewrite(tiny({ id: 'hs', type: 'hillshade', source: 'geo', paint: basic, layout: { visibility: 'visible' } }), SIX, 9);
    expect(shown.style.layers[0]!.layout!['visibility']).toBe('visible');
    expect(shown.gates[0]!.visibility).toBe('visible');
  });

  it('clamps copy zoom bounds to [0, 24] when the parse range reaches below 0', () => {
    const wide = resolveTransition({ from: 1, to: 8, steps: 6 });
    const { style } = rewrite(tiny(vec('a', 'fill')), wide, 1.5);
    const copies = style.layers.filter((l) => l.id.startsWith('a'));
    for (const l of copies) expect(l.minzoom ?? 0).toBeGreaterThanOrEqual(0);
    expect(copies.find((l) => l.id === 'a__b0')!.minzoom).toBeUndefined();
    expect(copies.find((l) => l.id === 'a__b1')!.minzoom).toBeUndefined();
    expect(copies.find((l) => l.id === 'a')!.maxzoom).toBeUndefined();
    expect(validateStyleMin(rewrite(liberty(), wide, 1.5).style as never)).toEqual([]);
  });

  it('keeps color-relief once in the Mercator band, faded by opacity and hidden by visibility', () => {
    const { style, gates } = rewrite(tiny({ id: 'cr', type: 'color-relief', source: 'geo' }), SIX, 4.6);
    const layer = style.layers.filter((l) => l.id === 'cr');
    expect(layer).toHaveLength(1);
    expect(layer[0]!.minzoom).toBeCloseTo(7.2, 12);
    expect(layer[0]!.paint!['color-relief-opacity']).toBe(0);
    expect(layer[0]!.layout!['visibility']).toBe('none');
    expect(gates.find((g) => g.layerId === 'cr')).toMatchObject({ band: 6, paint: { 'color-relief-opacity': undefined }, hideByVisibility: true });
  });

  it('rejects bands whose blends differ from the transition at equal length', () => {
    const bands = SIX.bands.map((b, i) => (i === 3 ? { ...b, blend: 0.9 } : b));
    expect(() => rewriteStyle(tiny(), { bands, transition: SIX, templates: TEMPLATES, initialZoom: 4 })).toThrow(TypeError);
  });

  it('removes Liberty natural_earth, whose maxzoom 7 lies below the Mercator band', () => {
    const { style, removedLayers } = rewrite();
    expect(removedLayers).toEqual(['natural_earth']);
    expect(style.layers.some((l) => l.type === 'raster')).toBe(false);
  });

  it('lists vector layers whose range reaches no band as removed', () => {
    const { style, removedLayers } = rewrite(tiny(vec('dead', 'fill', { minzoom: 10, maxzoom: 10 }), vec('ok', 'fill')));
    expect(removedLayers).toEqual(['dead']);
    expect(style.layers.some((l) => l.id.startsWith('dead'))).toBe(false);
  });

  it('records gates per band, in layer order', () => {
    const result = rewrite(tiny(vec('a', 'fill'), vec('s', 'symbol')));
    expect(result.gatesForBand(2).map((g) => g.layerId)).toEqual(['a__b2', 's__b2']);
    expect(result.gatesForBand(6).map((g) => g.layerId)).toEqual(['a', 's']);
    const full = rewrite();
    for (let k = 0; k <= 6; k++) {
      for (const g of full.gatesForBand(k)) {
        expect(g.band).toBe(k);
        expect(full.style.layers.some((l) => l.id === g.layerId)).toBe(true);
      }
    }
  });

  it('leaves non-banded sources and state alone, and keeps the Mercator background under its id', () => {
    const { style } = rewrite();
    expect(style.layers.find((l) => l.id === 'background')).toMatchObject({ type: 'background', paint: liberty().layers[0]!.paint });
    expect(style.state).toEqual(liberty().state);
    const geo: StyleLayerLike = { id: 'g', type: 'fill', source: 'geo', paint: { 'fill-opacity': 0.3 } };
    expect(rewrite(tiny(geo)).style.layers).toEqual([geo]);
  });

  it('records metadata without aliasing the result', () => {
    const result = rewrite(liberty(), SIX, 5.0);
    expect(result.style.metadata![REWRITTEN_METADATA_KEY]).toEqual({ bands: SIX.bands.map((b) => b.blend), sources: ['openmaptiles'] });
    result.bandedSources.push('x');
    expect((result.style.metadata![REWRITTEN_METADATA_KEY] as { sources: string[] }).sources).toEqual(['openmaptiles']);
  });

  it('refuses an already rewritten style and colliding ids', () => {
    const once = rewrite(tiny(vec('a', 'fill'))).style;
    expect(() => rewrite(once)).toThrow(TypeError);
    expect(() => rewrite(tiny(vec('a', 'fill'), vec('a__b2', 'fill')))).toThrow(/a__b2/);
    const clash = tiny(vec('a', 'fill'));
    clash.sources['openmaptiles__b3'] = { type: 'geojson', data: {} };
    expect(() => rewrite(clash)).toThrow(/openmaptiles__b3/);
  });

  it('rejects mismatched bands and templates without tiles', () => {
    expect(() =>
      rewriteStyle(tiny(), { bands: resolveTransition({ steps: 3 }).bands, transition: SIX, templates: TEMPLATES, initialZoom: 4 }),
    ).toThrow(TypeError);
    expect(() =>
      rewriteStyle(tiny(), { bands: SIX.bands, transition: SIX, templates: { openmaptiles: { tiles: [] } }, initialZoom: 4 }),
    ).toThrow(/openmaptiles/);
  });

  it('pure Equal Earth: one band, no transition, raster removed', () => {
    const bands = [{ minZoom: -Infinity, blend: 0 }];
    const { style, removedLayers } = rewriteStyle(liberty(), { bands, transition: null, templates: TEMPLATES, initialZoom: 2 });
    expect(style.layers.some((l) => l.type === 'raster')).toBe(false);
    expect(removedLayers).toEqual(['natural_earth']);
    expect(style.layers.filter((l) => l.id === 'water' || l.id.startsWith('water__b')).map((l) => l.id)).toEqual(['water__b0']);
    expect(style.sources['openmaptiles__b0']).toBeDefined();
  });

  it('produces a style the style spec accepts', () => {
    const errors = validateStyleMin(rewrite().style as never);
    expect(errors).toEqual([]);
  });

  it('matches the committed snapshot (layer ids, ranges and sources)', async () => {
    const { style } = rewrite();
    const r = (n: number | undefined) => (n === undefined ? '' : String(Math.round(n * 1e6) / 1e6));
    const summary = style.layers.map((l) => `${l.id} ${l.source ?? '-'} [${r(l.minzoom)},${r(l.maxzoom)})`).join('\n');
    await expect(summary).toMatchFileSnapshot('./__snapshots__/liberty-six-steps.txt');
  });
});

describe('applyGate', () => {
  const symbol: LayerGate = { layerId: 's__b2', band: 2, paint: { 'text-opacity': 0.8, 'icon-opacity': undefined }, visibility: 'visible', hideByVisibility: true };
  const fill: LayerGate = { layerId: 'f__b2', band: 2, paint: { 'fill-opacity': 0.5 }, hideByVisibility: false };

  it('shown restores own visibility and paint verbatim', () => {
    const host = new FakeGateHost();
    applyGate(host, symbol, 'shown');
    applyGate(host, fill, 'shown');
    expect(host.calls).toEqual([
      ['layout', 's__b2', 'visibility', 'visible'],
      ['paint', 's__b2', 'text-opacity', 0.8],
      ['paint', 's__b2', 'icon-opacity', undefined],
      ['paint', 'f__b2', 'fill-opacity', 0.5],
    ]);
  });

  it('shown writes an undefined own visibility verbatim', () => {
    const host = new FakeGateHost();
    applyGate(host, { ...symbol, visibility: undefined }, 'shown');
    expect(host.calls[0]).toEqual(['layout', 's__b2', 'visibility', undefined]);
  });

  it('fading zeroes paint and leaves visibility alone', () => {
    const host = new FakeGateHost();
    applyGate(host, symbol, 'fading');
    applyGate(host, fill, 'fading');
    expect(host.calls).toEqual([
      ['paint', 's__b2', 'text-opacity', 0],
      ['paint', 's__b2', 'icon-opacity', 0],
      ['paint', 'f__b2', 'fill-opacity', 0],
    ]);
  });

  it('shows and hides a hillshade gate by visibility alone', () => {
    const hillshade: LayerGate = { layerId: 'hs', band: 6, paint: {}, visibility: undefined, hideByVisibility: true };
    const host = new FakeGateHost();
    applyGate(host, hillshade, 'shown');
    applyGate(host, hillshade, 'fading');
    applyGate(host, hillshade, 'hidden');
    expect(host.calls).toEqual([
      ['layout', 'hs', 'visibility', undefined],
      ['layout', 'hs', 'visibility', 'none'],
    ]);
  });

  it('hidden zeroes paint and hides symbols; for a fill it equals fading', () => {
    const host = new FakeGateHost();
    applyGate(host, symbol, 'hidden');
    expect(host.calls).toEqual([
      ['paint', 's__b2', 'text-opacity', 0],
      ['paint', 's__b2', 'icon-opacity', 0],
      ['layout', 's__b2', 'visibility', 'none'],
    ]);
    const a = new FakeGateHost();
    const b = new FakeGateHost();
    applyGate(a, fill, 'hidden');
    applyGate(b, fill, 'fading');
    expect(a.calls).toEqual(b.calls);
  });
});

describe('restorableStyle', () => {
  it('bounds a layer explicitly where the rewrite bounded it in place and the original did not', () => {
    const original = tiny(vec('water', 'fill'), vec('road', 'line', { minzoom: 3 }), vec('river', 'line', { maxzoom: 9 }));
    const live = rewrite(original).style;
    // The Mercator band keeps the original ids, ranged from its parse range up.
    expect(live.layers.find((l) => l.id === 'water')!.minzoom).toBeGreaterThan(0);
    const restorable = restorableStyle(original, live);
    // A diffed setStyle cannot remove a bound (`setLayerZoomRange` skips an absent one): 0 can.
    expect(restorable.layers.find((l) => l.id === 'water')).toMatchObject({ minzoom: 0 });
    expect(restorable.layers.find((l) => l.id === 'water')!.maxzoom).toBeUndefined();
    expect(restorable.layers.find((l) => l.id === 'road')!.minzoom).toBe(3);
    expect(restorable.layers.find((l) => l.id === 'river')).toMatchObject({ minzoom: 0, maxzoom: 9 });
    // Nothing else changes, and the original is not mutated.
    const normalised = (style: StyleLike) => style.layers.map((l) => ({ ...l, minzoom: l.minzoom ?? 0 }));
    expect(normalised(restorable)).toEqual(normalised(original));
    expect(original.layers[0]!.minzoom).toBeUndefined();
  });

  it('returns the original itself when nothing needs a bound', () => {
    const original = tiny(vec('water', 'fill'));
    expect(restorableStyle(original, original)).toBe(original);
    expect(restorableStyle(original, undefined)).toBe(original);
    // Pure Equal Earth renames every copy: the originals are re-added, not diffed.
    const pure = rewriteStyle(original, { bands: EQUAL_EARTH_BANDS, transition: null, templates: TEMPLATES, initialZoom: 2 }).style;
    expect(restorableStyle(original, pure)).toBe(original);
  });
});

describe('withoutRewriteBounds', () => {
  /** What MapLibre serialises after diffing `next` over `live`: `setLayerZoomRange` skips absent bounds. */
  const diffed = (live: StyleLike, next: StyleLike): StyleLike => ({
    ...next,
    layers: next.layers.map((layer) => {
      const old = live.layers.find((l) => l.id === layer.id && l.type === layer.type && l.source === layer.source);
      return {
        ...layer,
        ...(layer.minzoom === undefined && old?.minzoom !== undefined ? { minzoom: old.minzoom } : {}),
        ...(layer.maxzoom === undefined && old?.maxzoom !== undefined ? { maxzoom: old.maxzoom } : {}),
      };
    }),
  });

  it("drops the Mercator band's in-place bounds that the diff left on the application's new style", () => {
    const original = tiny(vec('water', 'fill'), vec('road', 'line', { minzoom: 3 }), vec('wetland', 'fill', { minzoom: 12 }));
    const rewritten = rewrite(original).style;
    const next = tiny(vec('water', 'fill', { paint: { 'fill-color': '#4477aa' } }), vec('road', 'line', { minzoom: 3 }), vec('wetland', 'fill', { minzoom: 12 }));
    const captured = diffed(rewritten, next);
    expect(captured.layers[0]!.minzoom).toBe(rewritten.layers.find((l) => l.id === 'water')!.minzoom);
    const cleaned = withoutRewriteBounds(captured, rewritten, original);
    expect(cleaned).toEqual(next);
    expect(captured.layers[0]!.minzoom).toBeGreaterThan(0); // not mutated
    // Rewritten again, every band has its copy of `water` once more; from `captured`, the low
    // bands would have none.
    expect(rewrite(cleaned).style.layers.filter((l) => l.id.startsWith('water'))).toHaveLength(SIX.bands.length);
    expect(rewrite(captured).style.layers.some((l) => l.id === 'water__b0')).toBe(false);
  });

  it('keeps bounds the original had, bounds that differ from ours, and replaced layers', () => {
    const original = tiny(vec('water', 'fill'), vec('road', 'line'), vec('rail', 'line'));
    const rewritten = rewrite(original).style;
    const band = rewritten.layers.find((l) => l.id === 'water')!.minzoom!;
    const captured = tiny(
      vec('water', 'fill', { minzoom: band + 1 }), // a bound of the application's own
      vec('road', 'fill', { minzoom: band }), // type changed: re-added, so the bound is its own
      vec('rail', 'line', { minzoom: band }),
    );
    const withRailBound = tiny(vec('water', 'fill'), vec('road', 'line'), vec('rail', 'line', { minzoom: band }));
    expect(withoutRewriteBounds(captured, rewritten, withRailBound)).toBe(captured);
  });

  it('returns the captured style itself without a rewritten style or an original', () => {
    const style = tiny(vec('water', 'fill', { minzoom: 9 }));
    expect(withoutRewriteBounds(style, undefined, style)).toBe(style);
    expect(withoutRewriteBounds(style, rewrite(tiny(vec('water', 'fill'))).style, undefined)).toBe(style);
  });
});

describe('cartography', () => {
  const cart = (options: CartographyOptions, style = liberty(), zoom = 4.6) =>
    rewriteStyle(style, { bands: SIX.bands, transition: SIX, templates: TEMPLATES, initialZoom: zoom, cartography: options });
  const libertyBackground = (): StyleLayerLike => liberty().layers[0]!;

  it('recolours the background copies of Equal Earth bands and puts the world polygon above them', () => {
    const { style } = cart({ outsideColor: '#123456' });
    const ids = style.layers.map((l) => l.id);
    const first = ids.indexOf('background__b0');
    expect(ids.slice(first, first + 7)).toEqual(['background__b0', 'background__b1', 'background__b2', 'background__b3', 'background__b4', 'background__b5', 'background']);
    expect(ids[first + 7]).toBe('equal-earth:world__b0');
    const layer = (id: string) => style.layers.find((l) => l.id === id)!;
    expect(layer('background__b0').paint!['background-color']).toBe('#123456');
    expect(layer('background').paint!['background-color']).toBe(libertyBackground().paint!['background-color']);
    expect(layer('equal-earth:world__b3').paint!['fill-color']).toEqual(libertyBackground().paint!['background-color']);
    expect(style.sources['equal-earth:world__b3']).toMatchObject({ type: 'geojson', buffer: 0, tolerance: 0 });
    expect(style.sources['equal-earth:world__b6']).toBeUndefined();
  });

  it('defaults the outside colour to transparent', () => {
    const { style } = cart({});
    expect(style.layers.find((l) => l.id === 'background__b2')!.paint!['background-color']).toBe('transparent');
  });

  it('carries a background expression and pattern onto the world polygon', () => {
    const style = liberty();
    const colour = ['interpolate', ['linear'], ['zoom'], 0, '#eee', 6, '#ddd'];
    style.layers[0]!.paint = { 'background-color': colour, 'background-pattern': 'dots', 'background-opacity': 0.9 };
    const out = cart({}, style).style;
    const world = out.layers.find((l) => l.id === 'equal-earth:world__b1')!;
    expect(world.paint).toMatchObject({ 'fill-color': colour, 'fill-pattern': 'dots', 'fill-opacity': 0.9, 'fill-antialias': false });
    const copy = out.layers.find((l) => l.id === 'background__b1')!;
    expect(copy.paint!['background-pattern']).toBeUndefined();
    expect(copy.paint!['background-opacity']).toBe(0.9);
  });

  it('omits the world polygon without a background layer, and adds the outside colour as one', () => {
    const style = liberty();
    style.layers = style.layers.filter((l) => l.type !== 'background');
    const out = cart({ outsideColor: '#000' }, style).style;
    expect(out.layers.some((l) => l.id.startsWith('equal-earth:world'))).toBe(false);
    expect(out.layers[0]).toMatchObject({ id: 'equal-earth:background__b0', type: 'background', paint: { 'background-color': '#000' } });
    expect(out.layers.filter((l) => l.id.startsWith('equal-earth:background'))).toHaveLength(6);
    expect(cart({}, style).style.layers.some((l) => l.id.startsWith('equal-earth:background'))).toBe(false);
  });

  it('puts graticule then outline right below the first symbol layer; graticule in every band, outline not in Mercator', () => {
    const { style } = cart({ outline: true, graticule: { step: 15 } });
    const ids = style.layers.map((l) => l.id);
    const firstSymbol = style.layers.findIndex((l) => l.type === 'symbol');
    const generated = ids.slice(0, firstSymbol).filter((id) => /^equal-earth:(graticule|outline)/.test(id));
    expect(generated).toEqual([
      ...[0, 1, 2, 3, 4, 5, 6].map((k) => `equal-earth:graticule__b${k}`),
      ...[0, 1, 2, 3, 4, 5].map((k) => `equal-earth:outline__b${k}`),
    ]);
    expect(ids.indexOf('equal-earth:outline__b5')).toBe(firstSymbol - 1);
    expect(style.layers.find((l) => l.id === 'equal-earth:outline__b2')).toMatchObject({
      type: 'line',
      layout: { 'line-cap': 'round' },
      paint: { 'line-color': '#9a9a9a', 'line-width': 1 },
    });
  });

  it('appends the lines at the end without a symbol layer, and emits nothing unless asked', () => {
    const style = tiny(vec('water', 'fill'));
    const out = cart({ graticule: true }, style).style;
    expect(out.layers.filter((l) => l.id.startsWith('equal-earth:graticule'))).toHaveLength(7);
    expect(out.layers.at(-1)!.id).toBe('equal-earth:graticule__b6');
    expect(cart({}, liberty()).style.layers.some((l) => /^equal-earth:(graticule|outline)/.test(l.id))).toBe(false);
  });

  it('gates every generated layer like a band copy', () => {
    const r = cart({ outline: true, graticule: true }, liberty(), 4.6); // initial band 1
    for (const id of ['background__b0', 'equal-earth:world__b0', 'equal-earth:outline__b0', 'equal-earth:graticule__b0']) {
      const gate = r.gates.find((g) => g.layerId === id);
      expect(gate, id).toBeDefined();
      expect(gate!.band).toBe(0);
    }
    const hidden = r.style.layers.find((l) => l.id === 'equal-earth:world__b0')!;
    expect(hidden.paint!['fill-opacity']).toBe(0);
    const shown = r.style.layers.find((l) => l.id === 'equal-earth:world__b1')!;
    expect(shown.paint!['fill-opacity']).toBeUndefined(); // own value: the Liberty background has none
    expect(r.style.layers.find((l) => l.id === 'background')!.paint!['background-opacity']).toBe(0);
    expect(r.gatesForBand(6).some((g) => g.layerId === 'equal-earth:graticule__b6')).toBe(true);
    expect(r.gatesForBand(6).some((g) => g.layerId.startsWith("equal-earth:outline"))).toBe(false);
  });

  it('throws on a collision with an existing generated id', () => {
    const style = liberty();
    style.sources['equal-earth:world__b1'] = { type: 'geojson', data: { type: 'FeatureCollection', features: [] } };
    expect(() => cart({}, style)).toThrow(TypeError);
  });

  it('validates with every option on', () => {
    expect(validateStyleMin(cart({ outsideColor: '#123', outline: { color: '#000', width: 2 }, graticule: { step: 10 } }).style as never)).toEqual([]);
  });

  it('works under pure Equal Earth (one band)', () => {
    const r = rewriteStyle(liberty(), { bands: EQUAL_EARTH_BANDS, transition: null, templates: TEMPLATES, initialZoom: 2, cartography: { outline: true } });
    expect(r.style.layers.filter((l) => l.id.startsWith('equal-earth:outline'))).toHaveLength(1);
    expect(r.style.layers.some((l) => l.id === 'background__b0')).toBe(true);
    expect(r.style.layers.some((l) => l.id === 'background')).toBe(false);
  });
});
