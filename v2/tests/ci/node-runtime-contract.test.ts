import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const V2_ROOT = resolve(TEST_DIR, '..', '..');
const REPO_ROOT = resolve(V2_ROOT, '..');

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
}

describe('repository Node.js runtime contract', () => {
  it('declares the same Node floor and npm 10/11 compatibility in both packages and lockfiles', () => {
    for (const packageDir of [V2_ROOT, join(REPO_ROOT, 'graph-ui')]) {
      const manifest = readJson(join(packageDir, 'package.json'));
      const lockfile = readJson(join(packageDir, 'package-lock.json'));

      expect(manifest.engines?.node).toBe('>=22.12.0');
      expect(manifest.packageManager).toBe('npm@10.9.0');
      expect(manifest.engines?.npm).toBe('>=10 <12');
      expect(lockfile.packages?.['']?.engines?.node).toBe('>=22.12.0');
      expect(lockfile.packages?.['']?.engines?.npm).toBe('>=10 <12');
    }
  });

  it('tests the exact minimum in every Node-powered CI job', () => {
    const workflow = parseYaml(
      readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
    ) as {
      jobs: Record<string, { steps: Array<{ uses?: string; with?: Record<string, unknown> }> }>;
    };

    for (const jobName of ['backend', 'windows-smoke', 'frontend', 'package-smoke']) {
      const setupNode = workflow.jobs[jobName].steps.find(step =>
        step.uses?.startsWith('actions/setup-node@')
      );
      expect(setupNode?.with?.['node-version'], jobName).toBe('22.12.0');
    }
  });

  it('selects Node 24 LTS for local development and all Docker stages', () => {
    expect(readFileSync(join(REPO_ROOT, '.nvmrc'), 'utf8').trim()).toBe('24');
    expect(readFileSync(join(REPO_ROOT, '.node-version'), 'utf8').trim()).toBe('24');

    const dockerfile = readFileSync(join(REPO_ROOT, 'Dockerfile'), 'utf8');
    expect(dockerfile.match(/^FROM node:[^\s]+/gm)).toEqual([
      'FROM node:24-bookworm-slim',
      'FROM node:24-bookworm',
      'FROM node:24-bookworm-slim',
    ]);
    expect(dockerfile).not.toMatch(/\bnode:20(?:\b|-)/u);
  });
});
