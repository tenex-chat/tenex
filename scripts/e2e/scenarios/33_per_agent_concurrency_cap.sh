#!/usr/bin/env bash
# E2E scenario 3.3 — Per-agent concurrency cap.
#
# Validates the daemon's per-agent admission plan (
# crates/tenex-daemon/src/worker_concurrency.rs:139):
#   When limits.per_agent is Some(N) and the active execution count for
#   (project_id, agent_pubkey) is already >= N, plan_worker_concurrency
#   returns WorkerConcurrencyDecision::Blocked with
#   WorkerConcurrencyBlockReason::AgentLimitReached.
#
# IMPORTANT CAVEAT about production wiring:
#   The daemon binary (crates/tenex-daemon/src/bin/daemon.rs:782-784) wires
#   WorkerConcurrencyLimits with per_project = None and per_agent = None;
#   only `global` is exposed via --max-concurrent-workers. There is no CLI
#   knob to set per_agent on a live daemon. To observe AgentLimitReached in
#   a live daemon would require either (a) adding a CLI flag to wire
#   per_agent through, or (b) constructing a worker fleet that saturates one
#   agent without saturating global — not possible without running real
#   workers (which requires Ollama).
#
# Approach: compile-and-run the release-profile unit tests in
# `worker_concurrency.rs`. These drive `plan_worker_concurrency` directly
# with the exact structures the daemon uses at admission time. It is the
# highest-fidelity, LLM-free verification of the per-agent rejection path
# this branch currently supports. If a CLI knob is added later this script
# should be extended with a live-daemon phase.
#
# Scenarios covered by the unit tests invoked:
#   - blocks_when_agent_limit_is_saturated
#       (per_agent: Some(2) saturated → AgentLimitReached)
#   - treats_none_limits_as_unlimited_and_zero_as_block_all
#       (per_agent: None → unlimited; global: Some(0) → blocks all)
#   - allows_start_when_counts_are_below_limits
#       (counts fully admit when under cap)
#
# No LLM required. No relay required.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

cd "$repo_root"

echo "[scenario] running crate-local unit tests for per-agent admission..."

log_file="/tmp/tenex-e2e-33-$$.log"
: > "$log_file"
trap 'rm -f "$log_file"' EXIT

# cargo test accepts only one positional filter. Run each test by filter and
# confirm it passes. Using --release ensures we test the same build profile
# the live daemon uses.
for test_name in \
    blocks_when_agent_limit_is_saturated \
    allows_start_when_counts_are_below_limits \
    treats_none_limits_as_unlimited_and_zero_as_block_all; do
  echo "[scenario]   running $test_name"
  if ! cargo test --release -p tenex-daemon --lib "$test_name" -- --nocapture \
       >> "$log_file" 2>&1; then
    echo "[scenario] FAIL — cargo test for $test_name exited non-zero"
    tail -80 "$log_file" >&2 || true
    exit 1
  fi
  # Confirm the test actually ran (cargo test silently passes if the filter
  # matches nothing).
  if ! grep -Eq "test .*::${test_name} \.\.\. ok" "$log_file"; then
    echo "[scenario] FAIL — test '$test_name' did not match any test"
    tail -40 "$log_file" >&2 || true
    exit 1
  fi
done

echo ""
echo "[scenario] PASS — scenario 3.3: per-agent concurrency cap"
echo "[scenario]   NOTE: verified via unit tests. The daemon binary does not"
echo "[scenario]   currently expose --per-agent-concurrent-workers, so live"
echo "[scenario]   daemon verification requires a small CLI change."
