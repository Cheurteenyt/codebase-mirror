// v2/tests/indexer/r100-cross-file-calls.test.ts
// R100: Cross-file CALLS precision + correctness tests.
// Closes the test gap identified by GPT 5.5 R100 audit.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProjectWasm } from '../../src/indexer/indexer.js';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';

describe('R100: Cross-file CALLS Precision + Correctness', () => {
  let tmpDir: string;
  let projectDir: string;
  let cacheDir: string;
  let projectName: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r100-'));
    projectDir = join(tmpDir, 'project');
    cacheDir = join(tmpDir, 'cache');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(cacheDir, 'codebase-memory-mcp'), { recursive: true });
    projectName = `r100-${Date.now()}`;
    process.env.XDG_CACHE_HOME = cacheDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.XDG_CACHE_HOME;
    delete process.env.CBM_TEST_FAIL_ON_FILE;
  });

  function getDb(): Database.Database {
    return new Database(defaultCodeDbPath(projectName), { readonly: true });
  }

  function countCrossFileEdges(db: Database.Database): number {
    return (db.prepare("SELECT COUNT(*) AS c FROM edges WHERE project = ? AND type = 'CALLS' AND properties_json LIKE '%cross_file%'").get(projectName) as { c: number }).c;
  }

  it('full index: cross-file CALLS edge created for identifier call', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 42; }\n');
    writeFileSync(join(projectDir, 'a.ts'), 'export function caller() { return foo(); }\n');

    const result = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    expect(result.errors.length).toBe(0);

    const db = getDb();
    const crossFile = countCrossFileEdges(db);
    expect(crossFile).toBeGreaterThan(0);

    const edge = db.prepare("SELECT properties_json FROM edges WHERE project = ? AND type = 'CALLS' AND properties_json LIKE '%cross_file%' AND properties_json LIKE '%foo%' LIMIT 1").get(projectName) as { properties_json: string };
    expect(edge).toBeDefined();
    const props = JSON.parse(edge.properties_json);
    expect(props.callee).toBe('foo');
    expect(props.call_kind).toBe('identifier_call');
    expect(props.resolution).toBe('cross_file_name_exact');
    db.close();
  });

  it('builtins filtered: console.log, array.map do not create cross-file edges', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function log() { return 1; }\nexport function map() { return 2; }\n');
    writeFileSync(join(projectDir, 'a.ts'), 'export function caller() { console.log("x"); const arr = [1]; arr.map(x => x); return log(); }\n');

    const result = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    expect(result.errors.length).toBe(0);

    const db = getDb();
    // console.log should NOT create a cross-file edge to b::log
    const consoleLogEdges = (db.prepare("SELECT COUNT(*) AS c FROM edges WHERE project = ? AND type = 'CALLS' AND properties_json LIKE '%console.log%'").get(projectName) as { c: number }).c;
    expect(consoleLogEdges).toBe(0);

    // arr.map should NOT create a cross-file edge to b::map
    const arrMapEdges = (db.prepare("SELECT COUNT(*) AS c FROM edges WHERE project = ? AND type = 'CALLS' AND properties_json LIKE '%arr.map%'").get(projectName) as { c: number }).c;
    expect(arrMapEdges).toBe(0);

    // But log() as identifier_call SHOULD create an edge
    const logEdges = (db.prepare("SELECT COUNT(*) AS c FROM edges WHERE project = ? AND type = 'CALLS' AND properties_json LIKE '%\"callee\":\"log\"%'").get(projectName) as { c: number }).c;
    expect(logEdges).toBeGreaterThan(0);

    db.close();
  });

  it('ambiguity: max 5 candidates per call', async () => {
    for (let i = 0; i < 7; i++) {
      writeFileSync(join(projectDir, `file${i}.ts`), `export function foo() { return ${i}; }\n`);
    }
    writeFileSync(join(projectDir, 'caller.ts'), 'export function caller() { return foo(); }\n');

    const result = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    expect(result.errors.length).toBe(0);

    const db = getDb();
    const fooEdges = (db.prepare("SELECT COUNT(*) AS c FROM edges WHERE project = ? AND type = 'CALLS' AND properties_json LIKE '%\"callee\":\"foo\"%' AND properties_json LIKE '%cross_file%'").get(projectName) as { c: number }).c;
    expect(fooEdges).toBeLessThanOrEqual(5);

    const sample = db.prepare("SELECT properties_json FROM edges WHERE project = ? AND type = 'CALLS' AND properties_json LIKE '%\"callee\":\"foo\"%' AND properties_json LIKE '%cross_file%' LIMIT 1").get(projectName) as { properties_json: string };
    if (sample) {
      const props = JSON.parse(sample.properties_json);
      expect(props.candidate_count).toBeLessThanOrEqual(5);
      expect(props.resolution).toBe('cross_file_ambiguous');
    }

    db.close();
  });

  it('JSON properties are valid for all CALLS edges', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function run() { return 1; }\n');
    writeFileSync(join(projectDir, 'a.ts'), 'export function caller() { return run(); }\n');

    const result = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    expect(result.errors.length).toBe(0);

    const db = getDb();
    const edges = db.prepare("SELECT properties_json FROM edges WHERE project = ? AND type = 'CALLS'").all(projectName) as Array<{ properties_json: string }>;
    for (const edge of edges) {
      const parsed = JSON.parse(edge.properties_json);
      expect(parsed).toBeDefined();
      expect(parsed.inferred).toBe(true);
    }
    db.close();
  });

  it('orphan edges = 0 after full index with cross-file CALLS', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 1; }\nexport function bar() { return 2; }\n');
    writeFileSync(join(projectDir, 'a.ts'), 'export function caller() { return foo() + bar(); }\n');

    const result = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    expect(result.errors.length).toBe(0);

    const db = getDb();
    const orphanCount = (db.prepare(`
      SELECT COUNT(*) AS c FROM edges e
      LEFT JOIN nodes s ON s.id = e.source_id AND s.project = e.project
      LEFT JOIN nodes t ON t.id = e.target_id AND t.project = e.project
      WHERE e.project = ? AND (s.id IS NULL OR t.id IS NULL)
    `).get(projectName) as { c: number }).c;
    expect(orphanCount).toBe(0);
    db.close();
  });

  it('incremental: crossFileCallsStale flag is set when files change', async () => {
    writeFileSync(join(projectDir, 'b.ts'), 'export function foo() { return 42; }\n');
    writeFileSync(join(projectDir, 'a.ts'), 'export function caller() { return foo(); }\n');

    // Full index
    await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: false, useWasm: true, workers: 0,
    });

    // Modify a.ts
    writeFileSync(join(projectDir, 'a.ts'), 'export function caller() { return foo() + 1; }\n');

    const result2 = await indexProjectWasm({
      project: projectName, rootPath: projectDir, incremental: true, useWasm: true, workers: 0,
    });

    expect(result2.errors.length).toBe(0);
    // R100: crossFileCallsStale should be true when incremental modifies files
    expect((result2 as any).crossFileCallsStale).toBe(true);
  });
});
