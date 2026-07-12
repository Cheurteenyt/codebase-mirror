/**
 * R169 SIG — Source inspection tests for the signature gate (Phase A).
 *
 * Phase A: The canonical verifier script exists with full runtime tests,
 * but the mirror workflow does NOT yet activate the gate. This is a
 * deliberate 2-phase bootstrap (SIG-R3-TRUST-01):
 *   - Phase A (this PR): publish script + tests + docs
 *   - Phase B (next PR): activate gate with ref=<Phase A squash SHA>
 *
 * These tests verify the STRUCTURE of the canonical verifier script.
 * Runtime behavioral tests are in r169-signature-runtime.test.ts.
 *
 * SIG-R169-TOKEN-01: Anti-leak test uses negative fixtures.
 * SIG-R169-TEST-01: Executable-bit test checks Unix mode.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const SCRIPT_PATH = join(REPO_ROOT, "scripts", "ci", "verify-github-commit-signature.sh");

function readScript(): string {
  return readFileSync(SCRIPT_PATH, "utf-8");
}

function readWorkflow(name: string): string {
  const path = join(REPO_ROOT, ".github", "workflows", name);
  return existsSync(path) ? readFileSync(path, "utf-8") : "";
}

// ─── Token leak detection (SIG-R169-TOKEN-01) ───────────────────────────

function isDangerousLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) return false;
  if (/^\s*set\s+-[a-zA-Z]*x/.test(line)) return true;
  if (/^\s*env\s*$/.test(trimmed) || /^\s*env\s*\|/.test(trimmed)) return true;
  if (/^\s*printenv\b/.test(trimmed)) return true;
  if (/^\s*(echo|printf)\b/.test(trimmed) && /\$GITHUB_TOKEN\b/.test(line)) {
    return true;
  }
  return false;
}

// ─── Script structure tests ─────────────────────────────────────────────

describe("R169 SIG — script structure", () => {
  it("script exists and is executable (SIG-R169-TEST-01)", () => {
    expect(existsSync(SCRIPT_PATH)).toBe(true);
    const mode = statSync(SCRIPT_PATH).mode;
    expect(mode & 0o111).not.toBe(0);
  });

  it("script contains all 11 error categories", () => {
    const script = readScript();
    const categories = [
      "GITHUB_SIGNATURE_CONFIG_ERROR",
      "GITHUB_SIGNATURE_API_NETWORK_ERROR",
      "GITHUB_SIGNATURE_API_HTTP_ERROR",
      "GITHUB_SIGNATURE_API_RATE_LIMITED",
      "GITHUB_SIGNATURE_API_MALFORMED_JSON",
      "GITHUB_SIGNATURE_API_SCHEMA_ERROR",
      "GITHUB_SIGNATURE_SHA_MISMATCH",
      "GITHUB_SIGNATURE_UNSIGNED",
      "GITHUB_SIGNATURE_INVALID",
      "GITHUB_SIGNATURE_UNVERIFIED",
      "GITHUB_SIGNATURE_TRANSIENT_VERIFIER_ERROR",
    ];
    for (const cat of categories) {
      expect(script).toContain(cat);
    }
  });

  it("script uses trap for output emission", () => {
    expect(readScript()).toContain("trap emit_final_outputs EXIT");
  });

  it("script has 3 attempts with backoff 1 and 2 (SIG-AUD-09)", () => {
    const script = readScript();
    expect(script).toContain("MAX_ATTEMPTS=3");
    expect(script).toContain("BACKOFF_DELAYS=(1 2)");
  });

  it("script has curl connect-timeout and max-time (SIG-AUD-08)", () => {
    const script = readScript();
    expect(script).toContain("--connect-timeout 10");
    expect(script).toContain("--max-time 30");
  });

  it("script checks 429 before generic 5xx (SIG-AUD-04)", () => {
    const script = readScript();
    const idx429 = script.indexOf('"429"');
    const idx500 = script.indexOf('"500"');
    expect(idx429).toBeGreaterThan(-1);
    expect(idx500).toBeGreaterThan(-1);
    expect(idx429).toBeLessThan(idx500);
  });

  it("script does not have dead is_retryable_reason function (SIG-AUD-12)", () => {
    expect(readScript()).not.toContain("is_retryable_reason");
  });

  it("script enforces GITHUB_ACTIONS + loopback in test mode (SIG-AUD-03)", () => {
    const script = readScript();
    expect(script).toContain("GITHUB_ACTIONS");
    expect(script).toContain("127.0.0.1");
    expect(script).toContain("localhost");
  });

  it("script writes JSON output (SIG-AUD-05)", () => {
    expect(readScript()).toContain("json.dump");
  });

  it("script sets verified to actual value not not-run (SIG-AUD-06)", () => {
    const script = readScript();
    expect(script).toContain('STATE_VERIFIED="$VERIFIED"');
  });

  it("script does strict type validation (SIG-AUD-07)", () => {
    const script = readScript();
    expect(script).toContain("isinstance(verified, bool)");
    expect(script).toContain("isinstance(reason, str)");
    expect(script).toContain("isinstance(verified_at, str)");
  });

  it("script validates verified_at as ISO-8601 WITH timezone on success (SIG-R3-TIME-01, SIG-R4-VERIFYAT-01)", () => {
    const script = readScript();
    expect(script).toContain("datetime.fromisoformat");
    expect(script).toContain("verified_at_format");
    expect(script).toContain("verified_at_timezone");
    expect(script).toContain("dt.tzinfo is None");
  });

  it("script allows null verified_at on refusal (SIG-R4-VERIFYAT-01)", () => {
    const script = readScript();
    // The parser must normalize null verified_at to '' on refusal paths
    expect(script).toContain("verified_at_success_required");
    expect(script).toContain("verified_at is None");
    expect(script).toContain("verified_at = ''");
  });

  it("script validates reason against official GitHub enum (SIG-R4-PARSER-01)", () => {
    const script = readScript();
    expect(script).toContain("GITHUB_REASONS");
    expect(script).toContain("reason_enum");
    // Check all 13 official reasons are in the enum
    const reasons = [
      "expired_key", "not_signing_key", "gpgverify_error",
      "gpgverify_unavailable", "unsigned", "unknown_signature_type",
      "no_user", "unverified_email", "bad_email", "unknown_key",
      "malformed_signature", "invalid", "valid",
    ];
    for (const r of reasons) {
      expect(script).toContain(`'${r}'`);
    }
  });

  it("script checks verified/reason coherence (SIG-R4-VERIFYAT-01)", () => {
    const script = readScript();
    expect(script).toContain("verified_true_reason_not_valid");
    expect(script).toContain("verified_false_reason_valid");
  });

  it("script uses env vars for JSON generation, not interpolation (SIG-R169-JSON-01)", () => {
    const script = readScript();
    expect(script).toContain("os.environ.get");
    expect(script).not.toContain("'github_signature_verified': '$STATE_VERIFIED'");
  });

  it("script has no key=value fallback (SIG-R169-JSON-02)", () => {
    const script = readScript();
    expect(script).not.toContain("printf 'github_signature_verified=");
    expect(script).not.toContain("printf 'github_signature_reason=");
    expect(script).not.toContain("printf 'github_signature_api_sha=");
    expect(script).toContain("no fallback (SIG-R169-JSON-02)");
  });

  it("script supports SIGNATURE_RETRY_DELAY_SCALE for tests (performance)", () => {
    const script = readScript();
    expect(script).toContain("SIGNATURE_RETRY_DELAY_SCALE");
    expect(script).toContain("maybe_sleep");
  });

  it("script validates SIGNATURE_RETRY_DELAY_SCALE (SIG-R3-RETRY-02)", () => {
    const script = readScript();
    expect(script).toContain("0|1)");
    expect(script).toContain("!= \"1\"");
  });

  it("script populates all state fields after parse (SIG-R169-DIAG-01)", () => {
    const script = readScript();
    expect(script).toContain('STATE_API_SHA="$API_SHA"');
    expect(script).toContain('STATE_REASON="$REASON"');
    expect(script).toContain('STATE_VERIFIED_AT="$VERIFIED_AT"');
    expect(script).toContain('STATE_VERIFIED="$VERIFIED"');
  });

  it("script does NOT retry malformed JSON (SIG-R3-RETRY-01)", () => {
    const script = readScript();
    expect(script).toContain("Malformed JSON (not retryable)");
    const malformedIdx = script.indexOf('"MALFORMED_JSON" ]; then');
    expect(malformedIdx).toBeGreaterThan(-1);
    const fiIdx = script.indexOf("fi", malformedIdx);
    const malformedBlock = script.substring(malformedIdx, fiIdx);
    expect(malformedBlock).not.toContain("continue");
    expect(malformedBlock).not.toContain("maybe_sleep");
  });

  it("script captures response headers for rate limit detection (SIG-R3-RATE-01, SIG-R4-RATE-01)", () => {
    const script = readScript();
    expect(script).toContain("--dump-header");
    expect(script).toContain("x-ratelimit-remaining");
    expect(script).toContain("secondary rate limit");
    expect(script).toContain("retry-after");
    expect(script).toContain("PRIMARY_EXHAUSTED");
    expect(script).toContain("RETRY_AFTER");
  });

  it("script has centralized HEADER_FILE cleanup in trap (SIG-R4-TEMP-01)", () => {
    const script = readScript();
    expect(script).toContain('HEADER_FILE=""');
    // The trap function should clean up HEADER_FILE — find the function body
    // by looking for the cleanup comment inside emit_final_outputs
    const trapIdx = script.indexOf("emit_final_outputs() {");
    expect(trapIdx).toBeGreaterThan(-1);
    // Look for HEADER_FILE cleanup within the first ~500 chars of the trap function
    const trapSection = script.substring(trapIdx, trapIdx + 600);
    expect(trapSection).toContain("HEADER_FILE");
    expect(trapSection).toContain("rm -f");
    expect(trapSection).toContain("SIG-R4-TEMP-01");
  });
});

// ─── Token leak detection (SIG-AUD-11, SIG-R169-TOKEN-01) ───────────────

describe("R169 SIG — token leak detection (SIG-R169-TOKEN-01)", () => {
  it("negative fixture: echo \"$GITHUB_TOKEN\" is detected as dangerous", () => {
    expect(isDangerousLine('echo "$GITHUB_TOKEN"')).toBe(true);
  });

  it("negative fixture: printf \"%s\" \"$GITHUB_TOKEN\" is detected", () => {
    expect(isDangerousLine('printf "%s" "$GITHUB_TOKEN"')).toBe(true);
  });

  it("negative fixture: set -x is detected", () => {
    expect(isDangerousLine("set -x")).toBe(true);
    expect(isDangerousLine("set -euox pipefail")).toBe(true);
  });

  it("negative fixture: env | sort is detected", () => {
    expect(isDangerousLine("env | sort")).toBe(true);
  });

  it("negative fixture: printenv is detected", () => {
    expect(isDangerousLine("printenv")).toBe(true);
    expect(isDangerousLine("printenv GITHUB_TOKEN")).toBe(true);
  });

  it("negative fixture: bare env is detected", () => {
    expect(isDangerousLine("env")).toBe(true);
  });

  it("safe line: echo \"GITHUB_TOKEN is not set\" is NOT dangerous", () => {
    expect(isDangerousLine('echo "::error::GITHUB_TOKEN is not set" >&2')).toBe(false);
  });

  it("safe line: Authorization: Bearer is NOT dangerous", () => {
    expect(isDangerousLine('-H "Authorization: Bearer $GITHUB_TOKEN"')).toBe(false);
  });

  it("safe line: presence check is NOT dangerous", () => {
    expect(isDangerousLine('if [ -z "${GITHUB_TOKEN:-}" ]; then')).toBe(false);
  });

  it("safe line: YAML env definition is NOT dangerous", () => {
    expect(isDangerousLine("          GITHUB_TOKEN: ${{ github.token }}")).toBe(false);
  });

  it("script has no dangerous lines", () => {
    const script = readScript();
    const lines = script.split("\n");
    const dangerous: string[] = [];
    for (const line of lines) {
      if (isDangerousLine(line)) {
        dangerous.push(line.trim());
      }
    }
    if (dangerous.length > 0) {
      expect.fail(`Dangerous lines found in script:\n${dangerous.join("\n")}`);
    }
  });
});

// ─── Phase A workflow state tests ───────────────────────────────────────

describe("R169 SIG — Phase A bootstrap (SIG-R3-TRUST-01)", () => {
  const workflow = readWorkflow("mirror-main-to-gitlab.yml");

  it("Phase A: workflow does NOT yet activate the signature gate", () => {
    // The gate is NOT active in Phase A. The workflow is in its pre-SIG-R169
    // state. Phase B will activate it with ref=<Phase A squash SHA>.
    expect(workflow).not.toContain("Verify GitHub commit signature");
    expect(workflow).not.toContain("verify-github-commit-signature.sh");
  });

  it("Phase A: workflow still has the basic mirror steps", () => {
    // The mirror workflow still functions normally without the gate
    expect(workflow).toContain("Validate event identity");
    expect(workflow).toContain("Checkout exact CI-validated SHA");
    expect(workflow).toContain("Materialize SSH key");
    expect(workflow).toContain("Run mirror state machine");
  });
});
