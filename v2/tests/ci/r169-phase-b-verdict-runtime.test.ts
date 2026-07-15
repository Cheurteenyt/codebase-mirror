/**
 * R169 SIG Phase B — Verdict runtime tests (SIG-R169-Phase-B-TEST-FINAL-01).
 *
 * These tests extract the REAL Bash verdict block from the workflow YAML
 * and execute it with a complete matrix of environment variables. This
 * verifies the actual production verdict logic — not just string matching.
 *
 * The test:
 *   1. Reads .github/workflows/mirror-main-to-gitlab.yml
 *   2. Extracts the exact `run:` block from the "Final verdict and summary" step
 *   3. Fails if the block is absent, ambiguous, or impossible to extract
 *   4. Executes the real Bash block with:
 *      - GITHUB_STEP_SUMMARY pointing to a temp file
 *      - GITHUB_OUTPUT pointing to a temp file
 *      - Full env matrix (signature, mirror, fingerprint, push, cleanup, job)
 *   5. Verifies exit code, verdict output, and summary content
 *
 * SIG-R169-Phase-B-FINAL-INVARIANTS-02: MIRROR_INVARIANTS_OK is verified
 * as a common requirement for SUCCESS and SUPERSEDED. Push coherence
 * (push_attempted/push_completed) is verified per verdict.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "mirror-main-to-gitlab.yml");

// ─── Extract the REAL Bash verdict block from the workflow YAML ─────────

function extractVerdictBash(): string {
  const yaml = readFileSync(WORKFLOW_PATH, "utf-8");

  // Find the "Final verdict and summary" step
  const stepMarker = "- name: Final verdict and summary";
  const stepStart = yaml.indexOf(stepMarker);
  if (stepStart === -1) {
    throw new Error("Could not find 'Final verdict and summary' step in workflow");
  }

  // Find the `run: |` block within this step
  const runMarker = "run: |";
  const runStart = yaml.indexOf(runMarker, stepStart);
  if (runStart === -1) {
    throw new Error("Could not find run: | block in Final verdict step");
  }

  // The run block starts after "run: |\n" and continues until the next
  // step (line starting with "      - name:" or "      - uses:" at the
  // same indentation level) or end of file.
  const codeStart = yaml.indexOf("\n", runStart) + 1;

  // Find the end: the next line that starts at 6-space indentation with
  // "- " (a new step) or end of jobs section
  let endIdx = codeStart;
  const lines = yaml.substring(codeStart).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // A new step starts with "      - name:" or "      - uses:" (6 spaces)
    if (/^      - (name|uses):/.test(line)) {
      endIdx = codeStart + lines.slice(0, i).join("\n").length;
      break;
    }
    // End of file
    if (line === "" && i === lines.length - 1) {
      endIdx = codeStart + lines.slice(0, i).join("\n").length;
      break;
    }
  }

  const rawBlock = yaml.substring(codeStart, endIdx);

  // Dedent: strip the common leading whitespace (8 spaces for run: | blocks)
  const blockLines = rawBlock.split("\n");
  let minIndent = Infinity;
  for (const line of blockLines) {
    if (line.trim().length === 0) continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (indent < minIndent) minIndent = indent;
  }
  if (minIndent === Infinity) minIndent = 0;

  return blockLines.map((line) => line.substring(minIndent)).join("\n");
}

const VERDICT_BASH = extractVerdictBash();

// ─── Test runner ────────────────────────────────────────────────────────

const TARGET_SHA = "a".repeat(40);       // A — the commit we wanted to mirror
const OTHER_SHA = "b".repeat(40);
const OBSERVED_DESCENDANT = "c".repeat(40); // B — GitLab is at a descendant
const GITHUB_MAIN = "a".repeat(40);      // GitHub main == target in normal case
const GITHUB_MAIN_NEWER = "d".repeat(40); // C — GitHub main advanced past target

interface VerdictResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  verdict: string | null;
  exactParity: string | null;
  summary: string;
}

function runVerdict(envOverrides: Record<string, string>): VerdictResult {
  const tmpDir = mkdtempSync(join(tmpdir(), "r169-verdict-"));
  const summaryFile = join(tmpDir, "summary.md");
  const outputFile = join(tmpDir, "output.txt");

  const baseEnv: Record<string, string> = {
    TARGET_SHA,
    TRUSTED_VERIFIER_SHA: "15a732d91984e5b4ffa29b4e129ac0d6316c9fca",
    EXPECTED_KEY_FP: "SHA256:test",
    EXPECTED_HOST_FP: "SHA256:test",
    GITHUB_STEP_SUMMARY: summaryFile,
    GITHUB_OUTPUT: outputFile,
    // Signature defaults — overridden per test
    SIG_VERIFIED: "true",
    SIG_REASON: "valid",
    SIG_VERIFIED_AT: "2026-07-13T10:00:00Z",
    SIG_API_SHA: TARGET_SHA,
    SIG_ERROR_CATEGORY: "none",
    SIG_ATTEMPTS: "1",
    // Mirror defaults — overridden per test
    FINAL_RESULT: "mirrored",
    OBSERVED_SHA: TARGET_SHA,
    GITHUB_MAIN_SHA: GITHUB_MAIN,
    ERROR_CATEGORY: "none",
    ERROR_PHASE: "none",
    CLIENT_FP_VERIFIED: "true",
    CLIENT_FP_ACTUAL: "SHA256:test",
    HOST_FP_VERIFIED: "true",
    HOST_FP_ACTUAL: "SHA256:test",
    PUSH_ATTEMPTED: "true",
    PUSH_COMPLETED: "true",
    POST_VERIFY_RESULT: "success",
    CLEANUP_OUTCOME: "success",
    JOB_STATUS: "success",
    // Native push is the historical default for this verdict matrix. Tests
    // can override both fields to exercise the exact-main dispatch branch.
    RUN_EVENT: "push",
    DISPATCH_REVALIDATION_OUTCOME: "skipped",
    ...envOverrides,
  };

  const result = spawnSync("bash", ["-c", VERDICT_BASH], {
    env: { ...process.env, ...baseEnv },
    encoding: "utf-8",
    timeout: 10000,
  });

  let verdict: string | null = null;
  let exactParity: string | null = null;
  try {
    const output = readFileSync(outputFile, "utf-8");
    const verdictMatch = output.match(/verdict=(\w+)/);
    if (verdictMatch) verdict = verdictMatch[1];
    const parityMatch = output.match(/exact_parity=(\w+)/);
    if (parityMatch) exactParity = parityMatch[1];
  } catch {}

  let summary = "";
  try {
    summary = readFileSync(summaryFile, "utf-8");
  } catch {}

  rmSync(tmpDir, { recursive: true, force: true });

  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    verdict,
    exactParity,
    summary,
  };
}

// ─── Extraction validation ──────────────────────────────────────────────

describe("R169 SIG Phase B verdict runtime — extraction (TEST-FINAL-R169-01)", () => {
  it("verdict Bash block is successfully extracted from the workflow", () => {
    expect(VERDICT_BASH).toBeTruthy();
    expect(VERDICT_BASH.length).toBeGreaterThan(500);
  });

  it("extracted block contains the required verdict markers", () => {
    expect(VERDICT_BASH).toContain("MIRROR_INVARIANTS_OK");
    expect(VERDICT_BASH).toContain("VERDICT");
    expect(VERDICT_BASH).toContain("SUCCESS");
    expect(VERDICT_BASH).toContain("SUPERSEDED");
    expect(VERDICT_BASH).toContain("FAILED");
    expect(VERDICT_BASH).toContain("exit 1");
  });
});

// ─── SUCCESS cases ──────────────────────────────────────────────────────

describe("R169 SIG Phase B verdict runtime — SUCCESS", () => {
  it("mirrored + exact parity + push true + invariants + sig → SUCCESS, exit 0", () => {
    const r = runVerdict({
      FINAL_RESULT: "mirrored",
      OBSERVED_SHA: TARGET_SHA,
      PUSH_ATTEMPTED: "true",
      PUSH_COMPLETED: "true",
      POST_VERIFY_RESULT: "success",
      CLIENT_FP_VERIFIED: "true",
      HOST_FP_VERIFIED: "true",
      ERROR_CATEGORY: "none",
      ERROR_PHASE: "none",
      GITHUB_MAIN_SHA: GITHUB_MAIN,
      JOB_STATUS: "success",
      CLEANUP_OUTCOME: "success",
      SIG_VERIFIED: "true",
      SIG_API_SHA: TARGET_SHA,
    });
    expect(r.exitCode).toBe(0);
    expect(r.verdict).toBe("SUCCESS");
    expect(r.exactParity).toBe("true");
    expect(r.summary).toContain("Operational result: SUCCESS");
  });

  it("already-mirrored + exact parity + push false + invariants + sig → SUCCESS, exit 0", () => {
    const r = runVerdict({
      FINAL_RESULT: "already-mirrored",
      OBSERVED_SHA: TARGET_SHA,
      PUSH_ATTEMPTED: "false",
      PUSH_COMPLETED: "false",
      POST_VERIFY_RESULT: "success",
      CLIENT_FP_VERIFIED: "true",
      HOST_FP_VERIFIED: "true",
      ERROR_CATEGORY: "none",
      ERROR_PHASE: "none",
      GITHUB_MAIN_SHA: GITHUB_MAIN,
      JOB_STATUS: "success",
      CLEANUP_OUTCOME: "success",
      SIG_VERIFIED: "true",
      SIG_API_SHA: TARGET_SHA,
    });
    expect(r.exitCode).toBe(0);
    expect(r.verdict).toBe("SUCCESS");
    expect(r.exactParity).toBe("true");
  });
});

// ─── SUPERSEDED cases (SIG-R169-Phase-B-CONC-R3-01) ─────────────────────
// Two valid origins: PREEXISTING (push false/false) and AFTER_PUSH_RACE
// (push true/true). GITHUB_MAIN_SHA must differ from TARGET_SHA.

describe("R169 SIG Phase B verdict runtime — SUPERSEDED", () => {
  it("newer-valid + push false/false (PREEXISTING) → SUPERSEDED, exit 0", () => {
    const r = runVerdict({
      FINAL_RESULT: "newer-valid-mirror-present",
      OBSERVED_SHA: OBSERVED_DESCENDANT, // B != A
      GITHUB_MAIN_SHA: GITHUB_MAIN_NEWER, // C != A
      PUSH_ATTEMPTED: "false",
      PUSH_COMPLETED: "false",
    });
    expect(r.exitCode).toBe(0);
    expect(r.verdict).toBe("SUPERSEDED");
    expect(r.exactParity).toBe("false");
    expect(r.summary).toContain("Operational result: SUPERSEDED");
    expect(r.summary).toContain("GitLab is ahead");
  });

  it("newer-valid + push true/true (AFTER_PUSH_RACE) → SUPERSEDED, exit 0", () => {
    const r = runVerdict({
      FINAL_RESULT: "newer-valid-mirror-present",
      OBSERVED_SHA: OBSERVED_DESCENDANT, // B != A
      GITHUB_MAIN_SHA: GITHUB_MAIN_NEWER, // C != A
      PUSH_ATTEMPTED: "true",
      PUSH_COMPLETED: "true",
    });
    expect(r.exitCode).toBe(0);
    expect(r.verdict).toBe("SUPERSEDED");
    expect(r.exactParity).toBe("false");
  });

  it("newer-valid + push true/false (push failed) → FAILED, exit 1", () => {
    const r = runVerdict({
      FINAL_RESULT: "newer-valid-mirror-present",
      OBSERVED_SHA: OBSERVED_DESCENDANT,
      GITHUB_MAIN_SHA: GITHUB_MAIN_NEWER,
      PUSH_ATTEMPTED: "true",
      PUSH_COMPLETED: "false", // push failed — incoherent
    });
    expect(r.exitCode).toBe(1);
    expect(r.verdict).toBe("FAILED");
  });

  it("newer-valid + push false/true (impossible) → FAILED, exit 1", () => {
    const r = runVerdict({
      FINAL_RESULT: "newer-valid-mirror-present",
      OBSERVED_SHA: OBSERVED_DESCENDANT,
      GITHUB_MAIN_SHA: GITHUB_MAIN_NEWER,
      PUSH_ATTEMPTED: "false",
      PUSH_COMPLETED: "true", // impossible — incoherent
    });
    expect(r.exitCode).toBe(1);
    expect(r.verdict).toBe("FAILED");
  });

  it("newer-valid + GITHUB_MAIN_SHA == TARGET_SHA → FAILED (descendant can't belong to same main)", () => {
    const r = runVerdict({
      FINAL_RESULT: "newer-valid-mirror-present",
      OBSERVED_SHA: OBSERVED_DESCENDANT,
      GITHUB_MAIN_SHA: TARGET_SHA, // same as target — contradictory
      PUSH_ATTEMPTED: "false",
      PUSH_COMPLETED: "false",
    });
    expect(r.exitCode).toBe(1);
    expect(r.verdict).toBe("FAILED");
  });
});

// ─── FAILED cases ───────────────────────────────────────────────────────

describe("R169 SIG Phase B verdict runtime — FAILED (signature/fingerprint errors)", () => {
  it("signature false → FAILED, exit 1", () => {
    const r = runVerdict({
      SIG_VERIFIED: "false",
      SIG_ERROR_CATEGORY: "GITHUB_SIGNATURE_UNSIGNED",
    });
    expect(r.exitCode).toBe(1);
    expect(r.verdict).toBe("FAILED");
  });

  it("API SHA mismatch → FAILED, exit 1", () => {
    const r = runVerdict({
      SIG_API_SHA: OTHER_SHA,
    });
    expect(r.exitCode).toBe(1);
    expect(r.verdict).toBe("FAILED");
  });

  it("cleanup failure → FAILED, exit 1", () => {
    const r = runVerdict({
      CLEANUP_OUTCOME: "failure",
    });
    expect(r.exitCode).toBe(1);
    expect(r.verdict).toBe("FAILED");
  });

  it("post_verify failure → FAILED, exit 1", () => {
    const r = runVerdict({
      POST_VERIFY_RESULT: "failed",
    });
    expect(r.exitCode).toBe(1);
    expect(r.verdict).toBe("FAILED");
  });

  it("client fingerprint false → FAILED, exit 1", () => {
    const r = runVerdict({
      CLIENT_FP_VERIFIED: "false",
    });
    expect(r.exitCode).toBe(1);
    expect(r.verdict).toBe("FAILED");
  });

  it("host fingerprint false → FAILED, exit 1", () => {
    const r = runVerdict({
      HOST_FP_VERIFIED: "false",
    });
    expect(r.exitCode).toBe(1);
    expect(r.verdict).toBe("FAILED");
  });

  it("error_category != none → FAILED, exit 1", () => {
    const r = runVerdict({
      ERROR_CATEGORY: "GITHUB_SIGNATURE_MIRROR_ERROR",
    });
    expect(r.exitCode).toBe(1);
    expect(r.verdict).toBe("FAILED");
  });

  it("error_phase != none → FAILED, exit 1", () => {
    const r = runVerdict({
      ERROR_PHASE: "push",
    });
    expect(r.exitCode).toBe(1);
    expect(r.verdict).toBe("FAILED");
  });

  it("github_main_sha empty → FAILED, exit 1", () => {
    const r = runVerdict({
      GITHUB_MAIN_SHA: "",
    });
    expect(r.exitCode).toBe(1);
    expect(r.verdict).toBe("FAILED");
  });

  it("job_status failure → FAILED, exit 1", () => {
    const r = runVerdict({
      JOB_STATUS: "failure",
    });
    expect(r.exitCode).toBe(1);
    expect(r.verdict).toBe("FAILED");
  });
});

describe("R169 SIG Phase B verdict runtime — FAILED (push coherence)", () => {
  it("mirrored but push_completed=false → FAILED, exit 1", () => {
    const r = runVerdict({
      FINAL_RESULT: "mirrored",
      PUSH_ATTEMPTED: "true",
      PUSH_COMPLETED: "false",
    });
    expect(r.exitCode).toBe(1);
    expect(r.verdict).toBe("FAILED");
  });

  it("already-mirrored but push_attempted=true → FAILED, exit 1", () => {
    const r = runVerdict({
      FINAL_RESULT: "already-mirrored",
      PUSH_ATTEMPTED: "true",
      PUSH_COMPLETED: "false",
    });
    expect(r.exitCode).toBe(1);
    expect(r.verdict).toBe("FAILED");
  });

  it("newer-valid with exact parity=true → FAILED (contradictory), exit 1", () => {
    const r = runVerdict({
      FINAL_RESULT: "newer-valid-mirror-present",
      OBSERVED_SHA: TARGET_SHA, // same as target — contradictory
      PUSH_ATTEMPTED: "false",
      PUSH_COMPLETED: "false",
    });
    expect(r.exitCode).toBe(1);
    expect(r.verdict).toBe("FAILED");
  });
});

// ─── Summary content verification ───────────────────────────────────────

describe("R169 SIG Phase B verdict runtime — summary content", () => {
  it("SUCCESS summary contains exact parity true and operational result", () => {
    const r = runVerdict({
      FINAL_RESULT: "mirrored",
      PUSH_ATTEMPTED: "true",
      PUSH_COMPLETED: "true",
    });
    expect(r.exitCode).toBe(0);
    expect(r.summary).toContain("Exact target parity: `true`");
    expect(r.summary).toContain("Operational result: SUCCESS");
  });

  it("SUPERSEDED summary contains exact parity false and operational result", () => {
    const r = runVerdict({
      FINAL_RESULT: "newer-valid-mirror-present",
      OBSERVED_SHA: OBSERVED_DESCENDANT,
      GITHUB_MAIN_SHA: GITHUB_MAIN_NEWER, // C != A
      PUSH_ATTEMPTED: "false",
      PUSH_COMPLETED: "false",
    });
    expect(r.exitCode).toBe(0);
    expect(r.summary).toContain("Exact target parity: `false`");
    expect(r.summary).toContain("Operational result: SUPERSEDED");
  });

  it("FAILED summary contains FAILED and the error category", () => {
    const r = runVerdict({
      SIG_VERIFIED: "false",
      SIG_ERROR_CATEGORY: "GITHUB_SIGNATURE_UNSIGNED",
    });
    expect(r.exitCode).toBe(1);
    expect(r.summary).toContain("Operational result: FAILED");
  });

  it("summary always contains TRUSTED_VERIFIER_SHA", () => {
    const r = runVerdict({});
    expect(r.summary).toContain("15a732d91984e5b4ffa29b4e129ac0d6316c9fca");
  });
});

describe("R169 SIG Phase B verdict runtime - trigger/main binding", () => {
  it("exact workflow_dispatch revalidation permits SUCCESS", () => {
    const r = runVerdict({
      RUN_EVENT: "workflow_dispatch",
      DISPATCH_REVALIDATION_OUTCOME: "success",
      GITHUB_MAIN_SHA: TARGET_SHA,
    });

    expect(r.exitCode).toBe(0);
    expect(r.verdict).toBe("SUCCESS");
  });

  it("failed workflow_dispatch revalidation is rejected", () => {
    const r = runVerdict({
      RUN_EVENT: "workflow_dispatch",
      DISPATCH_REVALIDATION_OUTCOME: "failed",
      GITHUB_MAIN_SHA: TARGET_SHA,
    });

    expect(r.exitCode).toBe(1);
    expect(r.verdict).toBe("FAILED");
  });

  it("workflow_dispatch is rejected when main moved", () => {
    const r = runVerdict({
      RUN_EVENT: "workflow_dispatch",
      DISPATCH_REVALIDATION_OUTCOME: "success",
      GITHUB_MAIN_SHA: GITHUB_MAIN_NEWER,
    });

    expect(r.exitCode).toBe(1);
    expect(r.verdict).toBe("FAILED");
  });
});
