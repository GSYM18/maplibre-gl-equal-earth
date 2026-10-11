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
 * loaded or errored. Nothing here reads MapLibre's tile caches.
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
}): { band: number; forced: boolean } {
  const { bands, transition, shown, requestedZoom: z, hysteresis } = input;
  const parsedAt = (k: number): boolean => {
    if (!transition) return true;
    const [lo, hi] = parseRange(transition, k);
    return z >= lo && z < hi;
  };
  const target = bandIndexWithHysteresis(bands, z, shown, hysteresis);
  if (target === shown) return { band: shown, forced: false };
  const step = target > shown ? -1 : 1;
  const shownParsed = parsedAt(shown);
  // The first ready, parsed band from the target towards the shown one. The switch is forced
  // when the shown band can no longer be drawn here (its tiles do not contain this zoom).
  for (let k = target; k !== shown; k += step) {
    if (parsedAt(k) && input.isReady(k)) return { band: k, forced: !shownParsed };
  }
  // Hold while the shown band is still parsed here.
  if (shownParsed) return { band: shown, forced: false };
  return { band: target, forced: true };
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
    for (const cancel of this.#pendingHides.values()) cancel();
    this.#pendingHides.clear();
  }

  decide(requestedZoom: number): number {
    this.#wakePending = false;
    const { band, forced } = this.#choose(requestedZoom);
    const target = bandIndexWithHysteresis(this.#o.bands, requestedZoom, this.#shown, this.#hysteresis);
    if (target !== this.#shown) this.#waitingSince ??= this.#now();
    if (band === this.#shown) return band;
    if (!forced && this.#now() - this.#lastSwitchAt < this.#dwellMs) return this.#shown;
    this.#switch(band, { requestedZoom, target, forced });
    return band;
  }

  readonly #onWake = (): void => {
    if (this.#wakePending || this.#host.isMoving()) return;
    const { band } = this.#choose(this.#o.requestedZoom());
    if (band !== this.#shown) {
      this.#wakePending = true;
      this.#host.jumpTo({});
    }
  };

  #isReady(band: number): boolean {
    return this.#o.sourceIdsForBand(band).every((id) => this.#host.isSourceLoaded(id) === true);
  }

  #choose(requestedZoom: number): { band: number; forced: boolean } {
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
