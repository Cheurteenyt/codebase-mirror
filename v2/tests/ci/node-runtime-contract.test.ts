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

interface WorkflowStep {
  name?: string;
  uses?: string;
  with?: Record<string, unknown>;
  run?: string;
  shell?: string;
  'working-directory'?: string;
}

interface WorkflowJob {
  name?: string;
  steps: WorkflowStep[];
}

function readCiWorkflow(): { jobs: Record<string, WorkflowJob> } {
  return parseYaml(
    readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  ) as { jobs: Record<string, WorkflowJob> };
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
    const workflow = readCiWorkflow();

    for (const jobName of ['backend', 'windows-smoke', 'frontend', 'package-smoke']) {
      const setupNode = workflow.jobs[jobName].steps.find(step =>
        step.uses?.startsWith('actions/setup-node@')
      );
      expect(setupNode?.with?.['node-version'], jobName).toBe('22.12.0');
    }
  });

  it('smoke-tests the installed tarball against an indexed Graph UI data contract', () => {
    const workflow = readCiWorkflow();
    expect(workflow.jobs['package-smoke'].name).toBe('npm pack + install + CLI smoke');
    const steps = workflow.jobs['package-smoke'].steps;
    const install = steps.find(step => step.name === 'Install tarball in temp directory');
    const graphSmoke = steps.find(
      step => step.name === 'Embedded packaged Graph UI data contract smoke'
    );

    expect(install?.run).toContain('$RUNNER_TEMP/cbm-install');
    expect(graphSmoke?.shell).toBe('bash');
    expect(graphSmoke?.['working-directory']).toBe('${{ runner.temp }}');

    const script = graphSmoke?.run ?? '';
    expect(script).toContain('$RUNNER_TEMP/cbm-package-smoke-fixture');
    expect(script).toContain('packagedGraphCaller');
    expect(script).toContain('"$CBM_BIN" index');
    expect(script).toContain("html.matchAll(/(?:src|href)");
    expect(script).toContain("contentType.includes('javascript')");
    expect(script).toContain("contentType.includes('text/css')");
    expect(script).toContain('/api/layout?');
    expect(script).toContain('layout.contract_version === 1');
    expect(script).toContain('layout.graph_revision');
    expect(script).toContain('catalog?.exact === true');
    expect(script).toContain('/api/node-search?');
    expect(script).toContain('search.contract_version === 1');
    expect(script).toContain('search.graph_revision');
    expect(script).toContain('search.graph_revision === layout.graph_revision');
    expect(script).toContain('/api/neighborhood?');
    expect(script).toContain('neighborhood.contract_version === 1');
    expect(script).toContain('neighborhood.graph_revision === search.graph_revision');
    expect(script).toContain('/api/scope?');
    expect(script).toContain('scope.contract_version === 1');
    expect(script).toContain('scope.graph_revision === neighborhood.graph_revision');
    expect(script).toContain('trap cleanup EXIT');
    expect(script).toContain("trap 'exit 130' INT");
    expect(script).not.toContain('/tmp/cbm-install');
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
