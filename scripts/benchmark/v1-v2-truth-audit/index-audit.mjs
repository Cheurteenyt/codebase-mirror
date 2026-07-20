#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const requireFromV2 = createRequire(join(repoRoot, 'v2', 'package.json'));
const Database = requireFromV2('better-sqlite3');
const spec = JSON.parse(readFileSync(join(here, 'tasks.json'), 'utf8'));
const v1Root = resolve(process.env.CBM_V1_HOME || 'D:/Mycodex/benchmark-state/v1-v055-r173');
const v2Root = resolve(process.env.XDG_CACHE_HOME || 'D:/Mycodex/benchmark-state/v2-r173-final');

function normalize(path) {
  return path.replaceAll('\\', '/');
}

function trackedFiles(checkout) {
  const result = spawnSync('git', ['-C', checkout, 'ls-files', '-z'], { encoding: 'buffer' });
  if (result.status !== 0) throw new Error(result.stderr.toString('utf8'));
  return result.stdout.toString('utf8').split('\0').filter(Boolean).map(normalize);
}

function extensionCounts(paths) {
  const counts = new Map();
  for (const path of paths) {
    const extension = extname(path).toLowerCase() || '[none]';
    counts.set(extension, (counts.get(extension) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function directories(paths) {
  return [...new Set(paths.filter((path) => path.includes('/')).map((path) => path.split('/')[0]))].sort();
}

function expectedPaths(tasks) {
  const serialized = JSON.stringify(tasks);
  const matches = serialized.match(/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.(?:tsx|ts|jsx|js|mjs|cjs|json|yaml|yml|html|css|java|cpp|md|py|sh|c|h)/g) ?? [];
  return [...new Set(matches.map(normalize))].sort();
}

function tableNames(db) {
  return db.prepare("select name from sqlite_master where type='table' order by name").all().map((row) => row.name);
}

function inspectDb(path, generation) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  const fileColumn = generation === 'v1' ? 'rel_path' : 'file_path';
  const indexed = db.prepare(`select ${fileColumn} path from file_hashes order by ${fileColumn}`).all().map((row) => normalize(row.path));
  const result = {
    path: normalize(path),
    bytes: readFileSync(path).byteLength,
    indexed_files: indexed.length,
    nodes: db.prepare('select count(*) count from nodes').get().count,
    edges: db.prepare('select count(*) count from edges').get().count,
    tables: tableNames(db),
    indexed_top_level_directories: directories(indexed),
    extensions: extensionCounts(indexed),
    indexed,
  };
  db.close();
  return result;
}

const report = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  targets: [],
};

for (const target of spec.targets) {
  const v1Db = join(v1Root, '.cache', 'codebase-memory-mcp', `${target.v1_project}.db`);
  const v2Db = join(v2Root, 'codebase-memory-mcp', `${target.v2_project}.db`);
  const v1 = inspectDb(v1Db, 'v1');
  const v2 = inspectDb(v2Db, 'v2');
  const tracked = trackedFiles(target.checkout);
  const expected = expectedPaths(target.tasks);
  const v1Set = new Set(v1.indexed);
  const v2Set = new Set(v2.indexed);
  const { indexed: v1Indexed, ...v1Summary } = v1;
  const { indexed: v2Indexed, ...v2Summary } = v2;
  report.targets.push({
    id: target.id,
    repository: target.repository,
    sha: target.sha,
    tracked_files: tracked.length,
    tracked_top_level_directories: directories(tracked),
    tracked_extensions: extensionCounts(tracked),
    expected_task_files: expected,
    v1: {
      ...v1Summary,
      missing_expected_task_files: expected.filter((path) => !v1Set.has(path)),
      indexed_only_in_v1: v1Indexed.filter((path) => !v2Set.has(path)),
    },
    v2: {
      ...v2Summary,
      missing_expected_task_files: expected.filter((path) => !v2Set.has(path)),
      indexed_only_in_v2: v2Indexed.filter((path) => !v1Set.has(path)),
    },
  });
}

console.log(JSON.stringify(report, null, 2));
