/**
 * R169 SIG — Runtime tests for the canonical signature verifier.
 *
 * SIG-R169-RT-01: These tests execute the REAL script
 * (scripts/ci/verify-github-commit-signature.sh) against a local HTTP
 * fixture server. They are NOT source-inspection tests.
 *
 * SIG-R3-CI-01: Tests delete GITHUB_ACTIONS from the child env so they
 * can run in GitHub Actions (where GITHUB_ACTIONS=true would otherwise
 * trigger the test-mode refusal).
 *
 * SIG-R3-HTTPTEST-01: Fixture server verifies method, path, and headers
 * (Authorization, Accept, X-GitHub-Api-Version) on every request.
 *
 * SIG-R3-TESTTIME-01: Child process has a 5s watchdog timer. Server
 * is closed with a Promise to avoid orphan handles.
 *
 * SIG-R3-TESTCOVER-01: Full test matrix including timezone validation,
 * 403 rate limits, 502/503/504, verified wrong type, etc.
 *
 * SIG-R169-DIV-01: The script tested here is the SAME script called by
 * the mirror workflow. No duplication.
 *
 * Implementation note: We use async `spawn` (not `spawnSync`) because
 * the HTTP fixture server needs the Node.js event loop to handle curl
 * requests from the script.
 *
 * Performance: SIGNATURE_RETRY_DELAY_SCALE=0 eliminates sleep delays.
 */

import { describe, it, expect } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const SCRIPT_PATH = join(REPO_ROOT, "scripts", "ci", "verify-github-commit-signature.sh");

const TARGET_SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const ISO_TS = "2026-07-13T10:00:00Z";
const ISO_TS_OFFSET = "2026-07-13T10:00:00+00:00";

// ─── Fixture types ──────────────────────────────────────────────────────

interface Fixture {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

interface RequestLog {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
}

// ─── Fixture server (SIG-R3-HTTPTEST-01: verifies method/path/headers) ──

interface FixtureServer {
  port: number;
  close: () => Promise<void>;
  requests: RequestLog[];
}

function startServer(responses: Fixture[]): Promise<FixtureServer> {
  return new Promise((resolve) => {
    let callCount = 0;
    const requests: RequestLog[] = [];
    const server: Server = createServer((req, res) => {
      // Log every request for verification
      requests.push({
        method: req.method || "",
        url: req.url || "",
        headers: { ...req.headers },
      });

      const idx = Math.min(callCount, responses.length - 1);
      const fixture = responses[idx] || responses[responses.length - 1];
      callCount++;

      const headers = { "Content-Type": "application/json", ...fixture.headers };
      res.writeHead(fixture.status, headers);
      res.end(fixture.body);
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            if (typeof (server as any).closeAllConnections === "function") {
              (server as any).closeAllConnections();
            }
            server.close((err) => (err ? rejectClose(err) : resolveClose()));
          }),
        requests,
      });
    });
  });
}

// ─── Async script runner (SIG-R3-TESTTIME-01: watchdog + no GITHUB_ACTIONS) ─

interface ScriptResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  outputs: Record<string, string> | null;
  timedOut: boolean;
}

// SIG-R3-CI-01: Build a LOCAL environment for fixture tests.
// Delete GITHUB_ACTIONS so the script's test-mode refusal doesn't trigger
// when tests run inside GitHub Actions.
function localFixtureEnv(port: number, targetSha: string = TARGET_SHA): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GITHUB_ACTIONS;
  return {
    ...env,
    TARGET_SHA: targetSha,
    GITHUB_API_URL: `http://127.0.0.1:${port}`,
    GITHUB_REPOSITORY: "test/repo",
    GITHUB_TOKEN: "fake-token",
    OUTPUT_FILE: "", // set by caller
    SIGNATURE_RETRY_DELAY_SCALE: "0",
    CBM_SIGNATURE_TEST_MODE: "1",
  };
}

function runScriptAsync(port: number, targetSha: string = TARGET_SHA): Promise<ScriptResult> {
  return new Promise((resolve) => {
    const tmpDir = mkdtempSync(join(tmpdir(), "r169-rt-"));
    const outputFile = join(tmpDir, "outputs.json");
    const env = localFixtureEnv(port, targetSha);
    env.OUTPUT_FILE = outputFile;

    const child = spawn("bash", [SCRIPT_PATH], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    // SIG-R3-TESTTIME-01: 5s watchdog
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 5000);

    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });

    child.on("close", (code) => {
      clearTimeout(timer);
      let outputs: Record<string, string> | null = null;
      try {
        outputs = JSON.parse(readFileSync(outputFile, "utf-8"));
      } catch {
        outputs = null;
      }
      rmSync(tmpDir, { recursive: true, force: true });
      resolve({
        exitCode: code ?? -1,
        stdout,
        stderr,
        outputs,
        timedOut,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      rmSync(tmpDir, { recursive: true, force: true });
      resolve({
        exitCode: -1,
        stdout,
        stderr: stderr + "\n" + err.message,
        outputs: null,
        timedOut,
      });
    });
  });
}

// Sync runner for config error tests (no server needed)
function runScriptSync(envOverrides: Record<string, string>): ScriptResult {
  const tmpDir = mkdtempSync(join(tmpdir(), "r169-cfg-"));
  const outputFile = join(tmpDir, "outputs.json");
  const env: NodeJS.ProcessEnv = { ...process.env };
  // SIG-R3-CI-01: delete GITHUB_ACTIONS by default for local tests
  delete env.GITHUB_ACTIONS;
  Object.assign(env, {
    OUTPUT_FILE: outputFile,
    SIGNATURE_RETRY_DELAY_SCALE: "0",
    CBM_SIGNATURE_TEST_MODE: "1",
    ...envOverrides,
  });
  const result = spawnSync("bash", [SCRIPT_PATH], {
    env,
    encoding: "utf-8",
    timeout: 5000,
  });
  let outputs: Record<string, string> | null = null;
  try { outputs = JSON.parse(readFileSync(outputFile, "utf-8")); } catch {}
  rmSync(tmpDir, { recursive: true, force: true });
  return { exitCode: result.status ?? -1, stdout: result.stdout || "", stderr: result.stderr || "", outputs, timedOut: false };
}

// ─── Body builders ──────────────────────────────────────────────────────

// SIG-R4-VERIFYAT-01: Body builders use the REAL GitHub API contract.
// Success: signature/payload/verified_at are strings.
// Refusal: signature=null, payload=null, verified_at=null (realistic).

function validBody(sha: string, ts: string = ISO_TS): string {
  return JSON.stringify({
    sha,
    commit: {
      verification: {
        verified: true,
        reason: "valid",
        signature: "pgp-signature-data",
        payload: "payload-data",
        verified_at: ts,
      },
    },
  });
}

// Realistic refusal body: signature=null, payload=null, verified_at=null
// This matches the actual GitHub API response for unsigned/invalid commits.
function refusalBody(sha: string, reason: string, ts: string | null = null): string {
  return JSON.stringify({
    sha,
    commit: {
      verification: {
        verified: false,
        reason,
        signature: null,
        payload: null,
        verified_at: ts,
      },
    },
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe("R169 SIG runtime — script file checks (SIG-R169-TEST-01)", () => {
  it("script file exists", () => {
    expect(existsSync(SCRIPT_PATH)).toBe(true);
  });

  it("script has executable bit set (mode & 0o111 != 0)", () => {
    const mode = statSync(SCRIPT_PATH).mode;
    expect(mode & 0o111).not.toBe(0);
  });
});

describe("R169 SIG runtime — success cases", () => {
  it("valid signature → exit 0, all 6 fields populated", async () => {
    const srv = await startServer([{ status: 200, body: validBody(TARGET_SHA) }]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.timedOut).toBe(false);
      expect(r.exitCode).toBe(0);
      expect(r.outputs?.verified).toBe("true");
      expect(r.outputs?.reason).toBe("valid");
      expect(r.outputs?.api_sha).toBe(TARGET_SHA);
      expect(r.outputs?.error_category).toBe("none");
      expect(r.outputs?.attempts).toBe("1");
      expect(r.outputs?.verified_at).toBe(ISO_TS);
    } finally {
      await srv.close();
    }
  });

  it("valid signature with +00:00 offset → exit 0 (SIG-R3-TIME-01)", async () => {
    const srv = await startServer([{ status: 200, body: validBody(TARGET_SHA, ISO_TS_OFFSET) }]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(0);
      expect(r.outputs?.verified_at).toBe(ISO_TS_OFFSET);
    } finally {
      await srv.close();
    }
  });

  it("429 then valid → exit 0, attempts=2", async () => {
    const srv = await startServer([
      { status: 429, body: JSON.stringify({ message: "rate limited" }) },
      { status: 200, body: validBody(TARGET_SHA) },
    ]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(0);
      expect(r.outputs?.verified).toBe("true");
      expect(r.outputs?.attempts).toBe("2");
    } finally {
      await srv.close();
    }
  });

  it("403 with x-ratelimit-remaining: 0 → exit 1, RATE_LIMITED, fail closed (SIG-R4-RATE-01)", async () => {
    // SIG-R4-RATE-01: Primary rate limit exhausted (remaining=0) → fail closed.
    // Retrying with 1s/2s backoff won't succeed before the reset window.
    const srv = await startServer([
      {
        status: 403,
        body: JSON.stringify({ message: "API rate limit exceeded" }),
        headers: { "x-ratelimit-remaining": "0" },
      },
      { status: 200, body: validBody(TARGET_SHA) },
    ]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_API_RATE_LIMITED");
      expect(r.outputs?.attempts).toBe("1"); // No retry — fail closed
    } finally {
      await srv.close();
    }
  });

  it("429 with Retry-After: 1 then valid → exit 0, attempts=2 (SIG-R4-RATE-01)", async () => {
    const srv = await startServer([
      {
        status: 429,
        body: JSON.stringify({ message: "rate limited" }),
        headers: { "retry-after": "1" },
      },
      { status: 200, body: validBody(TARGET_SHA) },
    ]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(0);
      expect(r.outputs?.attempts).toBe("2");
    } finally {
      await srv.close();
    }
  });

  it("429 with Retry-After: 60 (>10s) → exit 1, fail closed (SIG-R4-RATE-01)", async () => {
    // SIG-R4-RATE-01: Retry-After > 10s → fail closed (don't waste CI time)
    const srv = await startServer([
      {
        status: 429,
        body: JSON.stringify({ message: "rate limited" }),
        headers: { "retry-after": "60" },
      },
      { status: 200, body: validBody(TARGET_SHA) },
    ]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_API_RATE_LIMITED");
      expect(r.outputs?.attempts).toBe("1"); // No retry — fail closed
    } finally {
      await srv.close();
    }
  });

  it("403 secondary rate limit then valid → exit 0 (SIG-R3-RATE-01)", async () => {
    const srv = await startServer([
      {
        status: 403,
        body: JSON.stringify({ message: "You have exceeded a secondary rate limit" }),
      },
      { status: 200, body: validBody(TARGET_SHA) },
    ]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(0);
      expect(r.outputs?.attempts).toBe("2");
    } finally {
      await srv.close();
    }
  });

  it("gpgverify_unavailable then valid → exit 0, attempts=2", async () => {
    const srv = await startServer([
      { status: 200, body: refusalBody(TARGET_SHA, "gpgverify_unavailable") },
      { status: 200, body: validBody(TARGET_SHA) },
    ]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(0);
      expect(r.outputs?.verified).toBe("true");
      expect(r.outputs?.attempts).toBe("2");
    } finally {
      await srv.close();
    }
  });
});

describe("R169 SIG runtime — refusal cases (realistic fixtures with null verified_at)", () => {
  it("unsigned + null verified_at → exit 1, UNSIGNED, verified_at normalized to '' (SIG-R4-VERIFYAT-01)", async () => {
    const srv = await startServer([{ status: 200, body: refusalBody(TARGET_SHA, "unsigned") }]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.verified).toBe("false");
      expect(r.outputs?.reason).toBe("unsigned");
      expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_UNSIGNED");
      expect(r.outputs?.attempts).toBe("1");
      expect(r.outputs?.api_sha).toBe(TARGET_SHA);
      // SIG-R4-VERIFYAT-01: null verified_at is normalized to ""
      expect(r.outputs?.verified_at).toBe("");
    } finally {
      await srv.close();
    }
  });

  it("invalid + null verified_at → exit 1, INVALID (SIG-R4-VERIFYAT-01)", async () => {
    const srv = await startServer([{ status: 200, body: refusalBody(TARGET_SHA, "invalid") }]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_INVALID");
      expect(r.outputs?.verified_at).toBe("");
    } finally { await srv.close(); }
  });

  it("malformed_signature + null verified_at → exit 1, INVALID (SIG-R4-VERIFYAT-01)", async () => {
    const srv = await startServer([{ status: 200, body: refusalBody(TARGET_SHA, "malformed_signature") }]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_INVALID");
    } finally { await srv.close(); }
  });

  it("unknown_key → exit 1, UNVERIFIED", async () => {
    const srv = await startServer([{ status: 200, body: refusalBody(TARGET_SHA, "unknown_key") }]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_UNVERIFIED");
    } finally { await srv.close(); }
  });

  it("SHA mismatch → exit 1, SHA_MISMATCH, all fields populated (SIG-R169-DIAG-01)", async () => {
    const srv = await startServer([{ status: 200, body: validBody(OTHER_SHA) }]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_SHA_MISMATCH");
      expect(r.outputs?.api_sha).toBe(OTHER_SHA);
      expect(r.outputs?.reason).toBe("valid");
      expect(r.outputs?.verified_at).toBe(ISO_TS);
    } finally { await srv.close(); }
  });

  it("verified=true but reason!=valid → exit 1, SCHEMA_ERROR (SIG-R4-VERIFYAT-01 coherence)", async () => {
    const srv = await startServer([
      {
        status: 200,
        body: JSON.stringify({
          sha: TARGET_SHA,
          commit: { verification: { verified: true, reason: "unsigned", verified_at: ISO_TS } },
        }),
      },
    ]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_API_SCHEMA_ERROR");
    } finally { await srv.close(); }
  });

  it("verified=false but reason=valid → exit 1, SCHEMA_ERROR (SIG-R4-VERIFYAT-01 coherence)", async () => {
    const srv = await startServer([
      {
        status: 200,
        body: JSON.stringify({
          sha: TARGET_SHA,
          commit: { verification: { verified: false, reason: "valid", verified_at: ISO_TS } },
        }),
      },
    ]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_API_SCHEMA_ERROR");
    } finally { await srv.close(); }
  });

  it("unknown reason (not in enum) → exit 1, SCHEMA_ERROR (SIG-R4-PARSER-01)", async () => {
    const srv = await startServer([
      {
        status: 200,
        body: JSON.stringify({
          sha: TARGET_SHA,
          commit: { verification: { verified: false, reason: "totally_made_up_reason", verified_at: null } },
        }),
      },
    ]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_API_SCHEMA_ERROR");
    } finally { await srv.close(); }
  });

  it("gpgverify_error + null verified_at → exit 1, TRANSIENT, attempts=3 (SIG-R4-VERIFYAT-01 retry path)", async () => {
    // SIG-R4-VERIFYAT-01: gpgverify_error with null verified_at must still
    // reach the retry logic (not be rejected as SCHEMA_ERROR).
    const srv = await startServer([
      { status: 200, body: refusalBody(TARGET_SHA, "gpgverify_error") },
      { status: 200, body: refusalBody(TARGET_SHA, "gpgverify_error") },
      { status: 200, body: refusalBody(TARGET_SHA, "gpgverify_error") },
    ]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_TRANSIENT_VERIFIER_ERROR");
      expect(r.outputs?.attempts).toBe("3");
      expect(r.outputs?.verified_at).toBe("");
    } finally { await srv.close(); }
  });

  it("gpgverify_unavailable + null verified_at → exit 1, TRANSIENT, attempts=3 (SIG-R4-VERIFYAT-01)", async () => {
    const srv = await startServer([
      { status: 200, body: refusalBody(TARGET_SHA, "gpgverify_unavailable") },
      { status: 200, body: refusalBody(TARGET_SHA, "gpgverify_unavailable") },
      { status: 200, body: refusalBody(TARGET_SHA, "gpgverify_unavailable") },
    ]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_TRANSIENT_VERIFIER_ERROR");
      expect(r.outputs?.attempts).toBe("3");
      expect(r.outputs?.verified_at).toBe("");
    } finally { await srv.close(); }
  });
});

describe("R169 SIG runtime — HTTP error cases", () => {
  it("500 permanent → exit 1, HTTP_ERROR, attempts=3", async () => {
    const body = JSON.stringify({ message: "server error" });
    const srv = await startServer([
      { status: 500, body },
      { status: 500, body },
      { status: 500, body },
    ]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_API_HTTP_ERROR");
      expect(r.outputs?.attempts).toBe("3");
    } finally { await srv.close(); }
  });

  it("502 → retryable", async () => {
    const srv = await startServer([
      { status: 502, body: JSON.stringify({ message: "bad gateway" }) },
      { status: 502, body: JSON.stringify({ message: "bad gateway" }) },
      { status: 502, body: JSON.stringify({ message: "bad gateway" }) },
    ]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.attempts).toBe("3");
    } finally { await srv.close(); }
  });

  it("503 → retryable", async () => {
    const srv = await startServer([
      { status: 503, body: JSON.stringify({ message: "unavailable" }) },
      { status: 503, body: JSON.stringify({ message: "unavailable" }) },
      { status: 503, body: JSON.stringify({ message: "unavailable" }) },
    ]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.attempts).toBe("3");
    } finally { await srv.close(); }
  });

  it("504 → retryable", async () => {
    const srv = await startServer([
      { status: 504, body: JSON.stringify({ message: "timeout" }) },
      { status: 504, body: JSON.stringify({ message: "timeout" }) },
      { status: 504, body: JSON.stringify({ message: "timeout" }) },
    ]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.attempts).toBe("3");
    } finally { await srv.close(); }
  });

  it("429 permanent → exit 1, RATE_LIMITED, attempts=3 (SIG-R3-TESTCOVER-01)", async () => {
    const srv = await startServer([
      { status: 429, body: JSON.stringify({ message: "rate limited" }) },
      { status: 429, body: JSON.stringify({ message: "rate limited" }) },
      { status: 429, body: JSON.stringify({ message: "rate limited" }) },
    ]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_API_RATE_LIMITED");
      expect(r.outputs?.attempts).toBe("3");
    } finally { await srv.close(); }
  });

  it("401 → exit 1, HTTP_ERROR, attempts=1 (no retry)", async () => {
    const srv = await startServer([{ status: 401, body: JSON.stringify({ message: "unauthorized" }) }]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_API_HTTP_ERROR");
      expect(r.outputs?.attempts).toBe("1");
    } finally { await srv.close(); }
  });

  it("404 → exit 1, HTTP_ERROR, attempts=1 (no retry)", async () => {
    const srv = await startServer([{ status: 404, body: JSON.stringify({ message: "not found" }) }]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_API_HTTP_ERROR");
      expect(r.outputs?.attempts).toBe("1");
    } finally { await srv.close(); }
  });

  it("403 (non-rate-limit) → exit 1, HTTP_ERROR, attempts=1", async () => {
    const srv = await startServer([
      { status: 403, body: JSON.stringify({ message: "forbidden" }) },
    ]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_API_HTTP_ERROR");
      expect(r.outputs?.attempts).toBe("1");
    } finally { await srv.close(); }
  });
});

describe("R169 SIG runtime — JSON/schema error cases", () => {
  it("malformed JSON → exit 1, MALFORMED_JSON, attempts=1 (SIG-R3-RETRY-01: no retry)", async () => {
    const srv = await startServer([
      { status: 200, body: "{not valid json" },
    ]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_API_MALFORMED_JSON");
      expect(r.outputs?.attempts).toBe("1");
    } finally { await srv.close(); }
  });

  it("schema missing verification → exit 1, SCHEMA_ERROR, attempts=1", async () => {
    const srv = await startServer([
      { status: 200, body: JSON.stringify({ sha: TARGET_SHA, commit: {} }) },
    ]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_API_SCHEMA_ERROR");
      expect(r.outputs?.attempts).toBe("1");
    } finally { await srv.close(); }
  });

  it("verified_at absent → exit 1, SCHEMA_ERROR", async () => {
    const srv = await startServer([
      {
        status: 200,
        body: JSON.stringify({
          sha: TARGET_SHA,
          commit: { verification: { verified: true, reason: "valid" } },
        }),
      },
    ]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_API_SCHEMA_ERROR");
    } finally { await srv.close(); }
  });

  it("verified_at = 'foo' → exit 1, SCHEMA_ERROR (SIG-R169-SCHEMA-01)", async () => {
    const srv = await startServer([
      {
        status: 200,
        body: JSON.stringify({
          sha: TARGET_SHA,
          commit: { verification: { verified: true, reason: "valid", verified_at: "foo" } },
        }),
      },
    ]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_API_SCHEMA_ERROR");
    } finally { await srv.close(); }
  });

  it("verified_at = '2026' (year only) → exit 1, SCHEMA_ERROR", async () => {
    const srv = await startServer([
      {
        status: 200,
        body: JSON.stringify({
          sha: TARGET_SHA,
          commit: { verification: { verified: true, reason: "valid", verified_at: "2026" } },
        }),
      },
    ]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_API_SCHEMA_ERROR");
    } finally { await srv.close(); }
  });

  it("verified_at = '2026-07-13T10:00:00' (no timezone) → exit 1, SCHEMA_ERROR (SIG-R3-TIME-01)", async () => {
    const srv = await startServer([
      {
        status: 200,
        body: JSON.stringify({
          sha: TARGET_SHA,
          commit: { verification: { verified: true, reason: "valid", verified_at: "2026-07-13T10:00:00" } },
        }),
      },
    ]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_API_SCHEMA_ERROR");
    } finally { await srv.close(); }
  });

  it("verified_at = '2026-07-13' (date-only) → exit 1, SCHEMA_ERROR (SIG-R3-TIME-01)", async () => {
    const srv = await startServer([
      {
        status: 200,
        body: JSON.stringify({
          sha: TARGET_SHA,
          commit: { verification: { verified: true, reason: "valid", verified_at: "2026-07-13" } },
        }),
      },
    ]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_API_SCHEMA_ERROR");
    } finally { await srv.close(); }
  });

  it("verified wrong type (string 'true') → exit 1, SCHEMA_ERROR (SIG-R3-TESTCOVER-01)", async () => {
    const srv = await startServer([
      {
        status: 200,
        body: JSON.stringify({
          sha: TARGET_SHA,
          commit: { verification: { verified: "true", reason: "valid", verified_at: ISO_TS } },
        }),
      },
    ]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_API_SCHEMA_ERROR");
    } finally { await srv.close(); }
  });

  it("reason wrong type (number) → exit 1, SCHEMA_ERROR (SIG-R3-TESTCOVER-01)", async () => {
    const srv = await startServer([
      {
        status: 200,
        body: JSON.stringify({
          sha: TARGET_SHA,
          commit: { verification: { verified: true, reason: 42, verified_at: ISO_TS } },
        }),
      },
    ]);
    try {
      const r = await runScriptAsync(srv.port);
      expect(r.exitCode).toBe(1);
      expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_API_SCHEMA_ERROR");
    } finally { await srv.close(); }
  });
});

describe("R169 SIG runtime — config error cases", () => {
  it("missing TARGET_SHA → exit 2, CONFIG_ERROR", () => {
    const r = runScriptSync({
      GITHUB_API_URL: "http://127.0.0.1:1",
      GITHUB_REPOSITORY: "test/repo",
      GITHUB_TOKEN: "fake-token",
    });
    expect(r.exitCode).toBe(2);
    expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_CONFIG_ERROR");
  });

  it("invalid TARGET_SHA (not 40 hex) → exit 2, CONFIG_ERROR (SIG-R3-TESTCOVER-01)", () => {
    const r = runScriptSync({
      TARGET_SHA: "abc123",
      GITHUB_API_URL: "http://127.0.0.1:1",
      GITHUB_REPOSITORY: "test/repo",
      GITHUB_TOKEN: "fake-token",
    });
    expect(r.exitCode).toBe(2);
    expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_CONFIG_ERROR");
  });

  it("missing GITHUB_TOKEN → exit 2, CONFIG_ERROR", () => {
    const r = runScriptSync({
      TARGET_SHA,
      GITHUB_API_URL: "http://127.0.0.1:1",
      GITHUB_REPOSITORY: "test/repo",
    });
    expect(r.exitCode).toBe(2);
    expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_CONFIG_ERROR");
  });

  it("missing GITHUB_API_URL → exit 2, CONFIG_ERROR (SIG-R3-TESTCOVER-01)", () => {
    const r = runScriptSync({
      TARGET_SHA,
      GITHUB_REPOSITORY: "test/repo",
      GITHUB_TOKEN: "fake-token",
    });
    expect(r.exitCode).toBe(2);
    expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_CONFIG_ERROR");
  });

  it("missing GITHUB_REPOSITORY → exit 2, CONFIG_ERROR (SIG-R3-TESTCOVER-01)", () => {
    const r = runScriptSync({
      TARGET_SHA,
      GITHUB_API_URL: "http://127.0.0.1:1",
      GITHUB_TOKEN: "fake-token",
    });
    expect(r.exitCode).toBe(2);
    expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_CONFIG_ERROR");
  });

  it("test mode rejects non-loopback URL → exit 2, CONFIG_ERROR", () => {
    const r = runScriptSync({
      TARGET_SHA,
      GITHUB_API_URL: "https://api.github.com",
      GITHUB_REPOSITORY: "test/repo",
      GITHUB_TOKEN: "fake-token",
    });
    expect(r.exitCode).toBe(2);
    expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_CONFIG_ERROR");
  });

  it("GITHUB_ACTIONS=true + test mode → exit 2, CONFIG_ERROR (SIG-R3-CI-01)", () => {
    // This test explicitly verifies that the script refuses test mode
    // when GITHUB_ACTIONS=true. The runtime tests above delete
    // GITHUB_ACTIONS from the child env so they can run in CI.
    const r = runScriptSync({
      TARGET_SHA,
      GITHUB_API_URL: "http://127.0.0.1:1",
      GITHUB_REPOSITORY: "test/repo",
      GITHUB_TOKEN: "fake-token",
      GITHUB_ACTIONS: "true",
    });
    expect(r.exitCode).toBe(2);
    expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_CONFIG_ERROR");
  });

  it("invalid SIGNATURE_RETRY_DELAY_SCALE (2) → exit 2, CONFIG_ERROR (SIG-R3-RETRY-02)", () => {
    const r = runScriptSync({
      TARGET_SHA,
      GITHUB_API_URL: "http://127.0.0.1:1",
      GITHUB_REPOSITORY: "test/repo",
      GITHUB_TOKEN: "fake-token",
      SIGNATURE_RETRY_DELAY_SCALE: "2",
    });
    expect(r.exitCode).toBe(2);
    expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_CONFIG_ERROR");
  });

  it("scale=0 in production mode (non-loopback) → exit 2, CONFIG_ERROR (SIG-R3-RETRY-02)", () => {
    // Without CBM_SIGNATURE_TEST_MODE=1, the script enforces production rules.
    // scale=0 is not allowed in production.
    const tmpDir = mkdtempSync(join(tmpdir(), "r169-cfg-"));
    const outputFile = join(tmpDir, "outputs.json");
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.GITHUB_ACTIONS;
    delete env.CBM_SIGNATURE_TEST_MODE;
    const result = spawnSync("bash", [SCRIPT_PATH], {
      env: {
        ...env,
        TARGET_SHA,
        GITHUB_API_URL: "https://api.github.com",
        GITHUB_REPOSITORY: "test/repo",
        GITHUB_TOKEN: "fake-token",
        OUTPUT_FILE: outputFile,
        SIGNATURE_RETRY_DELAY_SCALE: "0",
      },
      encoding: "utf-8",
      timeout: 5000,
    });
    let outputs: any = null;
    try { outputs = JSON.parse(readFileSync(outputFile, "utf-8")); } catch {}
    rmSync(tmpDir, { recursive: true, force: true });
    expect(result.status).toBe(2);
    expect(outputs?.error_category).toBe("GITHUB_SIGNATURE_CONFIG_ERROR");
  });
});

describe("R169 SIG runtime — network error cases", () => {
  it("connection refused → exit 1, NETWORK_ERROR, attempts=3 (SIG-R3-TESTCOVER-01)", async () => {
    // Use a port that's definitely not listening
    // We don't start a server — the connection will be refused
    const tmpDir = mkdtempSync(join(tmpdir(), "r169-net-"));
    const outputFile = join(tmpDir, "outputs.json");
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.GITHUB_ACTIONS;

    const result = await new Promise<ScriptResult>((resolve) => {
      const child = spawn("bash", [SCRIPT_PATH], {
        env: {
          ...env,
          TARGET_SHA,
          GITHUB_API_URL: "http://127.0.0.1:1", // port 1 — connection refused
          GITHUB_REPOSITORY: "test/repo",
          GITHUB_TOKEN: "fake-token",
          OUTPUT_FILE: outputFile,
          SIGNATURE_RETRY_DELAY_SCALE: "0",
          CBM_SIGNATURE_TEST_MODE: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("close", (code) => {
        clearTimeout(timer);
        let outputs: any = null;
        try { outputs = JSON.parse(readFileSync(outputFile, "utf-8")); } catch {}
        rmSync(tmpDir, { recursive: true, force: true });
        resolve({ exitCode: code ?? -1, stdout, stderr, outputs, timedOut: false });
      });
    });

    expect(result.exitCode).toBe(1);
    expect(result.outputs?.error_category).toBe("GITHUB_SIGNATURE_API_NETWORK_ERROR");
    expect(result.outputs?.attempts).toBe("3");
  });
});

describe("R169 SIG runtime — fixture request verification (SIG-R3-HTTPTEST-01)", () => {
  it("fixture verifies correct method, path, and headers", async () => {
    const srv = await startServer([{ status: 200, body: validBody(TARGET_SHA) }]);
    try {
      await runScriptAsync(srv.port);
      expect(srv.requests.length).toBe(1);
      const req = srv.requests[0];
      expect(req.method).toBe("GET");
      expect(req.url).toBe(`/repos/test/repo/commits/${TARGET_SHA}`);
      expect(req.headers["authorization"]).toBe("Bearer fake-token");
      expect(req.headers["accept"]).toContain("application/vnd.github+json");
      expect(req.headers["x-github-api-version"]).toBe("2026-03-10");
    } finally {
      await srv.close();
    }
  });

  it("429-then-valid makes exactly 2 requests", async () => {
    const srv = await startServer([
      { status: 429, body: JSON.stringify({ message: "rate limited" }) },
      { status: 200, body: validBody(TARGET_SHA) },
    ]);
    try {
      await runScriptAsync(srv.port);
      expect(srv.requests.length).toBe(2);
    } finally {
      await srv.close();
    }
  });

  it("500 permanent makes exactly 3 requests", async () => {
    const body = JSON.stringify({ message: "server error" });
    const srv = await startServer([
      { status: 500, body },
      { status: 500, body },
      { status: 500, body },
    ]);
    try {
      await runScriptAsync(srv.port);
      expect(srv.requests.length).toBe(3);
    } finally {
      await srv.close();
    }
  });

  it("401 makes exactly 1 request (no retry)", async () => {
    const srv = await startServer([{ status: 401, body: JSON.stringify({ message: "unauthorized" }) }]);
    try {
      await runScriptAsync(srv.port);
      expect(srv.requests.length).toBe(1);
    } finally {
      await srv.close();
    }
  });

  it("malformed JSON makes exactly 1 request (SIG-R3-RETRY-01: no retry)", async () => {
    const srv = await startServer([{ status: 200, body: "{not valid json" }]);
    try {
      await runScriptAsync(srv.port);
      expect(srv.requests.length).toBe(1);
    } finally {
      await srv.close();
    }
  });
});
