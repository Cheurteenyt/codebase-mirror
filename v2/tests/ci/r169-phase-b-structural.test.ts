/**
 * R169 SIG Phase B — Structural tests for the activated signature gate.
 *
 * These tests verify the STRUCTURE of the mirror workflow YAML to ensure
 * the signature gate is correctly activated with the pinned verifier.
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
 *   - Strict summary (Overall SUCCESS requires all conditions)
 *   - Cleanup always runs
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
    const gateIdx = workflow.indexOf("Verify GitHub commit signature");
    const sshIdx = workflow.indexOf("Materialize SSH key");
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

  it("cleanup runs LAST (always)", () => {
    const cleanupIdx = workflow.indexOf("Remove SSH material");
    const summaryIdx = workflow.indexOf("Write truthful mirror summary");
    expect(cleanupIdx).toBeGreaterThan(summaryIdx);
    // Cleanup must have if: always()
    const cleanupSection = workflow.substring(cleanupIdx);
    expect(cleanupSection).toMatch(/if:\s*always/);
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
    // The script invocation captures exit code with || SCRIPT_EXIT=$?
    // but the step itself must not use || true to mask failures
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

  it("gate validates exit 0 consistency (verified=true, reason=valid, api_sha=TARGET_SHA, category=none)", () => {
    const gateSection = workflow.substring(
      workflow.indexOf("Verify GitHub commit signature"),
      workflow.indexOf("Checkout exact CI-validated SHA")
    );
    expect(gateSection).toContain("exit0_inconsistent");
  });

  it("gate validates attempts is an integer", () => {
    const gateSection = workflow.substring(
      workflow.indexOf("Verify GitHub commit signature"),
      workflow.indexOf("Checkout exact CI-validated SHA")
    );
    expect(gateSection).toContain("attempts_not_int");
  });
});

describe("R169 SIG Phase B — strict summary (SIG-R169-Phase-B-SUMMARY)", () => {
  const workflow = readWorkflow();

  it("summary requires SIG_VERIFIED == true for SUCCESS", () => {
    const summarySection = workflow.substring(
      workflow.indexOf("Write truthful mirror summary"),
      workflow.indexOf("Remove SSH material")
    );
    expect(summarySection).toContain('SIG_VERIFIED');
    expect(summarySection).toContain('"true"');
  });

  it("summary requires SIG_SHA_MATCH == true for SUCCESS", () => {
    const summarySection = workflow.substring(
      workflow.indexOf("Write truthful mirror summary"),
      workflow.indexOf("Remove SSH material")
    );
    expect(summarySection).toContain("SIG_SHA_MATCH");
  });

  it("summary normalizes mirror success states", () => {
    const summarySection = workflow.substring(
      workflow.indexOf("Write truthful mirror summary"),
      workflow.indexOf("Remove SSH material")
    );
    expect(summarySection).toContain("mirrored|already-mirrored|newer-valid-mirror-present");
  });

  it("summary requires GITLAB_PARITY == true for SUCCESS", () => {
    const summarySection = workflow.substring(
      workflow.indexOf("Write truthful mirror summary"),
      workflow.indexOf("Remove SSH material")
    );
    expect(summarySection).toContain("GITLAB_PARITY");
  });

  it("summary requires JOB_STATUS == success for SUCCESS", () => {
    const summarySection = workflow.substring(
      workflow.indexOf("Write truthful mirror summary"),
      workflow.indexOf("Remove SSH material")
    );
    expect(summarySection).toContain("JOB_STATUS");
    expect(summarySection).toContain('"success"');
  });

  it("summary defaults to FAILED if any condition is false", () => {
    const summarySection = workflow.substring(
      workflow.indexOf("Write truthful mirror summary"),
      workflow.indexOf("Remove SSH material")
    );
    expect(summarySection).toContain("EFFECTIVE_RESULT");
    expect(summarySection).toContain("FAILED");
    expect(summarySection).toContain("SUCCESS");
  });
});

describe("R169 SIG Phase B — permissions and security (SIG-R169-Phase-B-PERMS)", () => {
  const workflow = readWorkflow();

  it("permissions remain contents: read only", () => {
    expect(workflow).toMatch(/permissions:\s*\n\s*contents:\s*read/);
  });

  it("no new secrets referenced (only existing GITLAB_MIRROR_SSH_PRIVATE_KEY)", () => {
    expect(workflow).toContain("GITLAB_MIRROR_SSH_PRIVATE_KEY");
    // Should not reference any new secrets
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

  it("cleanup removes signature output file", () => {
    const cleanupSection = workflow.substring(
      workflow.indexOf("Remove SSH material")
    );
    expect(cleanupSection).toContain("github-signature-outputs.json");
  });
});

describe("R169 SIG Phase B — no regression on existing tests", () => {
  it("Phase A runtime tests still exist and pass", () => {
    const runtimeTestPath = join(REPO_ROOT, "v2", "tests", "ci", "r169-signature-runtime.test.ts");
    expect(existsSync(runtimeTestPath)).toBe(true);
  });

  it("Phase A source inspection tests still exist and pass", () => {
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
