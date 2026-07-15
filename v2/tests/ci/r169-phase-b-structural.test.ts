/**
 * R169 SIG Phase B — Structural tests for the activated signature gate.
 *
 * SIG-R169-Phase-B requirements verified:
 *   - TRUSTED_VERIFIER_SHA pinned to the exact audited runtime squash SHA
 *   - Verifier checkout uses ref: <SHA> (not main/HEAD/TARGET_SHA)
 *   - Verifier checkout uses path: trusted-verifier
 *   - persist-credentials: false
 *   - Gate runs BEFORE target checkout
 *   - Gate runs BEFORE SSH materialization
 *   - No continue-on-error on gate step
 *   - No `|| true` on gate step
 *   - Fail-closed JSON wrapper validation
 *   - Cleanup BEFORE final verdict (SIG-R169-Phase-B-CLEANUP)
 *   - Final verdict is the LAST step (SIG-R169-Phase-B-FINAL)
 *   - Final verdict exits 1 on FAILED
 *   - Three verdicts: SUCCESS, SUPERSEDED, FAILED (SIG-R169-Phase-B-CONC)
 *   - Cleanup outcome required for SUCCESS/SUPERSEDED
 *   - newer-valid-mirror-present → SUPERSEDED (not SUCCESS)
 *   - No FAILED path leaves the job green
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "mirror-main-to-gitlab.yml");

function readWorkflow(): string {
  return readFileSync(WORKFLOW_PATH, "utf-8");
}

const TRUSTED_VERIFIER_SHA = "15a732d91984e5b4ffa29b4e129ac0d6316c9fca";

function readPinnedBlob(relativePath: string): string {
  return execFileSync(
    "git",
    ["show", `${TRUSTED_VERIFIER_SHA}:${relativePath}`],
    { cwd: REPO_ROOT, encoding: "utf-8" },
  );
}

describe("R169 SIG Phase B — verifier pin (SIG-R169-Phase-B-PIN)", () => {
  const workflow = readWorkflow();

  it("TRUSTED_VERIFIER_SHA is the exact audited runtime squash SHA", () => {
    expect(workflow).toContain(`TRUSTED_VERIFIER_SHA: ${TRUSTED_VERIFIER_SHA}`);
  });

  it("the immutable pinned blobs contain and syntax-check the production runtimes", () => {
    const verifier = readPinnedBlob("scripts/ci/verify-github-commit-signature.sh");
    const mirror = readPinnedBlob("scripts/ci/mirror-main-to-gitlab.sh");

    expect(verifier).toContain("api_sha");
    expect(verifier).toContain("verified_at");
    expect(mirror).toContain("git_is_ancestor()");
    expect(mirror).toContain("HostKeyAlgorithms=ssh-ed25519");
    expect(mirror).toContain("PubkeyAcceptedAlgorithms=ssh-ed25519");
    expect(() => execFileSync("bash", ["-n", "-s"], { input: verifier })).not.toThrow();
    expect(() => execFileSync("bash", ["-n", "-s"], { input: mirror })).not.toThrow();
  });

  it("verifier checkout uses ref: <TRUSTED_VERIFIER_SHA> (not main/HEAD)", () => {
    expect(workflow).toContain(`ref: ${TRUSTED_VERIFIER_SHA}`);
  });

  it("verifier checkout does NOT use ref: main", () => {
    const verifierSection = workflow.substring(
      workflow.indexOf("Checkout trusted signature verifier"),
      workflow.indexOf("Verify GitHub commit signature")
    );
    expect(verifierSection).not.toContain("ref: main");
    expect(verifierSection).not.toContain("ref: HEAD");
    expect(verifierSection).not.toContain("ref: ${{");
  });

  it("verifier checkout uses path: trusted-verifier", () => {
    const verifierSection = workflow.substring(
      workflow.indexOf("Checkout trusted signature verifier"),
      workflow.indexOf("Verify GitHub commit signature")
    );
    expect(verifierSection).toContain("path: trusted-verifier");
  });

  it("verifier checkout has persist-credentials: false", () => {
    const verifierSection = workflow.substring(
      workflow.indexOf("Checkout trusted signature verifier"),
      workflow.indexOf("Verify GitHub commit signature")
    );
    expect(verifierSection).toContain("persist-credentials: false");
  });

  it("verifier checkout uses sparse-checkout for scripts/ci only", () => {
    const verifierSection = workflow.substring(
      workflow.indexOf("Checkout trusted signature verifier"),
      workflow.indexOf("Verify GitHub commit signature")
    );
    expect(verifierSection).toContain("sparse-checkout");
    expect(verifierSection).toContain("scripts/ci");
  });
});

describe("R169 SIG Phase B — step ordering (SIG-R169-Phase-B-ORDER)", () => {
  const workflow = readWorkflow();

  it("gate runs BEFORE target checkout", () => {
    const gateIdx = workflow.indexOf("Verify GitHub commit signature");
    const targetIdx = workflow.indexOf("Checkout exact CI-validated SHA");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(targetIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(targetIdx);
  });

  it("gate runs BEFORE SSH materialization", () => {
    // Search for the step name (with `- name: ` prefix) to avoid matching
    // text in comments
    const gateIdx = workflow.indexOf("- name: Verify GitHub commit signature");
    const sshIdx = workflow.indexOf("- name: Materialize SSH key");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(sshIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(sshIdx);
  });

  it("verifier checkout runs BEFORE gate", () => {
    const verifierIdx = workflow.indexOf("Checkout trusted signature verifier");
    const gateIdx = workflow.indexOf("Verify GitHub commit signature");
    expect(verifierIdx).toBeLessThan(gateIdx);
  });

  it("event validation runs FIRST", () => {
    const validateIdx = workflow.indexOf("Validate event identity");
    const verifierIdx = workflow.indexOf("Checkout trusted signature verifier");
    expect(validateIdx).toBeLessThan(verifierIdx);
  });

  it("cleanup runs BEFORE final verdict (SIG-R169-Phase-B-CLEANUP)", () => {
    const cleanupIdx = workflow.indexOf("Cleanup SSH material");
    const verdictIdx = workflow.indexOf("Final verdict and summary");
    expect(cleanupIdx).toBeGreaterThan(-1);
    expect(verdictIdx).toBeGreaterThan(-1);
    expect(cleanupIdx).toBeLessThan(verdictIdx);
  });

  it("final verdict is the LAST step", () => {
    // The final verdict step must be the last named step in the workflow
    const verdictIdx = workflow.indexOf("Final verdict and summary");
    const cleanupIdx = workflow.indexOf("Cleanup SSH material");
    // After the verdict section, there should be no more named steps
    const afterVerdict = workflow.substring(verdictIdx + 100);
    expect(afterVerdict).not.toContain("- name: ");
  });
});

describe("R169 SIG Phase B — fail-closed gate (SIG-R169-Phase-B-FAILCLOSED)", () => {
  const workflow = readWorkflow();

  it("gate step has NO continue-on-error", () => {
    const gateSection = workflow.substring(
      workflow.indexOf("Verify GitHub commit signature"),
      workflow.indexOf("Checkout exact CI-validated SHA")
    );
    expect(gateSection).not.toContain("continue-on-error");
  });

  it("gate step does NOT use || true", () => {
    const gateSection = workflow.substring(
      workflow.indexOf("Verify GitHub commit signature"),
      workflow.indexOf("Checkout exact CI-validated SHA")
    );
    expect(gateSection).not.toMatch(/\|\|\s*true/);
  });

  it("gate uses the pinned verifier script path", () => {
    const gateSection = workflow.substring(
      workflow.indexOf("Verify GitHub commit signature"),
      workflow.indexOf("Checkout exact CI-validated SHA")
    );
    expect(gateSection).toContain("trusted-verifier/scripts/ci/verify-github-commit-signature.sh");
  });

  it("gate uses OUTPUT_FILE in RUNNER_TEMP", () => {
    const gateSection = workflow.substring(
      workflow.indexOf("Verify GitHub commit signature"),
      workflow.indexOf("Checkout exact CI-validated SHA")
    );
    expect(gateSection).toContain("OUTPUT_FILE");
    expect(gateSection).toContain("runner.temp");
  });

  it("gate validates JSON is non-empty", () => {
    const gateSection = workflow.substring(
      workflow.indexOf("Verify GitHub commit signature"),
      workflow.indexOf("Checkout exact CI-validated SHA")
    );
    expect(gateSection).toContain("-s");
    expect(gateSection).toContain("no output JSON");
  });

  it("gate validates exact key set", () => {
    const gateSection = workflow.substring(
      workflow.indexOf("Verify GitHub commit signature"),
      workflow.indexOf("Checkout exact CI-validated SHA")
    );
    expect(gateSection).toContain("verified");
    expect(gateSection).toContain("reason");
    expect(gateSection).toContain("verified_at");
    expect(gateSection).toContain("api_sha");
    expect(gateSection).toContain("error_category");
    expect(gateSection).toContain("attempts");
    expect(gateSection).toContain("invalid_keys");
  });

  it("gate rejects multiline values", () => {
    const gateSection = workflow.substring(
      workflow.indexOf("Verify GitHub commit signature"),
      workflow.indexOf("Checkout exact CI-validated SHA")
    );
    expect(gateSection).toContain("multiline");
  });

  it("gate validates exit 0 consistency", () => {
    const gateSection = workflow.substring(
      workflow.indexOf("Verify GitHub commit signature"),
      workflow.indexOf("Checkout exact CI-validated SHA")
    );
    expect(gateSection).toContain("exit0_inconsistent");
  });

  it("gate validates attempts with strict regex (SIG-R169-Phase-B-WRAPPER-03)", () => {
    const gateSection = workflow.substring(
      workflow.indexOf("Verify GitHub commit signature"),
      workflow.indexOf("Checkout exact CI-validated SHA")
    );
    expect(gateSection).toContain("attempts_not_string");
    expect(gateSection).toContain("attempts_not_canonical");
    expect(gateSection).toContain("attempts_success_too_low");
    expect(gateSection).toContain("^[0-3]$");
  });
});

describe("R169 SIG Phase B — three verdicts (SIG-R169-Phase-B-CONC)", () => {
  const workflow = readWorkflow();
  const verdictSection = workflow.substring(
    workflow.indexOf("Final verdict and summary"),
    workflow.length
  );

  it("verdict step defines SUCCESS", () => {
    expect(verdictSection).toContain("SUCCESS");
  });

  it("verdict step defines SUPERSEDED", () => {
    expect(verdictSection).toContain("SUPERSEDED");
  });

  it("verdict step defines FAILED", () => {
    expect(verdictSection).toContain("FAILED");
  });

  it("SUCCESS requires mirrored or already-mirrored", () => {
    expect(verdictSection).toContain('"mirrored"');
    expect(verdictSection).toContain('"already-mirrored"');
  });

  it("SUPERSEDED requires newer-valid-mirror-present", () => {
    expect(verdictSection).toContain("newer-valid-mirror-present");
  });

  it("newer-valid-mirror-present does NOT give SUCCESS (exact parity impossible)", () => {
    // The SUCCESS blocks (mirrored and already-mirrored) must NOT include
    // newer-valid-mirror-present. Check each SUCCESS if-block.
    const mirroredIdx = verdictSection.indexOf('"mirrored"');
    expect(mirroredIdx).toBeGreaterThan(-1);
    // Find the end of the mirrored if-block (next blank line or "fi")
    const alreadyIdx = verdictSection.indexOf('"already-mirrored"', mirroredIdx);
    const mirroredBlock = verdictSection.substring(mirroredIdx, alreadyIdx);
    expect(mirroredBlock).not.toContain("newer-valid-mirror-present");

    // The already-mirrored block also must not contain it
    const newerIdx = verdictSection.indexOf("newer-valid-mirror-present", alreadyIdx);
    const alreadyBlock = verdictSection.substring(alreadyIdx, newerIdx);
    expect(alreadyBlock).not.toContain("newer-valid-mirror-present");
  });

  it("SUPERSEDED requires post_verify_result == success", () => {
    const supersededSection = verdictSection.substring(
      verdictSection.indexOf("newer-valid-mirror-present")
    );
    expect(supersededSection).toContain("POST_VERIFY_RESULT");
    expect(supersededSection).toContain("success");
  });

  it("SUPERSEDED requires observed_sha and github_main_sha non-empty", () => {
    const supersededSection = verdictSection.substring(
      verdictSection.indexOf("newer-valid-mirror-present")
    );
    expect(supersededSection).toContain("OBSERVED_SHA");
    expect(supersededSection).toContain("GITHUB_MAIN_SHA");
  });

  it("both SUCCESS and SUPERSEDED require signature gate passed", () => {
    expect(verdictSection).toContain("SIG_OK");
    expect(verdictSection).toContain("SIG_VERIFIED");
  });

  it("both SUCCESS and SUPERSEDED require MIRROR_INVARIANTS_OK (SIG-R169-Phase-B-FINAL-INVARIANTS-02)", () => {
    expect(verdictSection).toContain("MIRROR_INVARIANTS_OK");
    expect(verdictSection).toContain("POST_VERIFY_RESULT");
    expect(verdictSection).toContain("CLIENT_FP_VERIFIED");
    expect(verdictSection).toContain("HOST_FP_VERIFIED");
    expect(verdictSection).toContain("ERROR_CATEGORY");
    expect(verdictSection).toContain("ERROR_PHASE");
    expect(verdictSection).toContain("GITHUB_MAIN_SHA");
    expect(verdictSection).toContain("JOB_STATUS");
  });

  it("SUCCESS mirrored requires push_attempted=true and push_completed=true", () => {
    expect(verdictSection).toContain("PUSH_ATTEMPTED");
    expect(verdictSection).toContain("PUSH_COMPLETED");
  });

  it("SUCCESS already-mirrored requires push_attempted=false and push_completed=false", () => {
    // The already-mirrored block should check push_attempted=false
    const alreadyMirroredIdx = verdictSection.indexOf('"already-mirrored"');
    expect(alreadyMirroredIdx).toBeGreaterThan(-1);
    const block = verdictSection.substring(alreadyMirroredIdx, alreadyMirroredIdx + 400);
    expect(block).toContain('"false"');
  });

  it("SUPERSEDED requires push_attempted=false and push_completed=false", () => {
    // The SUPERSEDED if-block starts at newer-valid-mirror-present and
    // contains PUSH_ATTEMPTED and PUSH_COMPLETED checks. Search a wider window.
    const supersededIdx = verdictSection.indexOf("newer-valid-mirror-present");
    expect(supersededIdx).toBeGreaterThan(-1);
    // The block extends to the "Write summary" section
    const summaryIdx = verdictSection.indexOf("Write summary", supersededIdx);
    const block = verdictSection.substring(supersededIdx, summaryIdx > 0 ? summaryIdx : supersededIdx + 800);
    expect(block).toContain("PUSH_ATTEMPTED");
    expect(block).toContain("PUSH_COMPLETED");
  });

  it("SUPERSEDED requires OBSERVED_SHA != TARGET_SHA (exact parity false)", () => {
    expect(verdictSection).toContain("OBSERVED_SHA");
    expect(verdictSection).toContain("TARGET_SHA");
  });
});

describe("R169 SIG Phase B — executable verdict (SIG-R169-Phase-B-FINAL)", () => {
  const workflow = readWorkflow();
  const verdictSection = workflow.substring(
    workflow.indexOf("Final verdict and summary"),
    workflow.length
  );

  it("verdict step exits 1 on FAILED", () => {
    expect(verdictSection).toContain('VERDICT" = "FAILED"');
    expect(verdictSection).toContain("exit 1");
  });

  it("verdict step exits 0 on SUCCESS or SUPERSEDED", () => {
    expect(verdictSection).toContain("exit 0");
  });

  it("verdict step is if: always()", () => {
    // The verdict step must run even if previous steps failed
    const verdictStepStart = workflow.indexOf("- name: Final verdict and summary");
    const verdictStepHeader = workflow.substring(verdictStepStart, verdictStepStart + 200);
    expect(verdictStepHeader).toContain("if: always()");
  });

  it("no FAILED path leaves the job green", () => {
    // The exit 1 must be in the FAILED branch, not bypassed
    const failedExit = verdictSection.indexOf('VERDICT" = "FAILED"');
    const exitOne = verdictSection.indexOf("exit 1", failedExit);
    expect(exitOne).toBeGreaterThan(failedExit);
    // There should be no "exit 0" between FAILED and exit 1
    const betweenText = verdictSection.substring(failedExit, exitOne);
    expect(betweenText).not.toContain("exit 0");
  });
});

describe("R169 SIG Phase B — cleanup step (SIG-R169-Phase-B-CLEANUP)", () => {
  const workflow = readWorkflow();

  it("cleanup step has id: cleanup", () => {
    const cleanupSection = workflow.substring(
      workflow.indexOf("Cleanup SSH material"),
      workflow.indexOf("Final verdict and summary")
    );
    expect(cleanupSection).toContain("id: cleanup");
  });

  it("cleanup step has if: always()", () => {
    const cleanupSection = workflow.substring(
      workflow.indexOf("Cleanup SSH material"),
      workflow.indexOf("Final verdict and summary")
    );
    expect(cleanupSection).toContain("if: always()");
  });

  it("cleanup removes signature output file", () => {
    const cleanupSection = workflow.substring(
      workflow.indexOf("Cleanup SSH material"),
      workflow.indexOf("Final verdict and summary")
    );
    expect(cleanupSection).toContain("github-signature-outputs.json");
    expect(cleanupSection).toContain("mirror-outputs.txt");
  });

  it("verdict step references steps.cleanup.outcome", () => {
    const verdictSection = workflow.substring(
      workflow.indexOf("Final verdict and summary"),
      workflow.length
    );
    expect(verdictSection).toContain("steps.cleanup.outcome");
  });
});

describe("R169 SIG Phase B — permissions and security (SIG-R169-Phase-B-PERMS)", () => {
  const workflow = readWorkflow();

  it("permissions remain actions: read and contents: read only", () => {
    expect(workflow).toMatch(
      /permissions:\s*\n\s*actions:\s*read\s*\n\s*contents:\s*read/,
    );
  });

  it("no new secrets referenced (only existing GITLAB_MIRROR_SSH_PRIVATE_KEY)", () => {
    expect(workflow).toContain("GITLAB_MIRROR_SSH_PRIVATE_KEY");
    expect(workflow).not.toContain("secrets.GITHUB");
    expect(workflow).not.toContain("secrets.PAT");
    expect(workflow).not.toContain("secrets.GITLAB_API");
  });

  it("gate uses github.token (not a PAT)", () => {
    const gateSection = workflow.substring(
      workflow.indexOf("Verify GitHub commit signature"),
      workflow.indexOf("Checkout exact CI-validated SHA")
    );
    expect(gateSection).toContain("github.token");
  });
});

describe("R169 SIG Phase B — no regression on existing tests", () => {
  it("Phase A runtime tests still exist", () => {
    const runtimeTestPath = join(REPO_ROOT, "v2", "tests", "ci", "r169-signature-runtime.test.ts");
    expect(existsSync(runtimeTestPath)).toBe(true);
  });

  it("Phase A source inspection tests still exist", () => {
    const gateTestPath = join(REPO_ROOT, "v2", "tests", "ci", "r169-signature-gate.test.ts");
    expect(existsSync(gateTestPath)).toBe(true);
  });

  it("canonical verifier script still exists", () => {
    const scriptPath = join(REPO_ROOT, "scripts", "ci", "verify-github-commit-signature.sh");
    expect(existsSync(scriptPath)).toBe(true);
  });

  it("mirror state machine script still exists", () => {
    const mirrorScriptPath = join(REPO_ROOT, "scripts", "ci", "mirror-main-to-gitlab.sh");
    expect(existsSync(mirrorScriptPath)).toBe(true);
  });
});
