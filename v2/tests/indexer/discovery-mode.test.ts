import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import Database from 'better-sqlite3';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';
import { CURRENT_DISCOVERY_POLICY_VERSION } from '../../src/indexer/schema.js';
import {
  discoverSourceFilesStructured,
  discoverSourceFilesWasm,
  type DiscoveryMode,
} from '../../src/indexer/wasm-extractor.js';

describe('source-discovery coverage modes', () => {
  let tmpDir: string;
  let projectDir: string;
  let createdDbPaths: string[];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cbm-discovery-mode-'));
    projectDir = join(tmpDir, 'project');
    createdDbPaths = [];
    mkdirSync(projectDir, { recursive: true });

    for (const file of [
      'src/main.ts',
      'scripts/generate.ts',
      'tools/release.ts',
      'docs/example.ts',
      'tests/main.test.ts',
      'tests/helper.ts',
      'migrations/001-create-table.ts',
      'node_modules/dependency/index.ts',
      'vendor/library.ts',
      '.hidden/secret.ts',
      '.github/workflows/ci.yml',
      '.storybook/story.ts',
      'composer.json',
      'tslint.json',
      '.stylelintrc.json',
      'pnpm-lock.json',
      '.vscode/launch.json',
      '.vscode/settings.json',
      '.vscode/extensions.json',
      '.vscode/tasks.json',
    ]) {
      const fullPath = join(projectDir, ...file.split('/'));
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, `export const value = ${JSON.stringify(file)};\n`);
    }
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    for (const dbPath of createdDbPaths) {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
    }
  });

  function uniqueProject(prefix: string): { project: string; dbPath: string } {
    const project = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const dbPath = defaultCodeDbPath(project);
    createdDbPaths.push(dbPath);
    return { project, dbPath };
  }

  function projectRelative(files: string[]): string[] {
    return files
      .map(file => relative(projectDir, file).split(sep).join('/'))
      .sort();
  }

  it('defaults to full coverage and includes scripts, tools, docs, tests, and migrations', () => {
    const mode: DiscoveryMode = 'full';
    const result = discoverSourceFilesStructured(projectDir);

    expect(mode).toBe('full');
    expect(result.complete).toBe(true);
    expect(projectRelative(result.files)).toEqual([
      '.github/workflows/ci.yml',
      '.hidden/secret.ts',
      '.storybook/story.ts',
      '.stylelintrc.json',
      'composer.json',
      'docs/example.ts',
      'migrations/001-create-table.ts',
      'pnpm-lock.json',
      'scripts/generate.ts',
      'src/main.ts',
      'tests/helper.ts',
      'tests/main.test.ts',
      'tools/release.ts',
      'tslint.json',
    ]);
    expect(projectRelative(discoverSourceFilesWasm(projectDir))).toEqual(projectRelative(result.files));
  });

  it('keeps fast coverage opt-in and excludes the lower-priority source families', () => {
    const result = discoverSourceFilesStructured(projectDir, undefined, 'fast');

    expect(result.complete).toBe(true);
    expect(projectRelative(result.files)).toEqual([
      '.github/workflows/ci.yml',
      '.hidden/secret.ts',
      '.storybook/story.ts',
      'src/main.ts',
      'tests/helper.ts',
    ]);
    expect(result.skippedPolicyPaths).toBeGreaterThanOrEqual(7);
    expect(projectRelative(discoverSourceFilesWasm(projectDir, 'fast'))).toEqual(projectRelative(result.files));
  });

  it('keeps the V1 fast exclusions for JSON manifests and VS Code configuration', () => {
    const result = discoverSourceFilesStructured(projectDir, undefined, 'fast');
    const discovered = new Set(projectRelative(result.files));

    for (const excludedPath of [
      'composer.json',
      'tslint.json',
      '.stylelintrc.json',
      'pnpm-lock.json',
      '.vscode/launch.json',
      '.vscode/settings.json',
      '.vscode/extensions.json',
      '.vscode/tasks.json',
    ]) {
      expect(discovered.has(excludedPath), `${excludedPath} should be excluded`).toBe(false);
    }

    expect(projectRelative(discoverSourceFilesWasm(projectDir, 'fast'))).toEqual([...discovered].sort());
  });

  it('propagates discoveryMode through indexProjectWasm and keeps full as its API default', async () => {
    const baseOptions = {
      project: `discovery-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      rootPath: projectDir,
      dryRun: true,
      workers: 0,
    };

    const fullResult = await indexProjectWasm(baseOptions);
    const fastResult = await indexProjectWasm({ ...baseOptions, discoveryMode: 'fast' });

    expect(fullResult.errors).toEqual([]);
    expect(fullResult.files).toBe(14);
    expect(fastResult.errors).toEqual([]);
    expect(fastResult.files).toBe(5);
  });

  it('rejects fast incremental before creating a fresh project database', async () => {
    const { project, dbPath } = uniqueProject('discovery-fast-incremental-fresh');

    await expect(indexProjectWasm({
      project,
      rootPath: projectDir,
      incremental: true,
      discoveryMode: 'fast',
      workers: 0,
    })).rejects.toThrow('Fast discovery is incompatible with incremental indexing');

    expect(existsSync(dbPath)).toBe(false);
  });

  it('rejects full-to-fast incremental without mutating the existing database', async () => {
    const { project, dbPath } = uniqueProject('discovery-full-to-fast');
    const fullResult = await indexProjectWasm({ project, rootPath: projectDir, workers: 0 });
    expect(fullResult.errors).toEqual([]);
    expect(fullResult.files).toBe(14);
    const before = readFileSync(dbPath);

    await expect(indexProjectWasm({
      project,
      rootPath: projectDir,
      incremental: true,
      discoveryMode: 'fast',
      workers: 0,
    })).rejects.toThrow('excluded source families cannot be updated or safely deleted');

    expect(readFileSync(dbPath)).toEqual(before);
  });

  it('allows a full incremental pass to expand a previous fast full rebuild', async () => {
    const { project, dbPath } = uniqueProject('discovery-fast-to-full');
    const fastResult = await indexProjectWasm({
      project,
      rootPath: projectDir,
      discoveryMode: 'fast',
      workers: 0,
    });
    expect(fastResult.errors).toEqual([]);
    expect(fastResult.files).toBe(5);

    const fullIncremental = await indexProjectWasm({
      project,
      rootPath: projectDir,
      incremental: true,
      discoveryMode: 'full',
      workers: 0,
    });
    expect(fullIncremental.errors).toEqual([]);
    expect(fullIncremental.files).toBe(9);

    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.prepare(
        'SELECT COUNT(DISTINCT file_path) AS count FROM nodes WHERE project = ?',
      ).get(project) as { count: number };
      expect(row.count).toBe(14);
    } finally {
      db.close();
    }
  });

  it('bumps the persisted discovery policy so old incomplete caches are not current', () => {
    expect(CURRENT_DISCOVERY_POLICY_VERSION).toBe(3);
  });
});
