#!/usr/bin/env bash
# E2E scenario 5.5 — active-parent receives via injection (no double execution).
#
# Specification (docs/E2E_TEST_SCENARIOS.md §5.5):
#   agent1 still streaming when child completion arrives. Child publishes
#   completion. Completion recorded in journal; daemon does NOT spawn second
#   agent1 worker; running worker receives via injection on next checkpoint.
#
# Why this scenario emits SKIP
# ─────────────────────────────
# The injection path (inbound_runtime.rs:239) fires ONLY when the parent RAL
# carries status == Claimed at the moment the child completion event is
# ingested.  In the mock-LLM delegation flow:
#
#   1.  agent1 dispatch starts   → RAL = Claimed
#   2.  agent1 calls `delegate`  → daemon journals WaitingForDelegation
#                                  (RAL transitions away from Claimed)
#   3.  agent2 receives, responds
#   4.  agent2 publishes kind:1 completion
#   5.  daemon ingests completion → RAL is WaitingForDelegation ∴ resume path,
#                                   NOT injection path
#
# For injection to fire, the completion must arrive while agent1 is still in
# step 1–2 (Claimed).  That requires:
#
#   a.  agent1's `delegate` tool call is in flight (streaming) when the
#       completion arrives, OR
#   b.  the daemon hasn't yet written WaitingForDelegation to the RAL journal
#       when it ingests the completion.
#
# Neither can be driven deterministically from bash:
#   • Streaming delay (streamDelay in fixture) slows word-by-word emission but
#     the worker does NOT write WaitingForDelegation mid-stream; it writes it
#     when the LLM turn finishes and the tool call is dispatched.
#   • Even a 10-second streamDelay on agent1's first turn does not keep the
#     RAL in Claimed: agent1 must finish the LLM call and invoke `delegate`
#     before WaitingForDelegation is written, but that still happens BEFORE
#     agent2 is even spawned.
#   • Publishing a synthetic kind:1 "completion" from bash while agent1 is
#     streaming requires knowing the delegation_conversation_id, which is
#     generated inside the worker and written to the RAL journal only after
#     the delegate call completes.
#
# The reliable vehicle for this scenario is a cargo integration test:
#   crates/tenex-daemon/tests/active_parent_injection.rs
#
# Such a test can:
#   1. Pre-seed the RAL journal with a Claimed entry (no real worker needed).
#   2. Call inbound_runtime::try_handle_delegation_completion() directly.
#   3. Assert that enqueue_worker_injection() was called and injection-queue.jsonl
#      contains a record with status=queued and a delegationCompletion payload.
#   4. Assert that no new dispatch record appears for the parent's
#      triggering_event_id.
#
# This file intentionally does NOT attempt a flaky timing-dependent run:
# a 0-for-N hit rate over 5 tries teaches nothing and obscures real failures.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../_bootstrap.sh
source "$repo_root/scripts/e2e/_bootstrap.sh"
# shellcheck source=../../e2e-test-harness.sh
source "$repo_root/scripts/e2e-test-harness.sh"

emit_result skip \
  "bash cannot reliably drive mid-stream injection; see cargo test proposal in script header"
