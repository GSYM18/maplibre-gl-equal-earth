import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { buildId, eqeVersion, workerSources } from '../scripts/build-id.ts';

const dirs: string[] = [];
function tempTree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'eqe-build-id-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('build id (the persistent cache name, Ruling R25)', () => {
  const tree = () =>
    tempTree({
      'entry.ts': "import { a } from './a.js';\nimport type { T } from './types.js';\nexport { a };\n",
      'a.ts': "import './b.js';\nexport const a = 1;\n",
      'b.ts': 'export const b = 2;\n',
      'types.ts': 'export type T = number;\n',
      'unrelated.ts': 'export const u = 3;\n',
    });

  it('follows the relative imports of the entry, transitively', () => {
    const dir = tree();
    const files = workerSources(join(dir, 'entry.ts')).map((file) => relative(dir, file));
    expect(files).toEqual(['a.ts', 'b.ts', 'entry.ts', 'types.ts']);
  });

  it('changes when a bundled source changes, and not when anything else does', () => {
    const dir = tree();
    const entry = join(dir, 'entry.ts');
    const first = buildId({ entry, version: '1.0.0' });
    expect(first).toMatch(/^1\.0\.0\+[0-9a-f]{8}$/);
    expect(buildId({ entry, version: '1.0.0' })).toBe(first);

    writeFileSync(join(dir, 'unrelated.ts'), 'export const u = 4;\n');
    expect(buildId({ entry, version: '1.0.0' })).toBe(first);

    writeFileSync(join(dir, 'b.ts'), 'export const b = 3;\n');
    const second = buildId({ entry, version: '1.0.0' });
    expect(second).not.toBe(first);
    expect(buildId({ entry, version: '1.0.0', extra: ['vt-pbf@3.1.3'] })).not.toBe(second);
  });

  it('does not depend on line endings', () => {
    const lf = tempTree({ 'entry.ts': 'export const a = 1;\nexport const b = 2;\n' });
    const crlf = tempTree({ 'entry.ts': 'export const a = 1;\r\nexport const b = 2;\r\n' });
    expect(buildId({ entry: join(lf, 'entry.ts'), version: '1' })).toBe(
      buildId({ entry: join(crlf, 'entry.ts'), version: '1' }),
    );
  });

  it("covers this repository's worker bundle: the tile pipeline and the maths, not the map modules", () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const files = workerSources(join(root, 'src/tiles/worker-entry.ts')).map((file) =>
      relative(root, file).replace(/\\/g, '/'),
    );
    for (const expected of ['src/tiles/worker-entry.ts', 'src/tiles/protocol.ts', 'src/tiles/mvt.ts', 'src/tiles/clip.ts', 'src/tiles/persistent-cache.ts', 'src/math/backproject.ts', 'src/math/equal-earth.ts']) {
      expect(files).toContain(expected);
    }
    expect(files).not.toContain('src/map/controller.ts');
    const pkg = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
    expect(eqeVersion()).toMatch(new RegExp(`^${pkg.replace(/\./g, '\\.')}\\+[0-9a-f]{8}$`));
  });
});

