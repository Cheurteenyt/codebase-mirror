/**
 * R169 SIG Phase B — Wrapper validation tests.
 *
 * SIG-R169-Phase-B-TEST-01: These tests extract the REAL Python wrapper
 * code from the workflow YAML and execute it with fixtures. This ensures
 * the tests validate the exact code that runs in production — no
 * duplication that could drift.
 *
 * The test fails if:
 *   - The Python block cannot be extracted from the YAML
 *   - Multiple candidate blocks exist (ambiguous extraction)
 *   - The workflow and fixtures are no longer compatible
 *
 * Test matrix:
 *   - exit 0 + valid JSON → success (outputs published)
 *   - exit 0 + JSON absent → failure
 *   - exit 0 + JSON empty → failure
 *   - exit 0 + JSON malformed → failure
 *   - exit 0 + verified=false → failure
 *   - exit 0 + api_sha mismatch → failure
 *   - exit 0 + category != none → failure
 *   - exit 0 + missing key → failure
 *   - exit 0 + extra key → failure
 *   - exit 0 + multiline value → failure
 *   - exit 0 + attempts not int → failure
 *   - exit 0 + attempts > 3 → failure
 *   - exit 0 + attempts negative → failure
 *   - exit 0 + attempts == 0 (success requires 1-3) → failure
 *   - exit 1 + valid diagnostic JSON → diagnostics published, then failure
 *   - exit 1 + verified=true → failure (inconsistent)
 *   - exit 1 + attempts == 0 (diagnostic allows 0-3) → success
 *   - exit 0 + reason != valid → failure
 *   - exit 0 + verified_at empty → failure
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "mirror-main-to-gitlab.yml");

// ─── Extract the REAL Python wrapper from the workflow YAML ─────────────
// SIG-R169-Phase-B-TEST-01: No duplication — read the actual code.

function extractWrapperPython(): string {
  const yaml = readFileSync(WORKFLOW_PATH, "utf-8");

  // The wrapper is invoked as: python3 -c '...'
  // The Python block ends with ' followed by ; then (shell if-statement)
  // Strategy: find all `python3 -c '` occurrences, extract the code until
  // the closing `'` that is followed by `;` or newline, and identify the
  // one that contains "WRAPPER_ERROR" (the wrapper validation marker).

  const candidates: string[] = [];
  const marker = "python3 -c '";
  let searchFrom = 0;

  while (true) {
    const startIdx = yaml.indexOf(marker, searchFrom);
    if (startIdx === -1) break;

    const codeStart = startIdx + marker.length;
    // Find the closing single quote — it's followed by either ';' or '\n'
    let endIdx = codeStart;
    while (endIdx < yaml.length) {
      if (yaml[endIdx] === "'" && (yaml[endIdx + 1] === ";" || yaml[endIdx + 1] === "\n")) {
        break;
      }
      endIdx++;
    }

    if (endIdx >= yaml.length) {
      searchFrom = codeStart;
      continue;
    }

    const code = yaml.substring(codeStart, endIdx);
    if (code.includes("WRAPPER_ERROR")) {
      candidates.push(code);
    }

    searchFrom = endIdx + 1;
  }

  if (candidates.length === 0) {
    throw new Error(
      "Could not extract wrapper Python from workflow YAML — no python3 -c block containing WRAPPER_ERROR found"
    );
  }

  if (candidates.length > 1) {
    throw new Error(
      `Ambiguous extraction: found ${candidates.length} candidate Python blocks containing WRAPPER_ERROR`
    );
  }

  // Dedent: strip the common leading whitespace from each line so the
  // Python code can be executed by `python3 -c`. The YAML indents the
  // code block by 10 spaces (the run: block indentation level).
  const raw = candidates[0];
  const lines = raw.split("\n");
  // Find minimum indentation across non-empty lines
  let minIndent = Infinity;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (indent < minIndent) minIndent = indent;
  }
  if (minIndent === Infinity) minIndent = 0;
  const dedented = lines.map((line) => line.substring(minIndent)).join("\n");

  return dedented;
}

// Extract once at module level — if this fails, ALL tests fail
const WRAPPER_PYTHON = extractWrapperPython();

interface WrapperResult {
  stdout: string;
  hasWrapperError: boolean;
  errorDetail: string | null;
  outputs: Record<string, string> | null;
}

function runWrapper(
  jsonContent: string | null,
  scriptExit: string,
  targetSha: string = "a".repeat(40)
): WrapperResult {
  const tmpDir = mkdtempSync(join(tmpdir(), "r169-wrap-"));
  const outputFile = join(tmpDir, "outputs.json");

  if (jsonContent !== null) {
    writeFileSync(outputFile, jsonContent, "utf-8");
  }

  const result = spawnSync("python3", ["-c", WRAPPER_PYTHON], {
    env: {
      ...process.env,
      OUTPUT_FILE: outputFile,
      TARGET_SHA: targetSha,
      SCRIPT_EXIT: scriptExit,
    },
    encoding: "utf-8",
    timeout: 5000,
  });

  rmSync(tmpDir, { recursive: true, force: true });

  const stdout = result.stdout || "";
  const hasWrapperError = stdout.includes("WRAPPER_ERROR|");
  const errorMatch = stdout.match(/WRAPPER_ERROR\|(\w+)/);
  const errorDetail = errorMatch ? errorMatch[1] : null;

  let outputs: Record<string, string> | null = null;
  if (!hasWrapperError) {
    outputs = {};
    for (const line of stdout.trim().split("\n")) {
      const idx = line.indexOf("=");
      if (idx > 0) {
        outputs[line.substring(0, idx)] = line.substring(idx + 1);
      }
    }
  }

  return { stdout, hasWrapperError, errorDetail, outputs };
}

function makeValidJson(sha: string = "a".repeat(40), attempts: string = "1"): string {
  return JSON.stringify({
    verified: "true",
    reason: "valid",
    verified_at: "2026-07-13T10:00:00Z",
    api_sha: sha,
    error_category: "none",
    attempts,
  });
}

function makeRefusalJson(reason: string, sha: string = "a".repeat(40), attempts: string = "1"): string {
  return JSON.stringify({
    verified: "false",
    reason,
    verified_at: "",
    api_sha: sha,
    error_category: `GITHUB_SIGNATURE_${reason.toUpperCase()}`,
    attempts,
  });
}

// ─── Extraction validation ──────────────────────────────────────────────

describe("R169 SIG Phase B wrapper — extraction from workflow (SIG-R169-Phase-B-TEST-01)", () => {
  it("wrapper Python is successfully extracted from the workflow YAML", () => {
    expect(WRAPPER_PYTHON).toBeTruthy();
    expect(WRAPPER_PYTHON.length).toBeGreaterThan(100);
  });

  it("extracted wrapper contains the required validation markers", () => {
    expect(WRAPPER_PYTHON).toContain("WRAPPER_ERROR");
    expect(WRAPPER_PYTHON).toContain("invalid_keys");
    expect(WRAPPER_PYTHON).toContain("multiline_value");
    expect(WRAPPER_PYTHON).toContain("exit0_inconsistent");
    expect(WRAPPER_PYTHON).toContain("attempts_out_of_range");
  });
});

// ─── Success cases ──────────────────────────────────────────────────────

describe("R169 SIG Phase B wrapper — success cases", () => {
  it("exit 0 + valid JSON → outputs published, no wrapper error", () => {
    const r = runWrapper(makeValidJson(), "0");
    expect(r.hasWrapperError).toBe(false);
    expect(r.outputs?.verified).toBe("true");
    expect(r.outputs?.reason).toBe("valid");
    expect(r.outputs?.api_sha).toBe("a".repeat(40));
    expect(r.outputs?.error_category).toBe("none");
    expect(r.outputs?.attempts).toBe("1");
  });

  it("exit 1 + valid diagnostic JSON → diagnostics published (no wrapper error)", () => {
    const r = runWrapper(makeRefusalJson("unsigned"), "1");
    expect(r.hasWrapperError).toBe(false);
    expect(r.outputs?.verified).toBe("false");
    expect(r.outputs?.reason).toBe("unsigned");
    expect(r.outputs?.error_category).toBe("GITHUB_SIGNATURE_UNSIGNED");
  });
});

// ─── Failure cases: JSON file issues ────────────────────────────────────

describe("R169 SIG Phase B wrapper — JSON file failures", () => {
  it("exit 0 + JSON absent → WRAPPER_ERROR (malformed_json)", () => {
    const r = runWrapper(null, "0");
    expect(r.hasWrapperError).toBe(true);
    expect(r.errorDetail).toBe("malformed_json");
  });

  it("exit 0 + JSON empty → WRAPPER_ERROR (malformed_json)", () => {
    const r = runWrapper("", "0");
    expect(r.hasWrapperError).toBe(true);
    expect(r.errorDetail).toBe("malformed_json");
  });

  it("exit 0 + JSON malformed → WRAPPER_ERROR (malformed_json)", () => {
    const r = runWrapper("{not valid json", "0");
    expect(r.hasWrapperError).toBe(true);
    expect(r.errorDetail).toBe("malformed_json");
  });
});

// ─── Failure cases: key set issues ──────────────────────────────────────

describe("R169 SIG Phase B wrapper — key set failures", () => {
  it("exit 0 + missing key (no attempts) → WRAPPER_ERROR (invalid_keys)", () => {
    const json = JSON.stringify({
      verified: "true",
      reason: "valid",
      verified_at: "2026-07-13T10:00:00Z",
      api_sha: "a".repeat(40),
      error_category: "none",
    });
    const r = runWrapper(json, "0");
    expect(r.hasWrapperError).toBe(true);
    expect(r.errorDetail).toBe("invalid_keys");
  });

  it("exit 0 + extra key → WRAPPER_ERROR (invalid_keys)", () => {
    const json = JSON.stringify({
      ...JSON.parse(makeValidJson()),
      extra_field: "unexpected",
    });
    const r = runWrapper(json, "0");
    expect(r.hasWrapperError).toBe(true);
    expect(r.errorDetail).toBe("invalid_keys");
  });
});

// ─── Failure cases: multiline values ────────────────────────────────────

describe("R169 SIG Phase B wrapper — multiline value failures", () => {
  it("exit 0 + multiline reason → WRAPPER_ERROR (multiline_value)", () => {
    const json = JSON.stringify({
      verified: "true",
      reason: "valid\nmalicious",
      verified_at: "2026-07-13T10:00:00Z",
      api_sha: "a".repeat(40),
      error_category: "none",
      attempts: "1",
    });
    const r = runWrapper(json, "0");
    expect(r.hasWrapperError).toBe(true);
    expect(r.errorDetail).toBe("multiline_value");
  });

  it("exit 0 + multiline verified_at → WRAPPER_ERROR (multiline_value)", () => {
    const json = JSON.stringify({
      verified: "true",
      reason: "valid",
      verified_at: "2026-07-13T10:00:00Z\r\nmalicious",
      api_sha: "a".repeat(40),
      error_category: "none",
      attempts: "1",
    });
    const r = runWrapper(json, "0");
    expect(r.hasWrapperError).toBe(true);
    expect(r.errorDetail).toBe("multiline_value");
  });
});

// ─── attempts validation (SIG-R169-Phase-B-WRAPPER-02) ──────────────────

describe("R169 SIG Phase B wrapper — attempts range validation (WRAPPER-02)", () => {
  it("exit 0 + attempts not int → WRAPPER_ERROR (attempts_not_int)", () => {
    const r = runWrapper(makeValidJson("a".repeat(40), "not-a-number"), "0");
    expect(r.hasWrapperError).toBe(true);
    expect(r.errorDetail).toBe("attempts_not_int");
  });

  it("exit 0 + attempts == 4 (>3) → WRAPPER_ERROR (attempts_out_of_range)", () => {
    const r = runWrapper(makeValidJson("a".repeat(40), "4"), "0");
    expect(r.hasWrapperError).toBe(true);
    expect(r.errorDetail).toBe("attempts_out_of_range");
  });

  it("exit 0 + attempts == -1 (negative) → WRAPPER_ERROR (attempts_out_of_range)", () => {
    const r = runWrapper(makeValidJson("a".repeat(40), "-1"), "0");
    expect(r.hasWrapperError).toBe(true);
    expect(r.errorDetail).toBe("attempts_out_of_range");
  });

  it("exit 0 + attempts == 0 (success requires 1-3) → WRAPPER_ERROR (attempts_success_too_low)", () => {
    const r = runWrapper(makeValidJson("a".repeat(40), "0"), "0");
    expect(r.hasWrapperError).toBe(true);
    expect(r.errorDetail).toBe("attempts_success_too_low");
  });

  it("exit 0 + attempts == 3 (max for success) → OK", () => {
    const r = runWrapper(makeValidJson("a".repeat(40), "3"), "0");
    expect(r.hasWrapperError).toBe(false);
  });

  it("exit 1 + attempts == 0 (diagnostic allows 0-3) → OK", () => {
    const r = runWrapper(makeRefusalJson("unsigned", "a".repeat(40), "0"), "1");
    expect(r.hasWrapperError).toBe(false);
  });

  it("exit 1 + attempts == 3 (max for diagnostic) → OK", () => {
    const r = runWrapper(makeRefusalJson("unsigned", "a".repeat(40), "3"), "1");
    expect(r.hasWrapperError).toBe(false);
  });

  it("exit 1 + attempts == 4 (>3) → WRAPPER_ERROR (attempts_out_of_range)", () => {
    const r = runWrapper(makeRefusalJson("unsigned", "a".repeat(40), "4"), "1");
    expect(r.hasWrapperError).toBe(true);
    expect(r.errorDetail).toBe("attempts_out_of_range");
  });
});

// ─── Failure cases: exit 0 inconsistency ────────────────────────────────

describe("R169 SIG Phase B wrapper — exit 0 inconsistency", () => {
  it("exit 0 + verified=false → WRAPPER_ERROR (exit0_inconsistent)", () => {
    const r = runWrapper(makeRefusalJson("unsigned"), "0");
    expect(r.hasWrapperError).toBe(true);
    expect(r.errorDetail).toBe("exit0_inconsistent");
  });

  it("exit 0 + reason != valid → WRAPPER_ERROR (exit0_inconsistent)", () => {
    const json = JSON.stringify({
      verified: "true",
      reason: "unsigned",
      verified_at: "2026-07-13T10:00:00Z",
      api_sha: "a".repeat(40),
      error_category: "none",
      attempts: "1",
    });
    const r = runWrapper(json, "0");
    expect(r.hasWrapperError).toBe(true);
    expect(r.errorDetail).toBe("exit0_inconsistent");
  });

  it("exit 0 + api_sha != TARGET_SHA → WRAPPER_ERROR (exit0_inconsistent)", () => {
    const r = runWrapper(makeValidJson("b".repeat(40)), "0", "a".repeat(40));
    expect(r.hasWrapperError).toBe(true);
    expect(r.errorDetail).toBe("exit0_inconsistent");
  });

  it("exit 0 + category != none → WRAPPER_ERROR (exit0_inconsistent)", () => {
    const json = JSON.stringify({
      verified: "true",
      reason: "valid",
      verified_at: "2026-07-13T10:00:00Z",
      api_sha: "a".repeat(40),
      error_category: "GITHUB_SIGNATURE_SOMETHING",
      attempts: "1",
    });
    const r = runWrapper(json, "0");
    expect(r.hasWrapperError).toBe(true);
    expect(r.errorDetail).toBe("exit0_inconsistent");
  });

  it("exit 0 + verified_at empty → WRAPPER_ERROR (exit0_inconsistent)", () => {
    const json = JSON.stringify({
      verified: "true",
      reason: "valid",
      verified_at: "",
      api_sha: "a".repeat(40),
      error_category: "none",
      attempts: "1",
    });
    const r = runWrapper(json, "0");
    expect(r.hasWrapperError).toBe(true);
    expect(r.errorDetail).toBe("exit0_inconsistent");
  });
});

// ─── Failure cases: exit non-zero inconsistency ─────────────────────────

describe("R169 SIG Phase B wrapper — exit non-zero inconsistency", () => {
  it("exit 1 + verified=true → WRAPPER_ERROR (exit_nonzero_but_verified_true)", () => {
    const r = runWrapper(makeValidJson(), "1");
    expect(r.hasWrapperError).toBe(true);
    expect(r.errorDetail).toBe("exit_nonzero_but_verified_true");
  });
});
