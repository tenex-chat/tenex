# TENEX Rust Migration — Live Status

**Last updated:** 2026-04-25 (post-audit cleanup)  
**Active branch:** `rust-agent-worker-publishing`  
**Audited commit:** `74ec086b`

## Work in flight

- **Project-warm worker migration** — commits 1–5 of the 8-commit plan in
  `docs/rust/project-warm-worker-design.md` are landed:
  - bootstrap split into `bootstrapProjectScope` + `runOneExecution`
  - TS worker drops the serialization guard, supports concurrent executions
  - protocol carries `agent` payload + `projectAgentInventory` + `project_boot`/`project_ready`
  - inline `agent` payload consumed (executing agent materialized via `materializeAgent`)
  - Rust runtime state moved to many-execution-per-worker (`Vec<ActiveExecutionSlot>`)
  - `select_warm_worker_for_dispatch` selector added with concurrency-cap arm

  Commits 6–8 remain open: admission still spawns a fresh worker per
  dispatch, `project_boot` is never sent, `AgentRegistry` placeholder
  cleanup is gated on commit 6. See the design doc for the per-commit
  status matrix and the wire-up needed for commit 6.
- **Backend-event publish path simplification** — second dispatch in flight in worktree with explicit pwd-isolation guard and the 24133 NIP-46 bunker-reply nuance flagged for verification before removal.
- **Tokio finishing pieces (b)+(c) — async session loop + publish_outbox_wake** — design landed at `docs/plans/2026-04-24-tokio-finishing-design.md`. The new design eliminates the registry's `Option<RuntimeHandle>` field that caused last attempt's 101 regression: `spawn_blocking` uses ambient runtime, `JoinHandle::blocking_join()` joins from sync context. Will dispatch as a single commit after backend-publish lands and stabilizes.

## Recent cleanups + landings this session

- **`WorkerConcurrencyLimits` deleted entirely (`2b2f4db1`)** — global/per-project/per-agent caps were either unwired in production or judged unnecessary by the user. Removed the struct, planner, `--max-concurrent-workers` CLI flag, `DEFAULT_MAX_CONCURRENT_WORKERS`, the admission concurrency check, scenario `33_per_agent_concurrency_cap.sh`, and ~540 lines of related code. Deduplication checks (`CandidateAlreadyActive`, `ConversationAlreadyActive`) retained as `check_worker_dispatch_dedup` — those are correctness, not capping.
- **Bug 1 orphan recovery wiring restored (`8708a88d`)** — was first added in the contaminated `4555db58` (then reverted with the rest). Re-applied as a focused commit. Scenario 102 SIGKILL-restart now records `crashed` records on startup; remaining 102 failures are the pre-existing khatru subscription-registration race.
- **Tokio finishing piece (a) (`c4fb798c`)** — whitelist reconciler + agent inventory poller now run as tokio tasks with explicit `watch::Sender<bool>` shutdown signal. NIP-46 sign body wraps in `spawn_blocking` to avoid starving the runtime. New gate test asserts both tasks exit within 1 s of shutdown. 994 lib tests + 13 daemon bin tests pass; scenario 101 = 4/5 with the known khatru flake.
- **Scenario 39 RAL exhaustion unparked (`d265e49b`)** — three real script bugs found: assertion was grepping the cargo stdout log instead of the daemon's tracing JSON log, the republished priming event was being silently dropped by the second daemon's relay subscription `since` filter, and the 24010 wait was a fixed sleep-then-check that flaked on slow runs. All fixed; scenario passes 4 consecutive runs.

## Latest daemon e2e suite (2026-04-24)

Full isolated harness run on this branch:

- Command: `scripts/e2e/run.sh --jobs 2 scripts/e2e/scenarios/*.sh`
- Result: `total=18 pass=17 fail=0 skip=1 unknown=0`
- Intentional skip: `55_active_parent_receives_via_injection.sh` still documents a bash/harness limitation, not a daemon regression
- Restart coverage is green:
  - `101_graceful_restart_no_stuck_ral.sh`
  - `102_sigkill_mid_stream_crash_restart.sh`
- Delegation coverage is green:
  - `02_delegation_a_to_b_to_a.sh`
  - `53_three_hop_delegation.sh`
- Queueing / concurrency / hot-reload coverage is green:
  - `21_agent_hot_reload.sh`
  - `31_concurrent_enqueue_under_flock.sh`
  - `32_redispatch_sequence_under_lock.sh`
  - `33_per_agent_concurrency_cap.sh`
  - `36_triggering_event_dedup.sh`
  - `37_dispatch_input_mismatch.sh`

## Recently resolved daemon issues

The following issues were real on earlier 2026-04-24 snapshots but are no longer accurate on the current audited commit:

- **Startup orphan recovery is wired into production startup**
  - `recover_worker_startup` is now called from `crates/tenex-daemon/src/bin/daemon.rs`
  - crash-restart scenario `102_sigkill_mid_stream_crash_restart.sh` passes end to end
- **Restart-time subscription/bootstrap behavior is no longer a red e2e gate**
  - boot/restart scenarios `01`, `11`, `12`, `14`, `101`, and `102` all pass in the latest suite
- **Mid-stream redirect / duplicate-start handling is hardened**
  - same-conversation redirects inject into the live worker instead of starting a duplicate session
  - launch-lock conflicts defer cleanly instead of failing the daemon tick
  - dispatch leases are rolled back to `queued` on post-lease launch failure
- **Filesystem restart admission now uses the validated admission/start path**
  - `37_dispatch_input_mismatch.sh` now passes reliably by holding the allocation lock until restart, then asserting the corrupted sidecar is rejected before launch
- **Whitelist rehydrated from persisted state at startup (`7646650a`)**
  - new `daemon_whitelist_store` module atomically writes `<daemon_dir>/whitelist.json` whenever config supplies owners, reads it back as a fallback when config doesn't
  - eliminates the SIGKILL-restart window where the daemon would subscribe to nothing until a fresh kind:14199 lands
  - 4 integration tests in `crates/tenex-daemon/tests/whitelist_rehydration.rs`
  - first attempt landed as `4555db58` with ~2,250 lines of unrelated tokio-finishing work bundled in; reverted (`ee79842f`) and re-applied cleanly

## E2E Matrix

<!-- e2e-matrix:start -->
_Last run: 2026-04-25T20:12:02Z · branch `e2e-event-driven` · commit `443aecb1688f` · total=21 pass=13 fail=6 skip=1 unknown=0 phase_partial=1_

| scenario | status | last_run | duration | known-issues |
|---|---|---|---|---|
| 01_nip42_dynamic_whitelist.sh | pass | 2026-04-25T20:07:51Z | 3s |  |
| 02_delegation_a_to_b_to_a.sh | fail | 2026-04-25T20:07:58Z | 7s |  |
| 04_parallel_sessions.sh | fail | 2026-04-25T20:08:04Z | 6s | agent1 never published kind:1 with 'session-alpha result: 100' |
| 101_graceful_restart_no_stuck_ral.sh | fail | 2026-04-25T20:08:10Z | 6s |  |
| 102_sigkill_mid_stream_crash_restart.sh | phase_partial | 2026-04-25T20:09:51Z | 101s | passes:clean-restart+crash-reconciliation+no-zombies; gaps:phase6=1 |
| 11_boot_gates_dispatch.sh | pass | 2026-04-25T20:09:57Z | 6s |  |
| 12_boot_activates_dispatch.sh | pass | 2026-04-25T20:10:04Z | 6s |  |
| 13_boot_is_idempotent.sh | pass | 2026-04-25T20:10:11Z | 7s |  |
| 14_stale_boot_recovered_on_restart.sh | pass | 2026-04-25T20:10:16Z | 5s |  |
| 15_boot_event_reordering.sh | pass | 2026-04-25T20:10:22Z | 6s | newer 31933 wins; older discarded; boot succeeded; no crash |
| 17_intervention_due.sh | pass | 2026-04-25T20:10:28Z | 6s | intervention review kind:1 published to relay within 20s of daemon start |
| 21_agent_hot_reload.sh | pass | 2026-04-25T20:10:34Z | 6s | agent2 added to index; filter refreshed; agent2 dispatched; agent1 index/dispatch unchanged |
| 31_concurrent_enqueue_under_flock.sh | pass | 2026-04-25T20:10:34Z | 0s |  |
| 32_redispatch_sequence_under_lock.sh | pass | 2026-04-25T20:10:34Z | 0s | ral journal resequenced correctly under concurrent inbound+completion writers |
| 36_triggering_event_dedup.sh | pass | 2026-04-25T20:10:40Z | 6s |  |
| 37_dispatch_input_mismatch.sh | pass | 2026-04-25T20:10:51Z | 11s |  |
| 39_ral_number_exhaustion.sh | pass | 2026-04-25T20:11:04Z | 13s |  |
| 41_scheduled_task_fires_within_deadline.sh | fail | 2026-04-25T20:11:28Z | 24s |  |
| 43_ral_status_transitions.sh | fail | 2026-04-25T20:11:54Z | 26s |  |
| 53_three_hop_delegation.sh | fail | 2026-04-25T20:12:02Z | 8s | agent1 never published any kind:1 delegation event |
| 55_active_parent_receives_via_injection.sh | skip | 2026-04-25T20:12:02Z | 0s | bash cannot reliably drive mid-stream injection; see cargo test proposal in script header |
<!-- e2e-matrix:end -->

## TL;DR

Rust already owns the daemon control plane on this branch, and the daemon-internal async-runtime migration plan is operationally landed on `rust-agent-worker-publishing`. Bun remains the bounded worker execution layer plus shared runtime contracts.

The important status update is that the old TypeScript daemon surface is already structurally gone at `HEAD`:

- `src/daemon/` is gone
- `src/commands/` is gone
- `src/index.ts` is now an internal-only guard that tells operators to use the Rust binary

The remaining blockers are no longer "delete the TS daemon tree". The remaining blockers are:

- transport acceptance and restart behavior
- real-client verification
- correlation / rollback / restart / performance quality gates
- lingering TypeScript runtime coupling such as `getProjectContext()` and TS-owned transport/chat-context stores

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
| Telegram outbound idempotence across restart | `docs/rust/implementation-milestones-and-quality-gates.md` explicitly requires durable, idempotent Telegram delivery across daemon restarts |
| Real-client verification | The milestone plan explicitly requires web, iOS, CLI, and Telegram to keep working against the Rust daemon, including restart recovery |

### Cross-cutting quality gates

These come directly from `docs/rust/implementation-milestones-and-quality-gates.md` and remain the right bar for completion:

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
