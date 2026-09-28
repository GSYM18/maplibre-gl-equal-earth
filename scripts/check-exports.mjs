/**
 * Guard against the failure that broke `maplibre-gl-equal-earth@0.2.1`: `lib/` was renamed,
 * `dist/` was never rebuilt, and the published bundle exported a function name that no longer
 * existed while omitting two that did. Nothing detected it for two years.
 *
 * Compares the runtime exports of the built bundle against the value exports declared in
 * `src/index.ts`. Run after `npm run build`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = new URL('..', import.meta.url);
const entrySource = readFileSync(new URL('src/index.ts', repoRoot), 'utf8');

/** Value (non-type) export names declared by src/index.ts. */
function declaredValueExports(source) {
  // Strip block and line comments so commented-out exports are not counted.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const names = new Set();
  for (const match of code.matchAll(/export\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g)) {
    for (const rawSpecifier of match[1].split(',')) {
      const specifier = rawSpecifier.trim();
      if (specifier === '' || specifier.startsWith('type ')) continue;
      // `X as Y` publishes Y.
      const parts = specifier.split(/\s+as\s+/);
      names.add((parts[1] ?? parts[0]).trim());
    }
  }
  return names;
}

const expected = declaredValueExports(entrySource);
if (expected.size === 0) {
  console.error('check-exports: parsed zero exports from src/index.ts — the parser is broken.');
  process.exit(1);
}

const bundleUrl = new URL('dist/index.js', repoRoot);
let bundle;
try {
  // Import by URL href, not by path: on Windows a drive-letter path is rejected by the
  // ESM loader as an unsupported URL scheme ('c:').
  bundle = await import(bundleUrl.href);
} catch (error) {
  console.error(
    `check-exports: could not import ${fileURLToPath(bundleUrl)}. Run \`npm run build\` first.`,
  );
  console.error(error);
  process.exit(1);
}

const actual = new Set(Object.keys(bundle).filter((key) => key !== 'default'));

const missing = [...expected].filter((name) => !actual.has(name)).sort();
const extra = [...actual].filter((name) => !expected.has(name)).sort();

if (missing.length > 0 || extra.length > 0) {
  console.error('check-exports: dist/index.js does not match src/index.ts.\n');
  if (missing.length > 0) {
    console.error(`  declared in src but absent from the bundle: ${missing.join(', ')}`);
  }
  if (extra.length > 0) {
    console.error(`  present in the bundle but not declared in src: ${extra.join(', ')}`);
  }
  console.error('\nRebuild with `npm run build`.');
  process.exit(1);
}

console.log(`check-exports: ${actual.size} exports match src/index.ts.`);
