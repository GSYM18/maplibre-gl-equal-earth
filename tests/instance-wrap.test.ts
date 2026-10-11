import { describe, expect, it } from 'vitest';
import { wrapMethod } from '../src/map/instance-wrap.js';

class Base { greet(name: string): string { return `hi ${name}`; } }

describe('wrapMethod', () => {
  it('shadows the prototype method on the instance and restores by deleting', () => {
    const a = new Base();
    const b = new Base();
    const restore = wrapMethod<(n: string) => string>(a, 'greet', (original) => (n) => original(n).toUpperCase());
    expect(a.greet('x')).toBe('HI X');
    expect(b.greet('x')).toBe('hi x');
    restore();
    expect(Object.prototype.hasOwnProperty.call(a, 'greet')).toBe(false);
    expect(a.greet('x')).toBe('hi x');
  });

  it('wraps and restores an existing own property', () => {
    const a = new Base();
    const own = (n: string) => `own ${n}`;
    a.greet = own;
    const restore = wrapMethod<(n: string) => string>(a, 'greet', (original) => (n) => `[${original(n)}]`);
    expect(a.greet('x')).toBe('[own x]');
    restore();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- compared by identity
    expect(a.greet).toBe(own);
  });

  it('leaves a method the application replaced after us', () => {
    const a = new Base();
    const restore = wrapMethod<(n: string) => string>(a, 'greet', (original) => original);
    const app = (n: string) => `app ${n}`;
    a.greet = app;
    restore();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- compared by identity
    expect(a.greet).toBe(app);
  });

  it('is a no-op for a missing method', () => {
    const a = {};
    const restore = wrapMethod(a, 'nope', (original) => original);
    expect('nope' in a).toBe(false);
    expect(() => restore()).not.toThrow();
  });
});
