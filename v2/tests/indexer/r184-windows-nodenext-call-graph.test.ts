import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import { CURRENT_EXTRACTOR_SEMANTICS_VERSION } from '../../src/indexer/schema.js';

describe('R184: Windows NodeNext call-graph correctness', () => {
  let tmpDir: string;
  let projectDir: string;
  let cacheDir: string;
  let projectName: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r184-windows-calls-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(join(projectDir, 'src', 'delivery'), { recursive: true });
    mkdirSync(join(projectDir, 'src', 'orchestration'), { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r184-windows-calls-${Date.now()}`;
    process.env.XDG_CACHE_HOME = cacheDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.XDG_CACHE_HOME;
  });

  it('resolves a nested NodeNext .js import to its .ts source without phantom functions', async () => {
    writeFileSync(
      join(projectDir, 'src', 'delivery', 'publish.ts'),
      'export async function commitDelivery(value: string) { return value; }\n',
    );
    writeFileSync(
      join(projectDir, 'src', 'orchestration', 'pipeline.ts'),
      [
        "import { commitDelivery } from '../delivery/publish.js';",
        'export async function runPipeline(value: string) {',
        '  return commitDelivery(value);',
        '}',
        '',
      ].join('\n'),
    );

    const result = await indexProjectWasm({
      project: projectName,
      rootPath: projectDir,
      incremental: false,
      useWasm: true,
      workers: 0,
    });
    expect(result.errors).toEqual([]);

    const db = new Database(defaultCodeDbPath(projectName), { readonly: true });
    try {
      const functions = db.prepare(
        `SELECT name, file_path
         FROM nodes
         WHERE project = ? AND label = 'Function'
         ORDER BY file_path, name`,
      ).all(projectName) as Array<{ name: string; file_path: string }>;

      expect.soft(functions.map(({ name }) => name)).toEqual([
        'commitDelivery',
        'runPipeline',
      ]);

      const calls = db.prepare(
        `SELECT s.name AS source_name, t.name AS target_name, e.properties_json
         FROM edges e
         JOIN nodes s ON s.project = e.project AND s.id = e.source_id
         JOIN nodes t ON t.project = e.project AND t.id = e.target_id
         WHERE e.project = ? AND e.type = 'CALLS'`,
      ).all(projectName) as Array<{
        source_name: string;
        target_name: string;
        properties_json: string;
      }>;

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        source_name: 'runPipeline',
        target_name: 'commitDelivery',
      });
      expect(JSON.parse(calls[0].properties_json)).toMatchObject({
        resolution: 'cross_file_import_exact',
        confidence: 1,
      });

      const moduleDependencies = db.prepare(
        `SELECT s.file_path AS source_path, t.file_path AS target_path, e.properties_json
         FROM edges e
         JOIN nodes s ON s.project = e.project AND s.id = e.source_id
         JOIN nodes t ON t.project = e.project AND t.id = e.target_id
         WHERE e.project = ? AND e.type = 'IMPORTS'`,
      ).all(projectName) as Array<{
        source_path: string;
        target_path: string;
        properties_json: string;
      }>;

      expect(moduleDependencies).toHaveLength(1);
      expect(moduleDependencies[0].source_path.replaceAll('\\', '/'))
        .toBe('src/orchestration/pipeline.ts');
      expect(moduleDependencies[0].target_path.replaceAll('\\', '/'))
        .toBe('src/delivery/publish.ts');
      expect(JSON.parse(moduleDependencies[0].properties_json)).toMatchObject({
        resolution: 'cross_file_module_exact',
        confidence: 1,
        binding_count: 1,
        import_kinds: ['named'],
      });
    } finally {
      db.close();
    }
  });

  it('marks a v8 graph stale instead of reusing pre-R184 file hashes', async () => {
    writeFileSync(
      join(projectDir, 'src', 'delivery', 'publish.ts'),
      'export function commitDelivery(value: string) { return value; }\n',
    );
    writeFileSync(
      join(projectDir, 'src', 'orchestration', 'pipeline.ts'),
      [
        "import { commitDelivery } from '../delivery/publish.js';",
        'export function runPipeline(value: string) { return commitDelivery(value); }',
        '',
      ].join('\n'),
    );
    const full = await indexProjectWasm({
      project: projectName,
      rootPath: projectDir,
      incremental: false,
      useWasm: true,
      workers: 0,
    });
    expect(full.errors).toEqual([]);
    expect(CURRENT_EXTRACTOR_SEMANTICS_VERSION).toBe(9);

    const dbPath = defaultCodeDbPath(projectName);
    const writable = new Database(dbPath);
    const fileHashesBefore = (
      writable.prepare('SELECT COUNT(*) AS c FROM file_hashes WHERE project = ?')
        .get(projectName) as { c: number }
    ).c;
    writable.prepare(
      'UPDATE projects SET extractor_semantics_version = 8 WHERE name = ?',
    ).run(projectName);
    writable.prepare(
      `DELETE FROM edges
       WHERE project = ? AND type = 'IMPORTS'
         AND properties_json LIKE '%"resolution":"cross_file_module_exact"%'`,
    ).run(projectName);
    writable.close();

    const incremental = await indexProjectWasm({
      project: projectName,
      rootPath: projectDir,
      incremental: true,
      useWasm: true,
      workers: 0,
    });
    expect(incremental.crossFileCallsStale).toBe(true);

    const readonly = new Database(dbPath, { readonly: true });
    try {
      const fileHashesAfter = (
        readonly.prepare('SELECT COUNT(*) AS c FROM file_hashes WHERE project = ?')
          .get(projectName) as { c: number }
      ).c;
      expect(fileHashesAfter).toBe(fileHashesBefore);
    } finally {
      readonly.close();
    }
  });
});
