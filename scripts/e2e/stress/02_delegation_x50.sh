#!/usr/bin/env bash
# Stress harness for scenario 02 (delegation A -> B -> A, mock-LLM fixture).
#
# Runs scripts/e2e/scenarios/02_delegation_a_to_b_to_a.sh consecutively
# `RUNS` times (default 50), captures per-run timing and status, preserves
# artifacts for any failed run, and emits a final summary JSON on stdout.
#
# Exit code: 0 iff all runs passed.

set -uo pipefail

# --- Paths -------------------------------------------------------------------

stress_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$stress_dir/../../.." && pwd)"
scenario="$repo_root/scripts/e2e/scenarios/02_delegation_a_to_b_to_a.sh"
artifacts_root="$repo_root/artifacts/e2e/stress/02_delegation"
scenario_name="02_delegation_a_to_b_to_a.sh"

[[ -x "$scenario" || -f "$scenario" ]] || {
  printf 'scenario not found at %s\n' "$scenario" >&2
  exit 2
}

RUNS="${RUNS:-50}"
if ! [[ "$RUNS" =~ ^[1-9][0-9]*$ ]]; then
  printf 'invalid RUNS value: %s\n' "$RUNS" >&2
  exit 2
fi

mkdir -p "$artifacts_root"
staging_dir="$(mktemp -d)"
trap 'rm -rf "$staging_dir"' EXIT

# --- Build daemon once (no forced rebuild between iterations) ---------------

daemon_bin="$repo_root/target/release/daemon"
if [[ ! -x "$daemon_bin" ]]; then
  printf '[stress] daemon binary missing at %s — building once...\n' "$daemon_bin" >&2
  if ! ( cd "$repo_root" && cargo build -p tenex-daemon --release ); then
    printf '[stress] cargo build failed\n' >&2
    exit 3
  fi
else
  printf '[stress] daemon binary present at %s (skipping build)\n' "$daemon_bin" >&2
fi

# --- Per-run loop ------------------------------------------------------------

pass_count=0
fail_count=0
total_duration=0
min_duration=""
max_duration=0
durations=()
failures_json="[]"

stress_started_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '[stress] starting %d runs of %s at %s\n' \
  "$RUNS" "$scenario_name" "$stress_started_iso" >&2

for (( idx=1; idx<=RUNS; idx++ )); do
  run_log="$staging_dir/run-${idx}.log"
  t0="$(date +%s)"
  bash "$scenario" >"$run_log" 2>&1
  exit_code=$?
  t1="$(date +%s)"
  duration=$(( t1 - t0 ))

  durations+=("$duration")
  total_duration=$(( total_duration + duration ))
  if [[ -z "$min_duration" || "$duration" -lt "$min_duration" ]]; then
    min_duration="$duration"
  fi
  if [[ "$duration" -gt "$max_duration" ]]; then
    max_duration="$duration"
  fi

  # Extract any [harness] FATAL lines for concise failure reason.
  fatal_lines="$(grep -E '^\[harness\] FATAL' "$run_log" 2>/dev/null | head -5 || true)"
  # Also capture the last assert line from the scenario for context.
  assert_line="$(grep -E 'ASSERT' "$run_log" 2>/dev/null | tail -1 || true)"
  # Parse the scenario's fixture_root so we can preserve the daemon log + RAL
  # journal on failure (the scenario emits one line: "[scenario] fixture_root=<p>").
  fixture_root="$(grep -E '^\[scenario\] fixture_root=' "$run_log" 2>/dev/null \
    | head -1 | sed -n 's/^\[scenario\] fixture_root=\(.*\)$/\1/p' || true)"

  if [[ "$exit_code" -eq 0 ]]; then
    pass_count=$(( pass_count + 1 ))
    printf '[stress] run %3d/%d: PASS (%ds)\n' "$idx" "$RUNS" "$duration" >&2
  else
    fail_count=$(( fail_count + 1 ))
    reason="exit_code=$exit_code"
    if [[ -n "$fatal_lines" ]]; then
      reason="$(printf '%s' "$fatal_lines" | head -1)"
    elif [[ -n "$assert_line" ]]; then
      reason="$(printf '%s' "$assert_line" | head -1)"
    fi
    printf '[stress] run %3d/%d: FAIL (%ds) — %s\n' \
      "$idx" "$RUNS" "$duration" "$reason" >&2

    # Preserve artifacts for this failed run.
    run_artifacts="$artifacts_root/$idx"
    mkdir -p "$run_artifacts"
    cp "$run_log" "$run_artifacts/scenario.log" || true
    if [[ -n "$fixture_root" && -d "$fixture_root" ]]; then
      # Use tar to preserve the fixture_root verbatim (daemon log, RAL journal,
      # relay data, whitelist, dispatch queue, etc.).
      tar -C "$(dirname "$fixture_root")" -cf "$run_artifacts/fixture_root.tar" \
        "$(basename "$fixture_root")" 2>/dev/null || \
        printf '[stress]   WARN: failed to archive fixture_root=%s\n' \
          "$fixture_root" >&2
    fi
    # Append a JSON entry to the failures array.
    failures_json="$(jq -c \
      --argjson idx "$idx" \
      --arg reason "$reason" \
      --arg log "$run_artifacts/scenario.log" \
      --arg fixture "${fixture_root:-}" \
      --argjson exit_code "$exit_code" \
      '. + [{idx:$idx, exit_code:$exit_code, reason:$reason, log:$log, fixture_root:$fixture}]' \
      <<<"$failures_json")"
  fi
done

# --- Summary -----------------------------------------------------------------

stress_finished_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [[ "$RUNS" -gt 0 ]]; then
  # Integer mean; stress durations are seconds-resolution and we don't want
  # floating-point noise here.
  mean_duration=$(( total_duration / RUNS ))
else
  mean_duration=0
fi

summary="$(jq -n \
  --arg scenario "$scenario_name" \
  --argjson runs "$RUNS" \
  --argjson pass "$pass_count" \
  --argjson fail "$fail_count" \
  --argjson total_s "$total_duration" \
  --argjson min_s "${min_duration:-0}" \
  --argjson max_s "$max_duration" \
  --argjson mean_s "$mean_duration" \
  --arg started "$stress_started_iso" \
  --arg finished "$stress_finished_iso" \
  --argjson failures "$failures_json" \
  '{scenario:$scenario, runs:$runs, pass:$pass, fail:$fail,
    total_duration_s:$total_s, min_s:$min_s, max_s:$max_s, mean_s:$mean_s,
    started:$started, finished:$finished, failures:$failures}')"

# Summary JSON on stdout (the deliverable).
printf '%s\n' "$summary"

# Human-readable line on stderr.
printf '[stress] DONE %d runs: pass=%d fail=%d min=%ds max=%ds mean=%ds total=%ds\n' \
  "$RUNS" "$pass_count" "$fail_count" \
  "${min_duration:-0}" "$max_duration" "$mean_duration" "$total_duration" >&2

if [[ "$pass_count" -eq "$RUNS" ]]; then
  exit 0
fi
exit 1
