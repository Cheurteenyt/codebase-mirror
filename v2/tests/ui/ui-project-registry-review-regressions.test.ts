import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';
import { defaultHumanDbPath, HumanMemoryStore } from '../../src/human/store.js';
import {
  fileIdentitiesMatch,
  isValidProjectName,
  pathsReferToSameStore,
  ProjectStoreRegistry,
} from '../../src/ui/project-store-registry.js';
import {
  createMinimalCodeDb,
  startUiTestFixture,
  type UiTestFixture,
} from '../helpers/ui-server-fixture.js';

describe('UI project registry review regressions', () => {
  let cacheRoot: string;
  let scratchRoot: string;
  let previousCache: string | undefined;
  let fixture: UiTestFixture | undefined;
  const repoRoots: string[] = [];

  beforeEach(() => {
    previousCache = process.env.XDG_CACHE_HOME;
    cacheRoot = mkdtempSync(join(tmpdir(), 'cbm-registry-review-cache-'));
    scratchRoot = mkdtempSync(join(tmpdir(), 'cbm-registry-review-paths-'));
    process.env.XDG_CACHE_HOME = cacheRoot;
  });

  afterEach(async () => {
    await fixture?.server.stop();
    fixture = undefined;
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previousCache;
    rmSync(cacheRoot, { recursive: true, force: true });
    rmSync(scratchRoot, { recursive: true, force: true });
    for (const root of repoRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('does not case-fold two existing files with different filesystem identities', () => {
    const upper = join(scratchRoot, 'Project.db');
    const lower = join(scratchRoot, 'project.db');
    writeFileSync(upper, 'upper');
    writeFileSync(lower, 'lower');

    const upperStat = statSync(upper);
    const lowerStat = statSync(lower);
    // A case-insensitive test volume cannot materialize the distinct-file
    // premise; the same assertion runs on every case-sensitive CI volume.
    if (upperStat.dev === lowerStat.dev && upperStat.ino === lowerStat.ino) return;
    expect(pathsReferToSameStore(upper, lower, true)).toBe(false);
  });

  it('compares NTFS-sized file identities without Number rounding', () => {
    const largeInode = 1n << 60n;
    expect(fileIdentitiesMatch(
      { dev: 7n, ino: largeInode },
      { dev: 7n, ino: largeInode + 1n },
    )).toBe(false);
    expect(fileIdentitiesMatch(
      { dev: 7n, ino: largeInode },
      { dev: 7n, ino: largeInode },
    )).toBe(true);
  });

  it.each(['my.project', 'My Project', 'projet-équipe']) (
    'accepts a storage-safe project name across registry and layout: %s',
    async (project) => {
      createMinimalCodeDb(defaultCodeDbPath(project), project, 'portable-name-node');
      fixture = await startUiTestFixture({ project });

      const layout = await fixture.getJson(`/api/layout?project=${encodeURIComponent(project)}&max_nodes=10`);
      expect(layout.status).toBe(200);
      expect(layout.body.nodes).toHaveLength(1);

      const projects = await fixture.getJson('/api/projects');
      expect(projects.body.projects.some((candidate: { name: string }) => candidate.name === project)).toBe(true);
    },
  );

  it.each(['..', '../escape', 'nested/name', 'trailing.', 'CON', '-flag', '_config', 'foo.human', 'bad|name']) (
    'rejects a cross-platform unsafe project name: %s',
    (project) => {
      expect(isValidProjectName(project)).toBe(false);
    },
  );

  it('does not case-fold an existing path onto a missing case variant', () => {
    const upper = join(scratchRoot, 'OneSided.db');
    const lower = join(scratchRoot, 'onesided.db');
    writeFileSync(upper, 'existing');

    // On a case-insensitive volume the lower spelling is the same existing
    // file, so the one-sided premise cannot be produced there.
    if (existsSync(lower)) return;
    expect(pathsReferToSameStore(upper, lower, true)).toBe(false);
  });

  it('keeps project aliases canonical after resolving names not opened by the route lease', async () => {
    const firstProject = 'registry-alias-a';
    const secondProject = 'registry-alias-b';
    createMinimalCodeDb(defaultCodeDbPath(firstProject), firstProject, 'shared-node');
    linkSync(defaultCodeDbPath(firstProject), defaultCodeDbPath(secondProject));
    writeFileSync(defaultHumanDbPath(firstProject), 'distinct-human-a');
    writeFileSync(defaultHumanDbPath(secondProject), 'distinct-human-b');

    const firstRoot = mkdtempSync(join(homedir(), 'cbm-registry-alias-a-'));
    const secondRoot = mkdtempSync(join(homedir(), 'cbm-registry-alias-b-'));
    repoRoots.push(firstRoot, secondRoot);

    fixture = await startUiTestFixture({
      project: 'registry-unrelated-default',
      projectStoreLimit: 1,
      maxConcurrentIndexJobs: 2,
      maxConcurrentIndexJobsPerProject: 1,
      getIndexerLaunch: () => ({
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
      }),
    });

    const first = await fixture.postJson('/api/index', {
      root_path: firstRoot,
      project_name: firstProject,
    });
    expect(first.status).toBe(202);

    const aliasAttempt = await fixture.postJson('/api/index', {
      root_path: secondRoot,
      project_name: secondProject,
    });
    expect(aliasAttempt.status).toBe(429);
    expect(aliasAttempt.body.error).toContain('for this project');
  });

  it('requires compatible code and human identities for a whole-project alias', () => {
    const first = 'registry-pair-a';
    const second = 'registry-pair-b';
    createMinimalCodeDb(defaultCodeDbPath(first), first, 'shared-code');
    linkSync(defaultCodeDbPath(first), defaultCodeDbPath(second));
    writeFileSync(defaultHumanDbPath(first), 'human-a');
    writeFileSync(defaultHumanDbPath(second), 'human-b');

    const registry = new ProjectStoreRegistry('registry-pair-default');
    expect(registry.resolveProjectName(first)).toBe(first);
    expect(registry.resolveProjectName(second)).toBe(second);
    registry.closeAll();
  });

  it('drops a cached alias after an atomic path identity change', () => {
    const first = 'registry-stale-a';
    const second = 'registry-stale-b';
    createMinimalCodeDb(defaultCodeDbPath(first), first, 'shared-code');
    linkSync(defaultCodeDbPath(first), defaultCodeDbPath(second));
    writeFileSync(defaultHumanDbPath(first), 'shared-human');
    linkSync(defaultHumanDbPath(first), defaultHumanDbPath(second));

    const registry = new ProjectStoreRegistry('registry-stale-default');
    expect(registry.resolveProjectName(first)).toBe(first);
    expect(registry.resolveProjectName(second)).toBe(first);
    unlinkSync(defaultCodeDbPath(second));
    writeFileSync(defaultCodeDbPath(second), 'distinct-code');
    expect(registry.resolveProjectName(second)).toBe(second);
    registry.closeAll();
  });

  it('treats a lazy in-flight lease as an open project store', () => {
    const registry = new ProjectStoreRegistry('registry-lease-default');
    const lease = registry.acquire('registry-lease-active');
    expect(registry.isProjectStoreOpen('registry-lease-active')).toBe(true);
    lease.release();
    registry.closeAll();
  });

  it('bounds canonical identity history together with evicted entries', () => {
    const registry = new ProjectStoreRegistry('registry-bounded-default', 4);
    for (let i = 0; i < 40; i++) {
      const lease = registry.acquire(`registry-bounded-${i}`);
      lease.release();
    }
    expect(registry.size).toBeLessThanOrEqual(4);
    const canonicalProjects = (registry as unknown as { canonicalProjects: string[] }).canonicalProjects;
    expect(canonicalProjects.length).toBeLessThanOrEqual(4);
    expect(canonicalProjects).toContain('registry-bounded-default');
    registry.closeAll();
  });

  it('rejects unknown API routes before creating project registry history', async () => {
    fixture = await startUiTestFixture({ project: 'registry-unknown-route-default' });
    const registry = (fixture.server as unknown as { registry: ProjectStoreRegistry }).registry;
    const sizeBefore = registry.size;

    for (let i = 0; i < 40; i++) {
      const response = await fixture.getJson(`/api/not-a-route?project=unknown-route-${i}`);
      expect(response.status).toBe(404);
    }

    expect(registry.size).toBe(sizeBefore);
    const canonicalProjects = (registry as unknown as { canonicalProjects: string[] }).canonicalProjects;
    expect(canonicalProjects).toEqual(['registry-unknown-route-default']);
  });

  it('closes the native human DB handle when initialization fails', () => {
    const path = defaultHumanDbPath('registry-broken-human');
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations VALUES
        (1, 'a', 'x'), (2, 'b', 'x'), (3, 'c', 'x'), (4, 'd', 'x');
    `);
    db.close();
    const closeSpy = vi.spyOn(Database.prototype, 'close');
    try {
      expect(() => new HumanMemoryStore(path)).toThrow(/human_nodes/i);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      rmSync(path, { force: true });
    } finally {
      closeSpy.mockRestore();
    }
  });

  it('opens human memory lazily and rejects cross-site GETs before creating it', async () => {
    const project = 'registry-lazy-human';
    const humanDbPath = defaultHumanDbPath(project);
    fixture = await startUiTestFixture({ project });

    expect(existsSync(humanDbPath)).toBe(false);
    const logs = await fixture.getJson('/api/logs');
    expect(logs.status).toBe(200);
    expect(existsSync(humanDbPath)).toBe(false);

    const crossSite = await fixture.getJson('/api/adr', { 'Sec-Fetch-Site': 'cross-site' });
    expect(crossSite.status).toBe(403);
    expect(existsSync(humanDbPath)).toBe(false);

    const adr = await fixture.getJson('/api/adr');
    expect(adr.status).toBe(200);
    expect(existsSync(humanDbPath)).toBe(true);
  });
});
