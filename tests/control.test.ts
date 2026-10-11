import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EqualEarthControl } from '../src/map/control.js';

/** The smallest DOM the control touches. */
class FakeElement {
  className = '';
  innerHTML = '';
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  parent: FakeElement | undefined;
  removed = false;
  #click: (() => void) | undefined;
  readonly classList = {
    toggle: (name: string, force?: boolean) => {
      const names = new Set(this.className.split(/\s+/).filter(Boolean));
      if (force ?? !names.has(name)) names.add(name);
      else names.delete(name);
      this.className = [...names].join(' ');
    },
    contains: (name: string) => this.className.split(/\s+/).includes(name),
  };
  constructor(readonly tag: string) {}
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  appendChild(child: FakeElement): FakeElement { child.parent = this; this.children.push(child); return child; }
  addEventListener(type: string, listener: () => void): void { if (type === 'click') this.#click = listener; }
  removeEventListener(type: string): void { if (type === 'click') this.#click = undefined; }
  click(): void { this.#click?.(); }
  remove(): void { this.removed = true; }
}

class FakeHost {
  type = 'mercator';
  readonly listeners = new Map<string, (() => void)[]>();
  getProjection() { return { type: this.type }; }
  setProjection(p: { type: string }) { this.type = p.type; this.fire('projectiontransition'); return this; }
  on(t: string, l: () => void) { this.listeners.set(t, [...(this.listeners.get(t) ?? []), l]); }
  off(t: string, l: () => void) { this.listeners.set(t, (this.listeners.get(t) ?? []).filter((x) => x !== l)); }
  fire(t: string) { for (const l of this.listeners.get(t) ?? []) l(); }
}

const g = globalThis as { document?: unknown };
let saved: unknown;
beforeEach(() => {
  saved = g.document;
  g.document = { createElement: (tag: string) => new FakeElement(tag) };
});
afterEach(() => { g.document = saved; });

const add = (control: EqualEarthControl, host: FakeHost) => control.onAdd(host) as unknown as FakeElement;

describe('EqualEarthControl', () => {
  it('turns Equal Earth on and off, reflecting the state in aria-pressed and the title', () => {
    const host = new FakeHost();
    const el = add(new EqualEarthControl(), host);
    const button = el.children[0]!;
    expect(el.className).toBe('maplibregl-ctrl maplibregl-ctrl-group');
    expect(button.className).toBe('maplibregl-ctrl-equal-earth');
    expect(button.innerHTML).toContain('<svg');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.getAttribute('title')).toBe('Equal Earth');
    button.click();
    expect(host.type).toBe('equal');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.getAttribute('title')).toBe('Mercator');
    button.click();
    expect(host.type).toBe('mercator');
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it("follows a projection the application sets itself", () => {
    const host = new FakeHost();
    const el = add(new EqualEarthControl({ on: 'equal-earth', off: 'globe' }), host);
    host.setProjection({ type: 'equal-earth' });
    expect(el.children[0]!.getAttribute('aria-pressed')).toBe('true');
    expect(el.children[0]!.getAttribute('title')).toBe('Globe');
    el.children[0]!.click();
    expect(host.type).toBe('globe');
  });

  it('follows a projection a style change carries', () => {
    const host = new FakeHost();
    const el = add(new EqualEarthControl(), host);
    host.type = 'equal';
    host.fire('styledata');
    expect(el.children[0]!.getAttribute('aria-pressed')).toBe('true');
  });

  it('removes its listeners and element on onRemove', () => {
    const host = new FakeHost();
    const control = new EqualEarthControl();
    const el = add(control, host);
    control.onRemove();
    expect([...host.listeners.values()].flat()).toHaveLength(0);
    expect(el.removed).toBe(true);
    expect(control.getDefaultPosition()).toBe('top-right');
  });
});
