/**
 * The build id that names the persistent tile cache (Ruling R25): `__EQE_VERSION__` is
 * `<package version>+<content hash>`, the hash covering every source file bundled into the worker
 * (the relative-import graph of `src/tiles/worker-entry.ts`) and the installed versions of the
 * runtime dependencies bundled with them. The package version alone stays the same through
 * development, so after a change to the warp, the clip or the encoding a reload would otherwise be
 * served the old warped tiles for up to `ttlDays`. A release build is stable per content; any
 * change to what the worker computes starts a fresh cache, and the cache's own cleanup deletes the
 * previous one.
 *
 * One helper for every build that compiles `src/` (vite.config.ts, vite.worker.config.ts,
 * vitest.config.ts, tests/browser/vite.config.ts), so they all see the same value.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `import … from './x.js'`, `export … from '../y.js'`, `import './z.js'`, `import('./w.js')`. */
const RELATIVE_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

/** The source file a relative specifier names: `.js` is written for `.ts` (bundler resolution). */
function resolveSpecifier(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier);
  const candidates = [base.replace(/\.js$/, '.ts'), base, `${base}.ts`, join(base, 'index.ts')];
  return candidates.find((candidate) => existsSync(candidate) && candidate.endsWith('.ts'));
}

/** Every file in the relative-import graph of `entry`, itself included, sorted. */
export function workerSources(entry: string): string[] {
  const seen = new Set<string>();
  const pending = [resolve(entry)];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, 'utf8').matchAll(RELATIVE_SPECIFIER)) {
      const next = resolveSpecifier(file, match[1]!);
      if (next !== undefined && !seen.has(next)) pending.push(next);
    }
  }
  return [...seen].sort();
}

export interface BuildIdOptions {
  /** The worker entry whose import graph is hashed. */
  entry: string;
  version: string;
  /** Further strings hashed with the sources, e.g. `name@version` of bundled dependencies. */
  extra?: readonly string[];
}

/** `<version>+<8 hex digits>`: SHA-256 over the sources (line endings normalised) and `extra`. */
export function buildId({ entry, version, extra = [] }: BuildIdOptions): string {
  const root = dirname(resolve(entry));
  const hash = createHash('sha256');
  for (const file of workerSources(entry)) {
    // Relative paths and LF line endings: a Windows and a Linux checkout agree.
    hash.update(`${relative(root, file).replace(/\\/g, '/')}\0`);
    hash.update(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
    hash.update('\0');
  }
  for (const item of extra) hash.update(`${item}\0`);
  return `${version}+${hash.digest('hex').slice(0, 8)}`;
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));

interface PackageJson {
  version: string;
  dependencies?: Record<string, string>;
}

const readPackage = (path: string): PackageJson => JSON.parse(readFileSync(path, 'utf8')) as PackageJson;

/** This repository's `__EQE_VERSION__`. */
export function eqeVersion(): string {
  const pkg = readPackage(join(ROOT, 'package.json'));
  // The runtime dependencies are bundled into the worker too (MVT decode and encode).
  const dependencies = Object.keys(pkg.dependencies ?? {})
    .sort()
    .map((name) => {
      const installed = join(ROOT, 'node_modules', name, 'package.json');
      return `${name}@${existsSync(installed) ? readPackage(installed).version : 'missing'}`;
    });
  return buildId({ entry: join(ROOT, 'src/tiles/worker-entry.ts'), version: pkg.version, extra: dependencies });
}
