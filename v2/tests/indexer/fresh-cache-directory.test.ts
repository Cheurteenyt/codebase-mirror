import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { indexProjectWasm } from '../../src/indexer/indexer.js';

describe('indexer on a fresh installation', () => {
  const originalCacheHome = process.env.XDG_CACHE_HOME;
  let tempRoot: string | undefined;

  afterEach(() => {
    if (originalCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = originalCacheHome;
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  });

  it('creates the code database parent without requiring a human store first', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'cbm-fresh-index-'));
    const projectRoot = join(tempRoot, 'project');
    const cacheRoot = join(tempRoot, 'cache-that-does-not-exist');
    mkdirSync(projectRoot);
    writeFileSync(join(projectRoot, 'index.ts'), 'export const ready = true;\n');
    process.env.XDG_CACHE_HOME = cacheRoot;

    const result = await indexProjectWasm({
      project: 'fresh-install',
      rootPath: projectRoot,
      incremental: false,
      dryRun: false,
      useWasm: true,
      workers: 0,
    });

    expect(result.errors).toEqual([]);
    expect(result.outcome).toBe('SUCCESS');
    expect(existsSync(result.dbPath)).toBe(true);
  });
});
