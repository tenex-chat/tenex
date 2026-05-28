# TENEX Supervision Internals

This document explains how TENEX supervises agent executions: the post-completion
gates and pre-tool checks that decide whether an agent's behavior should be
corrected before a completion is published or a tool is allowed to run, and the
structured-state exits that let an agent stop safely.

## Ownership

Supervision logic lives in the **`tenex-supervision`** crate. It is **pure**:
no I/O, no async, no workspace dependencies — just heuristics over plain inputs,
which makes it trivially unit-testable. The agent runner (`tenex-agent`) owns the
side effects: it builds the context, calls the supervisor, and acts on the
result inside its turn loop.

The public surface:

- `tenex_supervision::heuristics::default_supervisor() -> Supervisor`
- `Supervisor::check_pre_tool(tool_name, todos, category) -> Option<String>` — a block reason, or `None`.
- `Supervisor::check_post_completion(context) -> PostCompletionOutcome`
- `Supervisor::record_tool_call(tool_name)` — feeds the tool-call counter.

A fresh `Supervisor` is created per agent invocation. Its state (which
once-per-execution heuristics have fired, which todos have reached a terminal
status, the stuck/re-engagement counters) lives only for that invocation; there
is no durable or cross-invocation retry tracking.

## Two timings

Supervision runs at two points:

- **`pre-tool-execution`** — before a tool is allowed to run.
- **`post-completion`** — when the agent tries to finish a turn.

## Heuristics today

### `pending-todos` (post-completion gate)
Blocks completion while the agent still has `Pending` or `InProgress` todo items.
It is a pure state check (no LLM). Its enforcement mode is **repeat-until-resolved**
and it re-engages the agent. It is intentionally **suppressed** when:

- the agent is waiting on structured external work (`pending_delegation_count > 0`, e.g. after `ask()`), or
- the request was explicitly "set up a todo list and stop".

### `consecutive-tools-without-todo` (post-completion nudge)
After the agent has made several tool calls (threshold: 5) without ever creating
a todo list, this nudges it to use `todo_write`. It is **once-per-execution**,
does **not** re-engage (advisory only), and suppresses itself once the agent has
been nudged.

### `worker-todo-before-file-or-shell` (pre-tool gate)
For agents in the `Worker` category, this blocks the protected tools (`shell`,
the `fs_*` filesystem tools, the `home_*` tools) until the agent has created a
todo list. It returns a block reason; the runner skips the tool with that reason.

> The previous TypeScript runtime also had LLM-verified `silent-agent` and
> `delegation-claim` heuristics. These are **not** implemented in Rust; every
> current heuristic is a pure state check with no LLM verification. The missing
> heuristics are tracked as parity gaps in `MIGRATION_PENDING.md`.

## Outcomes

`check_post_completion` returns one of:

- **`Accept`** — supervision is satisfied; the runner proceeds to publish.
- **`InjectMessage { message }`** — an advisory note; the completion is allowed
  to finish and the message is surfaced, but it is not persisted and does not
  re-run the agent.
- **`ReEngage { message }`** — the turn must not complete yet. The runner
  persists the message as a `supervision`-type user message and runs the agent
  again instead of publishing.

A `Detection` (`heuristic_name`, `message`, `enforcement`, `re_engage`) is the
internal representation a heuristic produces; the supervisor maps it to one of
the outcomes above.

## Enforcement modes

- **`OncePerExecution`** — once the heuristic fires, it is skipped on later
  post-completion checks within the same invocation. Use for advisory nudges
  where repeating would only add noise.
- **`RepeatUntilResolved`** — re-evaluated on every completion attempt; firing
  once does not exempt it later. Use for objective gates where "warning
  delivered" is not the same as "condition resolved" (e.g. `pending-todos`).

## Progress detection and the stuck cap

Re-engaging gates cannot loop forever:

- When a todo reaches a terminal status (`Done` or `Skipped`), the supervisor
  counts that as progress and resets its stuck counter.
- After `MAX_STUCK_ITERATIONS` (3) consecutive re-engagements with **no**
  progress, the supervisor returns `Accept` — it stops blocking and lets the
  completion through. (There is no separate "stronger final correction" message;
  it simply accepts.)
- An absolute backstop (`ABSOLUTE_REENGAGEMENT_CAP`, 30) accepts unconditionally
  if re-engagements ever reach that count.

## Post-completion flow

1. When the agent finishes streaming, the turn loop builds a
   `PostCompletionContext`: the current todos, the tool calls made this turn,
   whether a todo nudge has already been delivered, the count of pending external
   work, and the original triggering message.
2. It calls `Supervisor::check_post_completion(...)`.
3. On `ReEngage`, the runner persists the supervision message and loops the agent.
   On `InjectMessage`, it publishes and surfaces the note. On `Accept`, it proceeds.
4. On `Accept`, the runner still decides **what** to publish: if there is pending
   external work or pending delegations, it emits an ordinary conversation
   message (`ConversationIntent`); otherwise it emits a completion
   (`CompletionIntent`) that marks the turn done. This publish decision is
   separate from supervision.

## Structured resolution paths

Supervision deliberately prefers structured state changes over free-text excuses.
An agent that cannot or should not keep working has these machine-visible exits:

- **Continue the work** and update the todo list as progress changes.
- **Call `ask()`** when human input or external confirmation is needed. This
  marks pending external work, which suppresses the `pending-todos` gate.
- **Mark todos `skipped`** (with a `skip_reason`) when an item is no longer
  relevant. Skipped counts as progress.

## Telemetry

The `tenex-supervision` crate emits no telemetry of its own (it has no I/O). Any
tracing or logging around supervision decisions happens in the `tenex-agent`
turn loop that drives it.

## Extending supervision

When adding or changing a heuristic:

1. Decide whether it is an advisory nudge or a gate, and set the enforcement mode
   (`OncePerExecution` vs `RepeatUntilResolved`) accordingly.
2. Keep it a pure function of its inputs — no I/O in `tenex-supervision`.
3. Make the correction message point the agent toward a structured state change
   (finish a todo, skip it with a reason, or `ask()`), not just prose.
4. Wire pre-tool gates through `check_pre_tool` and post-completion gates through
   `check_post_completion`, and cover the new behavior with crate-level tests.

## Where to look

- `crates/tenex-supervision/` (`supervisor.rs`, `heuristics/`, `types.rs`) and its `AGENTS.md`.
- The post-completion gating and re-engagement loop in `crates/tenex-agent/src/turn_loop/`.
- `docs/CONTEXT-MANAGEMENT-AND-REMINDERS.md` for how supervision messages reach the model-facing prompt.
