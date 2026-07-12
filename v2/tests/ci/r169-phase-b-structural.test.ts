/**
 * R169 SIG Phase B — Structural tests for the activated signature gate.
 *
 * SIG-R169-Phase-B requirements verified:
 *   - TRUSTED_VERIFIER_SHA pinned to exact Phase A squash SHA
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
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "mirror-main-to-gitlab.yml");

function readWorkflow(): string {
  return readFileSync(WORKFLOW_PATH, "utf-8");
}

const TRUSTED_VERIFIER_SHA = "f5d42688d921f04b4323a017586af4566c17e381";

describe("R169 SIG Phase B — verifier pin (SIG-R169-Phase-B-PIN)", () => {
  const workflow = readWorkflow();

  it("TRUSTED_VERIFIER_SHA is the exact Phase A squash SHA", () => {
    expect(workflow).toContain(`TRUSTED_VERIFIER_SHA: ${TRUSTED_VERIFIER_SHA}`);
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

  it("gate validates attempts range (0-3, success requires 1-3)", () => {
    const gateSection = workflow.substring(
      workflow.indexOf("Verify GitHub commit signature"),
      workflow.indexOf("Checkout exact CI-validated SHA")
    );
    expect(gateSection).toContain("attempts_out_of_range");
    expect(gateSection).toContain("attempts_success_too_low");
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
    expect(verdictSection).toContain("mirrored|already-mirrored");
  });

  it("SUPERSEDED requires newer-valid-mirror-present", () => {
    expect(verdictSection).toContain("newer-valid-mirror-present");
  });

  it("newer-valid-mirror-present does NOT give SUCCESS (exact parity impossible)", () => {
    // The SUCCESS case statement (the bash `case` block) must NOT include
    // newer-valid-mirror-present. We search for the actual case pattern
    // in the bash code, not in comments.
    const caseStart = verdictSection.indexOf("mirrored|already-mirrored)");
    expect(caseStart).toBeGreaterThan(-1);
    // Find the next `;;` which closes the SUCCESS case branch
    const caseEnd = verdictSection.indexOf(";;", caseStart);
    expect(caseEnd).toBeGreaterThan(caseStart);
    const successCase = verdictSection.substring(caseStart, caseEnd);
    expect(successCase).not.toContain("newer-valid-mirror-present");
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

  it("both SUCCESS and SUPERSEDED require cleanup success", () => {
    expect(verdictSection).toContain("CLEANUP_OUTCOME");
    expect(verdictSection).toContain("CLEANUP_OK");
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

  it("permissions remain contents: read only", () => {
    expect(workflow).toMatch(/permissions:\s*\n\s*contents:\s*read/);
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
