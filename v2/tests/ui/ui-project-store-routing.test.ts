import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';
import { defaultHumanDbPath, HumanMemoryStore } from '../../src/human/store.js';
import { ProjectStoreRegistry } from '../../src/ui/project-store-registry.js';
import {
  createMinimalCodeDb,
  startUiTestFixture,
  type UiTestFixture,
} from '../helpers/ui-server-fixture.js';

describe('UI per-project physical store routing', () => {
  let cacheRoot: string;
  let previousCache: string | undefined;
  let fixture: UiTestFixture | undefined;

  beforeEach(() => {
    previousCache = process.env.XDG_CACHE_HOME;
    cacheRoot = mkdtempSync(join(tmpdir(), 'cbm-ui-routing-'));
    process.env.XDG_CACHE_HOME = cacheRoot;
  });

  afterEach(async () => {
    await fixture?.server.stop();
    fixture = undefined;
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previousCache;
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it('selects code and human DBs for the requested project', async () => {
    const projectA = 'routing-a';
    const projectB = 'routing-b';
    createMinimalCodeDb(defaultCodeDbPath(projectA), projectA, 'node-from-a');
    createMinimalCodeDb(defaultCodeDbPath(projectB), projectB, 'node-from-b');

    for (const [project, title] of [[projectA, 'ADR-A'], [projectB, 'ADR-B']] as const) {
      const store = new HumanMemoryStore(defaultHumanDbPath(project));
      store.createNode({
        project,
        label: 'ADR',
        title,
        body_markdown: `content-${project}`,
        source: 'human',
        status: 'active',
      });
      store.close();
    }

    fixture = await startUiTestFixture({ project: projectA });
    const layoutB = await fixture.getJson(`/api/layout?project=${projectB}`);
    expect(layoutB.status).toBe(200);
    expect(layoutB.body.nodes.map((node: { name: string }) => node.name)).toEqual(['node-from-b']);

    const adrB = await fixture.getJson(`/api/adr?project=${projectB}`);
    expect(adrB.status).toBe(200);
    expect(adrB.body.title).toBe('ADR-B');

    const saveB = await fixture.postJson(`/api/adr?project=${projectB}`, {
      project: projectB,
      title: 'ADR-B-NEW',
      content: 'stored only in B',
    });
    expect(saveB.status).toBe(200);
    const adrA = await fixture.getJson(`/api/adr?project=${projectA}`);
    expect(adrA.body.all_adrs.map((adr: { title: string }) => adr.title)).not.toContain('ADR-B-NEW');
  });

  it('rejects invalid project names before deriving or opening a DB path', async () => {
    fixture = await startUiTestFixture({ project: 'routing-safe' });
    const response = await fixture.getJson('/api/adr?project=..%2Fevil');
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Invalid project name');
  });

  it('evicts only idle non-default stores when the registry is bounded', () => {
    const registry = new ProjectStoreRegistry('registry-a', 2);
    const leaseB = registry.acquire('registry-b');
    leaseB.release();
    const leaseC = registry.acquire('registry-c');
    leaseC.release();
    expect(registry.size).toBe(2);
    expect(registry.resolveProjectName('registry-a')).toBe('registry-a');
    registry.closeAll();
  });
});
