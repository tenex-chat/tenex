#!/usr/bin/env bash
# E2E scenario 5.10 — killed delegation flag propagates.
#
# Specification (docs/E2E_TEST_SCENARIOS.md §5.10):
#   agent1 has pending delegation to agent2; user aborts agent1.
#   Expected: Delegation marked killed: true, killed_at: <ts>;
#             agent2 worker can detect and terminate.
#
# Why this scenario emits SKIP
# ─────────────────────────────
# The DelegationKilled RAL journal event is written ONLY when an active
# agent1 worker sends the `delegation_killed` worker-protocol message.
# That message is emitted by the TS `kill` tool
# (src/tools/implementations/kill.ts:351) calling publisher.killDelegation().
#
# For the kill tool to emit delegation_killed, it must be called with the
# delegation_conversation_id. That ID is generated inside the worker at
# delegation time and written to the RAL journal — it is NOT known before
# the delegation call. The mock LLM fixture cannot embed it ahead of time.
#
# The daemon's handle_stop_command (nostr_ingress.rs:412) handles kind:24134
# stop events and writes a WorkerStopRequest file. When an active agent1
# worker reads this file, it sends `abort` — which records Aborted in the
# RAL journal, not DelegationKilled. The DelegationKilled path requires the
# worker to call the kill tool with the child's conversation ID.
#
# Driving this deterministically requires:
#   a. Pre-seeding the RAL journal with a WaitingForDelegation entry, OR
#   b. A cargo integration test that calls handle_delegation_killed() directly.
#
# Option (b) is the right vehicle. See the pattern established in:
#   crates/tenex-daemon/tests/active_parent_injection.rs
#
# A cargo test can:
#   1. Pre-seed the RAL journal with WaitingForDelegation (known delegation ID).
#   2. Call handle_delegation_killed() with that conversation ID.
#   3. Assert journal contains DelegationKilled with killed_at set.
#   4. Replay the journal and verify pending_delegation.killed == true.
#
# This bash scenario intentionally SKIPs rather than attempt a
# timing-dependent hack that would be flaky across runs.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../_bootstrap.sh
source "$repo_root/scripts/e2e/_bootstrap.sh"
# shellcheck source=../../e2e-test-harness.sh
source "$repo_root/scripts/e2e-test-harness.sh"

emit_result skip \
  "DelegationKilled requires worker-protocol message from kill tool; delegation ID is unknown at fixture time; see cargo test proposal in script header"
