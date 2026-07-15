/**
 * Runtime contract for the repository-owned post-merge watchdog.
 *
 * The production inline Node program is executed unchanged except that its
 * fixed polling delay is reduced to zero. A fake GitHub API records every
 * request and makes accepted dispatches observable as queued exact-SHA runs.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const WORKFLOW_PATH = join(
  REPO_ROOT,
  ".github",
  "workflows",
  "main-exact-sha-watchdog.yml",
);
const REPOSITORY = "Cheurteenyt/codebase-mirror";
const MAIN_SHA = "a".repeat(40);
const ADVANCED_SHA = "b".repeat(40);

interface ApiCall {
  method: string;
  path: string;
  search: string;
  body: unknown;
}

interface ScenarioRun {
  path: string;
  repository: { full_name: string };
  head_branch: string;
  head_sha: string;
  event: string;
  status: string;
  conclusion: string | null;
}

interface Scenario {
  eventName?: "workflow_run" | "workflow_dispatch" | "schedule";
  triggerPath?: string;
  mainShas?: string[];
  runs?: Record<string, ScenarioRun[]>;
  acknowledgeDispatch?: boolean;
}

function exactRun(
  file: "ci.yml" | "codeql.yml",
  options: Partial<ScenarioRun> = {},
): ScenarioRun {
  return {
    path: `.github/workflows/${file}`,
    repository: { full_name: REPOSITORY },
    head_branch: "main",
    head_sha: MAIN_SHA,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    ...options,
  };
}

function extractRuntime(): string {
  const workflow = readFileSync(WORKFLOW_PATH, "utf8");
  const match = workflow.match(
    /node <<'NODE'\r?\n([\s\S]*?)\r?\n\s{10}NODE/,
  );
  if (!match) throw new Error("watchdog Node heredoc not found");
  const source = match[1]
    .split(/\r?\n/)
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n");
  expect(source).toContain("const SETTLE_DELAY_MS = 2000;");
  return source.replace(
    "const SETTLE_DELAY_MS = 2000;",
    "const SETTLE_DELAY_MS = 0;",
  );
}

const HARNESS = String.raw`
{
const scenario = JSON.parse(process.env.WATCHDOG_SCENARIO);
const repository = process.env.GH_REPOSITORY;
const calls = [];
const runs = structuredClone(scenario.runs || {});
let mainRead = 0;

function response(body, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function queuedRun(file, sha) {
  return {
    path: ".github/workflows/" + file,
    repository: { full_name: repository },
    head_branch: "main",
    head_sha: sha,
    event: "workflow_dispatch",
    status: "queued",
    conclusion: null,
  };
}

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  const method = options.method || "GET";
  const body = options.body ? JSON.parse(String(options.body)) : null;
  calls.push({ method, path: url.pathname, search: url.search, body });
  const prefix = "/repos/" + repository;

  if (method === "GET" && url.pathname === prefix + "/actions/runs/123") {
    return response({
      id: 123,
      path: scenario.triggerPath || ".github/workflows/glm-merge-gate.yml",
      status: "completed",
      conclusion: "cancelled",
      repository: { full_name: repository },
    });
  }

  if (method === "GET" && url.pathname === prefix + "/git/ref/heads/main") {
    const values = scenario.mainShas || ["${MAIN_SHA}"];
    const sha = values[Math.min(mainRead, values.length - 1)];
    mainRead += 1;
    return response({
      ref: "refs/heads/main",
      object: { type: "commit", sha },
    });
  }

  const workflowMatch = url.pathname.match(
    new RegExp("^" + prefix + "/actions/workflows/(ci\\.yml|codeql\\.yml)(/runs|/dispatches)?$"),
  );
  if (workflowMatch) {
    const file = workflowMatch[1];
    const suffix = workflowMatch[2] || "";
    if (method === "GET" && suffix === "") {
      return response({
        id: file === "ci.yml" ? 1 : 2,
        state: "active",
        path: ".github/workflows/" + file,
      });
    }
    if (method === "GET" && suffix === "/runs") {
      return response({ workflow_runs: runs[file] || [] });
    }
    if (method === "POST" && suffix === "/dispatches") {
      if (scenario.acknowledgeDispatch !== false) {
        runs[file] = [...(runs[file] || []), queuedRun(file, body.inputs.expected_sha)];
      }
      return response(null, 204);
    }
  }

  return response({ message: "unexpected fake endpoint" }, 404);
};

process.on("exit", () => {
  console.log("__WATCHDOG_CALLS__" + JSON.stringify(calls));
});
}
`;

function runScenario(scenario: Scenario): {
  status: number | null;
  stderr: string;
  stdout: string;
  calls: ApiCall[];
} {
  const runtime = extractRuntime();
  const result = spawnSync(process.execPath, [], {
    input: `${HARNESS}\n${runtime}`,
    encoding: "utf8",
    env: {
      ...process.env,
      GH_TOKEN: "test-token",
      GH_API_URL: "https://api.github.test",
      GH_REPOSITORY: REPOSITORY,
      EVENT_NAME: scenario.eventName ?? "workflow_run",
      TRIGGER_RUN_ID: "123",
      GITHUB_STEP_SUMMARY: "",
      WATCHDOG_SCENARIO: JSON.stringify(scenario),
    },
    maxBuffer: 2 * 1024 * 1024,
  });
  const marker = result.stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith("__WATCHDOG_CALLS__"));
  if (!marker) {
    throw new Error(`runtime did not emit calls: ${result.stderr}`);
  }
  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
    calls: JSON.parse(marker.slice("__WATCHDOG_CALLS__".length)) as ApiCall[],
  };
}

function dispatches(result: ReturnType<typeof runScenario>): ApiCall[] {
  return result.calls.filter(
    (call) => call.method === "POST" && call.path.endsWith("/dispatches"),
  );
}

describe("R169 post-merge watchdog runtime", () => {
  it("does nothing when a gate is cancelled before merge and native main runs exist", () => {
    const result = runScenario({
      runs: {
        "ci.yml": [exactRun("ci.yml", { event: "push" })],
        "codeql.yml": [exactRun("codeql.yml", { event: "push" })],
      },
    });

    expect(result.status).toBe(0);
    expect(dispatches(result)).toHaveLength(0);
    expect(result.stdout).toContain("CI: already-present");
    expect(result.stdout).toContain("CodeQL: already-present");
  });

  it("recovers both dispatches after merge and binds each to the observed SHA", () => {
    const result = runScenario({ runs: { "ci.yml": [], "codeql.yml": [] } });
    const posts = dispatches(result);

    expect(result.status).toBe(0);
    expect(posts.map((call) => call.path)).toEqual([
      `/repos/${REPOSITORY}/actions/workflows/ci.yml/dispatches`,
      `/repos/${REPOSITORY}/actions/workflows/codeql.yml/dispatches`,
    ]);
    expect(posts.map((call) => call.body)).toEqual([
      { ref: "main", inputs: { expected_sha: MAIN_SHA } },
      { ref: "main", inputs: { expected_sha: MAIN_SHA } },
    ]);
  });

  it("dispatches only CodeQL when exact-SHA CI is already registered", () => {
    const result = runScenario({
      runs: {
        "ci.yml": [exactRun("ci.yml")],
        "codeql.yml": [],
      },
    });

    expect(result.status).toBe(0);
    expect(dispatches(result).map((call) => call.path)).toEqual([
      `/repos/${REPOSITORY}/actions/workflows/codeql.yml/dispatches`,
    ]);
  });

  it("is idempotent when queued exact-SHA dispatch runs already exist", () => {
    const result = runScenario({
      runs: {
        "ci.yml": [exactRun("ci.yml", { status: "queued", conclusion: null })],
        "codeql.yml": [
          exactRun("codeql.yml", { status: "in_progress", conclusion: null }),
        ],
      },
    });

    expect(result.status).toBe(0);
    expect(dispatches(result)).toHaveLength(0);
  });

  it("retries a cancelled validation but not a completed failing validation", () => {
    const result = runScenario({
      runs: {
        "ci.yml": [exactRun("ci.yml", { conclusion: "failure" })],
        "codeql.yml": [exactRun("codeql.yml", { conclusion: "cancelled" })],
      },
    });

    expect(result.status).toBe(0);
    expect(dispatches(result).map((call) => call.path)).toEqual([
      `/repos/${REPOSITORY}/actions/workflows/codeql.yml/dispatches`,
    ]);
  });

  it("fails closed without dispatch when main advances during recovery", () => {
    const result = runScenario({
      mainShas: [MAIN_SHA, ADVANCED_SHA],
      runs: { "ci.yml": [], "codeql.yml": [] },
    });

    expect(result.status).toBe(1);
    expect(dispatches(result)).toHaveLength(0);
    expect(result.stderr).toContain("main advanced while recovering CI");
  });

  it("rejects a non-canonical workflow_run trigger before any dispatch", () => {
    const result = runScenario({
      triggerPath: ".github/workflows/other.yml",
      runs: { "ci.yml": [], "codeql.yml": [] },
    });

    expect(result.status).toBe(1);
    expect(dispatches(result)).toHaveLength(0);
    expect(result.stderr).toContain("not the completed canonical GLM merge gate");
  });
});
