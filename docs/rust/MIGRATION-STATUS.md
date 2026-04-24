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
- e2e scenario **02 Phase B (delegation with deterministic Mock-LLM)** passes 3/3 consecutive runs (merged from Track A `72586c4a`/`6d28db3d` → `3106e7ce`)
- **Mock-LLM fixture infra** (`USE_MOCK_LLM=true` + `TENEX_MOCK_LLM_FIXTURE`) working end-to-end with strict matching, `expectedModelId` pinning, fail-loud on missing triggers — production TS unit tests still green (`bun test src/test-utils/mock-llm` 6/0, `bun test src/llm/providers/__tests__` 58/0)

## What DOES NOT WORK (known broken / blockers)

- **Hardcoded relay binary path** in `scripts/e2e-test-harness.sh:18` — CI-unrunnable. (Track D shipped `scripts/e2e/_bootstrap.sh` portable resolver; not yet committed — files still untracked in main tree.)
- **Sleep-based synchronization** in several scenarios (scenario 02, 01) — will flake under load. Track D added `helpers/await_file.sh` for condition-based waiting but existing scenarios not yet migrated.
- `_pick_free_port` TOCTOU race — will collide with >30 parallel scenarios.
- `await_daemon_subscribed` depends on log-grep — brittle to log format changes.
- Telegram inbound adapter missing (M8 blocker).
- M9 TS shim audit not done — unclear what remains to delete.
- Agent worktree isolation unreliable: Tracks C, D, E wrote files to main tree instead of their worktrees. Landed work in main as untracked; merge plan in progress.

## What we DON'T KNOW YET (and when we'll know)

| Unknown | ETA / trigger |
|---------|---------------|
| Do project boot scenarios (1.1–1.5) pass on Rust daemon? | Batch 1 Track B completes |
| Do dispatch queue concurrency scenarios (3.1, 3.3, 3.6, 3.7, 3.9) pass? | Batch 1 Track C completes |
| Does deterministic mock-LLM Phase B work end-to-end? | Batch 1 Track A completes |
| Do delegation flows survive concurrent interleaved RAL completions under the append lock? | Cargo concurrency-invariants integration test (Batch 2 Track E, dispatched) |
| Does §3.2 (re-dispatch sequence under lock) hold? | Batch 2 scenarios (pending) |
| Do §4.3–4.5 (RAL transitions, snapshot recovery, append failure) hold? | Batch 2 scenarios (pending) |
| Does §5.5/5.7 (active-parent injection, deferred completion) hold? | Batch 3 delegation scenarios (pending) |
| Does publish-outbox tolerate two daemons racing on same directory? | Batch 3 adversarial M7 scenarios (not scheduled) |
| Does Telegram outbound delivery work against a real bot? | M8 real-client fixture (not scheduled) |
| Does M9 TS cleanup leave any dead imports / broken builds? | M9 audit pass (not scheduled) |

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
_Last run: 2026-04-24T06:53:24Z · branch `rust-agent-worker-publishing` · commit `6d5b9e72ecb1` · total=1 pass=1 fail=0 skip=0 unknown=0 phase_partial=0_

| scenario | status | last_run | duration | known-issues |
|---|---|---|---|---|
| 01_nip42_dynamic_whitelist.sh | pass | 2026-04-24T06:53:24Z | 3s |  |
<!-- e2e-matrix:end -->

## Active orchestration

**Batch 1 in flight (background subagents, Ollama+local relay, isolated worktrees):**
- Track A — Mock-LLM fixtures + port scenario 02 to deterministic Phase B
- Track B — Project boot scenarios 1.1–1.5 (`11_*.sh`–`15_*.sh`)
- Track C — Dispatch queue scenarios 3.1/3.3/3.6/3.7/3.9 (`31_*.sh`–`39_*.sh`)

**Batch 2 planned (dispatching now, revised per reviewer feedback):**
- Track D — e2e runner + status JSON + portable harness fixes (new files only; serialized harness edits land later)
- Track E — cargo integration test for concurrency invariants: shared `ProjectEventIndex` identity, RAL seq monotonicity under lock, claim-token uniqueness, publish-outbox atomic seq monotonicity

**Batch 3 planned (after Batch 2 merges):**
- High-churn concurrency scenarios: §3.2, §4.3, §4.4, §4.5
- Delegation variants: §5.5 (active-parent injection), §5.7 (deferred completion)
- Recovery: §10.1, §10.2

**Deferred:**
- Adversarial M7 (two daemons on same outbox, relay half-ack, tmp→pending gap)
- M8 real-client Telegram E2E
- M9 TS shim audit

## Orchestration-feedback cadence

Every ~30 min: dispatch 2–3 critical reviewers in parallel asking (a) is the current direction right, (b) what's next, (c) what am I missing. Log findings and course corrections here.

### Feedback session log

**2026-04-24 — Session 1**
- Verdict: my initial Batch 1 partitioning aimed at quiescent subsystems (boot, dispatch admission). High-churn concurrency work was not probed. Bash scenarios duplicate some cargo interop gates. Harness has scalability issues. No dashboard.
- Actions: wrote this doc; redirected Batch 2 toward concurrency invariants via cargo integration test; froze harness edits during fan-out; deferred high-risk sections (§3.2, §4.*, §5.5/7, §10.*) to Batch 3 after runner + dashboard land.

## Blockers for master merge

1. M8: Telegram inbound adapter + real-client fixture
2. M8: full-daemon E2E for project-status / operations-status / scheduler-wakeups
3. M9: TS daemon code fully deleted, no feature flags remaining
4. All M0–M8 quality gates green in CI (currently local-only; requires portable relay resolution + CI plan)
5. Real clients (web / iOS / CLI / Telegram) verified against Rust daemon E2E
6. e2e scenario matrix: top-priority scenarios (sections 1–8) scripted, green, and reproducible from clean checkout

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
