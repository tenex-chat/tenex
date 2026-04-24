#!/usr/bin/env bash
# TENEX e2e scenario bootstrap.
#
# Source this BEFORE scripts/e2e-test-harness.sh in every scenario:
#
#   repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
#   source "$repo_root/scripts/e2e/_bootstrap.sh"
#   source "$repo_root/scripts/e2e-test-harness.sh"
#
# Responsibilities:
#   1. Resolve HARNESS_RELAY_BIN portably (env > PATH > historical default).
#   2. Export emit_result() so scenarios can emit a single machine-parseable
#      status line that scripts/e2e/run.sh picks up.
#   3. Export with_scenario_timeout() so scenarios can wrap long sequences in
#      a hard wall-clock bound.
#
# This file never edits scripts/e2e-test-harness.sh; it only pre-exports the
# variables that the harness reads on source.

# Guard against double-source.
if [[ -n "${_TENEX_E2E_BOOTSTRAP_LOADED:-}" ]]; then
  return 0 2>/dev/null || exit 0
fi
_TENEX_E2E_BOOTSTRAP_LOADED=1

# --- Logging primitives (mirror the harness for consistency) -----------------

_bootstrap_log() { printf '[bootstrap] %s\n' "$*" >&2; }
_bootstrap_die() { _bootstrap_log "FATAL: $*"; exit 1; }

# --- Relay binary resolution -------------------------------------------------

# Historical default used by existing scenarios. Kept only as the last-resort
# fallback so new machines/CI see a helpful error instead of a silent miss.
_TENEX_RELAY_HISTORICAL_DEFAULT="/Users/pablofernandez/Work/tenex-launcher/relay/tenex-relay"

_resolve_relay_bin() {
  local candidate

  if [[ -n "${HARNESS_RELAY_BIN:-}" ]]; then
    if [[ -x "$HARNESS_RELAY_BIN" ]]; then
      return 0
    fi
    _bootstrap_die "HARNESS_RELAY_BIN is set to '$HARNESS_RELAY_BIN' but that path is not executable"
  fi

  if candidate="$(command -v tenex-relay 2>/dev/null)" && [[ -n "$candidate" && -x "$candidate" ]]; then
    HARNESS_RELAY_BIN="$candidate"
    return 0
  fi

  if [[ -x "$_TENEX_RELAY_HISTORICAL_DEFAULT" ]]; then
    HARNESS_RELAY_BIN="$_TENEX_RELAY_HISTORICAL_DEFAULT"
    return 0
  fi

  _bootstrap_die "tenex-relay not found.
  Set HARNESS_RELAY_BIN=/path/to/tenex-relay, or put 'tenex-relay' on PATH.
  To build locally: cd \$TENEX_LAUNCHER_REPO/relay && go build -o tenex-relay ."
}

_resolve_relay_bin
export HARNESS_RELAY_BIN

# --- Scenario result emission -----------------------------------------------

# emit_result <status> [detail]
#   status: one of pass | fail | skip | phase_partial | unknown
#   detail: free-form one-liner (no newlines)
#
# Prints a single parseable line to stdout. run.sh parses the LAST such line.
emit_result() {
  local status="${1:-unknown}"
  local detail="${2:-}"
  local scenario
  scenario="$(basename "${BASH_SOURCE[1]:-${0}}")"
  case "$status" in
    pass|fail|skip|phase_partial|unknown) ;;
    *)
      _bootstrap_log "emit_result: invalid status '$status' (expected pass|fail|skip|phase_partial|unknown)"
      status="unknown"
      ;;
  esac
  # Strip newlines from detail; the line must stay parseable.
  detail="${detail//$'\n'/ }"
  printf '[harness] RESULT status=%s scenario=%s detail=%s\n' "$status" "$scenario" "$detail"
}
export -f emit_result

# --- Scenario timeout wrapper ------------------------------------------------

# with_scenario_timeout <seconds> <command...>
#   Runs the command under `timeout`. Returns 124 on trip (bash/GNU convention).
#   Uses `gtimeout` on macOS if `timeout` isn't present (coreutils via brew).
with_scenario_timeout() {
  local seconds="${1:?seconds required}"; shift
  [[ $# -gt 0 ]] || _bootstrap_die "with_scenario_timeout: command required"

  local timeout_bin
  if command -v timeout >/dev/null 2>&1; then
    timeout_bin="timeout"
  elif command -v gtimeout >/dev/null 2>&1; then
    timeout_bin="gtimeout"
  else
    _bootstrap_die "neither 'timeout' nor 'gtimeout' on PATH (install coreutils on macOS: brew install coreutils)"
  fi

  "$timeout_bin" --preserve-status "$seconds" "$@"
}
export -f with_scenario_timeout
