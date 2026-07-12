/**
 * R169 SIG Phase B — Gate shell runtime tests (SIG-R169-HOTFIX-R5-01).
 *
 * SIG-R169-HOTFIX: The Phase B first production run failed with
 * "syntax error near unexpected token `then'" because the wrapper's
 * command substitution `$(` was never closed with `)"` before `; then`.
 *
 * These tests prevent this class of bug by:
 *   1. Extracting the COMPLETE `run: |` block from the "Verify GitHub
 *      commit signature" step (not just the Python fragment).
 *   2. Running `bash -n` on the extracted block to verify syntax.
 *   3. Executing the real Bash block with a fake verifier fixture.
 *
 * The previous wrapper tests (r169-phase-b-wrapper.test.ts) only tested
 * the embedded Python in isolation — they could not detect shell quoting
 * or command-substitution errors in the surrounding Bash.
 *
 * Test matrix:
 *   - bash -n on all inline Bash blocks in the workflow
 *   - bash -n on the gate step specifically
 *   - Runtime: success JSON + exit 0 → wrapper exit 0, 6 outputs
 *   - Runtime: JSON absent → wrapper exit 1
 *   - Runtime: JSON malformed → wrapper exit 1
 *   - Runtime: api_sha mismatch → wrapper exit 1
 *   - Runtime: verified=false + exit 0 → wrapper exit 1
 *   - Runtime: error_category != none + exit 0 → wrapper exit 1
 *   - Runtime: diagnostic JSON + verifier exit 1 → outputs published, exit 1
 *   - Runtime: attempts non-canonical → wrapper exit 1
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "yaml";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "mirror-main-to-gitlab.yml");

// ─── Extract inline Bash blocks from the workflow YAML ──────────────────

interface StepBlock {
  name: string;
  run: string;
}

function extractAllRunBlocks(): StepBlock[] {
  const yamlContent = readFileSync(WORKFLOW_PATH, "utf-8");
  const doc = yaml.parse(yamlContent);
  const steps = doc.jobs.mirror.steps;
  return steps
    .filter((s: any) => s.run)
    .map((s: any) => ({ name: s.name || "?", run: s.run }));
}

function extractGateStepRun(): string {
  const blocks = extractAllRunBlocks();
  const gate = blocks.find((b) => b.name === "Verify GitHub commit signature");
  if (!gate) {
    throw new Error("Could not find 'Verify GitHub commit signature' step in workflow");
  }
  return gate.run;
}

// ─── bash -n syntax validation ──────────────────────────────────────────

describe("R169 SIG Phase B gate shell — bash -n syntax validation (HOTFIX-R5-01)", () => {
  it("all inline Bash blocks in the workflow pass bash -n", () => {
    const blocks = extractAllRunBlocks();
    expect(blocks.length).toBeGreaterThan(0);

    for (const block of blocks) {
      const tmpDir = mkdtempSync(join(tmpdir(), "r169-bashn-"));
      const scriptPath = join(tmpDir, "step.sh");
      writeFileSync(scriptPath, block.run, "utf-8");

      const result = spawnSync("bash", ["-n", scriptPath], {
        encoding: "utf-8",
        timeout: 5000,
      });

      rmSync(tmpDir, { recursive: true, force: true });

      if (result.status !== 0) {
        expect.fail(
          `bash -n failed for step "${block.name}" (exit ${result.status}):\n${result.stderr}`
        );
      }
    }
  });

  it("gate step specifically passes bash -n", () => {
    const gateRun = extractGateStepRun();
    expect(gateRun.length).toBeGreaterThan(100);

    const tmpDir = mkdtempSync(join(tmpdir(), "r169-gate-bashn-"));
    const scriptPath = join(tmpDir, "gate-step.sh");
    writeFileSync(scriptPath, gateRun, "utf-8");

    const result = spawnSync("bash", ["-n", scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
    });

    rmSync(tmpDir, { recursive: true, force: true });

    expect(result.status).toBe(0);
    expect(result.stderr.trim()).toBe("");
  });

  it("gate step run block is not ambiguous to extract", () => {
    const blocks = extractAllRunBlocks();
    const gateBlocks = blocks.filter((b) => b.name === "Verify GitHub commit signature");
    expect(gateBlocks.length).toBe(1);
  });
});

// ─── Runtime wrapper tests with fake verifier ────────────────────────────

interface RuntimeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  githubOutput: string;
}

/**
 * Execute the real gate step Bash block with a fake verifier.
 * Creates a temp directory with:
 *   - trusted-verifier/scripts/ci/verify-github-commit-signature.sh (fake)
 *   - GITHUB_OUTPUT temp file
 *   - OUTPUT_FILE temp file (JSON written by the fake verifier)
 */
function runGateWithFakeVerifier(
  fakeVerifierScript: string,
): RuntimeResult {
  const tmpDir = mkdtempSync(join(tmpdir(), "r169-gate-rt-"));
  const trustedVerifierDir = join(tmpDir, "trusted-verifier", "scripts", "ci");
  mkdirSync(trustedVerifierDir, { recursive: true });

  const fakeScriptPath = join(trustedVerifierDir, "verify-github-commit-signature.sh");
  writeFileSync(fakeScriptPath, fakeVerifierScript, "utf-8");

  const githubOutputFile = join(tmpDir, "github-output.txt");
  const outputFile = join(tmpDir, "signature-outputs.json");

  const gateRun = extractGateStepRun();

  // The gate step references:
  //   - trusted-verifier/scripts/ci/verify-github-commit-signature.sh
  //   - $OUTPUT_FILE
  //   - $GITHUB_OUTPUT
  //   - $TARGET_SHA
  //   - $GITHUB_TOKEN, $GITHUB_API_URL, $GITHUB_REPOSITORY (passed to verifier)
  // We set all of these in the child env.
  const env: Record<string, string> = {
    ...process.env,
    TARGET_SHA: "a".repeat(40),
    GITHUB_TOKEN: "fake-token",
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_REPOSITORY: "test/repo",
    OUTPUT_FILE: outputFile,
    GITHUB_OUTPUT: githubOutputFile,
    TRUSTED_VERIFIER_SHA: "f5d42688d921f04b4323a017586af4566c17e381",
    // Clean up env vars that could interfere
  };
  delete env.GITHUB_ACTIONS;

  const result = spawnSync("bash", ["-c", gateRun], {
    cwd: tmpDir,
    env,
    encoding: "utf-8",
    timeout: 10000,
  });

  let githubOutput = "";
  try {
    githubOutput = readFileSync(githubOutputFile, "utf-8");
  } catch {}

  rmSync(tmpDir, { recursive: true, force: true });

  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    githubOutput,
  };
}

function makeFakeVerifier(jsonContent: string | null, exitCode: number): string {
  const writeJson = jsonContent !== null
    ? `cat > "$OUTPUT_FILE" <<'ENDJSON'\n${jsonContent}\nENDJSON`
    : `: > "$OUTPUT_FILE"`;
  return `#!/usr/bin/env bash\nset -euo pipefail\n${writeJson}\nexit ${exitCode}\n`;
}

const VALID_JSON = JSON.stringify({
  verified: "true",
  reason: "valid",
  verified_at: "2026-07-12T21:35:03Z",
  api_sha: "a".repeat(40),
  error_category: "none",
  attempts: "1",
});

const REFUSAL_JSON = JSON.stringify({
  verified: "false",
  reason: "unsigned",
  verified_at: "",
  api_sha: "a".repeat(40),
  error_category: "GITHUB_SIGNATURE_UNSIGNED",
  attempts: "1",
});

// ─── Runtime success case ───────────────────────────────────────────────

describe("R169 SIG Phase B gate shell — runtime success", () => {
  it("success JSON + exit 0 → wrapper exit 0, 6 outputs published", () => {
    const fake = makeFakeVerifier(VALID_JSON, 0);
    const r = runGateWithFakeVerifier(fake);

    if (r.exitCode !== 0) {
      expect.fail(
        `Expected exit 0, got ${r.exitCode}\nstderr: ${r.stderr}\nstdout: ${r.stdout}`
      );
    }
    expect(r.exitCode).toBe(0);
    // GITHUB_OUTPUT should contain the 6 validated keys
    expect(r.githubOutput).toContain("verified=true");
    expect(r.githubOutput).toContain("reason=valid");
    expect(r.githubOutput).toContain("verified_at=2026-07-12T21:35:03Z");
    expect(r.githubOutput).toContain("api_sha=" + "a".repeat(40));
    expect(r.githubOutput).toContain("error_category=none");
    expect(r.githubOutput).toContain("attempts=1");
    // No WRAPPER_ERROR in outputs
    expect(r.githubOutput).not.toContain("WRAPPER_ERROR");
  });
});

// ─── Runtime failure cases ──────────────────────────────────────────────

describe("R169 SIG Phase B gate shell — runtime failures", () => {
  it("JSON absent → wrapper exit 1", () => {
    // Fake verifier writes empty file and exits 0
    const fake = makeFakeVerifier(null, 0);
    const r = runGateWithFakeVerifier(fake);
    expect(r.exitCode).toBe(1);
  });

  it("JSON malformed → wrapper exit 1", () => {
    const fake = makeFakeVerifier("{not valid json", 0);
    const r = runGateWithFakeVerifier(fake);
    expect(r.exitCode).toBe(1);
  });

  it("api_sha mismatch → wrapper exit 1", () => {
    const badJson = JSON.stringify({
      verified: "true",
      reason: "valid",
      verified_at: "2026-07-12T21:35:03Z",
      api_sha: "b".repeat(40), // different from TARGET_SHA
      error_category: "none",
      attempts: "1",
    });
    const fake = makeFakeVerifier(badJson, 0);
    const r = runGateWithFakeVerifier(fake);
    expect(r.exitCode).toBe(1);
  });

  it("verified=false + exit 0 → wrapper exit 1", () => {
    const fake = makeFakeVerifier(REFUSAL_JSON, 0);
    const r = runGateWithFakeVerifier(fake);
    expect(r.exitCode).toBe(1);
  });

  it("error_category != none + exit 0 → wrapper exit 1", () => {
    const badJson = JSON.stringify({
      verified: "true",
      reason: "valid",
      verified_at: "2026-07-12T21:35:03Z",
      api_sha: "a".repeat(40),
      error_category: "GITHUB_SIGNATURE_SOMETHING",
      attempts: "1",
    });
    const fake = makeFakeVerifier(badJson, 0);
    const r = runGateWithFakeVerifier(fake);
    expect(r.exitCode).toBe(1);
  });

  it("diagnostic JSON + verifier exit 1 → outputs published, wrapper exit 1", () => {
    const fake = makeFakeVerifier(REFUSAL_JSON, 1);
    const r = runGateWithFakeVerifier(fake);
    // The wrapper publishes diagnostic outputs, then exits 1
    expect(r.exitCode).toBe(1);
    expect(r.githubOutput).toContain("verified=false");
    expect(r.githubOutput).toContain("error_category=GITHUB_SIGNATURE_UNSIGNED");
  });

  it("attempts non-canonical → wrapper exit 1", () => {
    const badJson = JSON.stringify({
      verified: "true",
      reason: "valid",
      verified_at: "2026-07-12T21:35:03Z",
      api_sha: "a".repeat(40),
      error_category: "none",
      attempts: "99", // non-canonical
    });
    const fake = makeFakeVerifier(badJson, 0);
    const r = runGateWithFakeVerifier(fake);
    expect(r.exitCode).toBe(1);
  });
});
