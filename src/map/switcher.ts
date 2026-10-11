/**
 * Which band is drawn, decided at runtime (spec §4.3).
 *
 * A band's tiles take time to fetch and warp. Switching by zoom alone showed the new band's
 * empty source for a second or more at every step (spike findings 3–4). So the shown band is
 * state: it follows the zoom's band only once that band's sources report loaded, and it is
 * held — still parsed, still drawn — until then. The decision runs inside the camera hook
 * (`BandSelector`), so the camera conversion and the style flip land in the same frame.
 *
 * Readiness comes from `isSourceLoaded`, public on both supported majors: every in-view tile
 * loaded or errored. It is also true for a source no layer used at the last render, so a band
 * counts as ready only if it was parsed at the zoom of the last render (its layers were in
 * range, so its tiles were really requested). Nothing here reads MapLibre's tile caches.
 *
 * Known residual: with the map's `fadeDuration: 0` and a symbol re-parse slower than
 * `symbolFadeMs`, incoming labels pop in at full opacity rather than cross-fading. The fill
 * cross-fade is unaffected and the labels end up correct.
 */

import { bandIndexWithHysteresis, parseRange, type Band, type ResolvedTransition } from './bands.js';
import type { BandSelector } from './camera.js';
import { applyGate, type GateHost, type LayerGate } from './style-rewrite.js';

export interface SwitcherHost extends GateHost {
  isSourceLoaded(id: string): boolean | undefined;
  getZoom(): number;
  isMoving(): boolean;
  jumpTo(options: Record<string, never>): unknown;
  on(type: string, listener: () => void): unknown;
  off(type: string, listener: () => void): unknown;
}

export interface SwitchEvent {
  from: number;
  to: number;
  requestedZoom: number;
  target: number;
  forced: boolean;
  waitedMs: number;
}

export interface SwitcherOptions {
  bands: readonly Band[];
  transition: ResolvedTransition | null;
  sourceIdsForBand(band: number): string[];
  gatesForBand(band: number): readonly LayerGate[];
  initialBand: number;
  requestedZoom(): number;
  /** Rendered minus requested zoom (the camera's compensation). @defaultValue `() => 0` */
  zoomOffset?: () => number;
  /** @defaultValue 0.1 */
  hysteresis?: number;
  /** @defaultValue 300 */
  dwellMs?: number;
  /** @defaultValue 300 */
  symbolFadeMs?: number;
  /** @defaultValue `performance.now` */
  now?: () => number;
  /** @defaultValue `setTimeout`; returns a cancel function. */
  schedule?: (fn: () => void, ms: number) => () => void;
  onSwitch?: (event: SwitchEvent) => void;
}

export function chooseBand(input: {
  bands: readonly Band[];
  transition: ResolvedTransition | null;
  shown: number;
  requestedZoom: number;
  /** The zoom MapLibre hides layers by: requested plus the camera's offset. @defaultValue `requestedZoom` */
  renderedZoom?: number;
  hysteresis: number;
  isReady(band: number): boolean;
}): { band: number; forced: boolean; target: number } {
  const { bands, transition, shown, requestedZoom: z, hysteresis } = input;
  const rendered = input.renderedZoom ?? z;
  const parsedAt = (k: number, at: number = z): boolean => {
    if (!transition) return true;
    const [lo, hi] = parseRange(transition, k);
    return at >= lo && at < hi;
  };
  const target = bandIndexWithHysteresis(bands, z, shown, hysteresis);
  if (target === shown) return { band: shown, forced: false, target };
  const step = target > shown ? -1 : 1;
  // The held band is still drawn only while the *rendered* zoom (requested plus the camera's
  // offset, which grows while a band is held) is inside its parse range. Candidates are judged
  // at the requested zoom: after a switch their offset is at most half a step, inside the
  // one-spacing slack of the parse range.
  const shownParsed = parsedAt(shown, rendered);
  // The first ready, parsed band from the target towards the shown one. The switch is forced
  // when the shown band can no longer be drawn here (its tiles do not contain this zoom).
  for (let k = target; k !== shown; k += step) {
    if (parsedAt(k) && input.isReady(k)) return { band: k, forced: !shownParsed, target };
  }
  // Hold while the shown band is still parsed here.
  if (shownParsed) return { band: shown, forced: false, target };
  return { band: target, forced: true, target };
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

/**
 * Readiness is judged at the zoom of the last `render` (MapLibre marks a source used, and
 * requests its tiles, only while rendering), so nothing counts as ready until the first
 * `render` after `start()`. A band whose source has only symbol layers is vacuously ready even
 * when parsed (its hidden symbol copies are `visibility: none`, which MapLibre counts as
 * unused); harmless for a single-source OpenMapTiles style.
 */
export class BandSwitcher implements BandSelector {
  readonly #host: SwitcherHost;
  readonly #o: SwitcherOptions;
  readonly #hysteresis: number;
  readonly #dwellMs: number;
  readonly #symbolFadeMs: number;
  readonly #now: () => number;
  readonly #schedule: (fn: () => void, ms: number) => () => void;
  #shown: number;
  #lastSwitchAt = -Infinity;
  #waitingSince: number | null = null;
  readonly #pendingHides = new Map<number, () => void>();
  #wakePending = false;
  #wakeTimer: (() => void) | null = null;
  #renderedZoom: number | null = null;
  #started = false;

  constructor(host: SwitcherHost, options: SwitcherOptions) {
    this.#host = host;
    this.#o = options;
    this.#shown = options.initialBand;
    this.#hysteresis = options.hysteresis ?? 0.1;
    this.#dwellMs = options.dwellMs ?? 300;
    this.#symbolFadeMs = options.symbolFadeMs ?? 300;
    this.#now = options.now ?? (() => performance.now());
    this.#schedule = options.schedule ?? defaultSchedule;
    if (options.transition !== null && this.#hysteresis >= options.transition.spacing) {
      throw new TypeError(
        `BandSwitcher: hysteresis ${this.#hysteresis} must be smaller than the band spacing ${options.transition.spacing}.`,
      );
    }
  }

  current(): number {
    return this.#shown;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#host.on('sourcedata', this.#onWake);
    this.#host.on('idle', this.#onWake);
    this.#host.on('render', this.#onRender);
  }

  destroy(): void {
    if (this.#started) {
      this.#host.off('sourcedata', this.#onWake);
      this.#host.off('idle', this.#onWake);
      this.#host.off('render', this.#onRender);
      this.#started = false;
    }
    this.#cancelWake();
    for (const cancel of this.#pendingHides.values()) cancel();
    this.#pendingHides.clear();
  }

  decide(requestedZoom: number): number {
    const { band, forced, target } = this.#choose(requestedZoom);
    if (target === this.#shown) this.#waitingSince = null;
    else this.#waitingSince ??= this.#now();
    let result = band;
    if (band !== this.#shown) {
      if (!forced && this.#now() - this.#lastSwitchAt < this.#dwellMs) result = this.#shown;
      else this.#switch(band, { requestedZoom, target, forced });
    }
    return result;
  }

  readonly #onRender = (): void => {
    this.#renderedZoom = this.#host.getZoom();
  };

  #cancelWake(): void {
    this.#wakeTimer?.();
    this.#wakeTimer = null;
  }

  readonly #onWake = (): void => {
    if (this.#wakePending || this.#host.isMoving()) return;
    const { band, forced } = this.#choose(this.#o.requestedZoom());
    if (band === this.#shown) return;
    const remaining = this.#dwellMs - (this.#now() - this.#lastSwitchAt);
    if (!forced && remaining > 0) {
      // Inside the dwell `decide` would refuse: wake once, when it ends.
      this.#wakeTimer ??= this.#schedule(() => {
        this.#wakeTimer = null;
        this.#onWake();
      }, remaining);
      return;
    }
    this.#wakePending = true;
    try {
      // `jumpTo` runs the camera hook synchronously, so `decide` has run when it returns.
      this.#host.jumpTo({});
    } finally {
      this.#wakePending = false;
    }
  };

  #isReady(band: number): boolean {
    if (this.#renderedZoom === null) return false;
    if (this.#o.transition) {
      const [lo, hi] = parseRange(this.#o.transition, band);
      if (!(this.#renderedZoom >= lo && this.#renderedZoom < hi)) return false;
    }
    return this.#o.sourceIdsForBand(band).every((id) => this.#host.isSourceLoaded(id) === true);
  }

  #choose(requestedZoom: number): { band: number; forced: boolean; target: number } {
    return chooseBand({
      bands: this.#o.bands,
      transition: this.#o.transition,
      shown: this.#shown,
      requestedZoom,
      renderedZoom: requestedZoom + (this.#o.zoomOffset?.() ?? 0),
      hysteresis: this.#hysteresis,
      isReady: (k) => this.#isReady(k),
    });
  }

  #switch(to: number, info: { requestedZoom: number; target: number; forced: boolean }): void {
    const from = this.#shown;
    this.#cancelWake();
    this.#pendingHides.get(to)?.();
    this.#pendingHides.delete(to);
    for (const g of this.#o.gatesForBand(to)) applyGate(this.#host, g, 'shown');
    const oldGates = this.#o.gatesForBand(from);
    for (const g of oldGates) applyGate(this.#host, g, 'fading');
    this.#pendingHides.get(from)?.();
    this.#pendingHides.set(
      from,
      this.#schedule(() => {
        this.#pendingHides.delete(from);
        for (const g of oldGates) if (g.symbol) applyGate(this.#host, g, 'hidden');
      }, this.#symbolFadeMs),
    );
    this.#shown = to;
    const now = this.#now();
    const waitedMs = this.#waitingSince === null ? 0 : now - this.#waitingSince;
    this.#lastSwitchAt = now;
    if (to === info.target) this.#waitingSince = null;
    this.#o.onSwitch?.({ from, to, requestedZoom: info.requestedZoom, target: info.target, forced: info.forced, waitedMs });
  }
}
