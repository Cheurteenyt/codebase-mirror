#!/usr/bin/env bash
#
# scripts/ci/verify-github-commit-signature.sh
#
# SIG-R169: Cross-host Signature Trust Gate — Canonical verifier.
#
# This script is the SINGLE source of truth for commit signature verification.
# The mirror workflow (.github/workflows/mirror-main-to-gitlab.yml) calls this
# script directly. Runtime tests (v2/tests/ci/r169-signature-runtime.test.ts)
# execute this same script against a local HTTP fixture server.
#
# Trust boundary (SIG-R169-POLICY-01):
#   - This script is loaded from a signed commit on the default branch.
#   - It verifies TARGET_SHA via the GitHub REST API.
#   - No checked-out repository code is executed before this gate.
#   - A GitHub "verified" badge proves cryptographic provenance, NOT code safety.
#   - The gate can still be modified by a future signed+merged PR; it is NOT
#     immutable. It protects against: unsigned pushes, invalid signatures, and
#     cryptographic identities GitHub does not recognize.
#
# Env vars:
#   TARGET_SHA (required)              — 40-char hex SHA to verify
#   GITHUB_API_URL (required)          — API base URL (https://api.github.com in prod)
#   GITHUB_REPOSITORY (required)       — owner/repo
#   GITHUB_TOKEN (required)            — API auth token
#   OUTPUT_FILE (optional)             — path to write JSON outputs
#   CBM_SIGNATURE_TEST_MODE (optional) — set to 1 for local test mode (loopback only)
#   SIGNATURE_RETRY_DELAY_SCALE (opt)  — multiplier for backoff (default 1; 0 = no sleep)
#
# Exit codes:
#   0 — signature verified (verified=true, reason=valid, verified_at=ISO, sha matches)
#   1 — verification failed (unsigned, invalid, SHA mismatch, HTTP error, etc.)
#   2 — configuration error
#
# JSON output format (written to OUTPUT_FILE if set):
#   {
#     "verified": "true|false|error|not-run",
#     "reason": "<GitHub reason string>",
#     "verified_at": "<ISO timestamp>",
#     "api_sha": "<40-char hex>",
#     "error_category": "<GITHUB_SIGNATURE_*>",
#     "attempts": "<integer as string>"
#   }
#
# No key=value fallback — if JSON cannot be written, the script exits with code 2.
#

set -euo pipefail

# ─── In-memory state (emitted once via trap as JSON — SIG-AUD-05) ────────
STATE_VERIFIED="not-run"
STATE_REASON=""
STATE_VERIFIED_AT=""
STATE_API_SHA=""
STATE_ERROR_CATEGORY="none"
STATE_ATTEMPTS="0"
OUTPUT_FILE="${OUTPUT_FILE:-}"
SIGNATURE_RETRY_DELAY_SCALE="${SIGNATURE_RETRY_DELAY_SCALE:-1}"
# SIG-R4-TEMP-01: Track temp file for centralized cleanup
HEADER_FILE=""

# ─── Output emission + cleanup ───────────────────────────────────────────
# SIG-R169-JSON-01: Values are passed via environment variables, NOT via
#   string interpolation into Python code. This prevents apostrophe/backslash
#   injection from breaking the JSON generator.
# SIG-R169-JSON-02: No key=value fallback. If JSON generation fails, the
#   script exits with code 2 (explicit failure, no silent degradation).
# SIG-R4-TEMP-01: HEADER_FILE cleanup is centralized in the trap to avoid
#   orphaned temp files on unexpected exits.
# shellcheck disable=SC2329 # Invoked via trap, not directly
emit_final_outputs() {
  local exit_code=$?
  # SIG-R4-TEMP-01: Clean up temp file before emitting outputs
  if [ -n "${HEADER_FILE:-}" ] && [ -f "$HEADER_FILE" ]; then
    rm -f "$HEADER_FILE" 2>/dev/null || true
  fi
  if [ -n "$OUTPUT_FILE" ]; then
    if ! STATE_VERIFIED="$STATE_VERIFIED" \
         STATE_REASON="$STATE_REASON" \
         STATE_VERIFIED_AT="$STATE_VERIFIED_AT" \
         STATE_API_SHA="$STATE_API_SHA" \
         STATE_ERROR_CATEGORY="$STATE_ERROR_CATEGORY" \
         STATE_ATTEMPTS="$STATE_ATTEMPTS" \
         OUTPUT_FILE="$OUTPUT_FILE" \
         python3 -c "
import json, os
data = {
    'verified': os.environ.get('STATE_VERIFIED', ''),
    'reason': os.environ.get('STATE_REASON', ''),
    'verified_at': os.environ.get('STATE_VERIFIED_AT', ''),
    'api_sha': os.environ.get('STATE_API_SHA', ''),
    'error_category': os.environ.get('STATE_ERROR_CATEGORY', ''),
    'attempts': os.environ.get('STATE_ATTEMPTS', '0'),
}
with open(os.environ['OUTPUT_FILE'], 'w') as f:
    json.dump(data, f, indent=2)
"; then
      echo "::error::Failed to write JSON output — no fallback (SIG-R169-JSON-02)" >&2
      exit_code=2
    fi
  fi
  exit "$exit_code"
}
trap emit_final_outputs EXIT

# ─── Configuration validation ───────────────────────────────────────────
if [ -z "${TARGET_SHA:-}" ]; then
  echo "::error::TARGET_SHA is not set" >&2
  STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_CONFIG_ERROR"
  exit 2
fi
if ! [[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::TARGET_SHA is not a valid 40-char hex SHA" >&2
  STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_CONFIG_ERROR"
  exit 2
fi
if [ -z "${GITHUB_API_URL:-}" ]; then
  echo "::error::GITHUB_API_URL is not set" >&2
  STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_CONFIG_ERROR"
  exit 2
fi
if [ -z "${GITHUB_REPOSITORY:-}" ]; then
  echo "::error::GITHUB_REPOSITORY is not set" >&2
  STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_CONFIG_ERROR"
  exit 2
fi
if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "::error::GITHUB_TOKEN is not set" >&2
  STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_CONFIG_ERROR"
  exit 2
fi

# ─── Test mode isolation (SIG-AUD-03) ────────────────────────────────────
# In test mode, only loopback URLs are allowed. This prevents accidental
# use of test mode against the real GitHub API.
CBM_SIGNATURE_TEST_MODE="${CBM_SIGNATURE_TEST_MODE:-}"
if [ "$CBM_SIGNATURE_TEST_MODE" = "1" ]; then
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    echo "::error::CBM_SIGNATURE_TEST_MODE not allowed when GITHUB_ACTIONS=true" >&2
    STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_CONFIG_ERROR"
    exit 2
  fi
  # shellcheck disable=SC2102 # [::1] is an IPv6 literal, not a range
  case "$GITHUB_API_URL" in
    http://127.0.0.1:*|http://localhost:*|http://[::1]:*) ;;
    *)
      echo "::error::Test mode requires loopback URL" >&2
      STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_CONFIG_ERROR"
      exit 2
      ;;
  esac
else
  if [ "$GITHUB_API_URL" != "https://api.github.com" ]; then
    echo "::error::GITHUB_API_URL must be https://api.github.com in production" >&2
    STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_CONFIG_ERROR"
    exit 2
  fi
fi

# ─── SIG-R3-RETRY-02: Validate SIGNATURE_RETRY_DELAY_SCALE ──────────────
# Production: must be exactly 1 (real backoff delays).
# Test mode (local only): may be 0 (no sleep) or 1.
# Any other value is rejected to prevent disabling backoff in production.
case "$SIGNATURE_RETRY_DELAY_SCALE" in
  0|1) ;;
  *)
    echo "::error::SIGNATURE_RETRY_DELAY_SCALE must be 0 or 1, got: $SIGNATURE_RETRY_DELAY_SCALE" >&2
    STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_CONFIG_ERROR"
    exit 2
    ;;
esac
if [ "$CBM_SIGNATURE_TEST_MODE" != "1" ] && [ "$SIGNATURE_RETRY_DELAY_SCALE" != "1" ]; then
  echo "::error::SIGNATURE_RETRY_DELAY_SCALE != 1 not allowed in production" >&2
  STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_CONFIG_ERROR"
  exit 2
fi

echo "=== GitHub Commit Signature Verification ==="
echo "Target SHA: $TARGET_SHA"
echo "Repository: $GITHUB_REPOSITORY"
echo "API URL: $GITHUB_API_URL"
echo "Retry delay scale: $SIGNATURE_RETRY_DELAY_SCALE"
echo ""

# ─── Retry loop (SIG-AUD-08/09: 3 attempts, backoff 1s/2s) ───────────────
MAX_ATTEMPTS=3
BACKOFF_DELAYS=(1 2)

# Scaled sleep — SIG-R3-RETRY-02: only 0 or 1 allowed, no awk needed
maybe_sleep() {
  local delay="$1"
  if [ "$SIGNATURE_RETRY_DELAY_SCALE" = "0" ]; then
    return 0
  fi
  sleep "$delay"
}

for attempt in $(seq 1 $MAX_ATTEMPTS); do
  STATE_ATTEMPTS="$attempt"
  echo "--- Attempt $attempt/$MAX_ATTEMPTS ---"

  # SIG-AUD-08: curl with connect-timeout and max-time
  # SIG-R3-RATE-01: Capture response headers to detect 403 rate limits
  HEADER_FILE=$(mktemp)
  HTTP_RESPONSE=$(curl \
    --connect-timeout 10 \
    --max-time 30 \
    --show-error \
    --silent \
    --dump-header "$HEADER_FILE" \
    -w "\n%{http_code}" \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2026-03-10" \
    "${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/commits/${TARGET_SHA}" 2>&1) || {
    STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_API_NETWORK_ERROR"
    echo "::error::Network error" >&2
    # SIG-R4-TEMP-01: HEADER_FILE cleanup is centralized in the trap
    if [ -n "${HEADER_FILE:-}" ] && [ -f "$HEADER_FILE" ]; then
      rm -f "$HEADER_FILE" 2>/dev/null || true
    fi
    HEADER_FILE=""
    if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
      echo "  Retrying in ${BACKOFF_DELAYS[$((attempt-1))]}s..."
      maybe_sleep "${BACKOFF_DELAYS[$((attempt-1))]}"
      continue
    fi
    exit 1
  }

  HTTP_BODY=$(echo "$HTTP_RESPONSE" | sed '$d')
  HTTP_STATUS=$(echo "$HTTP_RESPONSE" | tail -1)
  echo "  HTTP status: $HTTP_STATUS"

  if [ "$HTTP_STATUS" != "200" ]; then
    # SIG-R3-RATE-01 + SIG-R4-RATE-01: GitHub rate limit detection.
    #   - HTTP 429: primary rate limit
    #   - HTTP 403 + x-ratelimit-remaining: 0: primary rate limit (exhausted)
    #   - HTTP 403 + body contains 'secondary rate limit'
    # NOTE: grep returns exit 1 when no match — use || true to avoid
    # set -e + pipefail killing the script on non-rate-limit responses.
    RATE_LIMITED=false
    PRIMARY_EXHAUSTED=false
    RETRY_AFTER=""
    if [ -f "$HEADER_FILE" ]; then
      RL_REMAINING=$(grep -i '^x-ratelimit-remaining:' "$HEADER_FILE" 2>/dev/null | tr -d '\r' | awk '{print $2}' || true)
      if [ "$HTTP_STATUS" = "403" ] && [ "$RL_REMAINING" = "0" ]; then
        RATE_LIMITED=true
        PRIMARY_EXHAUSTED=true
      fi
      # Secondary rate limits are 403 with a specific message in the body
      if [ "$HTTP_STATUS" = "403" ] && echo "$HTTP_BODY" | grep -qi 'secondary rate limit' 2>/dev/null; then
        RATE_LIMITED=true
      fi
      # Capture Retry-After header (seconds) for 429 and secondary rate limits
      RETRY_AFTER=$(grep -i '^retry-after:' "$HEADER_FILE" 2>/dev/null | tr -d '\r' | awk '{print $2}' || true)
    fi
    # SIG-R4-TEMP-01: cleanup is centralized in the trap. Clear the variable
    # so the trap knows we've already processed this file's headers.
    HEADER_FILE=""

    # SIG-AUD-04 + SIG-R3-RATE-01 + SIG-R4-RATE-01:
    # Rate limit handling with smart retry policy.
    if [ "$HTTP_STATUS" = "429" ] || [ "$RATE_LIMITED" = "true" ]; then
      STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_API_RATE_LIMITED"
      echo "::error::HTTP $HTTP_STATUS — rate limited" >&2

      # SIG-R4-RATE-01: 403 + remaining=0 (primary exhausted) → fail closed.
      # Retrying with 1s/2s backoff won't succeed before the reset window.
      if [ "$PRIMARY_EXHAUSTED" = "true" ]; then
        echo "  Primary rate limit exhausted (remaining=0) — fail closed, re-run later" >&2
        exit 1
      fi

      # SIG-R4-RATE-01: For 429/secondary, honor Retry-After if present and <= 10s.
      # If Retry-After > 10s or absent, use default backoff (or fail if last attempt).
      if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
        if [ -n "$RETRY_AFTER" ] && [ "$RETRY_AFTER" -le 10 ] 2>/dev/null; then
          echo "  Retry-After: ${RETRY_AFTER}s — honoring" >&2
          maybe_sleep "$RETRY_AFTER"
          continue
        elif [ -z "$RETRY_AFTER" ]; then
          # No Retry-After header — use default backoff
          echo "  Retrying in ${BACKOFF_DELAYS[$((attempt-1))]}s..." >&2
          maybe_sleep "${BACKOFF_DELAYS[$((attempt-1))]}"
          continue
        else
          echo "  Retry-After: ${RETRY_AFTER}s > 10s — fail closed" >&2
          exit 1
        fi
      fi
      exit 1
    elif [ "$HTTP_STATUS" = "500" ] || [ "$HTTP_STATUS" = "502" ] || \
         [ "$HTTP_STATUS" = "503" ] || [ "$HTTP_STATUS" = "504" ]; then
      STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_API_HTTP_ERROR"
      echo "::error::HTTP $HTTP_STATUS (retryable)" >&2
      if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
        echo "  Retrying in ${BACKOFF_DELAYS[$((attempt-1))]}s..."
        maybe_sleep "${BACKOFF_DELAYS[$((attempt-1))]}"
        continue
      fi
      exit 1
    elif [ "$HTTP_STATUS" = "401" ]; then
      STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_API_HTTP_ERROR"
      echo "::error::HTTP 401 — auth failed" >&2
      exit 1
    elif [ "$HTTP_STATUS" = "404" ]; then
      STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_API_HTTP_ERROR"
      echo "::error::HTTP 404 — not found" >&2
      exit 1
    else
      STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_API_HTTP_ERROR"
      echo "::error::HTTP $HTTP_STATUS" >&2
      exit 1
    fi
  fi

  # SIG-AUD-07 + SIG-R169-SCHEMA-01 + SIG-R4-VERIFYAT-01 + SIG-R4-PARSER-01:
  # Strict JSON parsing respecting the REAL GitHub API contract.
  #
  # Contract:
  #   - sha: always a 40-char hex string
  #   - verification: always an object
  #   - verified: always a bool
  #   - reason: always a string from the official GitHub enum
  #   - verified_at: ISO-8601+tz string on success (verified=true, reason=valid);
  #                   may be null on refusal (verified=false, reason!=valid)
  #
  # Incoherent states (→ SCHEMA_ERROR):
  #   - verified=true + reason!=valid
  #   - verified=false + reason=valid
  #   - verified=true + reason=valid + verified_at null/not-ISO/no-tz
  #   - reason not in official enum
  PARSE_RESULT=$(echo "$HTTP_BODY" | python3 -c "
import json, sys, re
from datetime import datetime
try:
    d = json.load(sys.stdin)
except Exception:
    print('MALFORMED_JSON')
    sys.exit(0)
sha = d.get('sha')
if not isinstance(sha, str) or not re.match(r'^[0-9a-f]{40}\$', sha):
    print('SCHEMA_ERROR|sha')
    sys.exit(0)
v = d.get('commit', {}).get('verification')
if not isinstance(v, dict):
    print('SCHEMA_ERROR|verification')
    sys.exit(0)
verified = v.get('verified')
if not isinstance(verified, bool):
    print('SCHEMA_ERROR|verified_type')
    sys.exit(0)
reason = v.get('reason')
if not isinstance(reason, str) or not reason:
    print('SCHEMA_ERROR|reason')
    sys.exit(0)
# SIG-R4-PARSER-01: Validate reason against the official GitHub enum.
# This prevents arbitrary strings from reaching the shell pipe parser.
GITHUB_REASONS = {
    'expired_key', 'not_signing_key', 'gpgverify_error',
    'gpgverify_unavailable', 'unsigned', 'unknown_signature_type',
    'no_user', 'unverified_email', 'bad_email', 'unknown_key',
    'malformed_signature', 'invalid', 'valid',
}
if reason not in GITHUB_REASONS:
    print('SCHEMA_ERROR|reason_enum')
    sys.exit(0)
# SIG-R4-VERIFYAT-01: Check verified/reason coherence.
if verified and reason != 'valid':
    print('SCHEMA_ERROR|verified_true_reason_not_valid')
    sys.exit(0)
if not verified and reason == 'valid':
    print('SCHEMA_ERROR|verified_false_reason_valid')
    sys.exit(0)
verified_at = v.get('verified_at')
# On success: verified_at must be an ISO-8601 string WITH timezone.
# On refusal: verified_at may be null (or a string); normalize null to ''.
if verified and reason == 'valid':
    if not isinstance(verified_at, str) or not verified_at:
        print('SCHEMA_ERROR|verified_at_success_required')
        sys.exit(0)
    try:
        dt = datetime.fromisoformat(verified_at.replace('Z', '+00:00'))
        if dt.tzinfo is None or dt.utcoffset() is None:
            print('SCHEMA_ERROR|verified_at_timezone')
            sys.exit(0)
    except Exception:
        print('SCHEMA_ERROR|verified_at_format')
        sys.exit(0)
else:
    # Refusal: normalize null/None to empty string for the output JSON.
    if verified_at is None:
        verified_at = ''
    elif not isinstance(verified_at, str):
        print('SCHEMA_ERROR|verified_at_type')
        sys.exit(0)
print(f'{sha}|{str(verified).lower()}|{reason}|{verified_at}')
" 2>/dev/null)

  # SIG-R3-RETRY-01: Malformed JSON is a contract violation, NOT a transient
  # error. Fail immediately (no retry). Same for schema errors.
  if [ "$PARSE_RESULT" = "MALFORMED_JSON" ]; then
    STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_API_MALFORMED_JSON"
    echo "::error::Malformed JSON (not retryable)" >&2
    exit 1
  fi

  if echo "$PARSE_RESULT" | grep -q "^SCHEMA_ERROR"; then
    STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_API_SCHEMA_ERROR"
    echo "::error::Schema error: $(echo "$PARSE_RESULT" | cut -d'|' -f2)" >&2
    exit 1
  fi

  API_SHA=$(echo "$PARSE_RESULT" | cut -d'|' -f1)
  VERIFIED=$(echo "$PARSE_RESULT" | cut -d'|' -f2)
  REASON=$(echo "$PARSE_RESULT" | cut -d'|' -f3)
  VERIFIED_AT=$(echo "$PARSE_RESULT" | cut -d'|' -f4)

  # SIG-R169-DIAG-01: Always populate ALL state fields after successful parse,
  # even on refusal paths. This ensures the summary has complete diagnostics.
  STATE_API_SHA="$API_SHA"
  STATE_REASON="$REASON"
  STATE_VERIFIED_AT="$VERIFIED_AT"
  # SIG-AUD-06: Set verified to the actual API value (not "not-run")
  STATE_VERIFIED="$VERIFIED"

  echo "  API SHA: $API_SHA"
  echo "  Verified: $VERIFIED"
  echo "  Reason: $REASON"

  if [ "$API_SHA" != "$TARGET_SHA" ]; then
    STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_SHA_MISMATCH"
    echo "::error::SHA mismatch: API=$API_SHA, target=$TARGET_SHA" >&2
    exit 1
  fi

  if [ "$VERIFIED" = "true" ] && [ "$REASON" = "valid" ] && [ -n "$VERIFIED_AT" ]; then
    STATE_ERROR_CATEGORY="none"
    echo "✓ Signature verified"
    exit 0
  fi

  # Map reason to error category
  case "$REASON" in
    unsigned)
      STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_UNSIGNED" ;;
    invalid|malformed_signature)
      STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_INVALID" ;;
    gpgverify_error|gpgverify_unavailable)
      STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_TRANSIENT_VERIFIER_ERROR"
      if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
        echo "  Retrying in ${BACKOFF_DELAYS[$((attempt-1))]}s..."
        maybe_sleep "${BACKOFF_DELAYS[$((attempt-1))]}"
        continue
      fi
      ;;
    *)
      STATE_ERROR_CATEGORY="GITHUB_SIGNATURE_UNVERIFIED" ;;
  esac

  echo "::error::Verification failed: $STATE_ERROR_CATEGORY (reason=$REASON)" >&2
  exit 1

done

echo "::error::Exhausted $MAX_ATTEMPTS attempts" >&2
exit 1
