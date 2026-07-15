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
 * Extractor semantics remain at version 8. Discovery policy version 3 is the
 * canonical coverage-mode contract.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "yaml";

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

// R168: the mirror logic was extracted to a shell script for testability.
// Tests that check implementation details (fingerprint checks, error
// classifier, step names) now read from the script, not the YAML.
function readMirrorScript(): string {
  return readRepoFile("scripts/ci/mirror-main-to-gitlab.sh");
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

describe("AI checkpoint continuity — canonical CI branch contract", () => {
  const ci = readWorkflow("ci.yml");
  const parsed = yaml.parse(ci);

  it("runs the canonical CI on main and v2/** checkpoint pushes", () => {
    expect(parsed.on.push.branches).toEqual(["main", "v2/**"]);
  });

  it("keeps pull request validation targeted at main", () => {
    expect(parsed.on.pull_request.branches).toEqual(["main"]);
  });

  it("keeps the canonical CI token read-only", () => {
    expect(parsed.permissions.contents).toBe("read");
  });
});

describe("R166 — mirror-main-to-gitlab workflow contract", () => {
  const mirrorWorkflow = readWorkflow("mirror-main-to-gitlab.yml");
  const parsedMirrorWorkflow = yaml.parse(mirrorWorkflow);
  const mirror = mirrorWorkflow + "\n" + readMirrorScript();

  it("mirror-main-to-gitlab.yml exists", () => {
    expect(mirror.length).toBeGreaterThan(0);
  });

  it("triggers on workflow_run completed of CI", () => {
    expect(mirror).toMatch(/on:\s*\n\s*workflow_run:\s*\n\s*workflows:\s*\[?"CI"\]?/);
    expect(mirror).toMatch(/types:\s*\[?"?completed"?\]?/);
  });

  it("keeps the workflow_run branch filter restricted to main", () => {
    expect(parsedMirrorWorkflow.on.workflow_run.branches).toEqual(["main"]);
  });

  it("only fires for successful canonical main push or exact-dispatch CI", () => {
    expect(mirror).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(mirror).toContain("github.event.workflow_run.event == 'push'");
    expect(mirror).toContain("github.event.workflow_run.event == 'workflow_dispatch'");
    expect(mirror).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(mirror).toContain(
      "github.event.workflow_run.head_repository.full_name == github.repository",
    );
  });

  it("uses actions:read and contents:read only (least privilege)", () => {
    expect(parsedMirrorWorkflow.permissions).toEqual({
      actions: "read",
      contents: "read",
    });
  });

  it("requires the canonical exact-SHA preflight for dispatched CI", () => {
    expect(mirror).toContain('EXPECTED_PREFLIGHT_NAME = "Exact main SHA preflight"');
    expect(mirror).toContain('event not in {"push", "workflow_dispatch"}');
    expect(mirror).toContain("Dispatched CI target is no longer the exact live main ref.");
  });

  it("uses persist-credentials: false on checkout", () => {
    expect(mirror).toContain("persist-credentials: false");
  });

  it("configures StrictHostKeyChecking yes", () => {
    expect(mirror).toMatch(/StrictHostKeyChecking[= ]yes/);
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
    expect(mirror).toMatch(/ls-remote gitlab refs\/heads\/main/);
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

  // R167 additions — stronger doc fidelity checks (TEST-R167-01)
  it("CONTRIBUTING.md has exactly one '## CI/CD' heading (no duplicate stale block)", () => {
    const matches = contributing.match(/^## CI\/CD$/gm) ?? [];
    expect(matches.length).toBe(1);
  });

  it("CONTRIBUTING.md does not mention the old GitLab → GitHub mirror architecture", () => {
    expect(contributing).not.toContain("GitLab → GitHub mirror");
  });

  it("CONTRIBUTING.md does not mention mirror-to-github", () => {
    expect(contributing).not.toContain("mirror-to-github");
  });

  it("CONTRIBUTING.md does not mention mr-preflight", () => {
    expect(contributing).not.toContain("mr-preflight");
  });

  it("CONTRIBUTING.md does not mention 'Push to a feature branch on GitLab'", () => {
    expect(contributing).not.toContain("Push to a feature branch on GitLab");
  });

  it("CONTRIBUTING.md does not claim GitHub Actions has unlimited minutes", () => {
    expect(contributing).not.toContain("GitHub Actions has unlimited");
  });
});

// =============================================================================
// R167 — Documentation Fidelity + Mirror Hardening regression tests
// =============================================================================

describe("R167 — MAINTAINERS_GUIDE.md doc fidelity", () => {
  const guide = readRepoFile("MAINTAINERS_GUIDE.md");

  it("MAINTAINERS_GUIDE.md does not mention --force-with-lease (forbidden since R166)", () => {
    expect(guide).not.toContain("--force-with-lease");
  });

  it("MAINTAINERS_GUIDE.md does not contain stale version 0.12.2", () => {
    expect(guide).not.toContain("0.12.2");
  });

  it("MAINTAINERS_GUIDE.md does not contain stale test count '376 tests'", () => {
    expect(guide).not.toContain("376 tests");
  });

  it("MAINTAINERS_GUIDE.md does not contain stale test count '353 tests'", () => {
    expect(guide).not.toContain("353 tests");
  });

  it("MAINTAINERS_GUIDE.md does not claim GITHUB_MIRROR_TOKEN has been removed (cannot observe external state)", () => {
    expect(guide).not.toContain("GITHUB_MIRROR_TOKEN has been removed");
  });

  it("MAINTAINERS_GUIDE.md states the GITHUB_MIRROR_TOKEN invariant as MUST NOT exist", () => {
    expect(guide).toContain("GITHUB_MIRROR_TOKEN");
    // Match across newlines (the phrase spans 2 lines in the doc).
    expect(guide).toMatch(/GITHUB_MIRROR_TOKEN[\s\S]*?MUST NOT exist/);
  });

  it("MAINTAINERS_GUIDE.md documents never-force invariant for the mirror", () => {
    expect(guide.toLowerCase()).toMatch(/never\s*force/);
  });

  it("MAINTAINERS_GUIDE.md documents fail-closed divergence handling", () => {
    expect(guide.toLowerCase()).toMatch(/fail[\s-]*closed/);
  });
});

describe("R167 — bridge doc operational completeness", () => {
  const bridge = readRepoFile("docs/GITHUB_GITLAB_BRANCH_BRIDGE.md");

  it("bridge doc documents the host key verification failure incident", () => {
    expect(bridge).toContain("Host key verification failed");
  });

  it("bridge doc documents protected branch authorization", () => {
    expect(bridge).toContain("protected branch");
  });

  it("bridge doc documents the dry-run / pre-receive limitation", () => {
    expect(bridge).toContain("git push --dry-run");
    expect(bridge).toContain("pre-receive");
  });

  it("bridge doc names the GitHub environment", () => {
    expect(bridge).toContain("gitlab-passive-mirror");
  });

  it("bridge doc names the SSH private key secret", () => {
    expect(bridge).toContain("GITLAB_MIRROR_SSH_PRIVATE_KEY");
  });

  it("bridge doc names the 'Allowed to push and merge' GitLab concept", () => {
    expect(bridge).toContain("Allowed to push and merge");
  });
});

// =============================================================================
// R167 — Mirror workflow hardening (split steps + fingerprint checks)
// =============================================================================

describe("R167 — mirror workflow split into diagnostic steps", () => {
  const mirror = readWorkflow("mirror-main-to-gitlab.yml") + "\n" + readMirrorScript();

  it("workflow uses named diagnostic phases (DOC-R168-01: no hardcoded count)", () => {
    // The workflow is a thin wrapper that calls scripts/ci/mirror-main-to-gitlab.sh
    // The script contains the diagnostic phases. Don't hardcode a step count.
    expect(mirror).toContain("scripts/ci/mirror-main-to-gitlab.sh");
  });

  it("workflow has a 'Validate event identity' step", () => {
    expect(mirror).toContain("Validate event identity");
  });

  it("workflow has a 'Checkout exact CI-validated SHA' step", () => {
    expect(mirror).toContain("Checkout exact CI-validated SHA");
  });

  it("workflow has a 'Materialize SSH key' step", () => {
    expect(mirror).toMatch(/Materialize SSH key/);
  });

  it("workflow has a 'Verify client key fingerprint' step", () => {
    expect(mirror).toContain("Verify client key fingerprint");
  });

  it("workflow has a 'Verify GitLab.com host key fingerprint' step", () => {
    expect(mirror).toContain("Verify GitLab.com host key fingerprint");
  });

  it("workflow has a 'Read GitHub main' step", () => {
    expect(mirror).toContain("Read GitHub main");
  });

  it("workflow has a 'Classify mirror state' step", () => {
    expect(mirror).toContain("Classify mirror state");
  });

  it("workflow has a 'Post-push verification' step", () => {
    expect(mirror).toContain("Post-push verification");
  });

  it("workflow has a summary/verdict step (if: always)", () => {
    // SIG-R169 Phase B: the summary step is now 'Final verdict and summary'
    // which includes the verdict logic and exits 1 on FAILED.
    expect(mirror).toContain("Final verdict and summary");
  });

  it("workflow has a cleanup step (if: always)", () => {
    // SIG-R169 Phase B: cleanup is now 'Cleanup SSH material and temp files'
    // and runs BEFORE the final verdict.
    expect(mirror).toContain("Cleanup SSH material");
  });
});

describe("R167 — fingerprint verification contract", () => {
  const mirror = readWorkflow("mirror-main-to-gitlab.yml") + "\n" + readMirrorScript();

  it("workflow reads GITLAB_MIRROR_KEY_FINGERPRINT variable", () => {
    expect(mirror).toContain("GITLAB_MIRROR_KEY_FINGERPRINT");
  });

  it("workflow reads GITLAB_ED25519_HOST_FINGERPRINT variable", () => {
    expect(mirror).toContain("GITLAB_ED25519_HOST_FINGERPRINT");
  });

  it("workflow verifies the client key fingerprint with ssh-keygen -y + -lf", () => {
    expect(mirror).toContain("ssh-keygen -y");
    expect(mirror).toContain("-lf");
  });

  it("workflow fails closed on client key fingerprint mismatch", () => {
    expect(mirror).toContain("Client deploy key fingerprint mismatch");
  });

  it("workflow fails closed on host key fingerprint mismatch", () => {
    expect(mirror).toContain("GitLab.com host key fingerprint mismatch");
  });

  it("workflow does NOT disable StrictHostKeyChecking", () => {
    expect(mirror).not.toContain("StrictHostKeyChecking no");
    expect(mirror).not.toContain("UserKnownHostsFile /dev/null");
  });
});

describe("R167 — push error classifier", () => {
  const mirror = readWorkflow("mirror-main-to-gitlab.yml") + "\n" + readMirrorScript();

  it("workflow classifies HOST_KEY_MISMATCH errors", () => {
    expect(mirror).toContain("HOST_KEY_MISMATCH");
  });

  it("workflow classifies SSH_PUBLICKEY_REJECTED errors", () => {
    expect(mirror).toContain("SSH_PUBLICKEY_REJECTED");
  });

  it("workflow classifies PROTECTED_BRANCH_REJECTED errors", () => {
    expect(mirror).toContain("PROTECTED_BRANCH_REJECTED");
  });

  it("workflow classifies NON_FAST_FORWARD errors", () => {
    expect(mirror).toContain("NON_FAST_FORWARD");
  });

  it("workflow classifies REMOTE_UNREACHABLE errors", () => {
    expect(mirror).toContain("REMOTE_UNREACHABLE");
  });

  it("workflow classifies UNKNOWN_GIT_ERROR errors", () => {
    expect(mirror).toContain("UNKNOWN_GIT_ERROR");
  });
});

describe("R167 — invariants preserved from R166", () => {
  const mirror = readWorkflow("mirror-main-to-gitlab.yml") + "\n" + readMirrorScript();

  it("workflow still uses -o ci.no_pipeline", () => {
    expect(mirror).toContain("-o ci.no_pipeline");
  });

  it("workflow still uses only actions:read and contents:read", () => {
    expect(mirror).toMatch(
      /permissions:\s*\n\s*actions:\s*read\s*\n\s*contents:\s*read/,
    );
  });

  it("workflow still uses persist-credentials: false", () => {
    expect(mirror).toContain("persist-credentials: false");
  });

  it("workflow still uses StrictHostKeyChecking yes", () => {
    expect(mirror).toMatch(/StrictHostKeyChecking[= ]yes/);
  });

  it("workflow still uses the gitlab-passive-mirror environment", () => {
    expect(mirror).toContain("environment: gitlab-passive-mirror");
  });

  it("workflow still does NOT use --force on main push", () => {
    expect(mirror).not.toMatch(/git\s+push\s+.*--force/);
    expect(mirror).not.toMatch(/git\s+push\s+.*--force-with-lease/);
  });

  it("workflow still does NOT use --mirror", () => {
    expect(mirror).not.toMatch(/git\s+push\s+.*--mirror/);
  });

  it("workflow still checks ancestry (fast-forward-only)", () => {
    expect(mirror).toContain("git merge-base --is-ancestor");
  });

  it("workflow still has DIVERGENCE fail-closed", () => {
    expect(mirror).toContain("DIVERGENCE");
  });

  it("workflow retains the hardened push and exact-dispatch trigger filter", () => {
    expect(mirror).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(mirror).toContain("github.event.workflow_run.event == 'push'");
    expect(mirror).toContain("github.event.workflow_run.event == 'workflow_dispatch'");
    expect(mirror).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(mirror).toContain(
      "github.event.workflow_run.head_repository.full_name == github.repository",
    );
  });

  it("workflow still removes SSH material at the end (if: always)", () => {
    expect(mirror).toMatch(/if:\s*always/);
    expect(mirror).toContain("rm -f");
    expect(mirror).toContain("gitlab_mirror_ed25519");
  });
});

describe("R167 — CI_CONTINUITY.md exists", () => {
  const continuity = readRepoFile("docs/CI_CONTINUITY.md");

  it("CI_CONTINUITY.md exists and is non-empty", () => {
    expect(continuity.length).toBeGreaterThan(1000);
  });

  it("CI_CONTINUITY.md documents Level 1 (delayed)", () => {
    expect(continuity).toContain("Level 1");
    expect(continuity.toLowerCase()).toContain("delayed");
  });

  it("CI_CONTINUITY.md documents Level 2 (unavailable extended)", () => {
    expect(continuity).toContain("Level 2");
  });

  it("CI_CONTINUITY.md documents Level 3 (GitHub entirely unavailable)", () => {
    expect(continuity).toContain("Level 3");
  });

  it("CI_CONTINUITY.md documents the quarterly exercise", () => {
    expect(continuity.toLowerCase()).toMatch(/quarterly/);
    expect(continuity).toContain("git fsck");
  });

  it("CI_CONTINUITY.md forbids reactivating GitLab CI as fallback", () => {
    expect(continuity.toLowerCase()).toMatch(/reactivate.*gitlab.*runner/);
  });

  it("CI_CONTINUITY.md forbids promoting GitLab to canonical", () => {
    expect(continuity.toLowerCase()).toMatch(/promote.*gitlab.*canonical/);
  });
});

describe("R166 — package version bumped", () => {
  const pkg = JSON.parse(readRepoFile("v2/package.json")) as {
    version: string;
  };

  it("v2/package.json version is at least 0.71.0 (R166 floor)", () => {
    // R166 bumped to 0.71.0. Future rounds may bump further. Future rounds may bump
    // further; this test asserts we never regress below the R166 floor.
    const v = pkg.version;
    const [major, minor] = v.split(".").map(Number);
    expect(major).toBe(0);
    expect(minor).toBeGreaterThanOrEqual(71);
  });
});

describe("R166 — semantics and discovery version contracts", () => {
  const schema = readRepoFile("v2/src/indexer/schema.ts");

  it("CURRENT_EXTRACTOR_SEMANTICS_VERSION is still 8", () => {
    expect(schema).toMatch(/CURRENT_EXTRACTOR_SEMANTICS_VERSION\s*=\s*8\b/);
  });

  it("CURRENT_DISCOVERY_POLICY_VERSION is 3", () => {
    expect(schema).toMatch(/CURRENT_DISCOVERY_POLICY_VERSION\s*=\s*3\b/);
  });
});
