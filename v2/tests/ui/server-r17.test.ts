// v2/tests/ui/server-r17.test.ts
// Tests for the R17 new API endpoints.
// We test the UiServer by starting it on a random port and making HTTP requests.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { UiServer } from '../../src/ui/server.js';
import { HumanMemoryStore, defaultHumanDbPath } from '../../src/human/store.js';
import { unlinkSync, existsSync } from 'node:fs';

const TEST_PROJECT = 'r17-test-' + Date.now().toString(36);
let server: UiServer;
let port: number;
let baseUrl: string;

function fetchJson(path: string, options?: { method?: string; body?: unknown }): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = `${baseUrl}${path}`;
    const opts: RequestInit = {
      method: options?.method ?? 'GET',
      headers: { 'Content-Type': 'application/json' },
    };
    if (options?.body !== undefined) {
      opts.body = JSON.stringify(options.body);
    }
    fetch(url, opts)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        resolve({ status: res.status, body });
      })
      .catch(reject);
  });
}

describe('R17: UiServer new endpoints', () => {
  beforeAll(() => {
    // Find a free port by trying a high random port.
    port = 9800 + Math.floor(Math.random() * 100);
    server = new UiServer({ project: TEST_PROJECT, port });
    server.start();
    baseUrl = `http://127.0.0.1:${port}`;
    // Wait a moment for the server to start.
    return new Promise((r) => setTimeout(r, 300));
  });

  afterAll(() => {
    server.stop();
    // Clean up the test human DB.
    const dbPath = defaultHumanDbPath(TEST_PROJECT);
    if (existsSync(dbPath)) {
      try { unlinkSync(dbPath); } catch { /* ignore */ }
    }
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(dbPath + suffix)) {
        try { unlinkSync(dbPath + suffix); } catch { /* ignore */ }
      }
    }
  });

  describe('GET /api/adr', () => {
    it('returns has_adr: false when no ADRs exist', async () => {
      const res = await fetchJson('/api/adr');
      expect(res.status).toBe(200);
      expect(res.body.has_adr).toBe(false);
    });
  });

  describe('POST /api/adr', () => {
    it('creates a new ADR note', async () => {
      const res = await fetchJson('/api/adr', {
        method: 'POST',
        body: {
          project: TEST_PROJECT,
          title: 'ADR-TEST: Test decision',
          content: 'We decided to test things.',
        },
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.id).toBeGreaterThan(0);
      expect(res.body.title).toBe('ADR-TEST: Test decision');
    });

    it('updates an existing ADR with the same title', async () => {
      // Create
      await fetchJson('/api/adr', {
        method: 'POST',
        body: {
          project: TEST_PROJECT,
          title: 'ADR-UPD: Update test',
          content: 'Original content',
        },
      });
      // Update
      const res = await fetchJson('/api/adr', {
        method: 'POST',
        body: {
          project: TEST_PROJECT,
          title: 'ADR-UPD: Update test',
          content: 'Updated content',
        },
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('rejects invalid JSON body', async () => {
      // Send raw invalid JSON
      const res = await fetch(`${baseUrl}/api/adr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      });
      const body = await res.json().catch(() => ({}));
      expect(res.status).toBe(400);
      expect(body.error).toContain('Invalid JSON');
    });
  });

  describe('GET /api/adr (after creating)', () => {
    it('returns has_adr: true with ADR content', async () => {
      const res = await fetchJson('/api/adr');
      expect(res.status).toBe(200);
      expect(res.body.has_adr).toBe(true);
      expect(typeof res.body.content).toBe('string');
      expect(res.body.all_adrs).toBeDefined();
      expect(Array.isArray(res.body.all_adrs)).toBe(true);
      expect(res.body.all_adrs.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('GET /api/browse', () => {
    it('lists directories in the home folder by default', async () => {
      const res = await fetchJson('/api/browse');
      expect(res.status).toBe(200);
      expect(res.body.path).toBeDefined();
      expect(Array.isArray(res.body.dirs)).toBe(true);
      expect(Array.isArray(res.body.roots)).toBe(true);
      expect(res.body.roots.length).toBeGreaterThan(0);
    });

    it('returns 404 for non-existent path', async () => {
      // R43 (SEC3): /api/browse is now restricted to the user's home directory.
      // Use a path inside home that doesn't exist so we test the 404 path
      // (not the 403 home-restriction path).
      const os = require('os');
      const path = require('path');
      const nonexistentInHome = path.join(os.homedir(), 'nonexistent-cbm-test-path-12345');
      const res = await fetchJson(`/api/browse?path=${encodeURIComponent(nonexistentInHome)}`);
      expect(res.status).toBe(404);
      expect(res.body.error).toContain('not found');
    });

    it('R43 (SEC3): returns 403 for paths outside home directory', async () => {
      const res = await fetchJson('/api/browse?path=/etc');
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('home directory');
    });
  });

  describe('GET /api/index-status', () => {
    it('returns jobs array (empty or with jobs)', async () => {
      const res = await fetchJson('/api/index-status');
      expect(res.status).toBe(200);
      expect(res.body.jobs).toBeDefined();
      expect(Array.isArray(res.body.jobs)).toBe(true);
    });
  });

  describe('POST /api/index', () => {
    it('rejects missing root_path', async () => {
      const res = await fetchJson('/api/index', {
        method: 'POST',
        body: { project_name: 'test' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('root_path');
    });

    it('rejects missing project_name', async () => {
      const res = await fetchJson('/api/index', {
        method: 'POST',
        body: { root_path: '/tmp' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('project_name');
    });

    it('rejects non-existent root_path', async () => {
      const res = await fetchJson('/api/index', {
        method: 'POST',
        body: { root_path: '/nonexistent/path', project_name: 'test' },
      });
      expect(res.status).toBe(404);
    });

    // R43 (SEC1): project_name argument-injection guard.
    it('rejects project_name starting with -- (CLI argument injection)', async () => {
      const res = await fetchJson('/api/index', {
        method: 'POST',
        body: { root_path: '/tmp', project_name: '--config=/tmp/evil.json' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid project name');
    });

    it('rejects project_name with shell metacharacters', async () => {
      const res = await fetchJson('/api/index', {
        method: 'POST',
        body: { root_path: '/tmp', project_name: 'foo;rm -rf /' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid project name');
    });

    it('accepts valid project_name (alphanumeric + dash + underscore)', async () => {
      const res = await fetchJson('/api/index', {
        method: 'POST',
        body: { root_path: '/tmp', project_name: 'my-app_2' },
      });
      // 404 is expected (root_path exists, but cbm binary may not be installed
      // in test env). The key assertion: NOT 400 (invalid project name).
      expect(res.status).not.toBe(400);
    });

    // R44 (B1): bare-flag argument-injection. The R43 regex allows hyphens,
    // so "--force" (all chars in [a-zA-Z0-9_-]) passed validation. The R44
    // fix rejects any value starting with '-'.
    it('rejects project_name that is a bare flag (starts with hyphen)', async () => {
      const res = await fetchJson('/api/index', {
        method: 'POST',
        body: { root_path: '/tmp', project_name: '--force' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('hyphen');
    });

    it('rejects project_name that is a single hyphen', async () => {
      const res = await fetchJson('/api/index', {
        method: 'POST',
        body: { root_path: '/tmp', project_name: '-' },
      });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/processes', () => {
    it('returns processes array', async () => {
      const res = await fetchJson('/api/processes');
      expect(res.status).toBe(200);
      expect(res.body.processes).toBeDefined();
      expect(Array.isArray(res.body.processes)).toBe(true);
      // R45 (F7): the list now uses the narrower cbm|cbm-v2 regex + always
      // includes the current process. On Unix, the current UI server should
      // be in the list. We assert it's an array of objects with the right
      // shape — the is_self assertion is best-effort (ps may not list self
      // in all CI environments).
      if (process.platform !== 'win32' && res.body.processes.length > 0) {
        const first = res.body.processes[0];
        expect(first).toHaveProperty('pid');
        expect(first).toHaveProperty('command');
        expect(first).toHaveProperty('is_self');
      }
    });
  });

  describe('POST /api/process-kill', () => {
    it('rejects killing the UI server itself', async () => {
      const res = await fetchJson('/api/process-kill', {
        method: 'POST',
        body: { pid: process.pid },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Cannot kill the UI server');
    });

    it('rejects invalid pid', async () => {
      const res = await fetchJson('/api/process-kill', {
        method: 'POST',
        body: { pid: -1 },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('positive number');
    });
  });

  // R45 (F6/SEC4): routeProjectHealth path-traversal guard.
  describe('GET /api/project-health', () => {
    it('rejects path traversal in name param', async () => {
      const res = await fetchJson('/api/project-health?name=../../etc/passwd');
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid project name');
    });

    it('rejects bare flag in name param', async () => {
      const res = await fetchJson('/api/project-health?name=--force');
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid project name');
    });
  });

  describe('POST /api/project-delete', () => {
    it('rejects invalid project name', async () => {
      const res = await fetchJson('/api/project-delete', {
        method: 'POST',
        body: { name: '../etc/passwd' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid project name');
    });

    it('rejects deleting the active project', async () => {
      const res = await fetchJson('/api/project-delete', {
        method: 'POST',
        body: { name: TEST_PROJECT },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Cannot delete the currently active project');
    });
  });

  describe('GET /api/logs', () => {
    it('returns log lines array', async () => {
      const res = await fetchJson('/api/logs');
      expect(res.status).toBe(200);
      expect(res.body.lines).toBeDefined();
      expect(Array.isArray(res.body.lines)).toBe(true);
    });

    it('respects the lines parameter', async () => {
      const res = await fetchJson('/api/logs?lines=5');
      expect(res.status).toBe(200);
      expect(res.body.lines.length).toBeLessThanOrEqual(5);
    });
  });

  describe('Unknown endpoint', () => {
    it('returns 404 for unknown API path', async () => {
      const res = await fetchJson('/api/nonexistent');
      expect(res.status).toBe(404);
      expect(res.body.error).toContain('Unknown API endpoint');
    });
  });
});
