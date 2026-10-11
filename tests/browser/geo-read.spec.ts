/**
 * The geographic reads (Task 6, audit §10 tests 1–5, 15, 16, 18) on real MapLibre, both majors:
 * while Equal Earth is active, `project`, `unproject`, `getCenter` and `getBounds` speak
 * geographic coordinates, and with them mouse-event `lngLat`, Marker and Popup placement, Marker
 * drag, `Hash` and `ScaleControl`. Outside Equal Earth the plugin changes nothing.
 */
import type { Page } from '@playwright/test';

import { centreOn, expect, geographicCentreOffsetPx, idle, openHarness, pixelOf, test } from './helpers.ts';

const G: [number, number] = [-103.35, 20.67]; // Guadalajara: not a fixture place
const ZURICH: [number, number] = [8.54, 47.37]; // a fixture place

/** A Marker or Popup the specs keep on `window` between evaluations. */
interface Kept {
  __marker?: import('maplibre-gl').Marker;
  __popup?: import('maplibre-gl').Popup;
  __events?: { type: string; lngLat: [number, number] }[];
  __dragged?: boolean;
}

/** Collect page exceptions: an `unproject` that throws inside a mouse event lands here. */
function pageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

/** The kept marker's projected point: its element's centre minus its offset (anchor `center`). */
async function markerPixel(page: Page): Promise<[number, number]> {
  return page.evaluate(() => {
    const marker = (window as unknown as Kept).__marker!;
    const canvas = window.__h.map.getCanvas().getBoundingClientRect();
    const r = marker.getElement().getBoundingClientRect();
    const offset = marker.getOffset();
    return [r.left + r.width / 2 - canvas.left - offset.x, r.top + r.height / 2 - canvas.top - offset.y] as [number, number];
  });
}

/** Centroid (CSS px) of the fixture's red place circles within `radius` of a point, or `null`. */
async function redCentroid(page: Page, [cx, cy]: [number, number], radius: number): Promise<[number, number] | null> {
  return page.evaluate(
    ({ cx, cy, radius }) => {
      const canvas = window.__h.map.getCanvas();
      const scale = canvas.width / canvas.clientWidth;
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      const context = copy.getContext('2d')!;
      context.drawImage(canvas, 0, 0);
      const x0 = Math.max(0, Math.floor((cx - radius) * scale));
      const y0 = Math.max(0, Math.floor((cy - radius) * scale));
      const x1 = Math.min(canvas.width, Math.ceil((cx + radius) * scale));
      const y1 = Math.min(canvas.height, Math.ceil((cy + radius) * scale));
      if (x1 <= x0 || y1 <= y0) return null;
      const data = context.getImageData(x0, y0, x1 - x0, y1 - y0).data;
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (let y = 0; y < y1 - y0; y++) {
        for (let x = 0; x < x1 - x0; x++) {
          const i = (y * (x1 - x0) + x) * 4;
          // #cc3333, the circle's own colour (its antialiased rim is excluded).
          if (Math.abs(data[i]! - 0xcc) <= 12 && Math.abs(data[i + 1]! - 0x33) <= 12 && Math.abs(data[i + 2]! - 0x33) <= 12) {
            sx += x0 + x + 0.5;
            sy += y0 + y + 0.5;
            n++;
          }
        }
      }
      return n === 0 ? null : ([sx / n / scale, sy / n / scale] as [number, number]);
    },
    { cx, cy, radius },
  );
}

test('mouse events carry geographic lngLat, and none throws outside the world', async ({ page, mlv }) => {
  const errors = pageErrors(page);
  await openHarness(page, { mlv, projection: 'equal' });
  await page.evaluate(() => {
    const kept = window as unknown as Kept;
    kept.__events = [];
    for (const type of ['click', 'mousemove'] as const) {
      window.__h.map.on(type, (e) => kept.__events!.push({ type, lngLat: [e.lngLat.lng, e.lngLat.lat] }));
    }
  });
  const box = (await page.locator('#map canvas').boundingBox())!;
  for (const zoom of [2, 5.2]) {
    // Centred on G, G is the canvas centre: an integer pixel, so the click lands on it exactly.
    await centreOn(page, G, zoom);
    const [x, y] = await pixelOf(page, G);
    expect(Math.abs(x - Math.round(x)) + Math.abs(y - Math.round(y))).toBeLessThan(1e-3);
    await page.evaluate(() => { (window as unknown as Kept).__events!.length = 0; });
    await page.mouse.click(box.x + Math.round(x), box.y + Math.round(y));
    const click = await page.evaluate(() => (window as unknown as Kept).__events!.find((e) => e.type === 'click'));
    expect(click, `z${zoom}`).toBeDefined();
    expect(Math.abs(click!.lngLat[0] - G[0]), `z${zoom} lng`).toBeLessThan(1e-6);
    expect(Math.abs(click!.lngLat[1] - G[1]), `z${zoom} lat`).toBeLessThan(1e-6);
  }

  // z1: the canvas's top-left corner is above the Equal Earth world.
  await centreOn(page, [0, 20], 1);
  await page.evaluate(() => { (window as unknown as Kept).__events!.length = 0; });
  await page.mouse.move(box.x + 1, box.y + 1);
  await page.waitForFunction(() => (window as unknown as Kept).__events!.some((e) => e.type === 'mousemove'));
  const moves = await page.evaluate(() => (window as unknown as Kept).__events!.filter((e) => e.type === 'mousemove'));
  for (const move of moves) {
    expect(Number.isFinite(move.lngLat[1]) && Math.abs(move.lngLat[1]) <= 90).toBe(true);
  }
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => window.__h.errors)).toEqual([]);
});

test('a Marker sits at project(lngLat) and on the rendered place', async ({ page, mlv }) => {
  await openHarness(page, { mlv, projection: 'equal' });
  for (const zoom of [3, 5, 7, 9]) {
    for (const [where, lngLat] of [['G', G], ['Zürich', ZURICH]] as const) {
      await centreOn(page, lngLat, zoom);
      await page.evaluate((c) => {
        const kept = window as unknown as Kept;
        kept.__marker?.remove();
        kept.__marker = new window.__h.maplibregl.Marker().setLngLat(c).addTo(window.__h.map);
      }, lngLat);
      await idle(page);
      const expected = await pixelOf(page, lngLat);
      const marker = await markerPixel(page);
      expect(Math.abs(marker[0] - expected[0]), `${where} z${zoom} x`).toBeLessThanOrEqual(1);
      expect(Math.abs(marker[1] - expected[1]), `${where} z${zoom} y`).toBeLessThanOrEqual(1);
      if (where === 'Zürich') {
        // The band's copy of the `places` layer has its own id: match the source layer.
        const places = await page.evaluate(
          ([x, y]) => window.__h.map.queryRenderedFeatures([[x - 2, y - 2], [x + 2, y + 2]]).filter((f) => f.sourceLayer === 'places').length,
          marker,
        );
        expect(places, `z${zoom} place under the marker`).toBeGreaterThan(0);
        const circle = await redCentroid(page, marker, 8);
        expect(circle, `z${zoom} circle`).not.toBeNull();
        expect(Math.hypot(circle![0] - marker[0], circle![1] - marker[1]), `z${zoom} circle`).toBeLessThanOrEqual(2);
      }
    }
  }
});

test('a dragged Marker lands where it was dropped, without a jump on dragend', async ({ page, mlv }) => {
  await openHarness(page, { mlv, projection: 'equal' });
  await centreOn(page, ZURICH, 4);
  await page.evaluate((c) => {
    const kept = window as unknown as Kept;
    kept.__dragged = false;
    kept.__marker = new window.__h.maplibregl.Marker({ draggable: true }).setLngLat(c).addTo(window.__h.map);
    kept.__marker.on('dragend', () => { kept.__dragged = true; });
  }, ZURICH);
  await idle(page);
  const start = await markerPixel(page);
  const grip = await page.evaluate(() => {
    const r = (window as unknown as Kept).__marker!.getElement().getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2] as [number, number];
  });
  await page.mouse.move(grip[0], grip[1]);
  await page.mouse.down();
  await page.mouse.move(grip[0] + 100, grip[1], { steps: 10 });
  await page.mouse.up();
  await page.waitForFunction(() => (window as unknown as Kept).__dragged === true);
  await idle(page);
  const dropped: [number, number] = [start[0] + 100, start[1]];
  const result = await page.evaluate((p) => {
    const { lng, lat } = (window as unknown as Kept).__marker!.getLngLat();
    const under = window.__h.map.unproject(p);
    return { lngLat: [lng, lat] as [number, number], under: [under.lng, under.lat] as [number, number] };
  }, dropped);
  expect(Math.abs(result.lngLat[0] - result.under[0])).toBeLessThan(1e-6);
  expect(Math.abs(result.lngLat[1] - result.under[1])).toBeLessThan(1e-6);
  const after = await markerPixel(page);
  expect(Math.abs(after[0] - dropped[0])).toBeLessThanOrEqual(1);
  expect(Math.abs(after[1] - dropped[1])).toBeLessThanOrEqual(1);
});

test('a Marker near the antimeridian is drawn on its place, from either edge of the world', async ({ page, mlv }) => {
  const place: [number, number] = [179.5, 0]; // a fixture place
  const size = { width: 0, height: 0 };
  const addMarkers = (lngLats: [number, number][]): Promise<void> =>
    page.evaluate((list) => {
      const kept = window as unknown as Kept & { __markers?: import('maplibre-gl').Marker[] };
      for (const marker of kept.__markers ?? []) marker.remove();
      kept.__markers = list.map((c) => new window.__h.maplibregl.Marker().setLngLat(c).addTo(window.__h.map));
    }, lngLats);
  /** Each kept marker's projected point (element centre minus offset). */
  const markerPixels = (): Promise<[number, number][]> =>
    page.evaluate(() => {
      const kept = window as unknown as { __markers: import('maplibre-gl').Marker[] };
      const canvas = window.__h.map.getCanvas().getBoundingClientRect();
      return kept.__markers.map((marker) => {
        const r = marker.getElement().getBoundingClientRect();
        const offset = marker.getOffset();
        return [r.left + r.width / 2 - canvas.left - offset.x, r.top + r.height / 2 - canvas.top - offset.y] as [number, number];
      });
    });

  await openHarness(page, { mlv, projection: 'equal' });
  Object.assign(size, await page.evaluate(() => {
    const canvas = window.__h.map.getCanvas();
    return { width: canvas.clientWidth, height: canvas.clientHeight };
  }));

  // (a) As far east as the constraint allows (world copies are off: the centre lands near 157.5):
  // 179.5 is on the canvas, and a marker given as its copy -180.5 is drawn on the same place.
  await centreOn(page, [175, 0], 3);
  await addMarkers([place, [-180.5, 0]]);
  await idle(page);
  const east = await pixelOf(page, place);
  expect(east[0] >= 0 && east[0] <= size.width && east[1] >= 0 && east[1] <= size.height, east.join(",")).toBe(true);
  for (const [i, pixel] of (await markerPixels()).entries()) {
    expect(Math.abs(pixel[0] - east[0]), `marker ${i} x`).toBeLessThanOrEqual(1);
    expect(Math.abs(pixel[1] - east[1]), `marker ${i} y`).toBeLessThanOrEqual(1);
  }
  const circle = await redCentroid(page, east, 8);
  expect(circle).not.toBeNull();
  expect(Math.hypot(circle![0] - east[0], circle![1] - east[1])).toBeLessThanOrEqual(3);

  // (b) From the west edge, smartWrap moves the marker to -180.5; it must still be drawn on its
  // place, off the canvas to the east, not in the void west of the world.
  await centreOn(page, [-175, 0], 3);
  await addMarkers([place]);
  await idle(page);
  const west = await pixelOf(page, place);
  expect(west[0]).toBeGreaterThan(size.width);
  const [pixel] = await markerPixels();
  expect(Math.abs(pixel![0] - west[0])).toBeLessThanOrEqual(1);
  expect(Math.abs(pixel![1] - west[1])).toBeLessThanOrEqual(1);
});

test('a Popup anchors at project(lngLat)', async ({ page, mlv }) => {
  await openHarness(page, { mlv, projection: 'equal' });
  await centreOn(page, G, 5);
  await page.evaluate((c) => {
    const kept = window as unknown as Kept;
    kept.__popup = new window.__h.maplibregl.Popup({ anchor: 'bottom', closeButton: false })
      .setLngLat(c)
      .setText('Guadalajara')
      .addTo(window.__h.map);
  }, G);
  await idle(page);
  const tip = await page.evaluate(() => {
    const canvas = window.__h.map.getCanvas().getBoundingClientRect();
    const r = (window as unknown as Kept).__popup!.getElement().getBoundingClientRect();
    return [r.left + r.width / 2 - canvas.left, r.bottom - canvas.top] as [number, number];
  });
  const expected = await pixelOf(page, G);
  expect(Math.abs(tip[0] - expected[0])).toBeLessThanOrEqual(1);
  expect(Math.abs(tip[1] - expected[1])).toBeLessThanOrEqual(1);
});

test('getBounds holds every visible point, pitched and rotated, and the world at z0', async ({ page, mlv }) => {
  await openHarness(page, { mlv, projection: 'equal' });
  await centreOn(page, G, 3);
  await page.evaluate(() => window.__h.map.jumpTo({ bearing: 30, pitch: 40 }));
  await idle(page);
  const outside = await page.evaluate(() => {
    const map = window.__h.map;
    const internal = map as unknown as {
      transform?: { isPointOnMapSurface(p: unknown): boolean };
      _camera?: { transform: { isPointOnMapSurface(p: unknown): boolean } };
    };
    const transform = internal.transform ?? internal._camera!.transform;
    const b = map.getBounds();
    const canvas = map.getCanvas();
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const corners = [[0, 0], [w, 0], [w, h], [0, h]];
    const misses: string[] = [];
    let checked = 0;
    for (let edge = 0; edge < 4; edge++) {
      const [x0, y0] = corners[edge]!;
      const [x1, y1] = corners[(edge + 1) % 4]!;
      for (let i = 0; i < 16; i++) {
        const p = { x: x0! + ((x1! - x0!) * i) / 16, y: y0! + ((y1! - y0!) * i) / 16 };
        if (!transform.isPointOnMapSurface(p)) continue;
        checked++;
        const { lng, lat } = map.unproject([p.x, p.y]);
        const eps = 1e-9;
        if (lng < b.getWest() - eps || lng > b.getEast() + eps || lat < b.getSouth() - eps || lat > b.getNorth() + eps) {
          misses.push(`${p.x},${p.y}: ${lng},${lat}`);
        }
      }
    }
    return { misses, checked, bounds: b.toArray() };
  });
  expect(outside.checked).toBeGreaterThan(32);
  expect(outside.misses, JSON.stringify(outside.bounds)).toEqual([]);

  await page.evaluate(() => window.__h.map.jumpTo({ bearing: 0, pitch: 0 }));
  await centreOn(page, [0, 0], 0);
  expect(await page.evaluate(() => window.__h.map.getBounds().toArray())).toEqual([[-180, -90], [180, 90]]);
});

test('the URL hash is geographic and reloads to the same view', async ({ page, mlv }) => {
  await openHarness(page, { mlv, projection: 'equal', hash: true });
  await centreOn(page, G, 6);
  await page.waitForFunction(() => /\/20\.67\/-103\.35(\/|$)/.test(location.hash));
  const [zoom, lat, lng] = (await page.evaluate(() => location.hash)).slice(1).split('/').map(Number);
  expect(Math.abs(zoom! - 6)).toBeLessThanOrEqual(0.07); // the band's compensation offset
  expect([lng, lat]).toEqual([-103.35, 20.67]);
  await page.reload();
  await page.waitForFunction(() => window.__h !== undefined);
  await page.evaluate(() => window.__h.ready);
  expect(await page.evaluate(() => window.__h.controller?.active)).toBe(true);
  expect(await geographicCentreOffsetPx(page, G)).toBeLessThanOrEqual(1);
});

test('ScaleControl measures the geographic distance', async ({ page, mlv }) => {
  await openHarness(page, { mlv, projection: 'equal' });
  await page.evaluate(() => {
    const { map, maplibregl } = window.__h;
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 100, unit: 'metric' }));
  });
  await centreOn(page, G, 6);
  const scale = await page.evaluate(() => {
    const { map } = window.__h;
    const element = map.getContainer().querySelector<HTMLElement>('.maplibregl-ctrl-scale')!;
    const [value, unit] = element.textContent.split(/\s+/);
    const label = Number(value) * (unit === 'km' ? 1000 : 1);
    const width = parseFloat(element.style.width);
    // What the control measures: 100 px across the canvas centre (scale_control.ts:104-107).
    const canvas = map.getCanvas();
    const y = canvas.clientHeight / 2;
    const x = canvas.clientWidth / 2;
    const a = map.unproject([x - 50, y]);
    const b = map.unproject([x + 50, y]);
    const rad = Math.PI / 180;
    const h = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lng - a.lng) * rad) / 2) ** 2;
    const haversine = 2 * 6371008.8 * Math.asin(Math.sqrt(h));
    // The label is a rounded distance drawn at the matching fraction of 100 px.
    return { measured: (label * 100) / width, haversine };
  });
  expect(Math.abs(scale.measured / scale.haversine - 1)).toBeLessThan(0.01);
});

for (const projection of ['mercator', 'globe'] as const) {
  test(`${projection}: the reads equal MapLibre's own, and nothing is wrapped`, async ({ page, mlv }) => {
    const read = (): Promise<unknown> =>
      page.evaluate(() => {
        const { map } = window.__h;
        return {
          center: map.getCenter().toArray(),
          project: map.project([10, 20]),
          unproject: map.unproject([100, 50]).toArray(),
          bounds: map.getBounds().toArray(),
        };
      });
    await openHarness(page, { mlv, plugin: false, projection });
    const without = await read();
    await openHarness(page, { mlv, projection });
    const own = await page.evaluate(() => {
      const { map, install } = window.__h;
      install!.controllerFor(map);
      return ['project', 'unproject', 'getCenter', 'getBounds'].filter((name) => Object.prototype.hasOwnProperty.call(map, name));
    });
    expect(await page.evaluate(() => window.__h.controller !== undefined)).toBe(true);
    expect(own).toEqual([]);
    expect(await read()).toEqual(without);
  });
}
