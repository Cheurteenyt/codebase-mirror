import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

describe('index CLI worker path', () => {
  let tmpDir: string;
  let projectDir: string;
  let cacheDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cbm-worker-url-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });

    // More than 20 files forces the parallel path when --workers is greater
    // than one, so this cannot silently pass through the single-thread path.
    for (let i = 0; i < 24; i++) {
      writeFileSync(
        join(projectDir, `worker-${i}.ts`),
        `export function worker${i}() { return ${i}; }\n`,
      );
    }
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function runIndex(workers: number) {
    const cliPath = fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url));
    const args = [
      cliPath,
      'index',
      '--project', `worker-url-${workers}-${Date.now()}`,
      '--root', projectDir,
      '--workers', String(workers),
    ];

    return spawnSync(process.execPath, args, {
      encoding: 'utf8',
      env: { ...process.env, XDG_CACHE_HOME: cacheDir },
      timeout: 60_000,
      windowsHide: true,
    });
  }

  it('runs the compiled parallel worker without mangling its Windows file URL', () => {
    const result = runIndex(2);
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

    expect(result.error, output).toBeUndefined();
    expect(result.status, output).toBe(0);
    expect(output).toContain('Files indexed:   24');
    expect(output).toContain('Parallel:        2 workers');
  });

  it('accepts --workers 0 for an explicit single-threaded run', () => {
    const result = runIndex(0);
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

    expect(result.error, output).toBeUndefined();
    expect(result.status, output).toBe(0);
    expect(output).toContain('Files indexed:   24');
    expect(output).not.toContain('Parallel:');
  });
});
