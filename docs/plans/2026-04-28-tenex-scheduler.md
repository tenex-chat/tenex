# `tenex-scheduler` — Product Spec

## Purpose

A standalone Rust binary that owns scheduled and one-off task execution across all TENEX projects on the host. Dual-mode: a management CLI (`list`, `add`, `add-once`, `rm`) and a long-lived daemon (`run`) that fires due tasks by publishing kind:1 trigger events to relays.

Replaces the in-process `SchedulerService` that today runs inside the bun project runtime.

## The key collapse

Today's scheduler auto-boots projects to deliver tasks. **It doesn't need to.** The supervisor daemon already subscribes to kind:1 events tagged with known project `a` tags and boots the project on receipt. The new scheduler simply publishes a properly-tagged kind:1 event when a task fires; the existing relay → supervisor → boot path takes care of the rest.

This means the scheduler has no project-lifecycle responsibility. It's a pure timer-to-event publisher.

## What it owns

- Cron task scheduling.
- One-off task scheduling (`executeAt` ISO timestamp).
- Catch-up on startup: tasks missed within the last 24h get fired (sequentially, with 5s spacing). Tasks older than 24h are dropped.
- Storage: the existing per-project schedule JSON at `~/.tenex/projects/<dTag>/schedules.json`. Schema lifted verbatim (`ScheduledTask` interface).
- Target resolution: `targetAgentSlug` → pubkey via on-disk agent registry (`~/.tenex/agents/...`). When resolution fails, publish without a `p` tag and log a warning — project routing falls back to PM, same as today.
- Publishing kind:1 trigger events with the existing tag layout: `["a", projectRef]`, `["p", targetPubkey]`, `["scheduled-task-id", taskId]`, plus either `["scheduled-task-cron", cronExpr]` or `["scheduled-task-execute-at", iso]`, plus optional `["e", targetChannel]`.
- File-watch reconciliation: when `schedules.json` files change on disk (because the bun runtime or a CLI invocation wrote them), the daemon picks up changes without restart.

## What it does *not* own

- Project boot orchestration. That's the supervisor's job, triggered by the kind:1 events this daemon publishes.
- Agent execution, dispatch, conversation routing.
- Per-project NDK subscriptions for inbound events. The scheduler only publishes.
- Cross-project task dependencies. Each task is independent.

## CLI surface

```
tenex-scheduler list [--project <dTag>]
tenex-scheduler add --schedule <cron-expr> --prompt <text> --target <agent-slug> --project <dTag>
                    [--title <text>] [--channel <event-id>] [--from <pubkey>]
tenex-scheduler add-once --at <iso8601> --prompt <text> --target <agent-slug> --project <dTag>
                         [--title <text>] [--channel <event-id>] [--from <pubkey>]
tenex-scheduler rm <task-id>
tenex-scheduler run
```

Management subcommands operate directly on the JSON files (atomic write-temp-then-rename, same pattern as the existing TS code). They don't talk to the running daemon — file-watch reconciliation handles propagation.

`run` is the daemon mode: load all schedules, set up timers, fire on schedule, watch for file changes, run forever.

## Trigger model

- Cron tasks: parsed with `cron` (Rust crate equivalent of `node-cron` / `cron-parser`). Timer set per task. UTC.
- One-off tasks: `tokio::time::sleep_until` for delays under `Duration::MAX`; chained re-evaluation for very long delays (the JS 24.8-day setTimeout cap doesn't apply here, but bound it anyway for clock-drift resilience — re-check every 24h).
- File-watch via `notify` crate on `~/.tenex/projects/*/schedules.json`. On change: reload + reconcile (same pattern as the TS `reconcileTasksInMemory`).

## Catch-up policy

On `run` startup:
1. Load all schedules from disk.
2. For each task with a `lastRun`, walk forward in cron from `lastRun` and find any executions in `[now - 24h, now)`. Fire them sequentially with 5s spacing.
3. For one-off tasks with `executeAt < now - 24h`: delete them (expired, can't catch up).
4. For one-off tasks with `executeAt < now` but within 24h: fire immediately.
5. For one-off tasks already with `lastRun` set: delete (orphaned by prior crash post-execution).

Same policy as today, ported to Rust.

## Single-instance enforcement

`flock` on `~/.tenex/scheduler.pid`. Mirror the `whitelist/` and `tenex-summarizer` pattern. A second `run` invocation fails the lock and exits cleanly. Management subcommands (`list`, `add`, `rm`) don't take the lock.

## Storage and writes

- Per-project schedule JSON at `~/.tenex/projects/<dTag>/schedules.json`. Format unchanged.
- Atomic write: write to `.tmp` and rename. Same as TS.
- Multiple writers safe via atomic rename + the daemon's file-watch reconciliation.
- The bun runtime continues to write to these files when agents create tasks via tools — until that path migrates to publishing scheduling-request Nostr events the daemon subscribes to. That's a future cleanup, not v1 scope.

## Signing and publishing

- Backend signer: read backend nsec from `~/.tenex/config.json` (same path as today's `config.ensureBackendPrivateKey()`).
- Publishes via `nostr-sdk` directly. When the relay-mux roadmap item lands, swap to publishing through it.
- When the NIP-46 signer daemon lands, swap signing to it. Both swaps are localized; don't pre-build abstractions for them.

## Layering

```
tenex-scheduler  (Rust binary; CLI + daemon)
     ↓
nostr-sdk (signing + publish)
filesystem (~/.tenex/projects/*/schedules.json, ~/.tenex/agents/*/)
```

No imports from the bun codebase. No dependency on `tenex-conversations` (scheduling state is its own JSON files; that's appropriate — schedules are not conversation state).

## Configuration

`~/.tenex/config.json`:
- Relay list.
- Backend nsec (or NIP-46 connection string when that exists).

No scheduler-specific config. Per-task config lives in the schedule JSON.

## Observability

- Structured logs via `tracing`.
- One log line per fired task: `task_id`, `project_id`, `target_pubkey`, `event_id`, latency.
- One log line per scan/reconcile cycle: tasks added, removed, updated.
- Catch-up logs: tasks found, processed, expired.

## What this deletes from the bun runtime

When this ships and the bun runtime stops scheduling in-process:

- `src/services/scheduling/` (entire directory: `SchedulerService.ts`, `storage.ts`, `errors.ts`, `types.ts`, `utils.ts`, tests).
- The scheduler init/shutdown wiring in the daemon layer.
- The `setProjectCallbacks` injection (`projectBootHandler`, `projectStateResolver`, `targetPubkeyResolver`).
- The `--only` flag's scheduler-disable path (it's about scheduler in-process; with the daemon out of the runtime, the flag becomes irrelevant for scheduling and is removed or repurposed).

Net code reduction in the bun runtime; the daemon takes on a strictly bounded responsibility.

## Non-goals

- No multi-host. One daemon per host.
- No web UI. CLI is the management surface.
- No retry-on-publish-failure beyond the next scheduled fire. If a task fails to publish, it's logged; the next cron tick gets it. One-off tasks that fail to publish are not retried — this matches today's behavior.
- No new cron syntax. The same `cron` expressions as today.
- No agent-side tool API change in v1. The bun `schedule_task` tool keeps writing JSON files; the daemon picks them up via file-watch.
- No automatic migration from the old "global" schedule file (`scheduled_tasks.json`) — that's a doctor concern, not the daemon's.

## Success criteria

- Same kind:1 events fire on the same schedules as today, against the same projects, with the same tags.
- A bun project runtime that is not running boots in response to a scheduled task fire (via the existing supervisor path).
- `tenex-scheduler add` and `tenex-scheduler rm` from the shell take effect within seconds without restarting the daemon.
- A daemon restart catches up missed tasks within the 24h grace window, identical to current TS behavior.
- The four pieces of code listed under "What this deletes" are removed in the cutover PR; no parallel paths.
