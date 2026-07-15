import { createServer as createNetServer } from 'node:net';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { UiServer, type UiServerOptions } from '../../src/ui/server.js';

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close();
        reject(new Error('Unable to reserve a TCP port'));
        return;
      }
      const port = address.port;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

export interface UiTestFixture {
  server: UiServer;
  port: number;
  baseUrl: string;
  csrfToken: string;
  getJson: (path: string, headers?: Record<string, string>) => Promise<{ status: number; body: any; headers: Headers }>;
  postJson: (
    path: string,
    body: unknown,
    headers?: Record<string, string>,
  ) => Promise<{ status: number; body: any; headers: Headers }>;
}

export async function startUiTestFixture(
  options: Omit<UiServerOptions, 'port'>,
): Promise<UiTestFixture> {
  const port = await reservePort();
  const server = new UiServer({ ...options, port });
  await server.start();
  const baseUrl = `http://127.0.0.1:${port}`;

  let bootstrapResponse: Response | undefined;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      bootstrapResponse = await fetch(`${baseUrl}/api/bootstrap`);
      if (bootstrapResponse.ok) break;
    } catch {
      // The listen callback may not have fired yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!bootstrapResponse?.ok) {
    await server.stop();
    throw new Error('UI test server failed to start');
  }
  const bootstrap = await bootstrapResponse.json() as { csrf_token: string };

  const parse = async (response: Response) => ({
    status: response.status,
    body: await response.json().catch(() => ({})),
    headers: response.headers,
  });
  return {
    server,
    port,
    baseUrl,
    csrfToken: bootstrap.csrf_token,
    getJson: async (path, headers = {}) => parse(await fetch(`${baseUrl}${path}`, { headers })),
    postJson: async (path, body, headers = {}) => parse(await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Sec-Fetch-Site': 'none',
        'X-CBM-CSRF': bootstrap.csrf_token,
        ...headers,
      },
      body: JSON.stringify(body),
    })),
  };
}

export async function waitForJob(
  fixture: UiTestFixture,
  jobId: string,
  terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'timed_out']),
  timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fixture.getJson('/api/index-status');
    const job = response.body.jobs?.find((candidate: { id: string }) => candidate.id === jobId);
    if (job && terminalStatuses.has(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for index job ${jobId}`);
}

export function createMinimalCodeDb(dbPath: string, project: string, nodeName: string): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE nodes (
        id INTEGER PRIMARY KEY,
        project TEXT NOT NULL,
        label TEXT NOT NULL,
        name TEXT NOT NULL,
        qualified_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        properties_json TEXT NOT NULL
      );
      CREATE TABLE edges (
        id INTEGER PRIMARY KEY,
        project TEXT NOT NULL,
        source_id INTEGER NOT NULL,
        target_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        properties_json TEXT NOT NULL
      );
    `);
    db.prepare(`
      INSERT INTO nodes (
        id, project, label, name, qualified_name,
        file_path, start_line, end_line, properties_json
      ) VALUES (1, ?, 'Function', ?, ?, 'src/index.ts', 1, 2, '{}')
    `).run(project, nodeName, `${project}.${nodeName}`);
  } finally {
    db.close();
  }
}
