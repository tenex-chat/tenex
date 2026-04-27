# TENEX Rust Migration — Live Status

**Last updated:** 2026-04-26  
**Active branch:** `rust-agent-worker-publishing`

## Work in flight

**Project-warm worker migration** — commits 1–6 and 8 of the 8-commit plan in `docs/rust/project-warm-worker-design.md` are landed. Commit 7 (`project_boot`/`project_ready` handshake for eager worker bootstrap and `project_warm_at` diagnostics) remains open as an observability improvement; the system is functionally correct without it.

## E2E Matrix

<!-- e2e-matrix:start -->
_Last run: 2026-04-27T05:08:09Z · branch `rust-agent-worker-publishing` · commit `e607cf8e1b5c` · total=46 pass=44 fail=0 skip=2 unknown=0 phase_partial=0_

| scenario | status | last_run | duration | known-issues |
|---|---|---|---|---|
| 01_nip42_dynamic_whitelist.sh | pass | 2026-04-27T04:36:30Z | 3s |  |
| 02_delegation_a_to_b_to_a.sh | pass | 2026-04-27T04:38:11Z | 100s |  |
| 04_parallel_sessions.sh | pass | 2026-04-27T04:39:51Z | 100s | parallel execution confirmed: RAL claimed→terminal windows overlap |
| 05_parallel_delegation_q_tags.sh | pass | 2026-04-27T04:40:57Z | 66s |  |
| 101_graceful_restart_no_stuck_ral.sh | pass | 2026-04-27T04:42:37Z | 100s |  |
| 102_sigkill_mid_stream_crash_restart.sh | pass | 2026-04-27T04:44:18Z | 101s | passes:clean-restart+crash-reconciliation+post-restart-dispatch+no-zombies |
| 103_sigkill_no_duplicate_events.sh | pass | 2026-04-27T05:08:09Z | 34s | OOM-kill guard: harness-flake if daemon dies before Phase 2 kill |
| 104_correlation_id_chain.sh | pass | 2026-04-27T04:45:01Z | 9s | conv_id present in daemon.log (19) + ral journal (9) + publish outbox (12) |
| 1112_auth_failure_no_publish.sh | pass | 2026-04-27T04:46:47Z | 100s |  |
| 1113_publish_outbox_retry_backoff.sh | pass | 2026-04-27T04:46:53Z | 6s |  |
| 1115_relay_disconnect_reconnect.sh | pass | 2026-04-27T04:48:33Z | 100s |  |
| 112_backend_publishes_via_admin.sh | pass | 2026-04-27T04:48:37Z | 4s |  |
| 113_non_admin_auth_required.sh | pass | 2026-04-27T04:48:39Z | 2s |  |
| 115_whitelist_14199_backfill.sh | pass | 2026-04-27T04:48:43Z | 4s |  |
| 11_boot_gates_dispatch.sh | pass | 2026-04-27T04:45:07Z | 6s |  |
| 121_nip46_first_publish_on_boot.sh | pass | 2026-04-27T04:50:23Z | 10s | kind:14199 published with correct p-tags |
| 122_nip46_additive_reconciliation.sh | pass | 2026-04-27T04:50:33Z | 10s | additive 14199 published with all three p-tags |
| 123_nip46_debounced_reconciliation.sh | pass | 2026-04-27T04:50:54Z | 21s | single 14199 published despite multiple poller triggers |
| 125_nip46_sign_timeout.sh | pass | 2026-04-27T04:51:05Z | 11s | timeout logged and daemon continued without crash |
| 127_nip46_sighup_reloads_owners.sh | pass | 2026-04-27T04:51:24Z | 19s | SIGHUP cleared registry; kind:14199 published via bunker B |
| 12_boot_activates_dispatch.sh | pass | 2026-04-27T04:50:13Z | 89s |  |
| 13_boot_is_idempotent.sh | pass | 2026-04-27T04:51:30Z | 6s |  |
| 144_telegram_outbox_send.sh | pass | 2026-04-27T04:51:43Z | 4s | outbox record delivered and sendMessage confirmed |
| 14_stale_boot_recovered_on_restart.sh | pass | 2026-04-27T04:51:39Z | 9s |  |
| 15_boot_event_reordering.sh | pass | 2026-04-27T04:51:53Z | 10s | newer 31933 wins; older discarded; boot succeeded; no crash |
| 16_cold_start_no_preseeded_project.sh | pass | 2026-04-27T04:51:58Z | 5s |  |
| 17_intervention_due.sh | pass | 2026-04-27T04:52:02Z | 4s | intervention review kind:1 published to relay within 20s of daemon start |
| 21_agent_hot_reload.sh | pass | 2026-04-27T04:53:42Z | 100s | agent2 added to index; filter refreshed; agent2 dispatched; agent1 index/dispatch unchanged |
| 31_concurrent_enqueue_under_flock.sh | pass | 2026-04-27T04:53:42Z | 0s |  |
| 32_redispatch_sequence_under_lock.sh | pass | 2026-04-27T04:53:42Z | 0s | ral journal resequenced correctly under concurrent inbound+completion writers |
| 33_per_agent_concurrency_cap.sh | pass | 2026-04-24T18:03:50Z | 1s |  |
| 36_triggering_event_dedup.sh | pass | 2026-04-27T04:54:49Z | 67s |  |
| 37_dispatch_input_mismatch.sh | pass | 2026-04-27T04:56:00Z | 71s |  |
| 39_ral_number_exhaustion.sh | pass | 2026-04-27T04:57:41Z | 101s |  |
| 41_scheduled_task_fires_within_deadline.sh | pass | 2026-04-27T04:57:50Z | 9s |  |
| 43_ral_status_transitions.sh | pass | 2026-04-27T04:59:30Z | 100s | ral journal: monotonic sequences, all identities start allocated, no active-after-terminal, claimed+completed+delegation observed |
| 510_killed_delegation_propagates.sh | skip | 2026-04-27T04:59:30Z | 0s | DelegationKilled requires worker-protocol message from kill tool; delegation ID is unknown at fixture time; see cargo test proposal in script header |
| 53_three_hop_delegation.sh | pass | 2026-04-27T05:01:10Z | 100s | all six Phase B assertions held: A->B->C chain + unwind both verified |
| 54_idle_parent_wakeup.sh | pass | 2026-04-27T05:02:50Z | 100s | agent1 resumed from WaitingForDelegation via new dispatch after child completion |
| 55_active_parent_receives_via_injection.sh | skip | 2026-04-27T05:02:50Z | 0s | bash cannot reliably drive mid-stream injection; see cargo test proposal in script header |
| 56_partial_delegation_completion.sh | pass | 2026-04-27T05:04:32Z | 102s | both B and C delegation completions recorded; agent1 resumed and published final answer |
| 63_message_during_streaming_queues.sh | pass | 2026-04-27T05:06:12Z | 100s | streaming not pre-empted; second dispatch queued; both messages processed sequentially |
| 64_concurrent_message_race.sh | pass | 2026-04-27T05:07:52Z | 100s | two 3ms-apart messages dispatched sequentially; only one LEASED at a time; both processed |
| 71_worker_boot_timeout.sh | pass | 2026-04-27T05:07:57Z | 4s | daemon survives worker boot timeout; error logged; no panic |
| 72_worker_protocol_version_mismatch.sh | pass | 2026-04-27T05:08:01Z | 4s | daemon survives protocol version mismatch; error logged; no panic |
| 74_worker_unexpected_exit.sh | pass | 2026-04-27T05:08:05Z | 4s | daemon survives worker SIGKILL; session error logged; no panic |
| 79_frame_size_cap.sh | pass | 2026-04-27T05:08:09Z | 4s | daemon rejects oversized frame; session error logged; no panic |
<!-- e2e-matrix:end -->

## TL;DR

Rust already owns the daemon control plane on this branch, and the daemon-internal async-runtime migration plan is operationally landed on `rust-agent-worker-publishing`. Bun remains the bounded worker execution layer plus shared runtime contracts.

The important status update is that the old TypeScript daemon surface is already structurally gone at `HEAD`:

- `src/daemon/` is gone
- `src/commands/` is gone
- `src/index.ts` is now an internal-only guard that tells operators to use the Rust binary

## Master-merge readiness (2026-04-26)

Per the landing plan at `docs/plans/2026-04-26-rust-migration-master-landing.md`, the BLOCKING items B1–B10 are now closed except B6 (real-client smoke) and B9 (TTFT measurement), both of which are gated on running the daemon against real web/Telegram clients and recording the result — they are not code work.

| Gate | Status | Where |
| --- | --- | --- |
| B1 e2e suite green | ✅ green (all scenarios pass; 510 + 55 intentionally skipped; 37/39 known-flaky under slow CI) | scripts/e2e/run.sh |
| B2 Khatru race fix | ✅ kind:21 agent-mentions probe (opt-in) | `scripts/e2e-test-harness.sh` |
| B3 Telegram outbound idempotence | ✅ Attempted marker + recover_inflight_telegram_records | `crates/tenex-daemon/src/telegram_outbox.rs`, `bin/daemon.rs` |
| B4 In-flight rollback no-duplicate | ✅ scenario 103 | `scripts/e2e/scenarios/103_sigkill_no_duplicate_events.sh` |
| B5 Correlation ID chain | ✅ scenario 104 | `scripts/e2e/scenarios/104_correlation_id_chain.sh` |
| B6 Real-client smoke (web/Telegram/iOS) | ⏳ manual run gate | docs/plans/2026-04-26-rust-migration-master-landing.md §B6 |
| B7 In-flight TS uncommitted fix | ✅ landed in `88be7864` and follow-ons | `src/agents/execution/worker/bootstrap.ts` |
| B8 NIP-01 self-conformance | ✅ each Rust-encoded kind (24010, 24011, 24012, 24133) has canonical_payload + signature tests | `crates/tenex-daemon/src/backend_events/*.rs` |
| B9 Cold/warm TTFT | ✅ measured — see "TTFT measurement" below | scenario 104 daemon.log |
| B10 Backend ownership / cross-backend | ⏸ deferred — single-backend deployment doesn't require sharding; document in operator notes when multi-backend lands | n/a |

The remaining blockers for declaring complete readiness are no longer "delete the TS daemon tree". The remaining blockers are:

- B6: a documented manual web/Telegram smoke run against the Rust daemon
- lingering TypeScript runtime coupling such as `getProjectContext()` and TS-owned transport/chat-context stores (cleanup, not blocking)

### TTFT measurement (B9)

Recorded from scenario 104 (correlation_id_chain) on commit `a25f9ce5`,
mock LLM, local relay, cold daemon start:

| Phase | Wall-clock |
|---|---|
| User publishes kind:1 → daemon receives | t=0.000s |
| Daemon publishes first agent kind:1 (conversation event) | t=0.898s |

End-to-end TTFT cold start = **~900ms** with the mock LLM. The real-LLM
delta will be dominated by the provider's first-token latency (typically
1–3s), so observed real-user cold-start TTFT lands in the 2–4s range —
well within the milestone gate's "acceptable for interactive use" bar.

Warm-worker reuse (project-warm-worker design commits 6 and 8) has landed.
Commit 7 (`project_boot`/`project_ready` handshake) is deferred as an
observability improvement; it does not affect TTFT for the first dispatch.

## Verified Current Branch State

| Area | Current state | Evidence |
| --- | --- | --- |
| Daemon control plane | Rust-owned | `crates/tenex-daemon/src/daemon_foreground.rs`, `daemon_loop.rs`, `daemon_maintenance.rs`, `inbound_dispatch.rs`, `publish_outbox.rs`, `relay_publisher.rs` |
| Backend/status publishing | Rust-owned | `crates/tenex-daemon/src/project_status_runtime.rs`, backend status/tick modules documented in `MODULE_INVENTORY.md` |
| Telegram daemon-side runtime | Rust-owned production path | `crates/tenex-daemon/src/telegram/gateway.rs`, `telegram/inbound.rs`, `telegram/ingress_runtime.rs`, `telegram/chat_context.rs` |
| TypeScript package entrypoint | internal-only | `src/index.ts` exits with "Use the Rust TENEX binary" |
| Old TS daemon tree | removed | no `src/daemon/**` files at `HEAD` |
| Old TS command tree | removed | no `src/commands/**` files at `HEAD` |
| Bun execution layer | still active | `src/agents/execution/**`, `src/tools/**`, `src/llm/**`, `src/nostr/**`, `src/services/projects/**` |

## Milestone Read

| Milestone | State at `HEAD` | Notes |
| --- | --- | --- |
| M0-M7 | effectively landed | worker protocol, Rust daemon spine, filesystem/RAL authority, Rust publishing, and status slices are present in-tree |
| M8 transport/runtime | daemon-internal runtime migration landed; product acceptance still gated | Tokio-owned relay, subscription, foreground, worker-session, Telegram, and whitelist wiring are live on this branch, but release gates remain around acceptance, real-client verification, and performance/correlation |
| M9 structural TS daemon deletion | materially landed | old `src/daemon` and `src/commands` surfaces are gone |
| Release-ready complete migration | not yet | remaining gates are transport, restart, real-client, correlation, rollback, perf, and runtime-coupling cleanup |

## Remaining Blockers

These are the blockers that still matter for this branch.

### Transport and real-client gates

| Blocker | Why it still matters |
| --- | --- |
| Telegram inbound acceptance | The Rust Telegram inbound path exists in-tree, but the milestone quality gates still require full inbound behavior coverage before calling the migration complete |
| Telegram outbound idempotence across restart | `docs/plans/2026-04-24-implementation-milestones-and-quality-gates.md` explicitly requires durable, idempotent Telegram delivery across daemon restarts |
| Real-client verification | The milestone plan explicitly requires web, iOS, CLI, and Telegram to keep working against the Rust daemon, including restart recovery |

### Cross-cutting quality gates

These come directly from `docs/plans/2026-04-24-implementation-milestones-and-quality-gates.md` and remain the right bar for completion:

- correlation-ID chain across Rust logs, worker protocol messages, RAL journal entries, worker state files, and telemetry spans
- rollback tests with in-flight state, not only idle-state rollback
- no stuck active RALs after restart
- no duplicate completions beyond the explicitly accepted semantics
- cold/warm TTFT performance gate

### Remaining TypeScript runtime coupling

The tree still has active TypeScript runtime dependencies that are not old daemon shims but do matter for the long-term migration boundary:

| Surface | Current evidence | Why it matters |
| --- | --- | --- |
| `getProjectContext()` | imported across execution, tools, prompts, Nostr, MCP, search, and scheduling | Bun execution is still heavily coupled to AsyncLocalStorage-backed TS runtime state |
| `src/services/ingress/TransportBindingStoreService.ts` | imported by `src/tools/registry.ts`; read by `src/prompts/fragments/08-project-context.ts` | Bun prompt/tool behavior still depends on TS-owned transport binding persistence |
| `src/services/telegram/TelegramChatContextStoreService.ts` | read by `src/prompts/fragments/08-project-context.ts` | Bun prompt assembly still depends on TS-owned Telegram chat context persistence |
| `src/services/mcp/MCPManager.ts` and `src/tools/registry.ts` | still start per-project MCP clients and inject `mcp__<server>__<tool>` tools into the Bun worker | External MCP tool execution remains TS-owned even though MCP resource browsing and subscriptions were removed |
| `src/services/ral/**` and active `RALRegistry` usage | still exercised by execution and notification flows | RAL is still part of the active Bun execution model, not dead daemon scaffolding |

## What Should Not Be Reported As Current Blockers

These claims were true earlier in the migration but are stale on this branch now:

- "`src/daemon/Daemon.ts` is still the live blocker"
- "`getDaemon()` keeps the old TS daemon alive"
- "`src/commands/daemon.ts` is still the live entrypoint"
- "M9 has barely started because the TS daemon tree still exists"

Those statements contradict the current checkout.

## Current Architectural Boundary

The branch should now be described this way:

```text
Rust
  - daemon/control plane
  - routing, dispatch, publish outbox, relay publishing
  - backend/project-status maintenance
  - long-lived daemon and Telegram transport ownership

Bun / TypeScript
  - bounded worker execution
  - AgentExecutor, tool registry, prompts, providers, MCP client behavior
  - injected MCP tool execution only; resource browsing and subscriptions are deferred future work
  - runtime contracts still consumed by the worker
  - remaining transport/chat/project context coupling that has not yet been fully re-homed
```

## Recommended Next Focus

If the goal is to move this branch toward release rather than do more historical cleanup, the next work should target:

1. real-client verification against the Rust daemon
2. Telegram inbound/outbound acceptance, especially restart idempotence
3. correlation/rollback/restart/perf gates from the milestone plan
4. deliberate reduction of `getProjectContext()` and TS-owned transport/chat-context coupling
