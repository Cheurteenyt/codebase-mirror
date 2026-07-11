/**
 * R166 — GitHub Canonical + GitLab Passive Mirror contract tests.
 *
 * Verifies that the CI/CD infrastructure migration from
 * "GitLab canonical → GitHub mirror" to "GitHub canonical → GitLab
 * passive mirror" is correctly applied and cannot regress silently.
 *
 * Tested invariants:
 *   - .gitlab-ci.yml is passive (workflow.rules.when never + sentinel job)
 *   - obsolete GitHub workflows are removed (gitlab-mr-ci, sync-graph-ui)
 *   - mirror-main-to-gitlab.yml exists and obeys the fast-forward-only contract
 *   - documentation no longer instructs contributors to push to GitLab
 *   - version is bumped to 0.71.0
 *
 * No semantics versions are touched (CURRENT_EXTRACTOR_SEMANTICS_VERSION = 8,
 * CURRENT_DISCOVERY_POLICY_VERSION = 2).
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const WORKFLOWS_DIR = join(REPO_ROOT, ".github", "workflows");

function readWorkflow(name: string): string {
  const path = join(WORKFLOWS_DIR, name);
  if (!existsSync(path)) {
    return "";
  }
  return readFileSync(path, "utf-8");
}

function readRepoFile(rel: string): string {
  const path = join(REPO_ROOT, rel);
  if (!existsSync(path)) {
    return "";
  }
  return readFileSync(path, "utf-8");
}

describe("R166 — GitLab CI is passive", () => {
  const gitlabCi = readRepoFile(".gitlab-ci.yml");

  it(".gitlab-ci.yml exists", () => {
    expect(gitlabCi.length).toBeGreaterThan(0);
  });

  it(".gitlab-ci.yml declares workflow.rules.when never", () => {
    expect(gitlabCi).toMatch(/workflow:\s*\n\s*rules:\s*\n\s*-\s*when:\s*never/);
  });

  it(".gitlab-ci.yml has a passive-mirror-sentinel job with rules.when never", () => {
    expect(gitlabCi).toContain("passive-mirror-sentinel");
    const sentinelSection = gitlabCi.split("passive-mirror-sentinel:")[1] ?? "";
    expect(sentinelSection).toMatch(/rules:\s*\n\s*-\s*when:\s*never/);
  });

  it(".gitlab-ci.yml does NOT define mirror-to-github", () => {
    expect(gitlabCi).not.toMatch(/mirror-to-github/);
  });

  it(".gitlab-ci.yml does NOT define quota-check", () => {
    expect(gitlabCi).not.toMatch(/quota-check/);
  });

  it(".gitlab-ci.yml does NOT define mr-preflight", () => {
    expect(gitlabCi).not.toMatch(/mr-preflight/);
  });
});

describe("R166 — obsolete GitHub workflows are removed", () => {
  it(".github/workflows/gitlab-mr-ci.yml is absent", () => {
    expect(existsSync(join(WORKFLOWS_DIR, "gitlab-mr-ci.yml"))).toBe(false);
  });

  it(".github/workflows/sync-graph-ui-to-gitlab.yml is absent", () => {
    expect(existsSync(join(WORKFLOWS_DIR, "sync-graph-ui-to-gitlab.yml"))).toBe(
      false,
    );
  });
});

describe("R166 — mirror-main-to-gitlab workflow contract", () => {
  const mirror = readWorkflow("mirror-main-to-gitlab.yml");

  it("mirror-main-to-gitlab.yml exists", () => {
    expect(mirror.length).toBeGreaterThan(0);
  });

  it("triggers on workflow_run completed of CI", () => {
    expect(mirror).toMatch(/on:\s*\n\s*workflow_run:\s*\n\s*workflows:\s*\[?"CI"\]?/);
    expect(mirror).toMatch(/types:\s*\[?"?completed"?\]?/);
  });

  it("only fires when CI conclusion is success on push to main from same repository", () => {
    expect(mirror).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(mirror).toContain("github.event.workflow_run.event == 'push'");
    expect(mirror).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(mirror).toContain(
      "github.event.workflow_run.head_repository.full_name == github.repository",
    );
  });

  it("uses contents:read only (least privilege)", () => {
    expect(mirror).toMatch(/permissions:\s*\n\s*contents:\s*read/);
  });

  it("uses persist-credentials: false on checkout", () => {
    expect(mirror).toContain("persist-credentials: false");
  });

  it("configures StrictHostKeyChecking yes", () => {
    expect(mirror).toContain("StrictHostKeyChecking yes");
  });

  it("uses GITLAB_MIRROR_SSH_PRIVATE_KEY secret", () => {
    expect(mirror).toContain("GITLAB_MIRROR_SSH_PRIVATE_KEY");
  });

  it("uses GITLAB_REPOSITORY_SSH_URL variable", () => {
    expect(mirror).toContain("GITLAB_REPOSITORY_SSH_URL");
  });

  it("uses GITLAB_KNOWN_HOSTS variable", () => {
    expect(mirror).toContain("GITLAB_KNOWN_HOSTS");
  });

  it("pushes with -o ci.no_pipeline", () => {
    expect(mirror).toContain("-o ci.no_pipeline");
  });

  it("does NOT use --force on main push", () => {
    expect(mirror).not.toMatch(/git\s+push\s+.*--force/);
    expect(mirror).not.toMatch(/git\s+push\s+.*--force-with-lease/);
  });

  it("does NOT use --mirror", () => {
    expect(mirror).not.toMatch(/git\s+push\s+.*--mirror/);
  });

  it("checks ancestry (fast-forward-only)", () => {
    expect(mirror).toContain("git merge-base --is-ancestor");
  });

  it("verifies post-push SHA", () => {
    expect(mirror).toContain("OBSERVED_SHA");
    expect(mirror).toContain("git ls-remote gitlab refs/heads/main");
  });

  it("removes SSH material at the end (cleanup if always)", () => {
    expect(mirror).toMatch(/if:\s*always/);
    expect(mirror).toContain("rm -f");
    expect(mirror).toContain("gitlab_mirror_ed25519");
  });

  it("uses the gitlab-passive-mirror environment", () => {
    expect(mirror).toContain("environment: gitlab-passive-mirror");
  });

  it("divergence is fail-closed (no auto-repair)", () => {
    expect(mirror).toContain("DIVERGENCE");
    expect(mirror).toContain("exit 1");
  });
});

describe("R166 — documentation reflects GitHub-canonical workflow", () => {
  const contributing = readRepoFile("CONTRIBUTING.md");

  it("CONTRIBUTING.md does not instruct contributors to push to GitLab", () => {
    expect(contributing).not.toMatch(/git\s+push\s+gitlab/);
  });

  it("CONTRIBUTING.md does not reference the GitLab MR → merge flow", () => {
    expect(contributing).not.toMatch(/GitLab\s+MR\s*[→-]>\s*merge/i);
  });

  it("CONTRIBUTING.md mentions GitHub Pull Request workflow", () => {
    expect(contributing.toLowerCase()).toMatch(/pull request/);
  });
});

describe("R166 — package version bumped", () => {
  const pkg = JSON.parse(readRepoFile("v2/package.json")) as {
    version: string;
  };

  it("v2/package.json version is 0.71.0", () => {
    expect(pkg.version).toBe("0.71.0");
  });
});

describe("R166 — semantics versions are NOT bumped", () => {
  const schema = readRepoFile("v2/src/indexer/schema.ts");

  it("CURRENT_EXTRACTOR_SEMANTICS_VERSION is still 8", () => {
    expect(schema).toMatch(/CURRENT_EXTRACTOR_SEMANTICS_VERSION\s*=\s*8\b/);
  });

  it("CURRENT_DISCOVERY_POLICY_VERSION is still 2", () => {
    expect(schema).toMatch(/CURRENT_DISCOVERY_POLICY_VERSION\s*=\s*2\b/);
  });
});
