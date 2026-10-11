/**
 * Geographic camera targets (Task 7, audit §10 tests 6–14, 16, 17) on real MapLibre, both
 * majors, under `equal`: `jumpTo`, `setCenter`, `easeTo`, `flyTo`, `panTo`, `panBy`,
 * `fitBounds` and `cameraForBounds` take geographic positions and land on them exactly, across
 * bands; MapLibre's own handlers and Camera chains, which hand these methods map-space values,
 * are not converted twice (double-click, keyboard, drag and rotate inertia, box zoom, v5
 * fallbacks, GeolocateControl, NavigationControl).
 *
 * "Exact" means `getCenter()` within 1e-6° of the target and the target's pixel at the canvas
 * centre ± 0.5 px, after `idle`. Each failure message carries the measured offset.
 */
import type { Page } from '@playwright/test';

import { centreOn, expect, geographicCentreOffsetPx, idle, openHarness, pixelOf, test } from './helpers.ts';

const G: [number, number] = [-103.35, 20.67]; // Guadalajara

/** What the specs keep on `window` between evaluations. */
interface Kept {
  __eases?: { around?: [number, number]; offset?: [number, number]; place?: [number, number]; bearing?: number }[];
  __trace?: { x: number; y: number; inertial: boolean }[];
  __release?: [number, number];
}

/** The canvas's page position and size. */
async function canvasBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  return (await page.locator('#map canvas').boundingBox())!;
}

/**
 * Record every `easeTo` the map receives (above the plugin's own wrapper): its `around` and
 * `offset`, and the place under `__release` (a canvas pixel) at that moment. Also trace, on every
 * `move`, the pixel of `tracked` and whether an inertial ease (`noMoveStart`) had begun.
 */
async function recordEases(page: Page, tracked: [number, number]): Promise<void> {
  await page.evaluate((tracked) => {
    const kept = window as unknown as Kept;
    const map = window.__h.map;
    kept.__eases = [];
    kept.__trace = [];
    let inertial = false;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called with the map below
    const inner = map.easeTo;
    map.easeTo = function (this: typeof map, options, eventData) {
      const o = options as { around?: unknown; offset?: unknown; noMoveStart?: boolean; bearing?: number };
      if (o.noMoveStart) inertial = true;
      const ll = (v: unknown): [number, number] | undefined => {
        if (!v) return undefined;
        const c = window.__h.maplibregl.LngLat.convert(v as [number, number]);
        return [c.lng, c.lat];
      };
      const pt = (v: unknown): [number, number] | undefined => {
        if (!v) return undefined;
        const p = v as [number, number] | { x: number; y: number };
        return Array.isArray(p) ? [p[0], p[1]] : [p.x, p.y];
      };
      const release = kept.__release;
      const place = release ? map.unproject(release) : undefined;
      kept.__eases!.push({
        ...(o.around ? { around: ll(o.around)! } : {}),
        ...(o.offset ? { offset: pt(o.offset)! } : {}),
        ...(place ? { place: [place.lng, place.lat] as [number, number] } : {}),
        ...(o.bearing === undefined ? {} : { bearing: o.bearing }),
      });
      return inner.call(this, options, eventData);
    } as typeof map.easeTo;
    map.on('move', () => {
      const p = map.project(tracked);
      kept.__trace!.push({ x: p.x, y: p.y, inertial });
    });
  }, tracked);
}

/** Largest pixel step between consecutive traced frames, split by phase. */
function steps(trace: { x: number; y: number; inertial: boolean }[]): { gesture: number; inertia: number } {
  let gesture = 0;
  let inertia = 0;
  for (let i = 1; i < trace.length; i++) {
    const step = Math.hypot(trace[i]!.x - trace[i - 1]!.x, trace[i]!.y - trace[i - 1]!.y);
    if (trace[i]!.inertial) inertia = Math.max(inertia, step);
    else gesture = Math.max(gesture, step);
  }
  return { gesture, inertia };
}

test('drag-pan with inertia: no jump, and the released place lands where the inertia carries it', async ({ page, mlv }) => {
  await openHarness(page, { mlv, projection: 'equal' });
  await centreOn(page, G, 5);
  await recordEases(page, G);
  const box = await canvasBox(page);
  const y = box.height / 2;
  const release: [number, number] = [box.width / 2 - 100, y];
  await page.evaluate((r) => { (window as unknown as Kept).__release = r; }, release);
  await page.mouse.move(box.x + box.width / 2 + 100, box.y + y);
  await page.mouse.down();
  await page.mouse.move(box.x + release[0], box.y + release[1], { steps: 10 });
  await page.mouse.up();
  await idle(page);

  const { eases, trace } = await page.evaluate(() => ({ eases: (window as unknown as Kept).__eases!, trace: (window as unknown as Kept).__trace! }));
  const inertial = eases.filter((e) => e.offset && e.place);
  expect(inertial, 'an inertial ease ran').toHaveLength(1);
  const [{ offset, place }] = inertial as [{ offset: [number, number]; place: [number, number] }];
  const [x, y1] = await pixelOf(page, place);
  const miss = Math.hypot(x - (release[0] + offset[0]), y1 - (release[1] + offset[1]));
  const { gesture, inertia } = steps(trace);
  console.log(`v${mlv} pan inertia: offset [${offset.map((v) => v.toFixed(1)).join(', ')}] px, landing miss ${miss.toFixed(3)} px, largest step gesture ${gesture.toFixed(1)} / inertia ${inertia.toFixed(1)} px`);
  expect(miss, `the released place missed its inertial landing by ${miss.toFixed(3)} px`).toBeLessThan(1);
  expect(inertia, `inertial step ${inertia.toFixed(1)} px vs gesture step ${gesture.toFixed(1)} px`).toBeLessThanOrEqual(2 * gesture);
});

test('drag-rotate with inertia keeps the centre: the inertial around comes from the wrapped getCenter (audit B3)', async ({ page, mlv }) => {
  await openHarness(page, { mlv, projection: 'equal' });
  await centreOn(page, G, 5);
  await recordEases(page, G);
  const box = await canvasBox(page);
  // Above the centre, horizontally: MapLibre rotates about the centre; pitch stays (dy = 0).
  const y = box.y + box.height / 2 - 120;
  await page.mouse.move(box.x + box.width / 2 - 100, y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(box.x + box.width / 2 + 100, y, { steps: 10 });
  await page.mouse.up({ button: 'right' });
  await idle(page);

  const { eases, trace } = await page.evaluate(() => ({ eases: (window as unknown as Kept).__eases!, trace: (window as unknown as Kept).__trace! }));
  const inertial = eases.filter((e) => e.around && e.bearing !== undefined);
  expect(inertial, 'an inertial rotation ran (else this test proves nothing)').toHaveLength(1);
  const offset = await geographicCentreOffsetPx(page, G);
  const centreDrift = Math.max(...trace.map((p) => Math.hypot(p.x - box.width / 2, p.y - box.height / 2)));
  const bearing = await page.evaluate(() => window.__h.map.getBearing());
  console.log(`v${mlv} rotate inertia: around [${inertial[0]!.around!.map((v) => v.toFixed(4)).join(', ')}], bearing ${bearing.toFixed(1)}°, centre offset after ${offset.toFixed(3)} px, largest during ${centreDrift.toFixed(3)} px`);
  expect(offset, `G is ${offset.toFixed(3)} px off the canvas centre after the inertial rotation`).toBeLessThan(1);
  expect(centreDrift, `G drifted up to ${centreDrift.toFixed(3)} px from the centre while rotating`).toBeLessThan(1);
});

/** How far the map's centre is from `target`: `getCenter()` in degrees, and `target`'s pixel from the canvas centre. */
async function centreError(page: Page, target: [number, number]): Promise<{ deg: number; px: number }> {
  const [lng, lat] = await page.evaluate(() => {
    const c = window.__h.map.getCenter();
    return [c.lng, c.lat] as [number, number];
  });
  const deg = Math.max(Math.abs(lng - target[0]), Math.abs(lat - target[1]));
  return { deg, px: await geographicCentreOffsetPx(page, target) };
}

/** `getCenter()` within 1e-6° of `target`, and `target` at the canvas centre ± 0.5 px. */
async function expectExact(page: Page, target: [number, number], what: string): Promise<void> {
  const { deg, px } = await centreError(page, target);
  expect(deg, `${what}: getCenter() is ${deg.toExponential(2)}° off (${px.toFixed(3)} px)`).toBeLessThan(1e-6);
  expect(px, `${what}: the target is ${px.toFixed(3)} px off the canvas centre`).toBeLessThanOrEqual(0.5);
}

test('jumpTo, setCenter, easeTo, flyTo and panTo land exactly on a geographic target across bands', async ({ page, mlv }) => {
  await openHarness(page, { mlv, projection: 'equal' });
  const moves: [string, () => void][] = [
    ['jumpTo', () => window.__h.map.jumpTo({ center: [-103.35, 20.67], zoom: 9 })],
    ['setCenter + setZoom', () => window.__h.map.setCenter([-103.35, 20.67]).setZoom(9)],
    ['easeTo', () => window.__h.map.easeTo({ center: [-103.35, 20.67], zoom: 9, duration: 1500 })],
    ['flyTo', () => window.__h.map.flyTo({ center: [-103.35, 20.67], zoom: 9, duration: 2000 })],
    ['panTo', () => window.__h.map.panTo([-103.35, 20.67], { duration: 1000 })],
  ];
  for (const [what, move] of moves) {
    await centreOn(page, [0, 0], 2);
    await page.evaluate(move);
    await idle(page);
    await expectExact(page, G, `${what} from z2`);
  }
  await centreOn(page, [0, 20], 5.5);
  await page.evaluate(() => window.__h.map.flyTo({ center: [-103.35, 20.67], zoom: 2, duration: 2000 }));
  await idle(page);
  await expectExact(page, G, 'flyTo from z5.5 to z2');
});

test('flyTo interrupting an easeTo that crossed a band lands exactly', async ({ page, mlv }) => {
  await openHarness(page, { mlv, projection: 'equal' });
  await centreOn(page, G, 2);
  const zoomAtInterrupt = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const map = window.__h.map;
        map.easeTo({ center: [0, 0], zoom: 7, duration: 3000 });
        setTimeout(() => {
          const zoom = map.getZoom();
          map.flyTo({ center: [-103.35, 20.67], zoom: 4, duration: 1500 });
          resolve(zoom);
        }, 1500);
      }),
  );
  expect(zoomAtInterrupt, 'the ease had crossed into band 1 (z ≥ 4) when interrupted').toBeGreaterThanOrEqual(4);
  await idle(page);
  await expectExact(page, G, `flyTo interrupting an easeTo at z${zoomAtInterrupt.toFixed(2)}`);
});

test('flyTo under reduced motion and along a zero-length path (v5 fallbacks)', async ({ page, mlv }) => {
  await openHarness(page, { mlv, projection: 'equal' });
  await centreOn(page, [0, 20], 2);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => window.__h.map.flyTo({ center: [-103.35, 20.67], zoom: 6 }));
  await idle(page);
  await expectExact(page, G, 'flyTo with prefers-reduced-motion');

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const here = await page.evaluate(() => {
    const map = window.__h.map;
    const c = map.getCenter();
    map.flyTo({ center: c, zoom: map.getZoom() });
    return [c.lng, c.lat] as [number, number];
  });
  await idle(page);
  const moved = await geographicCentreOffsetPx(page, here);
  expect(moved, `flyTo to the current centre moved it by ${moved.toFixed(3)} px`).toBeLessThanOrEqual(0.5);
});

test('double-click zoom keeps the place under the cursor (audit B1)', async ({ page, mlv }) => {
  await openHarness(page, { mlv, projection: 'equal' });
  await centreOn(page, [0, 20], 3);
  const box = await canvasBox(page);
  const cursor: [number, number] = [box.width / 2 + 120, box.height / 2];
  const before = await page.evaluate((p) => {
    const ll = window.__h.map.unproject(p);
    return [ll.lng, ll.lat] as [number, number];
  }, cursor);
  await page.mouse.dblclick(box.x + cursor[0], box.y + cursor[1]);
  await idle(page);
  const zoom = await page.evaluate(() => window.__h.map.getZoom());
  const [x, y] = await pixelOf(page, before);
  const miss = Math.hypot(x - cursor[0], y - cursor[1]);
  console.log(`v${mlv} double-click: z3 → z${zoom.toFixed(3)}, the place under the cursor moved ${miss.toFixed(3)} px`);
  expect(zoom).toBeGreaterThan(3.9);
  expect(miss, `the place under the cursor moved ${miss.toFixed(3)} px`).toBeLessThanOrEqual(2);
});

test('arrow keys pan by the pan step, and a burst pans without a jump or an extra moveend (audit B2)', async ({ page, mlv }) => {
  await openHarness(page, { mlv, projection: 'equal' });
  await centreOn(page, G, 4);
  const box = await canvasBox(page);
  await page.locator('#map canvas').focus();
  await page.keyboard.press('ArrowRight');
  await idle(page);
  const [x1, y1] = await pixelOf(page, G);
  const dx = x1 - box.width / 2;
  expect(Math.abs(dx + 100), `one ArrowRight moved the old centre by ${dx.toFixed(3)} px`).toBeLessThanOrEqual(1);
  expect(Math.abs(y1 - box.height / 2)).toBeLessThanOrEqual(1);

  await recordEases(page, G);
  await page.evaluate(() => {
    const kept = window as unknown as Kept & { __moveends?: number };
    kept.__moveends = 0;
    window.__h.map.on('moveend', () => { kept.__moveends!++; });
  });
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await idle(page);
  const { moveends, trace } = await page.evaluate(() => {
    const kept = window as unknown as Kept & { __moveends?: number };
    return { moveends: kept.__moveends!, trace: kept.__trace! };
  });
  const { gesture } = steps(trace);
  const [x2] = await pixelOf(page, G);
  console.log(`v${mlv} keyboard: 1 press ${dx.toFixed(3)} px; burst of 3: ${moveends} moveend, largest frame step ${gesture.toFixed(1)} px, total ${(x2 - x1).toFixed(1)} px`);
  // MapLibre itself, without the plugin, fires one moveend per press on both majors (measured:
  // each keydown ends the running keyboard ease before the next starts), and each press pans 100 px
  // from where the camera is then, not from the last target: three presses in ~15 ms total ~100 px.
  expect(moveends, 'one moveend per press, as MapLibre without the plugin').toBe(3);
  expect(gesture, `a frame jumped ${gesture.toFixed(1)} px`).toBeLessThanOrEqual(100);
  expect(x2 - x1, `three presses moved the centre by ${(x2 - x1).toFixed(3)} px`).toBeLessThanOrEqual(-99);
  expect(x2 - x1).toBeGreaterThanOrEqual(-301);
});

test('panBy pans by pixels (audit B4)', async ({ page, mlv }) => {
  await openHarness(page, { mlv, projection: 'equal' });
  await centreOn(page, G, 3);
  const old = await page.evaluate(() => {
    const map = window.__h.map;
    const c = map.getCenter();
    map.panBy([100, 0], { duration: 0 });
    return [c.lng, c.lat] as [number, number];
  });
  await idle(page);
  const box = await canvasBox(page);
  const [x, y] = await pixelOf(page, old);
  expect(Math.abs(x - (box.width / 2 - 100)), `the old centre is at x ${x.toFixed(3)}`).toBeLessThanOrEqual(0.5);
  expect(Math.abs(y - box.height / 2)).toBeLessThanOrEqual(0.5);
});

test('box zoom shows the box it was given (audit B6)', async ({ page, mlv }) => {
  await openHarness(page, { mlv, projection: 'equal' });
  await centreOn(page, [0, 20], 3);
  const box = await canvasBox(page);
  const p0: [number, number] = [box.width / 2 - 75, box.height / 2 - 50];
  const p1: [number, number] = [box.width / 2 + 75, box.height / 2 + 50];
  const corners = await page.evaluate(
    ({ a, b }) =>
      [a, [b[0], a[1]], b, [a[0], b[1]]].map((p) => {
        const ll = window.__h.map.unproject(p as [number, number]);
        return [ll.lng, ll.lat] as [number, number];
      }),
    { a: p0, b: p1 },
  );
  await page.keyboard.down('Shift');
  await page.mouse.move(box.x + p0[0], box.y + p0[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + p1[0], box.y + p1[1], { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await idle(page);
  const { zoom, bounds } = await page.evaluate(() => {
    const map = window.__h.map;
    const b = map.getBounds();
    return { zoom: map.getZoom(), bounds: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] };
  });
  const pixels = await Promise.all(corners.map((c) => pixelOf(page, c)));
  console.log(`v${mlv} box zoom: z3 → z${zoom.toFixed(3)}, corners at ${pixels.map(([x, y]) => `(${x.toFixed(1)}, ${y.toFixed(1)})`).join(' ')}`);
  expect(zoom).toBeGreaterThan(4);
  for (const [i, [lng, lat]] of corners.entries()) {
    const inside = lng >= bounds[0]! && lng <= bounds[2]! && lat >= bounds[1]! && lat <= bounds[3]!;
    expect(inside, `corner ${i} [${lng.toFixed(4)}, ${lat.toFixed(4)}] outside getBounds() [${bounds.map((v) => v.toFixed(4)).join(', ')}]`).toBe(true);
  }
});

// Ruling R11: the fit is solved against the camera's compensation, so it is exact under the
// default 'zoom+bearing' too (before R11: 11.79 px beyond the padding on the left and right).
for (const compensation of ['zoom+bearing', 'none'] as const) {
  test(`fitBounds fits the bounds to the padding, and cameraForBounds gives the same view (compensation ${compensation})`, async ({ page, mlv }) => {
    await openHarness(page, { mlv, projection: 'equal', compensation });
    const bounds: [[number, number], [number, number]] = [[4, 55], [32, 71]]; // Scandinavia
    await page.evaluate((b) => window.__h.map.fitBounds(b, { padding: 20, duration: 0 }), bounds);
    await idle(page);
    const box = await canvasBox(page);
    const [[w, s], [e, n]] = bounds;
    const edge: [number, number][] = [];
    for (let i = 0; i <= 32; i++) {
      const t = i / 32;
      edge.push([w + (e - w) * t, s], [w + (e - w) * t, n], [w, s + (n - s) * t], [e, s + (n - s) * t]);
    }
    const pixels = await Promise.all(edge.map((p) => pixelOf(page, p)));
    const xs = pixels.map(([x]) => x);
    const ys = pixels.map(([, y]) => y);
    const extent = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    const slack = [extent[0]! - 20, extent[1]! - 20, box.width - 20 - extent[2]!, box.height - 20 - extent[3]!];
    const zoom = await page.evaluate(() => window.__h.map.getZoom());
    console.log(`v${mlv} fitBounds (${compensation}): z${zoom.toFixed(3)}, slack to the padded edges (left, top, right, bottom) ${slack.map((v) => v.toFixed(2)).join(', ')} px`);
    for (const v of slack) expect(v, `an edge point is ${(-v).toFixed(2)} px beyond the padding`).toBeGreaterThanOrEqual(-0.5);
    expect(Math.min(...slack), 'one edge point touches a padded edge').toBeLessThanOrEqual(0.5);
    const bearing = await page.evaluate(() => window.__h.map.getBearing());
    expect(Math.abs(bearing), `rendered bearing ${bearing}° instead of the fit's 0°`).toBeLessThan(1e-6);

    const fitted = await page.evaluate(() => {
      const c = window.__h.map.getCenter();
      return [c.lng, c.lat] as [number, number];
    });
    await centreOn(page, [0, 20], 1);
    await page.evaluate((b) => {
      const map = window.__h.map;
      map.jumpTo(map.cameraForBounds(b, { padding: 20 })!);
    }, bounds);
    await idle(page);
    const { deg } = await centreError(page, fitted);
    expect(deg, `jumpTo(cameraForBounds) lands ${deg.toExponential(2)}° from the fitBounds centre`).toBeLessThan(1e-6);
  });
}

test('GeolocateControl centres on the position', async ({ page, context, mlv }) => {
  const zurich: [number, number] = [8.54, 47.37];
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: zurich[1], longitude: zurich[0], accuracy: 500 });
  await openHarness(page, { mlv, projection: 'equal' });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const { map, maplibregl } = window.__h;
        const control = new maplibregl.GeolocateControl({});
        map.addControl(control);
        control.on('geolocate', () => resolve());
        // Triggering needs the control's support check, which runs asynchronously on add.
        const trigger = (): void => {
          if (!control.trigger()) setTimeout(trigger, 50);
        };
        trigger();
      }),
  );
  await idle(page);
  const { deg } = await centreError(page, zurich);
  expect(deg, `GeolocateControl centred ${deg.toExponential(2)}° from the position`).toBeLessThan(1e-4);
});

test('NavigationControl zooms about the geographic centre, and right-drag rotates about it', async ({ page, mlv }) => {
  await openHarness(page, { mlv, projection: 'equal' });
  await page.evaluate(() => window.__h.map.addControl(new window.__h.maplibregl.NavigationControl()));
  await centreOn(page, G, 3);
  for (let i = 1; i <= 4; i++) {
    await page.locator('.maplibregl-ctrl-zoom-in').click();
    await idle(page);
    const zoom = await page.evaluate(() => window.__h.map.getZoom());
    const { deg } = await centreError(page, G);
    expect(deg, `after zoom-in ${i} (z${zoom.toFixed(2)}) getCenter() is ${deg.toExponential(2)}° off`).toBeLessThan(1e-6);
  }
  const box = await canvasBox(page);
  const y = box.y + box.height / 2 - 120;
  await page.mouse.move(box.x + box.width / 2 - 50, y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(box.x + box.width / 2 + 50, y, { steps: 10 });
  await page.waitForTimeout(300); // no inertia: the release comes after a pause
  await page.mouse.up({ button: 'right' });
  await idle(page);
  const bearing = await page.evaluate(() => window.__h.map.getBearing());
  const offset = await geographicCentreOffsetPx(page, G);
  console.log(`v${mlv} rotate: bearing ${bearing.toFixed(2)}°, G ${offset.toFixed(3)} px off centre`);
  expect(Math.abs(bearing), 'rotated by about 45°').toBeGreaterThan(35);
  expect(offset, `G is ${offset.toFixed(3)} px off the canvas centre after rotating`).toBeLessThanOrEqual(1);
});
