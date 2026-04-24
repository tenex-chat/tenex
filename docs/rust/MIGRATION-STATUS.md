# TENEX Rust Migration — Live Status

**Last updated**: 2026-04-24
**Active branch**: `rust-agent-worker-publishing`
**Target**: merge to `master` once release criteria pass (LFG! checklist at bottom)
**Next orchestration-feedback session due**: ~30 min from last update

---

## TL;DR

M0–M7 substantially landed. M8 in progress (Telegram outbox + caches + wakeups + watchers landed; Telegram inbound adapter + real-client E2E not yet). M9 started (TS NIP-46 stack removed, TS dispatch layer removed, `project.json` descriptors removed). e2e bash harness exists with 2/100+ scenarios scripted (`01_nip42`, `02_delegation`); orchestration in progress to fill high-risk gaps and stand up a runnable status dashboard.

## Milestones

| M | State | Evidence |
|---|-------|----------|
| M0 Compatibility harness & fixtures | ✅ DONE | golden fixtures, event normalizer, NIP-01 conformance |
| M1 TS worker extraction | ✅ DONE | framed protocol, real-engine worker, publisher bridge; `d9f5e05b` replaced Bun protocol probe with in-process fake |
| M2 Stable worker protocol | ✅ DONE | versioned length-prefixed frames; shared Bun/Rust `publish_result`/`stream_delta` schemas |
| M3 Rust daemon skeleton | ✅ DONE | `daemon_readiness`, lockfile/status/restart compat; `daemon-control readiness/status/foreground/maintenance` |
| M4 Shadow routing | ✅ DONE | `ProjectEventIndex` shared across ingress/routing/gateways (`2a0e32a2`) |
| M5 Rust worker pool | ✅ DONE + hardening | dispatch journal, RAL locks, admission planner, `--max-concurrent-workers=16` default, parallel sessions (`a927fafd`), detached session threads (`6aed4327`) |
| M6 Filesystem RAL authority | ✅ DONE | journal + snapshot + claim tokens + orphan reconciliation; RAL resequencing under append lock (`d8c8238f`) |
| M7 Rust-owned publishing | ✅ DONE | `publish_outbox`, `relay_publisher`, backend encoders for kinds 24010/24011/24012/24133; all three interop gates green when opted in |
| M8 Long-lived services + transport | 🟡 IN PROGRESS | ✅ `telegram_outbox`, caches, `scheduler_wakeups`, `skill_whitelist`, `agent_definition_watcher`, `periodic_tick`. ❌ Telegram **inbound** adapter, real-client fixtures, full daemon E2E of project-status |
| M9 Complete migration | 🟡 STARTED | TS NIP-46 stack removed (`d0618ddc`), TS dispatch layer removed, `project.json` descriptors removed (`d6830a44`). Remaining TS shims not yet audited |

## What WORKS (verified by actually running)

- Rust daemon starts/stops cleanly on macOS; `daemon-control readiness/status/maintenance` operational
- Rust relay publisher publishes worker-signed agent events byte-for-byte, hash and sig verified
- Publish-outbox durability across restarts, idempotent dedup, retry classification
- **Worker interop gate**: real Bun worker executes mock + real LLM paths over stdio
- **Runtime spine gate**: real Bun daemon-worker round-trips filesystem state
- **Publish interop gate**: Rust outbox → Rust relay publisher → local mock relay → TS `nostr-tools` probe validates hash/sig/decode round trip
- RAL journal resequencing under append lock (`d8c8238f`)
- Per-filter khatru listener race fixed (`d5bcf38b`)
- Single shared `ProjectEventIndex` (`2a0e32a2`)
- Concurrent worker sessions on scoped threads with detached tick boundaries
- e2e scenario **01 (NIP-42 dynamic whitelist)** passes
- e2e scenario **02 Phase A (delegation daemon plumbing)** passes
- e2e scenario **02 Phase B (delegation with deterministic Mock-LLM)** passes 3/3 consecutive runs (Track A merged as `3106e7ce`)
- **Mock-LLM fixture infra** (`USE_MOCK_LLM=true` + `TENEX_MOCK_LLM_FIXTURE`) working end-to-end with strict matching, `expectedModelId` pinning, fail-loud on missing triggers — production TS unit tests still green (`bun test src/test-utils/mock-llm` 6/0, `bun test src/llm/providers/__tests__` 58/0)
- **Concurrency invariants** (Track E, `d4a90c19`) — 4 tests pass, but Session 2 review flagged **2 of 4 as weak**:
  - ✅ RAL journal resequences concurrent appends under the append lock with no gaps/duplicates (defends `d8c8238f`) — real invariant
  - ✅ `publish_result` sequence atomic is globally monotonic across 1024 concurrent reservations (defends `5fe5ba00`) — real invariant at the primitive level (doesn't route through `handle_worker_message_flow` yet)
  - ⚠️ `ProjectEventIndex` singleton test clones an `Arc` in-test and asserts `ptr_eq` — **tautology**, doesn't exercise daemon wiring. Regression in `src/` would still pass. Patch or delete (tracked).
  - ⚠️ `RAL claim tokens unique` uses 16 distinct identities — uniqueness is over-determined by inputs, doesn't actually test the `AtomicU64+nanosecond+sha256` mint mechanism. Patch to same-identity minting (tracked).
- **E2E runner + dashboard** (Track D, landed) — `./scripts/e2e/run.sh [glob] [--jobs N]`, atomic `.status.json`, auto-regenerated `e2e-matrix` block in this doc, portable `HARNESS_RELAY_BIN` resolution, condition-based `await_file_contains`, `collect_artifacts` tarball helper.
- **Project boot scenarios** (Track B, committed): 1.1, 1.2, 1.3, 1.4 all green through runner. 1.5 (reordering) not yet scripted (Track B stream-idle-timed-out).
- **Dispatch queue scenarios** (Track C partial, committed): 3.1 flock-serialization, 3.3 per-agent admission (via cargo unit tests — CLI can't set per_agent), 3.6 triggering-event dedup. All green.
- **Redispatch sequence under lock** (Track F, `f74bd4a6`) — scenario 3.2 green. Pure filesystem contention test, 100/100 completion writers had stale pre-snapshot sequences rewritten under lock during verification. Defends `d8c8238f` + `6d5b9e72` from bash.
- **Concurrency tests strengthened** (Track G, merged) — weak `project_event_index_is_shared_singleton_across_paths` DELETED with module docstring documenting the type-enforced contract; weak `ral_claim_tokens_unique` REWRITTEN so 32 threads contend for the same identity + same worker_id, forcing uniqueness to come entirely from the `AtomicU64+nanosecond+sha256` mint mechanism. 3/3 strengthened tests pass 5× consecutively.

## What DOES NOT WORK (known broken / blockers)

- **🔴 Real-client verification never performed.** Milestone doc (`implementation-milestones-and-quality-gates.md:1441`) declares this a **per-slice development gate**. `git log` since branch start shows **zero commits** verifying web/iOS/CLI/Telegram against the Rust daemon end-to-end. This is the largest untouched risk. Session 2 review surfaced it as the LFG blocker that will take the longest to close.
- **Scenario 37 (dispatch input mismatch) — scenario bug.** Daemon correctly rejects mismatched sidecars and logs the validation failure (`worker dispatch input validation failed: execute field triggeringEventId ... does not match`), but the scenario's grep assertion doesn't match the actual error string. Parked under `scripts/e2e/scenarios/_wip/` pending assertion fix. Daemon behavior is **correct**.
- **Scenario 39 (RAL number exhaustion) — needs investigation.** After seeding the journal with `ralNumber=u64::MAX` and restarting the daemon, no `RalNumberExhausted` error appears in the log. Could be: (a) seeding method doesn't trigger the exhaustion check path, (b) daemon lacks the check on restart replay, or (c) the republish never routes to that identity. Parked under `scripts/e2e/scenarios/_wip/`.
- **🚨 Scenario 02 flake rate 20% under stress (root cause identified).** 50-run stress of scenario 02 complete: **40 pass / 10 fail = 20%**. Mean 31s, min 25s, max 82s. 9 of 10 failures are `[harness] FATAL: daemon subscription never became live`; 1 is `agent1 never published any kind:1 event` (run 42, 82s duration — slowest run also failed). Root cause from run-4 daemon log (`artifacts/e2e/stress/02_delegation/4/fixture_root.tar`): daemon-relay WebSocket disconnects mid-run with `"websocket error: WebSocket protocol error: Connection reset without closing handshake"`, then `relay disconnected, reconnecting after backoff backoff_ms=2000`. The 2s backoff + re-AUTH + resubscribe exceeds the harness's 45s probe window when combined with other startup work. Combination of **daemon/relay WebSocket stability** and **insufficient harness probe tolerance**. Stress summary: `artifacts/e2e/stress/02_delegation/_x50_summary.json`.
- **Sleep-based synchronization** in existing scenarios (01, 02) — will flake under load. `helpers/await_file.sh` now available; existing scenarios not yet migrated.
- `_pick_free_port` TOCTOU race — will collide with >30 parallel scenarios.
- `await_daemon_subscribed` depends on log-grep — brittle to log format changes.
- Telegram inbound adapter missing (M8 blocker).
- Telegram outbound idempotency across daemon restart — claimed landed, **not tested** (per milestone doc line 1197).
- M9 TS shim audit not done — unclear what remains to delete.
- **Correlation-ID chain** (milestone global gate line 1324) across logs / worker protocol / RAL journal / worker state / telemetry spans — no test verifies the full chain.
- **Cold/warm time-to-first-token** (M9 line 1258) — no perf gate exists.
- Scenario 1.5 (boot event reordering) — not scripted (Track B timed out before delivering).
- Agent worktree isolation was unreliable: Tracks C, D, E wrote files to main tree instead of their worktrees. All landed work committed; future dispatches use single-scenario prompts with tighter scope.

## What we DON'T KNOW YET (and when we'll know)

| Unknown | ETA / trigger |
|---------|---------------|
| Does §3.2 (re-dispatch sequence under lock) hold? | Batch 3 Track F (dispatching) |
| Does §1.5 (boot event reordering) hold? | Follow-up (Track B didn't finish it) |
| Do §4.3/4.4/4.5 (RAL transitions, snapshot recovery, journal append failure) hold? | Batch 3 (after §3.2 lands clean) |
| Does §5.5/5.7 (active-parent injection, deferred completion) hold? | Batch 4 (after §4.*) |
| Does scenario 02 pass 50× consecutively, not just 3×? | Stress-loop test (Batch 3) |
| Does the `ProjectEventIndex` singleton invariant hold in daemon wiring (not just the isolated test)? | Patched concurrency test (Batch 3 Track G) |
| Does the claim-token mint mechanism produce unique tokens for same-identity concurrent claims? | Patched concurrency test (Batch 3 Track G) |
| Does §8.3 (live publish without daemon tick) hold? | Not scheduled |
| Does §8.10 (operations-status persists across ticks) hold? | Not scheduled |
| Does publish-outbox tolerate two daemons racing on same directory? | Adversarial M7 (not scheduled) |
| Does Telegram outbound delivery survive daemon restart (idempotent)? | M8 idempotence gate (not scheduled) |
| Does Telegram outbound delivery work against a real bot? | M8 real-client fixture (not scheduled) |
| Do real TENEX clients (web/iOS/CLI) work against Rust daemon end-to-end? | **#1 LFG blocker — not scheduled, needs human** |
| Does M9 TS cleanup leave any dead imports / broken builds? | M9 audit pass (not scheduled) |
| Does scenario 39 fail because of scenario bug or real daemon gap in RalNumberExhausted? | Investigation (not scheduled) |

## Test coverage snapshot

| Surface | Coverage | Gate |
|---------|----------|------|
| Rust unit tests | high | `cargo test -p tenex-daemon --no-fail-fast` |
| Worker interop | green | `bun run test:rust:daemon:worker-interop` |
| Publish interop | green | `bun run test:rust:daemon:publish-interop` |
| Runtime spine | green | `bun run test:rust:daemon:runtime-spine` |
| Concurrency invariants (shared singletons, seq monotonicity, claim tokens) | 🔴 GAP | cargo integration test in flight |
| e2e bash scenarios | 🔴 2/~100 | manual; no runner; no status JSON |
| Real client (web/iOS/CLI/Telegram) vs Rust daemon | 🔴 not automated | per-milestone development gate |
| CI runnability | 🔴 no CI, local-only | hardcoded paths block it |

## E2E scenario matrix

Regenerated automatically by `scripts/e2e/run.sh` after every run. Do not edit
between the delimiters — changes will be overwritten.

<!-- e2e-matrix:start -->
_Last run: 2026-04-24T08:03:27Z · branch `rust-agent-worker-publishing` · commit `dcacba34e1c9` · total=1 pass=1 fail=0 skip=0 unknown=0 phase_partial=0_

| scenario | status | last_run | duration | known-issues |
|---|---|---|---|---|
| 01_nip42_dynamic_whitelist.sh | pass | 2026-04-24T07:55:08Z | 7s |  |
| 02_delegation_a_to_b_to_a.sh | pass | 2026-04-24T07:56:14Z | 66s |  |
| 11_boot_gates_dispatch.sh | pass | 2026-04-24T07:56:39Z | 25s |  |
| 12_boot_activates_dispatch.sh | pass | 2026-04-24T07:57:05Z | 26s |  |
| 13_boot_is_idempotent.sh | pass | 2026-04-24T07:57:28Z | 23s |  |
| 14_stale_boot_recovered_on_restart.sh | pass | 2026-04-24T07:58:13Z | 45s |  |
| 15_boot_event_reordering.sh | pass | 2026-04-24T08:03:27Z | 19s | newer 31933 wins; older discarded; boot succeeded; no crash |
| 31_concurrent_enqueue_under_flock.sh | pass | 2026-04-24T07:58:57Z | 0s |  |
| 32_redispatch_sequence_under_lock.sh | pass | 2026-04-24T07:58:59Z | 2s | ral journal resequenced correctly under concurrent inbound+completion writers |
| 33_per_agent_concurrency_cap.sh | pass | 2026-04-24T07:59:45Z | 46s |  |
| 36_triggering_event_dedup.sh | fail | 2026-04-24T08:00:16Z | 31s |  |
| 37_dispatch_input_mismatch.sh | fail | 2026-04-24T08:00:48Z | 32s |  |
| 39_ral_number_exhaustion.sh | fail | 2026-04-24T07:11:50Z | 38s |  |
<!-- e2e-matrix:end -->

## Active orchestration

**Batch 1 (COMPLETE, merged):**
- ✅ Track A — Mock-LLM fixtures + deterministic scenario 02 (`3106e7ce`)
- ✅ Track B — Boot scenarios 1.1–1.4 green (`22bce496` predecessor; 1.5 deferred)
- 🟡 Track C — 3 of 5 green (31, 33, 36); 37/39 parked under `_wip` (`22bce496`)

**Batch 2 (COMPLETE, merged):**
- ✅ Track D — e2e runner + portable bootstrap + dashboard section
- ✅ Track E — concurrency invariants integration test (`d4a90c19`) — 2 strong, 2 weak (flagged)

**Batch 3 (single-scenario focused dispatches, 15-min cap, structured RESULT):**
- Track F — §3.2 re-dispatch sequence under lock
- Track G — patch weak concurrency tests (drop or rewrite `ProjectEventIndex` singleton test; rewrite claim-token test for same-identity concurrent minting)
- Track H — stress-loop scenario 02 (50× consecutive, cold daemon) to surface flake that 3× doesn't

**Batch 4 planned (after Batch 3):**
- §4.4 RAL snapshot recovery, §4.5 journal append failure, §4.3 RAL transitions
- §1.5 boot event reordering (Track B's missing scenario)
- Fix scenario 37 assertion; investigate scenario 39

**Batch 5 planned:**
- Delegation §5.5, §5.7, §5.3 three-hop
- §8.3 live publish without daemon tick, §8.10 operations-status persistence across ticks

**Deferred (needs human or multi-day effort):**
- Real-client verification (web/iOS/CLI/Telegram) — **#1 LFG blocker**
- Adversarial M7: two daemons on same outbox, relay half-ack, tmp→pending gap, replay attack, EACCES mid-write
- M8 Telegram inbound adapter
- M8 outbound idempotence-across-restart test
- M9 TS shim audit
- Correlation-ID chain verification
- Cold/warm TTFT perf gate

## Orchestration-feedback cadence

Every ~30 min: dispatch 2–3 critical reviewers in parallel asking (a) is the current direction right, (b) what's next, (c) what am I missing. Log findings and course corrections here.

### Feedback session log

**2026-04-24 — Session 1**
- Verdict: initial Batch 1 partitioning aimed at quiescent subsystems (boot, dispatch admission). High-churn concurrency work was not probed. Bash scenarios duplicate some cargo interop gates. Harness has scalability issues. No dashboard.
- Actions: wrote this doc; redirected Batch 2 toward concurrency invariants via cargo integration test; froze harness edits during fan-out; deferred high-risk sections (§3.2, §4.*, §5.5/7, §10.*) to Batch 3 after runner + dashboard land.

**2026-04-24 — Session 2**
- Verdict: Batch 2 delivered the runner + dashboard (great), **but 2 of 4 concurrency tests are weak ceremony** (`ProjectEventIndex` singleton is a tautology, claim-token test is over-determined by distinct inputs). Real-client verification remains **untouched**, which is the biggest unknown risk and longest LFG blocker. Scenario catalog is ~8% adversarial — happy-path regression suite dressed up as E2E. Multiple agents wrote to main tree instead of worktrees (not blocking, but indicates prompts were too broad).
- Hidden blockers surfaced from milestone doc: correlation-ID chain, rollback-tests-with-in-flight-state, Telegram outbound idempotence-across-restart, cold/warm TTFT perf, "no stuck RALs after restart", "no duplicate completions".
- Actions: parked scenarios 37 (bad assertion) and 39 (needs investigation) under `_wip`; committed Track C's 3 green scenarios + `dispatch_id_for` harness helper; rewrote Batch 3 to be **single-scenario dispatches** (§3.2, patch weak tests, stress-loop scenario 02); logged hidden M9 gates into "DOES NOT WORK"; bumped real-client verification to top of blockers; recommended web-client-pointed-at-Rust-daemon as the next human-driven checkpoint.

**2026-04-24 — Session 3**
- Verdict: direction is right — keep scripting e2e scenarios. Clean re-stress shows 10/11 pass (vs 40/50 contaminated), so 20% flake was mostly load-induced, **but run 8 failed even on a clean system with the same signature** → real intermittent bug exists, just at ~9% not 20%. Scenario 1.5 agent independently observed "tenex-khatru-relay drops idle connections after ~33s" which matches the 25s disconnect pattern in stress failures.
- Real-client gap re-scoped: this repo is `@tenex-chat/backend`, NOT the web/iOS clients — clients live in sibling repos. Orchestrator cannot spawn a sonnet agent to "run the web client" from here; genuinely needs human with sibling-repo access. A CLI-only smoke via existing tool implementations IS possible and queued as a future dispatch.
- **M9 is gated on M8**: `docs/rust/m9-ts-shim-audit.md` shows 14 TS daemon files are transitively live via `getDaemon()` called from 3 TS tool files (`project_list.ts`, `delegate_crossproject.ts`, `send_message.ts`). Deleting them requires first re-homing those tools off `getDaemon()`, which needs Rust-side replacements — that's M8 work. Do not attack M9 deletions directly until M8 tools have Rust parity.
- Zero-coverage sections ranked by "prove production-ready": §10.1/10.3/10.4 (crash recovery) > §5.5/5.7 (injection, deferred completion) > §4.1/4.6 (claim tokens, stale lock) > §11.15 (relay reconnect) > §2.1 (add agent).
- Actions: dispatched §5.5 (active-parent injection) and §4.3 (RAL status transitions) as next scenarios; queued §11.15 for after WS investigation lands; kept clean re-stress running as the threshold for retiring the 20% flake flag (success = ≥45/50 AND no `Connection reset` in any clean-run daemon log).

## Blockers for master merge (ranked by estimated time-to-close)

1. **Real-client verification** (web / iOS / Telegram) against Rust daemon — zero evidence it's been done; milestone says this is a per-slice gate that has been ignored. **Requires human** because clients live in sibling repos, not this one. CLI smoke via in-tree tool implementations is achievable and queued.
2. **M8 tools need Rust replacement** before M9 can delete any daemon TS: `src/tools/implementations/project_list.ts`, `delegate_crossproject.ts`, `send_message.ts` all call `getDaemon()`; they keep all 14 TS daemon files alive.
3. **M8 Telegram inbound adapter** — not written.
4. **M8 real-client Telegram fixture** — outbound bot API never verified against a real bot.
5. **M8 Telegram outbound idempotence-across-restart** — claimed landed, not tested.
6. **CI runnability** — portable `HARNESS_RELAY_BIN` now resolves, but Ollama dep + sandboxed CI runner not decided.
7. **Hidden quality gates**: correlation-ID chain, rollback-with-in-flight-state, no-stuck-RAL-after-restart, no-duplicate-completions, cold/warm TTFT perf.
8. **Intermittent daemon-relay WebSocket disconnect** (~9% after zombie purge) — real bug, not pure load artifact. Likely khatru ~33s idle-connection drop. Daemon reconnect works but harness probe window is insufficient.
9. **e2e coverage breadth**: ~14 of ~100 scenarios scripted + green. Zero coverage in §10 (crash/recovery), §4 (claims/locks), §5.2-5.11 (delegation variants), §11.12-21 (NIP-42 / relay edge cases).

## Release criteria — LFG! readiness checklist

- [ ] M8 fully landed (Telegram inbound adapter + real-client fixture)
- [ ] M9 complete (all TS daemon code deleted, no feature flags, no shims)
- [ ] All M0–M8 quality gates green in CI
- [ ] e2e scenario runner + persistent dashboard
- [ ] Top-priority e2e scenarios green (§§1–8, plus §10 recovery, §11 NIP-42)
- [ ] Real client verification pass (web / iOS / CLI / Telegram) against Rust daemon
- [ ] Per-milestone release criteria ✅ all
- [ ] No known regressions vs TS daemon on documented features
- [ ] NIP-01 self-conformance, schnorr sig, relay round-trip, signer identity gates pass for every Rust-encoded kind

When every box is checked, the top of this document will read:

# 🚀 LFG!

---

*This document is regenerated/updated after every batch merge, every feedback session, and every significant finding. If you find something stale, update it in place — do not append "outdated" notes.*
