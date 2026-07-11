// v2/tests/cli/r153-cli-process.test.ts
// R153 (TEST-R153-04): CLI process spawn tests for index command.
// Verifies stdout output, exit codes, and warning visibility by spawning the
// actual CLI binary as a subprocess.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, '..', '..', 'dist', 'cli', 'index.js');

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

async function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [CLI_PATH, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    proc.stdout.on('data', (d) => stdout.push(d.toString()));
    proc.stderr.on('data', (d) => stderr.push(d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      resolve({ stdout: stdout.join(''), stderr: stderr.join(''), exitCode: code });
    });
  });
}

describe('R153: CLI process tests (TEST-R153-04)', () => {
  let tmpDir: string, projectDir: string, cacheDir: string, projectName: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r153cli-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r153cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('TEST-R153-04a: clean index → exit 0, SUCCESS banner', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    const result = await runCli(
      ['index', '--project', projectName, '--root', projectDir,],
      { XDG_CACHE_HOME: cacheDir },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('indexed successfully');
    expect(result.stdout).not.toContain('with warnings');
  });

  it('TEST-R153-04b: index with broken symlink (no history) → exit 0, SUCCESS_WITH_WARNINGS', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    symlinkSync('/nonexistent', join(projectDir, 'broken.ts'));
    const result = await runCli(
      ['index', '--project', projectName, '--root', projectDir,],
      { XDG_CACHE_HOME: cacheDir },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('indexed successfully with warnings');
    expect(result.stdout).toContain('discovery warning');
    expect(result.stdout).toContain('ENOENT');
    expect(result.stdout).toContain('broken.ts');
  });

  it('TEST-R153-04c: dry-run shows warnings even without DB writes', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    symlinkSync('/nonexistent', join(projectDir, 'broken.ts'));
    const result = await runCli(
      ['index', '--project', projectName, '--root', projectDir, '--dry-run', ],
      { XDG_CACHE_HOME: cacheDir },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Dry-run complete');
    // R153 (OUTCOME-R153-02): dry-run shows warnings.
    expect(result.stdout).toContain('discovery warning');
    expect(result.stdout).toContain('ENOENT');
  });

  it('TEST-R153-04d: missing root → exit 1', async () => {
    const result = await runCli(
      ['index', '--project', projectName, '--root', join(tmpDir, 'does-not-exist'),],
      { XDG_CACHE_HOME: cacheDir },
    );
    expect(result.exitCode).toBe(1);
    // The error is printed to stdout via console.log (not stderr).
    expect(result.stdout).toContain('Discovery root error');
    // R160 (CLI-R160-01): when result.failure is present, the first line is
    // "indexing failed due to a system error" instead of "indexed with N
    // error(s)". The errors list still shows "Errors: 1" in the Result block.
    expect(result.stdout).toContain('Errors:          1');
    expect(result.stdout).toContain('indexing failed due to a system error');
  });

  it('TEST-R153-04e: warnings printed BEFORE success banner (ordering)', async () => {
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    symlinkSync('/nonexistent', join(projectDir, 'broken.ts'));
    const result = await runCli(
      ['index', '--project', projectName, '--root', projectDir,],
      { XDG_CACHE_HOME: cacheDir },
    );
    expect(result.exitCode).toBe(0);
    const warningIdx = result.stdout.indexOf('discovery warning');
    const successIdx = result.stdout.indexOf('indexed successfully with warnings');
    expect(warningIdx).toBeGreaterThan(-1);
    expect(successIdx).toBeGreaterThan(-1);
    // R153 (OUTCOME-R153-01): warnings come BEFORE the success banner.
    expect(warningIdx).toBeLessThan(successIdx);
  });

  it('TEST-R153-04f: warning count uses actual sample length, not hardcoded 5', async () => {
    // Create 10 broken symlinks — the "and N more" should reflect the real
    // hidden count (10 - samplePaths.length for ENOENT), not 10 - 5.
    writeFileSync(join(projectDir, 'a.ts'), 'export function a() { return 1; }\n');
    for (let i = 0; i < 10; i++) {
      symlinkSync('/nonexistent', join(projectDir, `broken${i}.ts`));
    }
    const result = await runCli(
      ['index', '--project', projectName, '--root', projectDir,],
      { XDG_CACHE_HOME: cacheDir },
    );
    expect(result.exitCode).toBe(0);
    // The ENOENT line should show count=10 and 5 samples + "and 5 more".
    // R153 (OUTCOME-R153-03): count - samplePaths.length, not count - 5.
    const enoentLine = result.stdout.split('\n').find(l => l.includes('ENOENT (10)'));
    expect(enoentLine).toBeDefined();
    expect(enoentLine!).toContain('and 5 more');
  });

  // ── R154 (OUTCOME-R154-01): --allow-partial does NOT mask FAILED ────

  it('TEST-R154-01a: missing root + --allow-partial → exit 1 (FAILED not masked)', async () => {
    const result = await runCli(
      ['index', '--project', projectName, '--root', join(tmpDir, 'does-not-exist'), '--allow-partial'],
      { XDG_CACHE_HOME: cacheDir },
    );
    // R154: --allow-partial only masks PARTIAL, not FAILED. Missing root = FAILED = exit 1.
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Discovery root error');
  });

  // ── R155 (OUTCOME-R155-02): Dry-run failure banner ──────────────────

  it('TEST-R155-02a: missing root + --dry-run → "Dry-run failed" (not "Dry-run complete")', async () => {
    const result = await runCli(
      ['index', '--project', projectName, '--root', join(tmpDir, 'does-not-exist'), '--dry-run'],
      { XDG_CACHE_HOME: cacheDir },
    );
    // R155: dry-run with errors shows "Dry-run failed", not "Dry-run complete".
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Dry-run failed');
    expect(result.stdout).not.toContain('Dry-run complete');
  });
});
