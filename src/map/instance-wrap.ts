/**
 * Per-instance method wrapping (spec §7): a wrapper is an own property of one map, shadowing the
 * prototype's method, so other maps on the same page are untouched. MapLibre captures no method
 * references (audit §0.2), so its own internal calls reach the wrapper too.
 */

/**
 * Install `make(original)` as an own property `name` of `target`, shadowing the prototype's
 * method. `original` is the method found there before, bound to `target`. The returned
 * restore puts back exactly what was there (an earlier own property, or nothing) — but only
 * while ours is still installed: an application that replaced it after us keeps its own.
 * A missing method is left alone and restore is a no-op.
 */
export function wrapMethod<F extends (...args: never[]) => unknown>(
  target: object,
  name: string,
  make: (original: F) => F,
): () => void {
  const slots = target as Record<string, unknown>;
  const found = slots[name];
  if (typeof found !== 'function') return () => {};
  const previous = Object.getOwnPropertyDescriptor(target, name);
  const original = ((...args: Parameters<F>) => (found as F).apply(target, args)) as F;
  const wrapper = make(original);
  Object.defineProperty(target, name, { value: wrapper, writable: true, configurable: true, enumerable: false });
  return () => {
    if (slots[name] !== wrapper) return;
    if (previous) Object.defineProperty(target, name, previous);
    else delete slots[name];
  };
}
