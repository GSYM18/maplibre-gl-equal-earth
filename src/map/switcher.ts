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
 * counts as ready only if it was parsed at the zoom of the last decision (its layers were in
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
  hysteresis: number;
  isReady(band: number): boolean;
}): { band: number; forced: boolean; target: number } {
  const { bands, transition, shown, requestedZoom: z, hysteresis } = input;
  const parsedAt = (k: number): boolean => {
    if (!transition) return true;
    const [lo, hi] = parseRange(transition, k);
    return z >= lo && z < hi;
  };
  const target = bandIndexWithHysteresis(bands, z, shown, hysteresis);
  if (target === shown) return { band: shown, forced: false, target };
  const step = target > shown ? -1 : 1;
  const shownParsed = parsedAt(shown);
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
  #lastZoom: number | null = null;
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
  }

  destroy(): void {
    if (this.#started) {
      this.#host.off('sourcedata', this.#onWake);
      this.#host.off('idle', this.#onWake);
      this.#started = false;
    }
    this.#cancelWake();
    for (const cancel of this.#pendingHides.values()) cancel();
    this.#pendingHides.clear();
  }

  decide(requestedZoom: number): number {
    this.#wakePending = false;
    const { band, forced, target } = this.#choose(requestedZoom);
    if (target === this.#shown) this.#waitingSince = null;
    else this.#waitingSince ??= this.#now();
    let result = band;
    if (band !== this.#shown) {
      if (!forced && this.#now() - this.#lastSwitchAt < this.#dwellMs) result = this.#shown;
      else this.#switch(band, { requestedZoom, target, forced });
    }
    this.#lastZoom = requestedZoom;
    return result;
  }

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
    let ok = false;
    try {
      this.#host.jumpTo({});
      ok = true;
    } finally {
      if (!ok) this.#wakePending = false;
    }
  };

  #isReady(band: number): boolean {
    if (this.#lastZoom === null) return false;
    if (this.#o.transition) {
      const [lo, hi] = parseRange(this.#o.transition, band);
      if (!(this.#lastZoom >= lo && this.#lastZoom < hi)) return false;
    }
    return this.#o.sourceIdsForBand(band).every((id) => this.#host.isSourceLoaded(id) === true);
  }

  #choose(requestedZoom: number): { band: number; forced: boolean; target: number } {
    return chooseBand({
      bands: this.#o.bands,
      transition: this.#o.transition,
      shown: this.#shown,
      requestedZoom,
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
