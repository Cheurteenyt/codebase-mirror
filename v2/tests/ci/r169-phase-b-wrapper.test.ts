/**
 * R169 SIG Phase B — Wrapper validation tests.
 *
 * These tests verify the fail-closed JSON wrapper logic that the workflow
 * uses to validate the verifier script's output. The wrapper is extracted
 * as a standalone Python script so it can be tested in isolation.
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
 *   - exit 1 + valid diagnostic JSON → diagnostics published, then failure
 *   - exit 1 + verified=true → failure (inconsistent)
 *   - exit 0 + reason != valid → failure
 *   - exit 0 + verified_at empty → failure
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..", "..");

// The wrapper validation Python code, extracted from the workflow YAML.
// This is the EXACT same logic that runs in the GitHub Actions step.
const WRAPPER_PYTHON = `
import json
import os
import sys

path = os.environ["OUTPUT_FILE"]
target = os.environ["TARGET_SHA"]
script_exit = os.environ["SCRIPT_EXIT"]

try:
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
except Exception:
    print("WRAPPER_ERROR|malformed_json")
    sys.exit(0)

# Exact key set — no missing, no extra
required = {
    "verified",
    "reason",
    "verified_at",
    "api_sha",
    "error_category",
    "attempts",
}
if set(d.keys()) != required:
    print("WRAPPER_ERROR|invalid_keys")
    sys.exit(0)

# Reject multiline values
for key, value in d.items():
    if "\\n" in str(value) or "\\r" in str(value):
        print("WRAPPER_ERROR|multiline_value")
        sys.exit(0)

# Validate attempts is an integer
try:
    int(d["attempts"])
except (ValueError, TypeError):
    print("WRAPPER_ERROR|attempts_not_int")
    sys.exit(0)

# If script exit 0, outputs must be consistent with success
if script_exit == "0":
    if not (
        d["verified"] == "true"
        and d["reason"] == "valid"
        and d["verified_at"]
        and d["api_sha"] == target
        and d["error_category"] == "none"
    ):
        print("WRAPPER_ERROR|exit0_inconsistent")
        sys.exit(0)

# If script exit != 0, verified must not be "true"
if script_exit != "0" and d["verified"] == "true":
    print("WRAPPER_ERROR|exit_nonzero_but_verified_true")
    sys.exit(0)

# All checks passed — emit key=value pairs for GITHUB_OUTPUT
for key, value in d.items():
    print(f"{key}={value}")
`;

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

function makeValidJson(sha: string = "a".repeat(40)): string {
  return JSON.stringify({
    verified: "true",
    reason: "valid",
    verified_at: "2026-07-13T10:00:00Z",
    api_sha: sha,
    error_category: "none",
    attempts: "1",
  });
}

function makeRefusalJson(reason: string, sha: string = "a".repeat(40)): string {
  return JSON.stringify({
    verified: "false",
    reason,
    verified_at: "",
    api_sha: sha,
    error_category: `GITHUB_SIGNATURE_${reason.toUpperCase()}`,
    attempts: "1",
  });
}

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
    // Pass null to skip writing the file
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
      // attempts missing
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

// ─── Failure cases: attempts not integer ────────────────────────────────

describe("R169 SIG Phase B wrapper — attempts validation", () => {
  it("exit 0 + attempts not int → WRAPPER_ERROR (attempts_not_int)", () => {
    const json = JSON.stringify({
      verified: "true",
      reason: "valid",
      verified_at: "2026-07-13T10:00:00Z",
      api_sha: "a".repeat(40),
      error_category: "none",
      attempts: "not-a-number",
    });
    const r = runWrapper(json, "0");
    expect(r.hasWrapperError).toBe(true);
    expect(r.errorDetail).toBe("attempts_not_int");
  });
});

// ─── Failure cases: exit 0 inconsistency ────────────────────────────────

describe("R169 SIG Phase B wrapper — exit 0 inconsistency", () => {
  it("exit 0 + verified=false → WRAPPER_ERROR (exit0_inconsistent)", () => {
    const json = JSON.stringify({
      verified: "false",
      reason: "unsigned",
      verified_at: "",
      api_sha: "a".repeat(40),
      error_category: "GITHUB_SIGNATURE_UNSIGNED",
      attempts: "1",
    });
    const r = runWrapper(json, "0");
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
    const json = makeValidJson("b".repeat(40)); // different SHA
    const r = runWrapper(json, "0", "a".repeat(40)); // target is a*40
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
    const json = JSON.stringify({
      verified: "true",
      reason: "valid",
      verified_at: "2026-07-13T10:00:00Z",
      api_sha: "a".repeat(40),
      error_category: "none",
      attempts: "1",
    });
    const r = runWrapper(json, "1");
    expect(r.hasWrapperError).toBe(true);
    expect(r.errorDetail).toBe("exit_nonzero_but_verified_true");
  });
});
