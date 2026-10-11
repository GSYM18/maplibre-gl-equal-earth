/**
 * `EqualEarthControl`: a toggle button in the style of MapLibre's `GlobeControl`. It only talks
 * to the map's (polyfilled) `getProjection` / `setProjection` and listens for the
 * `projectiontransition` the polyfill fires, so it also works beside MapLibre's own
 * `GlobeControl` on the same map. The class has no `maplibre-gl` import: the map is typed
 * structurally ({@link ControlHost}), and the DOM through `document`.
 */

import { worldOutline } from './cartography.js';

export interface EqualEarthControlOptions {
  /** Projection the button turns on. @defaultValue 'equal' */
  on?: 'equal' | 'equal-earth';
  /** Projection it turns off to. @defaultValue 'mercator' */
  off?: 'mercator' | 'globe';
}

/** The slice of a MapLibre `Map` the control uses (structural; v5 and v6 satisfy it). */
export interface ControlHost {
  getProjection(): { type?: unknown } | undefined;
  setProjection(projection: { type: string }): unknown;
  on(type: string, listener: () => void): unknown;
  off(type: string, listener: () => void): unknown;
}

/** The Equal Earth outline as an SVG path in a 20×20 box, built once. */
function outlinePath(): string {
  const points = worldOutline(0).geometry.coordinates;
  const xs = points.map((p) => p[0]!);
  const ys = points.map((p) => p[1]!);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  // Lng 1…19 wide; the same scale vertically, centred, latitude mirrored (SVG y points down).
  const scale = 18 / (maxX - minX);
  const midY = (minY + maxY) / 2;
  const fmt = (n: number): string => String(Math.round(n * 100) / 100);
  // Every 4th sample (2°) is plenty at 20 px.
  const sampled = points.filter((_, i) => i % 4 === 0 || i === points.length - 1);
  return (
    sampled
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${fmt(1 + (p[0]! - minX) * scale)} ${fmt(10 - (p[1]! - midY) * scale)}`)
      .join('') + 'Z'
  );
}

const ICON =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" ` +
  `style="display:block;margin:auto"><path d="${outlinePath()}" fill="none" stroke="currentColor" ` +
  `stroke-width="1.5" stroke-linejoin="round"/></svg>`;

const TITLES = { equal: 'Equal Earth', 'equal-earth': 'Equal Earth', mercator: 'Mercator', globe: 'Globe' } as const;

export class EqualEarthControl {
  readonly #on: 'equal' | 'equal-earth';
  readonly #off: 'mercator' | 'globe';
  #map: ControlHost | undefined;
  #container: HTMLElement | undefined;
  #button: HTMLElement | undefined;

  constructor(options: EqualEarthControlOptions = {}) {
    this.#on = options.on ?? 'equal';
    this.#off = options.off ?? 'mercator';
  }

  onAdd(map: ControlHost): HTMLElement {
    this.#map = map;
    const container = document.createElement('div');
    container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    const button = document.createElement('button');
    button.setAttribute('type', 'button');
    button.className = 'maplibregl-ctrl-equal-earth';
    button.innerHTML = ICON;
    button.addEventListener('click', this.#toggle);
    container.appendChild(button);
    this.#container = container;
    this.#button = button;
    this.#update();
    map.on('styledata', this.#update);
    map.on('projectiontransition', this.#update);
    return container;
  }

  onRemove(): void {
    const map = this.#map;
    this.#container?.remove();
    this.#button?.removeEventListener('click', this.#toggle);
    map?.off('styledata', this.#update);
    map?.off('projectiontransition', this.#update);
    this.#map = undefined;
    this.#container = undefined;
    this.#button = undefined;
  }

  getDefaultPosition(): 'top-right' {
    return 'top-right';
  }

  #isOn(): boolean {
    return this.#map?.getProjection()?.type === this.#on;
  }

  #toggle = (): void => {
    this.#map?.setProjection({ type: this.#isOn() ? this.#off : this.#on });
    this.#update();
  };

  #update = (): void => {
    const button = this.#button;
    if (!button || !this.#map) return;
    let on = false;
    try {
      on = this.#isOn();
    } catch {
      // `getProjection` throws on a map without a style yet: the button reads as off.
    }
    button.setAttribute('aria-pressed', String(on));
    button.setAttribute('title', TITLES[on ? this.#off : this.#on]);
  };
}
