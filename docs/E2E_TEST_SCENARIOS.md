# E2E Test Scenarios — Rust Daemon

A comprehensive, deduplicated battery of end-to-end scenarios for the Rust daemon (`crates/tenex-daemon/`), runnable via `scripts/setup-nak-interop-fixture.sh`.

Synthesized from: Rust source on `rust-agent-worker-publishing`, TypeScript control plane on `master`, project documentation, ~2400 commits of git history, and the fixture's current capabilities.

Each scenario includes: **Setup → Trigger → Expected → Exercises**. Categories are roughly ordered by criticality / risk of regression.

---

## 0. Test infrastructure

### LLM
Tests run against **real Ollama** at `http://localhost:11434` (per fixture default). No mocking. Models per fixture: `qwen3.5`, `glm-5`. Trade-off: tests are non-deterministic at the LLM-output level, so assertions focus on protocol/state behavior (events published, RAL transitions, dispatch states), not exact agent text.

### Relay
Tests run against the **local TENEX relay** at `/Users/pablofernandez/Work/tenex-launcher/relay/tenex-relay` (pre-built; source at `/Users/pablofernandez/Work/tenex-launcher/relay/`). Started per-test on a free port, with isolated `data_dir` under the fixture root. Sync to upstream `wss://relay.tenex.chat` is disabled (`sync.relays = []`).

**NIP-42 is always on** for this relay — there is no toggle. Auth is required for any non-ephemeral, non-public-readable subscription. This means every test exercises the auth path. Whitelist mechanisms used by the harness:

- **`admin_pubkeys` in config** — backend pubkey is added so the daemon can publish/read without ceremony
- **kind:14199 with p-tags** (transitive) — used by the user/owner identity to whitelist itself + agents (mirrors production flow)
- **`<TENEX_BASE_DIR>/daemon/whitelist.txt`** — polled every 2s; harness uses this for pre-seeding pubkeys that need to read before any 14199 has been published (tests that exercise pre-whitelist subscribe paths)

### Harness primitives (`scripts/e2e-test-harness.sh`)

| Function | Purpose |
|---|---|
| `start_local_relay --admin <hex>...` | Starts `tenex-relay` on a free port; returns `ws://127.0.0.1:<port>` |
| `stop_local_relay` | Graceful shutdown |
| `start_daemon` | Starts daemon with the fixture's `TENEX_BASE_DIR` |
| `stop_daemon` / `crash_daemon` | Graceful (SIGTERM) vs. SIGKILL |
| `kill_worker <pid>` | Targeted worker kill for crash scenarios |
| `seed_whitelist_file <pubkey>...` | Writes pubkeys to `daemon/whitelist.txt` |
| `publish_event_as <nsec> <kind> <content> <tag>...` | Wraps `nak event` |
| `await_dispatch_status <dispatch_id> <status>` | Polls `dispatch-queue.jsonl` |
| `await_kind_event <kind> [d-tag] [author]` | Polls relay via `nak req` |
| `await_ral_state <project> <agent> <conv> <jq-predicate>` | Polls `ral/journal.jsonl` |
| `assert_ral_journal_contains <jq-filter>` | Hard assertion |
| `assert_no_dispatch <dispatch_id>` | Negative assertion |
| `dispatch_id_for <triggering_event_id>` | Computes dispatch_id from event |

### Known limitations

- **Mid-stream interruption** (e.g. scenario 6.1 redirect) currently has no clean injection point. Workaround: use slow Ollama models (e.g. `glm-5`) and time the redirect to land during a tool checkpoint.
- **Crash-at-fixed-RAL-transition**: SIGKILL is coarse-grained. For deterministic transition-point crashes, the daemon would need a test-mode hook (deferred — most recovery scenarios work with arbitrary mid-execution kills).

The fixture already provides: keypair generation, project + agent inventory setup, kind:14199/31933 publishing, manifest export. See `scripts/setup-nak-interop-fixture.sh`.

---

## 1. Project boot & activation

| # | Scenario | Setup | Trigger | Expected |
|---|----------|-------|---------|----------|
| 1.1 | Boot gates dispatch | Project defined on disk, no boot event ingested | Inbound text event for an agent in that project | Event ignored with reason `project_not_booted`; no dispatch enqueued |
| 1.2 | Boot event activates dispatch | Same as 1.1 | Publish kind:31933 (or kind:24000) boot event for the project; then publish inbound | Boot recorded in `booted-projects.json`; subsequent inbound dispatched normally |
| 1.3 | Boot is idempotent | Project already booted | Publish identical boot event again | No duplicate boot record; no kind 14199 churn; no rebroadcast |
| 1.4 | Stale boot state recovered on restart | Daemon crashed mid-boot; `booted-projects.json` has partial state | Restart daemon | Stale flags cleared; project rebooted cleanly; no infinite loop |
| 1.5 | Boot event reordering | Out-of-order arrival: project update arrives before initial boot, both published | Daemon ingests in arrival order | Final state is consistent; no crash; later-published state wins or merges per addressable-event rules |

## 2. Agent membership hot-reload

| # | Scenario | Setup | Trigger | Expected |
|---|----------|-------|---------|----------|
| 2.1 | **Add agent to booted project (user's #1)** | Project booted with agent1 | Publish updated kind:31933 with agent1 + agent2 p-tags AND publish kind:24001 (agent create) for agent2 | agent2 appears in `agent-definitions.json` snapshot; subsequent inbound to agent2 is dispatched; reconciler re-publishes kind:14199 with agent2 added |
| 2.2 | Remove agent while project booted | Project booted, agent2 has active worker | Publish kind:24030 (agent delete) for agent2 | Active worker completes; new inbound to agent2 ignored; agent removed from snapshot; reconciler re-publishes kind:14199 minus agent2 |
| 2.3 | Agent config update via kind:24020 | Agent has model X | Publish kind:24020 with new model Y | Next worker spawn uses model Y; existing worker finishes with X |
| 2.4 | Re-ingressing same kind:31933 doesn't blitz index | Project has indexed agents | Republish identical project event | Agent slug index in `agents/index.json` unchanged (additive merge); no agents dropped (covers regression `56fbae67`) |
| 2.5 | Agent definition file edit | Agent file edited on disk (slug, tools change) | `agent_definition_watcher` picks up change | Next worker reads updated config; running worker is unaffected |

## 3. Dispatch queue & concurrency

| # | Scenario | Setup | Trigger | Expected |
|---|----------|-------|---------|----------|
| 3.1 | Concurrent enqueue under flock | Three concurrent paths (inbound, completion, scheduled) | All try to enqueue simultaneously | `LOCK_EX` serializes; sequence numbers monotonic; no duplicates (covers `999286f5`) |
| 3.2 | Re-dispatch sequence computed under lock | Worker completion in flight; inbound arrives | Inbound enqueues first; completion path enqueues second | Completion re-reads queue tail under lock before computing sequence; no out-of-order |
| 3.3 | Per-agent concurrency cap | `per_agent: 1`; agent1 has active worker | Two more inbounds for agent1 | First admitted, others rejected with `AgentLimitReached`; admitted as previous completes |
| 3.4 | Per-project concurrency cap | `per_project: 2`; agent1 + agent2 each have 1 worker | Inbound to agent3 in same project | Rejected with `ProjectLimitReached` |
| 3.5 | Global concurrency cap | `global: 3`; three workers across three projects | Any new inbound | Rejected with `GlobalLimitReached` |
| 3.6 | Triggering-event dedup | Inbound event A enqueued | Relay redelivers same event A | Recognized by `dispatch_id`; no duplicate dispatch; no worker spawned twice |
| 3.7 | Dispatch input mismatch validation | Dispatch queued for agent1 | Sidecar written with mismatched agent pubkey | Admission fails with `WorkerDispatchAdmissionStartError::DispatchInput`; logged; no worker launch |
| 3.8 | Triggering event mismatch validation | Dispatch sidecar contains `triggering_event_id=X` | Worker dispatch input written with `Y` | Admission fails; dispatch terminated cleanly |
| 3.9 | RAL number exhaustion guard | Conversation at `ralNumber = u64::MAX` | New inbound for same identity | `ral_number_exhausted` flagged; allocation rejected |

## 4. RAL claim, allocation & ownership

| # | Scenario | Setup | Trigger | Expected |
|---|----------|-------|---------|----------|
| 4.1 | Claim token prevents duplicate workers | Two inbounds for same `(project, agent, conversation)` arrive within ms | Daemon allocates one RAL number; mints `ralClaimToken` for first | Only one worker boots; second event queued or dropped per dedup policy; second worker never starts |
| 4.2 | Triggering-event uniqueness in scheduler | Same triggering event allocates RAL twice | Re-allocation attempted | `active_triggering_events` collision detected; existing RAL number returned |
| 4.3 | RAL status class transitions | Allocated → Claimed → Streaming → Tool_active → Completed | Each transition published | Each appended to `journal.jsonl`; status class correctly re-classified |
| 4.4 | RAL snapshot persistence + recovery | Long-running journal, snapshot rotated | Restart daemon | Snapshot loaded; replay state matches pre-snapshot; no pending delegations or terminal history lost |
| 4.5 | RAL journal append failure (disk full) | Mid-write disk-full simulated | Worker reports state transition | Daemon does NOT ack worker until journal write succeeds; on restart, partial line ignored |
| 4.6 | Stale lock reclamation via `kill(pid,0)` | Worker crashed; lock file orphaned | New execution arrives for same identity | Liveness check (`ESRCH`) detects; lock reclaimed; new worker proceeds |

## 5. Delegation flow

| # | Scenario | Setup | Trigger | Expected |
|---|----------|-------|---------|----------|
| 5.1 | **Simple two-hop (user's #2)**: agent1 → agent2 → agent1 continues | Project with agent1 + agent2 booted | User → agent1; agent1 publishes delegation to agent2; agent2 publishes completion reply with `["e", delegation_event_id]` | Daemon routes completion to agent1's RAL via `try_handle_delegation_completion`; agent1 RAL marked `DelegationCompleted`; agent1 re-dispatched and resumes |
| 5.2 | **Followup (user's #4)**: A→B, B completes, A follows up, B responds again | After 5.1 completes | agent1 publishes followup delegation tagged as `Followup` type | New dispatch for agent2 with prior transcript available in RAL snapshot (`fullTranscript` field); agent2 responds; loop completes |
| 5.3 | Three-hop chain: A → B → C, then unwind | Three agents booted | Chain delegations | Each child completion routes to its direct parent; nested `parent_delegation_conversation_id` works; no cross-routing |
| 5.4 | Idle-parent wakeup | agent1 has finished its turn (idle) when child completion arrives | Child publishes completion | Daemon spawns new agent1 worker with completion injected; no re-execution of agent1's prior turn |
| 5.5 | Active-parent receives via injection (no double execution) | agent1 still streaming when child completion arrives | Child publishes completion | Completion recorded in journal; daemon does NOT spawn second agent1 worker; running worker receives via injection on next checkpoint |
| 5.6 | Partial completion with multiple pending children | agent1 has pending delegations to B, C, D; only B completes | B publishes completion | RAL records `DelegationCompleted` for B; parent stays in `WaitingForDelegation` with C, D still pending; no resume yet |
| 5.7 | Deferred completion (child completes before parent waits) | agent2 completes before agent1's `delegation_registered` is recorded | Child completion arrives first | Recorded as `RalDeferredCompletion`; when agent1 reaches waiting state, deferred completion immediately available; no deadlock |
| 5.8 | Cross-project delegation routed correctly | agent1 in project A delegates to agent2 in project B | Both projects booted | Routed correctly; project context preserved; transparent attribution maintained (covers regression `Issue #1`) |
| 5.9 | Delegation events start NEW conversation, not threaded | agent1 publishes delegation | Event leaves daemon | No `e`-tag pointing at parent conversation root (covers regression `75289580`); reply-to points to triggering envelope only |
| 5.10 | Killed delegation flag propagates | agent1 has pending delegation to agent2; user aborts agent1 | Abort published | Delegation marked `killed: true, killed_at: <ts>`; agent2 worker can detect and terminate |
| 5.11 | Paused child wakes parent on abort | agent2 paused (mid-tool); user aborts agent2 | Abort published | Parent agent1 woken with abort completion; doesn't hang (covers regression `Issue #2`) |

## 6. Interruption & redirection

| # | Scenario | Setup | Trigger | Expected |
|---|----------|-------|---------|----------|
| 6.1 | **Mid-execution redirect (user's #3)**: "write 20 poems, by file 5 say 'jokes for the rest'" | agent1 actively writing files in a loop | User publishes kind:1 redirect message mid-task | RAL ingests new pending event; on next worker checkpoint, agent sees updated transcript and pivots; remaining files contain jokes; no duplicate poem #5 |
| 6.2 | Redirect prevents duplicate work | Redirect arrives between checkpoints | Worker detects redirect | Task A's incomplete work not republished; only task B's results published |
| 6.3 | New user message during streaming queues but doesn't pre-empt | agent1 streaming a long response | User sends second message | Second message queued in conversation; current stream completes; second message dispatched after |
| 6.4 | Concurrent message race (3ms apart, single agent) | Two user messages sent 3ms apart for same agent | Both arrive | Single execution scheduled; second message queued in conversation, not as separate dispatch (covers production trace `a65d59fe`) |

## 7. Worker lifecycle & process management

| # | Scenario | Setup | Trigger | Expected |
|---|----------|-------|---------|----------|
| 7.1 | Worker boot timeout | Configured boot timeout 100ms; mock worker sleeps 500ms before `ready` | Spawn | `WorkerProcessError::BootTimeout`; worker killed; dispatch terminated; RAL → `Crashed` |
| 7.2 | Worker protocol version mismatch | Worker reports incompatible protocol version in `ready` | Spawn | Daemon rejects; clear error in journal; no dispatch admission |
| 7.3 | Worker heartbeat timeout | Worker hangs; no heartbeat for > timeout | Maintenance tick | Worker classified as crashed; terminal RAL event; dispatch terminated |
| 7.4 | Worker unexpected exit (non-zero) | Active worker; SIGKILL externally | Process exits | Frame-pump detects EOF; session loop ends; RAL → `Crashed`; dispatch terminated |
| 7.5 | Warm reuse for matching execution | Agent worker idle; new execution arrives within idle TTL | Same project + agent + cwd + protocol version | Worker reused; no spawn cost |
| 7.6 | Warm reuse rejected on mismatch | Worker idle for project A | Execution for project B arrives | Reuse rejected; fresh worker spawned |
| 7.7 | MCP server lifecycle bounded to worker | Agent uses MCP server | Worker exits cleanly | MCP child processes cleaned up |
| 7.8 | MCP cleanup on worker crash | Same as 7.7 but worker SIGKILLed | EOF detected | MCP processes cleaned up; no leaks |
| 7.9 | Frame size cap (1 MiB) | Worker emits oversized frame | Frame received | Rejected; worker terminated; clear error |
| 7.10 | Stream delta batching | Worker emits one char/50ms | Daemon receives | Frames coalesced every 250ms or 8KiB, whichever first |

## 8. Worker protocol — publish, injection

| # | Scenario | Setup | Trigger | Expected |
|---|----------|-------|---------|----------|
| 8.1 | Publish sequence monotonicity | Worker sends `publish_request` seq=1, then seq=1, then seq=3 | All received | First accepted; second rejected (`PublishResultSequenceNotAfterRequest`); third accepted |
| 8.2 | Publish request idempotency | Same `request_id` sent twice | Both received | First queued; second dedup'd (idempotent ack with same result) |
| 8.3 | Live publish without daemon tick | Worker publishes operations-status mid-execution | Published immediately | Event reaches relay within 1s; not blocked on daemon tick (covers `74236fca`) |
| 8.4 | Egress route classification | Worker publishes message with telegram routing indicator | Daemon classifies | Routed to telegram outbox; `TelegramOutboxRecord` created with `nostr_event_id` reference |
| 8.5 | Injection delivery + lease | Daemon enqueues injection; worker leases via `consume_injections` | Worker crashes before `injections_applied` | Lease released by orphan reconciliation; next worker for same RAL receives injection again — no loss |
| 8.6 | Injection ack clears lease | Worker `injections_applied` received | Daemon marks injections consumed | Restart daemon; injection not re-delivered |
| 8.7 | Multiple injections delivered FIFO | Several injections queued | Worker requests | Delivered in order queued; each marked sent |
| 8.8 | Max injection attempts → terminal | Worker repeatedly rejects malformed injection | Threshold hit | Session terminated; error recorded |
| 8.9 | Operations-status uses default model when agent omits | Project default = `claude-opus`; agent has none | Worker publishes status | `model` field = `claude-opus` (covers `dba4d318`) |
| 8.10 | Operations status state persists across ticks | Worker publishes "3/5 tools done" | Next tick | State loaded from disk; not reset (covers `845f464f`) |

## 9. Inbound / subscription / classification

| # | Scenario | Setup | Trigger | Expected |
|---|----------|-------|---------|----------|
| 9.1 | Subscription `since` filter set to boot time | Daemon boots | Relay sends events from before boot | Pre-boot events filtered by `since` (covers `1cba536f`) |
| 9.2 | Subscription kind whitelist | Daemon subscribed for {1, 14199, 24133, ...} | Relay sends kind:1, kind:1985 | kind:1 ingested; kind:1985 dropped |
| 9.3 | Subscription dedup by event ID | Relay redelivers same event | Both received | First processed; second dropped |
| 9.4 | Subscription filters refreshed on agent change | Daemon subscribed for agent1 mentions | agent2 added | Filters extended to include agent2 pubkey |
| 9.5 | Project address tag filtering | Two projects A & B booted | Inbound tagged with project A address only | Routed only to project A agents |
| 9.6 | p-tag-only event with multi-project agent → ambiguity guard | agent1 in projects A and B | Inbound with only `["p", agent1]`, no `a`-tag | Event dropped with reason `ambiguous_project` (no double-dispatch) |
| 9.7 | p-tag-only event with single-project agent → routes | agent1 only in project A | Inbound with only `["p", agent1]` | Routed to project A agent1 |
| 9.8 | Implicit conversation derivation | User message with no conversation context | Sent to agent | Conversation ID derived from sender + project; routed normally |
| 9.9 | Non-whitelisted sender ignored | Inbound from non-whitelisted pubkey | Sent to agent in whitelisted project | Dropped per whitelist policy |
| 9.10 | Trust precedence: whitelisted > backend > agent | Same pubkey in all three categories | Trust check | Returns trusted via highest-precedence source |

## 10. Recovery & crash resilience

| # | Scenario | Setup | Trigger | Expected |
|---|----------|-------|---------|----------|
| 10.1 | Daemon restart during streaming RAL | Worker streaming; daemon `SIGTERM` mid-stream | Restart daemon | Replay journal; classify orphaned RAL; mark `Crashed` or replan; release locks |
| 10.2 | Worker crash mid-tool-call | Worker SIGKILLed mid `tool_active` | Maintenance | Orphan reconciliation appends `Crashed` event; dispatch terminated; reconciliation plan applied atomically |
| 10.3 | Partial dispatch queue write recovery | Crash mid-write; partial line in `dispatch-queue.jsonl` | Restart | Replay reads up to last complete line; partial line ignored; lock released on reopen |
| 10.4 | Partial RAL journal write recovery | Same for `ral/journal.jsonl` | Restart | Same — partial line skipped; safe-point recovery |
| 10.5 | Orphan dispatch (no matching RAL) | Dispatch in LEASED, RAL absent | Maintenance | Detected; cleaned up; logged |
| 10.6 | Pending delegation IDs survive restart | agent1 worker spawn includes `pending_delegation_ids` from sidecar | Crash before RAL hydrates fully on restart | New worker still sees pending delegations from sidecar (covers `90bca404`) |
| 10.7 | Publish outbox drained after worker error | Worker queues 3 publishes, crashes after 1 | Next maintenance tick | Remaining 2 published (covers `c0daa9ce`) |
| 10.8 | Outbox tolerates pre-existing records on restart | Records left from prior session | Daemon restart | Loaded and published; no idempotency error (covers `a3e7ef9f`) |
| 10.9 | Single bad tick does not crash daemon | Maintenance tick hits corrupted JSON | Tick runs | Logged as warning; daemon continues; next normal tick works |
| 10.10 | Dispatch input sidecar missing on replay | Dispatch in LEASED, sidecar deleted | Replay | Clean error; dispatch aborted; no worker launch with garbage input |
| 10.11 | Filesystem state consistency check | RAL terminal but dispatch active for same identity (or vice versa) | Maintenance | Inconsistency detected; deterministic reconciliation rule applied; corrected on next write |

## 11. Publishing & relay (NIP-42 always-on)

The local `tenex-relay` is permanently NIP-42-gated for non-ephemeral, non-public-readable kinds. Every test exercises this path. These scenarios specifically pin auth + whitelist behavior.

| # | Scenario | Setup | Trigger | Expected |
|---|----------|-------|---------|----------|
| 11.1 | Backend as admin: subscribes without 14199 | Relay started with `admin_pubkeys=[backend_pubkey]`; no 14199 published yet | Daemon subscribes for project events on boot | Auth completes; subscription accepted; events delivered without 14199 dependency |
| 11.2 | Backend publish through admin path | Same as 11.1 | Daemon publishes kind:24010 status | AUTH challenge handled; publish accepted; event present on relay (covers `8f34c452`, `15f127db`) |
| 11.3 | Non-admin subscriber gets `auth-required` | User pubkey not whitelisted; no 14199 | User subscribes for kind:1 from agent | Relay sends `auth-required`; client must AUTH before any historical events delivered |
| 11.4 | Authenticated but non-whitelisted: `LimitZero` defer | User authenticated but neither admin nor in any 14199 | Subscribes for kind:1 | Filter rewritten with `LimitZero=true`; live events not broadcast; sub registered for backfill |
| 11.5 | Dynamic whitelist via 14199: backfill triggered | After 11.4: user publishes kind:14199 with self in p-tag | Relay processes 14199 | User's deferred subs are backfilled with all matching historical events; live broadcasts now reach them |
| 11.6 | Transitive whitelist via 14199 p-tag | User's 14199 includes agent2 pubkey in p-tag | Agent2 subscribes (after authing) | Agent2 immediately whitelisted (no separate 14199 needed); subs receive both backfill and live events |
| 11.7 | Ephemeral kinds bypass auth | Unauthenticated client subscribes for kinds in 20000–29999 only | Subscribe | Accepted without AUTH; ephemeral events delivered |
| 11.8 | Public-readable kinds bypass auth (4199/14199/34199) | Unauthenticated client subscribes for `kinds=[14199]` | Subscribe | Accepted without AUTH; existing 14199 events delivered |
| 11.9 | `daemon/whitelist.txt` pre-seed picks up within 2s | Harness writes pubkey X to `whitelist.txt` before subscribing | X authenticates and subscribes | Within 2s X is treated as whitelisted; deferred subs (if any) backfilled |
| 11.10 | Relay restart preserves whitelist via 14199 replay | Multiple 14199 events stored; relay restarted | Restart | `buildWhitelistFromStorage` replays all 14199 events; previously whitelisted pubkeys remain whitelisted |
| 11.11 | Relay restart loses ephemeral cache | Ephemeral events (kind 24133) published; relay restarted | Subscribe for them after restart | Not delivered (ephemeral by design); current/live events still flow |
| 11.12 | AUTH challenge failure → no publish | Daemon's AUTH frame is corrupted/rejected | Relay returns auth failure | Publish remains in outbox `pending`; retry scheduled; doesn't silently drop |
| 11.13 | Publish outbox retry with backoff | Relay down | Maintenance ticks | Retry counter incremented; exponential backoff; succeeds when relay returns |
| 11.14 | Subscription `since` filter set to boot time after AUTH | Daemon boots, relay sends pre-boot events on first SUB | Subscribe | `since` filter blocks pre-boot history (covers `1cba536f`) |
| 11.15 | Relay disconnect/reconnect | Relay killed mid-session, restarted | Daemon reconnects | Subscription + AUTH re-established; current `since` preserved; pending publishes drained |
| 11.16 | Concurrent publishes during AUTH window | Daemon has 5 publishes queued when AUTH challenge arrives | AUTH completes | All 5 publishes succeed in correct order after AUTH |
| 11.17 | Connection rate limit | Open >10 connections from same IP within 1s | Connection attempt | Relay rate-limits; daemon retries with backoff |
| 11.18 | Filter rate limit (20/s, burst 40) | Daemon issues 50 filter changes in 1s | Filter changes | Subset rejected with rate-limit; daemon retries |
| 11.19 | Event signature integrity | Worker → daemon publish | Inspect event on relay | Event signed with backend nsec; ID matches hash |
| 11.20 | NIP-9 deletion: own events | Daemon publishes event E, then publishes kind:5 with `["e", E_id]` | Relay processes | Event E deleted from store |
| 11.21 | NIP-9 deletion: foreign events ignored | Daemon publishes deletion for an event by a different pubkey | Relay processes | Deletion ignored (pubkey mismatch logged) |

## 12. NIP-46 / kind:14199 whitelist reconciliation

| # | Scenario | Setup | Trigger | Expected |
|---|----------|-------|---------|----------|
| 12.1 | First publish on boot | Project booted with N agents | Reconciler runs | kind:14199 published with N p-tags |
| 12.2 | Additive reconciliation on agent add | Existing 14199 has agents A, B | Add agent C | New 14199 has A, B, C — A and B p-tags preserved (covers `668fa3a5`, `3a19695b`) |
| 12.3 | Debounced reconciliation | Three agents added in 100ms | All trigger reconciliation | Single 14199 publish (debounce window coalesces); not three (covers `f1d15b7c`) |
| 12.4 | Per-owner retry isolation | Two owners; reconciliation to owner1 fails | Owner2 unaffected | Only owner1 retried; owner2 publish stands |
| 12.5 | NIP-46 sign request timeout | Bunker unresponsive | Sign request sent | Timeout (~30s); pending request map cleared; failure surfaced (covers `bca68a66`) |
| 12.6 | Snapshot cache prevents redundant work | Reconciler triggered with no diff | Cached 14199 matches current state | No publish |
| 12.7 | SIGHUP reloads NIP-46 owners | Daemon running with bunker A | Config updated; SIGHUP | Registry reloaded; next sign uses bunker B (covers `58bfdfc9`) |

## 13. Backend heartbeat & status

| # | Scenario | Setup | Trigger | Expected |
|---|----------|-------|---------|----------|
| 13.1 | Heartbeat gated until backend ready | Daemon starting; backend key not yet generated | Tick fires | Heartbeat skipped; logged (covers `0e6087d2`) |
| 13.2 | Heartbeat latch stops after owner whitelists backend | Owner publishes 14199 including backend pubkey | Latch checks | Latch moves to stopped; never reopens (covers `MODULE_INVENTORY` heartbeat-latch) |
| 13.3 | Heartbeat owner replacement on SIGHUP | Owner config changed | SIGHUP | Latch's owner list updated; next heartbeat reflects new owner (covers `af2f3c54`) |
| 13.4 | Project status (kind:24010) includes all agents + worktrees + models | Project booted with rich agent metadata | Project-status tick | Event includes pubkeys, models, tools, skills, MCP servers, worktree branches |

## 14. Telegram transport

| # | Scenario | Setup | Trigger | Expected |
|---|----------|-------|---------|----------|
| 14.1 | First-contact binding persisted | Telegram user DMs unknown agent | Routed via hint | `transport-bindings.json` records `telegram:user → project_d_tag` |
| 14.2 | Subsequent contact uses binding | Same user sends another message | Daemon ingests | Routed without ambiguity resolution |
| 14.3 | Telegram → Nostr → agent end-to-end | Telegram message arrives | Routed through `InboundEnvelope` | Worker receives; metadata (chat_id, message_id, thread_id) preserved end-to-end (covers `MODULE_INVENTORY` telegram metadata) |
| 14.4 | Reply via send_message tool round-trips through outbox | Agent calls `send_message(channel, text)` | Worker forwards | Message routed via Rust outbox; delivered to Telegram chat (covers `4d0e3ca8`, `0af0f326`) |
| 14.5 | Media download in blocking task | Inbound Telegram message with photo | Daemon downloads | Blocking task isolated; daemon main loop unaffected (covers `7665c494`) |

## 15. Supervision (post-completion gates)

| # | Scenario | Setup | Trigger | Expected |
|---|----------|-------|---------|----------|
| 15.1 | Silent agent re-engaged | Mock LLM returns empty completion | Worker tries to complete | `silent-agent` heuristic suppresses publish; `reEngage: true`; worker re-runs |
| 15.2 | Silent completion via `no_response()` allowed | Agent calls `no_response()` | Worker completes silently | Suppressed publish; RAL records silent completion; no re-engage |
| 15.3 | Pending todos block completion (repeat-until-resolved) | Agent has todos; tries to complete | First attempt | Re-engaged with correction; same on attempts 2 and 3 |
| 15.4 | Pending todos final correction at MAX | After 3 attempts | Attempt 4+ | Stronger directive correction; gate stays active until resolved |
| 15.5 | Pending-todos suppressed when waiting on delegation | Agent has todos AND pending delegation | Tries to complete | `pendingDelegationCount > 0` → gate suppressed; completion allowed |
| 15.6 | Pending-todos suppression survives RAL boundary | Delegation registered in RAL1; supervision check in RAL2 | Suppression checked | Conversation-wide pending count still > 0; gate stays suppressed |
| 15.7 | `consecutive-tools-without-todo` nudge once per execution | Agent uses 6 tools without todo_write | Completes | Nudge injected; `reEngage: false`; not fired again in same RAL |
| 15.8 | Reminders injected at request time, not persisted | Conversation transcript saved | Multiple executions with reminders | Canonical transcript on disk has no reminder text; only request-time injection |

## 16. Skills, prompts, and lessons

| # | Scenario | Setup | Trigger | Expected |
|---|----------|-------|---------|----------|
| 16.1 | Skill whitelist (kind:14202) hydrates on subscription | Skill publisher publishes whitelist | Daemon ingests | Whitelist cached; whitelisted skills hydrated locally |
| 16.2 | Skill not in whitelist rejected | Worker requests non-whitelisted skill | Resolution | Skill not loaded; error to worker |
| 16.3 | Prompt compiler invalidation on lesson change | Agent has compiled cached instructions | Lesson published (kind:30023) | Cache invalidated; LLM re-synthesizes; kind:0 republished with new instruction hash |
| 16.4 | Agent kind:0 profile republished | Agent metadata change | Profile event seen | Daemon publishes updated kind:0 with current model/tool list |

## 17. Worktrees

| # | Scenario | Setup | Trigger | Expected |
|---|----------|-------|---------|----------|
| 17.1 | Worktree created on demand | Delegation tagged `["branch", "feature-xyz"]`; worktree absent | Worker spawns | `.worktrees/feature-xyz/` created; cwd switched |
| 17.2 | Worktree reused if exists | Same delegation, second time | Worker spawns | Existing worktree reused; no recreate |
| 17.3 | Working directory included in warm-reuse compatibility | Warm worker on branch A | Execution arrives for branch B | Reuse rejected; fresh worker spawned |

## 18. Operator / diagnostics

| # | Scenario | Setup | Trigger | Expected |
|---|----------|-------|---------|----------|
| 18.1 | `daemon-control` shows planned actions only | Daemon running | Run diagnostic command | No mutations; output matches what *would* happen |
| 18.2 | Maintenance is explicit, not implicit in status reads | Status query | Inspect | Status read is side-effect-free; repair only on explicit `daemon-control` action |
| 18.3 | Restart-state file restored on startup | Daemon stopped with in-flight executions | Restart | `restart-state.json` consumed; in-flight executions reconciled |

## 19. Multi-project / multi-tenant

| # | Scenario | Setup | Trigger | Expected |
|---|----------|-------|---------|----------|
| 19.1 | RAL namespace isolation | Same agent in two projects | Concurrent execution in both | Independent RAL state; no cross-pollination |
| 19.2 | Per-project dispatch queues / locks | Two projects under load | Each loads dispatch queue | Locks scoped per project; one project's contention doesn't block the other |
| 19.3 | Heartbeat & status published per project | N booted projects | Status tick | One kind:24010 per project |

## 20. Edge cases & timing

| # | Scenario | Setup | Trigger | Expected |
|---|----------|-------|---------|----------|
| 20.1 | Inbound + completion race | New inbound and child completion arrive same tick | Daemon processes | One of: serial under lock, no corruption either way |
| 20.2 | Boot event + inbound race | Boot event and inbound for same project arrive same tick | Daemon processes | Either: inbound waits for boot, or inbound dropped per gate; never partially processed |
| 20.3 | Clock-skewed events | Events with `created_at` in the future | Ingested | Accepted (relay accepts); RAL records arrival order; no negative timing math |
| 20.4 | Very large inbound payload | 100KB inbound text | Routed | Successfully ingested, dispatched, written to RAL; no truncation |

---

## Recommended starting set (phase 1)

If running in order, start with these 12 — they cover the user's four examples plus the highest-risk regression areas:

1. `1.2` — Boot event activates dispatch
2. `2.1` — **Add agent to booted project** (user's #1)
3. `3.1` — Concurrent enqueue under flock
4. `3.6` — Triggering-event dedup
5. `4.1` — Claim token prevents duplicate workers
6. `5.1` — **Two-hop A→B→A** (user's #2)
7. `5.2` — **Followup A→B→A→B** (user's #4)
8. `5.5` — Active-parent receives via injection (no double execution)
9. `5.7` — Deferred completion
10. `6.1` — **Mid-execution redirect** (user's #3)
11. `10.1` — Daemon restart during streaming RAL
12. `12.2` — Additive 14199 reconciliation on agent add

These 12 alone exercise: boot, dispatch concurrency, RAL claim/journal/recovery, all four delegation patterns, redirection, daemon restart, and reconciliation — the load-bearing surface area of the Rust port.

---

## Sources mined

- Rust source on branch `rust-agent-worker-publishing`: `crates/tenex-daemon/src/`
- TypeScript on `master`: `src/agents/execution/worker/`, `src/services/ral/`, `src/services/dispatch/`, `src/events/runtime/AgentWorkerProtocol.ts`, plus `__tests__/` directories
- Documentation: `docs/ARCHITECTURE.md`, `docs/DELEGATION-AND-RAL-PROCESSING.md`, `docs/SUPERVISION.md`, `docs/CONTEXT-MANAGEMENT-AND-REMINDERS.md`, `docs/system-prompt-architecture.md`, `docs/rust/agent-execution-worker-migration.md`, `docs/rust/implementation-milestones-and-quality-gates.md`, `MODULE_INVENTORY.md`
- Git history: ~2400 commits across both branches, especially commits matching `fix|race|concurrency|recover|replay|deadlock|hang|crash|RAL|dispatch|delegation|completion|publish|subscription|membership`. Specific regressions referenced inline: `552cd21b`, `999286f5`, `90bca404`, `2a0547e7`, `7507c68e`, `4bd539a3`, `56fbae67`, `75289580`, `aa2a7776`, `8f34c452`, `15f127db`, `1cba536f`, `c0daa9ce`, `a3e7ef9f`, `74236fca`, `dba4d318`, `845f464f`, `4d0e3ca8`, `0af0f326`, `7665c494`, `0e6087d2`, `af2f3c54`, `58bfdfc9`, `668fa3a5`, `3a19695b`, `f1d15b7c`, `bca68a66`, `791f4d16`, `228e6f72`, plus production trace `a65d59fe`
- Fixture: `scripts/setup-nak-interop-fixture.sh`
