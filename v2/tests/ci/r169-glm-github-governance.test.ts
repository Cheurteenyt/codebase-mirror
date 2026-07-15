/**
 * R169 — Structural security contract for the GLM GitHub integration.
 *
 * These tests intentionally inspect the canonical workflow text. They freeze
 * the trust split that cannot be inferred from product tests: branch code may
 * push checkpoints, but it must never be executed by the repository-owned
 * broker or merge job while those jobs hold write permissions.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..", "..");

function read(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf-8");
}

const broker = read(".github/workflows/glm-pr-broker.yml");
const gate = read(".github/workflows/glm-merge-gate.yml");
const ci = read(".github/workflows/ci.yml");
const codeql = read(".github/workflows/codeql.yml");
const codeowners = read(".github/CODEOWNERS");
const operations = read("docs/GLM_GITHUB_OPERATIONS.md");
const quota = read(".github/workflows/quota-report.yml");
const storagePolicy = read("docs/GITHUB_ACTIONS_STORAGE_POLICY.md");
const dependabot = read(".github/dependabot.yml");

describe("R169 GLM PR broker", () => {
  it("is limited to same-repository v2/glm checkpoints", () => {
    expect(broker).toContain('- "v2/glm/**"');
    expect(broker).toContain(
      "github.repository == 'Cheurteenyt/codebase-mirror'",
    );
    expect(broker).toContain("startsWith(github.ref_name, 'v2/glm/')");
    expect(broker).toContain("BRANCH_PATTERN.fullmatch(branch)");
    expect(broker).toContain('if ".." in branch or "//" in branch');
  });

  it("uses only read contents plus PR write and never checks out branch code", () => {
    expect(broker).toContain("permissions: {}\n");
    expect(broker).toMatch(/permissions:\s+contents: read\s+pull-requests: write/);
    expect(broker).not.toContain("actions/checkout");
    expect(broker).not.toContain("secrets.");
  });

  it("creates one ready bot-authored PR bound to the pushed SHA", () => {
    expect(broker).toContain('"draft": False');
    expect(broker).toContain('EXPECTED_PR_AUTHOR = "github-actions[bot]"');
    expect(broker).toContain('pull["head"]["sha"] != head_sha');
    expect(broker).toContain("More than one open PR targets main");
  });
});

describe("R169 GLM merge gate", () => {
  it("qualifies only successful canonical push CI from v2/glm", () => {
    expect(gate).toContain('workflows: ["CI"]');
    expect(gate).toContain('- "v2/glm/**"');
    expect(gate).toContain("github.event.workflow_run.event == 'push'");
    expect(gate).toContain('EXPECTED_WORKFLOW_PATH = ".github/workflows/ci.yml"');
    expect(gate).toContain("run[\"workflow_id\"] == canonical_ci[\"id\"]");
  });

  it("never checks out or executes candidate-controlled code", () => {
    expect(gate).not.toContain("actions/checkout");
    expect(gate).not.toMatch(/^\s*uses:/m);
    expect(gate).not.toContain("secrets.");
    expect(gate).toContain("base_control_plane != head_control_plane");
    for (const protectedPath of [
      'path.startswith(".github/")',
      'path.startswith("scripts/ci/")',
      'path == ".gitmodules"',
      'path.endswith("/AGENTS.md")',
    ]) {
      expect(gate).toContain(protectedPath);
    }
  });

  it("resolves commit trees through the Git commit object", () => {
    expect(gate).toContain('f"/repos/{repository}/git/commits/{commit_sha}"');
    expect(gate).toContain('f"/repos/{repository}/git/trees/{tree_sha}?recursive=1"');
    expect(gate).not.toContain('git/trees/{commit_sha}');
  });

  it("requires the exact owner review and protected environment", () => {
    expect(gate).toContain("name: glm-merge-gate");
    expect(gate).toContain('EXPECTED_REVIEWER = "Cheurteenyt"');
    expect(gate).toContain('latest.get("state", "").upper() != "APPROVED"');
    expect(gate).toContain('latest.get("commit_id") != candidate_sha');
  });

  it("does not derive immutable squash history from mutable PR metadata", () => {
    expect(gate).toContain(
      "f\"GLM: {branch.removeprefix('v2/glm/')} (#{pr_number})\"",
    );
    expect(gate).not.toContain("pull['title']");
    expect(gate).not.toContain('pull["title"]');
  });

  it("binds the squash and post-merge dispatches to exact SHAs", () => {
    expect(gate).toContain('"sha": candidate_sha');
    expect(gate).toContain('"merge_method": "squash"');
    expect(gate).toContain('main_sha == merge_sha');
    expect(gate).toContain(
      'dispatch = {"ref": "main", "inputs": {"expected_sha": merge_sha}}',
    );
    expect(gate).toContain("actions/workflows/ci.yml/dispatches");
    expect(gate).toContain("actions/workflows/codeql.yml/dispatches");
  });
});

describe("R169 native authorization and exact-main recovery", () => {
  it("assigns every path to the sole native CODEOWNER", () => {
    expect(codeowners).toMatch(/^\*\s+@Cheurteenyt\s*$/m);
    expect(codeowners).toMatch(/^\/.github\/\s+@Cheurteenyt\s*$/m);
  });

  it("keeps exact-SHA dispatch preflights in CI and CodeQL", () => {
    for (const workflow of [ci, codeql]) {
      expect(workflow).toContain("workflow_dispatch:");
      expect(workflow).toContain("expected_sha:");
      expect(workflow).toContain('ref != "refs/heads/main"');
      expect(workflow).toContain("event_sha != expected_sha");
      expect(workflow).toContain('main_object.get("sha") != expected_sha');
    }
  });

  it("documents the environment as operational, not an exclusive credential", () => {
    expect(operations).toContain(
      "The hard `main` boundary is therefore the exact `@Cheurteenyt` CODEOWNER review",
    );
    expect(operations).toContain(
      "The environment is a second operational confirmation",
    );
    expect(operations).toContain(
      "staging repository or a narrowly permissioned GitHub App",
    );
  });
});

describe("R169 Actions storage observability", () => {
  it("uses validated owner configuration without an administrative workflow call", () => {
    expect(quota).toContain(
      "CACHE_LIMIT_GB: ${{ vars.ACTIONS_CACHE_LIMIT_GB }}",
    );
    expect(quota).toContain(
      'max_cache_size_gb = positive_int_env("CACHE_LIMIT_GB")',
    );
    expect(quota).not.toContain("actions/cache/storage-limit");
    expect(storagePolicy).toContain("`ACTIONS_CACHE_LIMIT_GB`");
  });

  it("disables branch-producing version PRs without disabling security updates", () => {
    expect(dependabot.match(/open-pull-requests-limit: 0/g)).toHaveLength(3);
    expect(dependabot).toContain(
      "Repository-level Dependabot security updates remain",
    );
  });
});
