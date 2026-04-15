# TENEX Supervision Internals

This document explains how TENEX supervises agent executions, with emphasis on post-completion heuristics, re-engagement, repeatable gates, and the structured-state exits that let an agent stop safely.

It is intended for contributors changing any of:

- `src/agents/supervision/*`
- `src/agents/execution/PostCompletionChecker.ts`
- `src/agents/execution/AgentExecutor.ts`
- `src/tools/implementations/ask.ts`
- `src/tools/implementations/todo.ts`
- `src/services/ral/*`

## Scope

TENEX supervision is the runtime layer that checks whether an agent's behavior should be corrected before:

- a completion is published
- a tool is allowed to run

The current default configuration only registers post-completion heuristics, but the subsystem supports both:

- `post-completion`
- `pre-tool-execution`

## Design Goals

The supervision system exists to enforce a few different kinds of rules:

1. Objective state checks.
2. Higher-level behavioral checks that may need LLM verification.
3. Low-stakes nudges that should not block progress.

The important design distinction is:

- Some heuristics are advisory and should only fire once.
- Some heuristics are gates and must keep firing until the underlying condition changes.

This distinction is now explicit in code through `HeuristicEnforcementMode`.

## Main Components

| File | Responsibility |
| --- | --- |
| `src/agents/supervision/registerHeuristics.ts` | Registers the default heuristics once during startup |
| `src/agents/supervision/heuristics/HeuristicRegistry.ts` | Stores heuristics and filters by timing |
| `src/agents/supervision/SupervisorOrchestrator.ts` | Runs detections, optional LLM verification, and returns correction actions |
| `src/agents/supervision/SupervisorLLMService.ts` | Verifies non-objective detections with the supervision model |
| `src/agents/supervision/types.ts` | Defines contexts, correction actions, enforcement modes, and retry limits |
| `src/agents/execution/PostCompletionChecker.ts` | Builds post-completion context, invokes supervision, and re-engages the agent |
| `src/agents/execution/AgentExecutor.ts` | Calls the checker before final publish and decides whether the turn can finish |
| `src/llm/system-reminder-context.ts` | Queues ephemeral supervision reminders for the next request |
| `src/tools/implementations/ask.ts` | Creates `PendingDelegation` state, which is a structured way to stop with unresolved work |
| `src/tools/implementations/todo.ts` | Defines the conversation-scoped todo state machine, including `skipped` plus `skip_reason` |

## Startup and Fail-Closed Registration

Default supervision is registered in `ProjectRuntime` through `registerDefaultHeuristics()`.

Current default heuristics:

- `silent-agent`
- `delegation-claim`
- `consecutive-tools-without-todo`
- `pending-todos`

`SupervisorOrchestrator.checkPostCompletion()` runs a health check before evaluating anything. If no post-completion heuristics are registered, it throws. This is intentional fail-closed behavior so supervision cannot silently disappear due to startup drift.

## Current Default Heuristics

### `silent-agent`

File: `src/agents/supervision/heuristics/SilentAgentHeuristic.ts`

Purpose:

- blocks empty or error-fallback completions unless silent completion was explicitly requested

Behavior:

- requires LLM verification
- uses `suppress-publish` with `reEngage: true`
- enforcement mode: `repeat-until-resolved`

### `delegation-claim`

File: `src/agents/supervision/heuristics/DelegationClaimHeuristic.ts`

Purpose:

- blocks "I delegated" style claims when no delegate tool was actually called

Behavior:

- requires LLM verification
- uses `suppress-publish` with `reEngage: true`
- enforcement mode: `repeat-until-resolved`

### `pending-todos`

File: `src/agents/supervision/heuristics/PendingTodosHeuristic.ts`

Purpose:

- blocks completion while the agent still has `pending` or `in_progress` todo items

Behavior:

- objective check, so `skipVerification = true`
- uses `suppress-publish` with `reEngage: true`
- enforcement mode: `repeat-until-resolved`
- intentionally suppresses itself when `pendingDelegationCount > 0`

The suppression condition is important. TENEX treats "waiting on delegated work or a human answer" as a valid structured reason to stop even if todos remain incomplete.

### `consecutive-tools-without-todo`

File: `src/agents/supervision/heuristics/ConsecutiveToolsWithoutTodoHeuristic.ts`

Purpose:

- nudges the agent to start using `todo_write()` after many tool calls without a todo list

Behavior:

- objective check, so `skipVerification = true`
- uses `inject-message` with `reEngage: false`
- default enforcement mode: `once-per-execution`
- also suppresses itself once the conversation has been marked as already nudged

This is intentionally not a gate.

## Enforcement Modes

Defined in `src/agents/supervision/types.ts`:

- `once-per-execution`
- `repeat-until-resolved`

These modes control what "already enforced" means.

### `once-per-execution`

Interpretation:

- the system assumes that delivering the warning once is sufficient

Effect:

- `SupervisorOrchestrator` skips the heuristic on later checks for the same execution once it has been marked enforced

Use this for:

- advisory nudges
- corrections where repeated firing would mostly create noise

### `repeat-until-resolved`

Interpretation:

- the condition itself must change before completion can pass

Effect:

- the heuristic is re-evaluated on every completion attempt within the same execution
- prior enforcement does not disable future checks

Use this for:

- objective completion gates
- conditions where "warning delivered" is not the same as "problem resolved"

## What "Execution" Means Here

The supervision state is keyed by:

```ts
`${agent.pubkey}:${conversationId}:${ralNumber}`
```

This identifier is built in `PostCompletionChecker.ts` and is effectively RAL-scoped. The name `executionId` is historical; in practice it means "this agent in this conversation in this RAL."

Supervision state currently tracks:

- `retryCount`
- `maxRetries`
- `lastHeuristicTriggered`
- `enforcedHeuristics`

This state is stored in memory in `SupervisorOrchestrator`.

Implementation note:

- there is a `clearState()` helper, but production code does not currently call it
- in practice this has not been used as the main lifecycle boundary because execution IDs are RAL-scoped and monotonically change as new RALs are created

If future work depends on stronger cleanup guarantees, revisit this lifecycle explicitly rather than assuming the current map is self-pruning.

## Post-Completion Flow

### 1. AgentExecutor reaches completion

`AgentExecutor` receives a completion event from the model and calls `checkPostCompletion(...)` before publishing anything.

### 2. PostCompletionChecker builds `PostCompletionContext`

`PostCompletionChecker` collects:

- final message content
- output token count
- tool calls made during this RAL
- conversation history
- available tools
- todo list state
- silent-completion request state
- conversation-wide pending delegation count
- whether the completion used the error fallback

The conversation-wide pending delegation count is intentionally not RAL-scoped:

- `pending-todos` should stay suppressed if the agent is still waiting on work from an earlier RAL in the same conversation

### 3. SupervisorOrchestrator evaluates heuristics

For each applicable heuristic:

1. skip it only if it is already enforced and its mode is `once-per-execution`
2. run `detect(...)`
3. if `skipVerification` is set, synthesize a violation directly
4. otherwise call `SupervisorLLMService.verify(...)`
5. build the correction action

Possible correction action types:

- `inject-message`
- `block-tool`
- `suppress-publish`

Current default post-completion heuristics use:

- `inject-message`
- `suppress-publish`

### 4. PostCompletionChecker applies the correction

If the result is `inject-message`:

- it queues a `supervision-message`
- the current completion is allowed to finish
- the message appears on a later request

If the result is `suppress-publish` plus `reEngage: true`:

- it queues a `supervision-correction`
- it returns `shouldReEngage: true`
- `AgentExecutor` immediately runs the agent again instead of publishing

The reminder queue is described in `docs/CONTEXT-MANAGEMENT-AND-REMINDERS.md`. Supervision uses that queue so corrections affect the model-facing prompt without mutating the canonical transcript.

### 5. AgentExecutor makes the final publish decision

If supervision does not re-engage the agent, `AgentExecutor` still re-checks `RALRegistry.hasOutstandingWork(...)` before deciding whether to publish:

- a final completion
- or an ordinary conversation message

This is separate from supervision. Supervision enforces behavior rules. `hasOutstandingWork(...)` enforces runtime execution state such as queued injections and delegation completion handling.

## Repeatable Gates and Final Corrections

`MAX_SUPERVISION_RETRIES` is currently `3`.

Old behavior:

- a re-engaging heuristic could be marked enforced once
- later completion attempts in the same execution could pass simply because the heuristic had already fired once
- after enough retries, the system could fall through to "publish anyway"

Current behavior for `repeat-until-resolved` heuristics:

- the heuristic is re-checked on every completion attempt
- reaching the retry limit does not allow publish-through
- on the last allowed retry, TENEX injects a stronger final correction
- after the limit is reached, TENEX keeps blocking and keeps the gate active

The final correction is intentionally directive. It tells the agent that the turn still cannot complete and that it must resolve the issue in structured state.

## Structured Resolution Paths

The supervision design deliberately prefers structured state changes over free-text excuses.

### Continue the work

If the agent is genuinely not finished, it should keep working and update its todo list as progress changes.

### Use `ask()`

If the agent cannot continue without human input or external confirmation, it should call `ask()`.

Why this matters:

- `ask()` immediately registers a `PendingDelegation` of type `ask`
- `pending-todos` sees the resulting `pendingDelegationCount > 0`
- the todo gate is then suppressed because the agent is now waiting on a structured external dependency

### Mark items `skipped`

If a todo item is no longer relevant, the agent should call `todo_write` and mark it:

- `status: "skipped"`
- `skip_reason: "..."`

This is the structured way to say "I intentionally did not do this item."

### What TENEX does not currently use

TENEX does not currently use a separate `blocked` todo status for supervision. The current structured exits are:

- `done`
- `skipped` with `skip_reason`
- pending delegation state such as `ask()`

## Why `pending-todos` Is Repeatable

This heuristic is the clearest example of why enforcement mode matters.

The relevant distinction is:

- "the warning was delivered"
- "the todo state changed"

Those are not equivalent.

If an agent is told "you still have pending todos" and then responds with another completion attempt that leaves the same todo state intact, the gate must fire again. The system should not infer that the agent had a valid reason just because it received the first warning.

For `pending-todos`, the condition is considered resolved only when one of these becomes true:

- all remaining todo items are `done`
- remaining abandoned items are `skipped` with reasons
- the agent is now waiting on a structured dependency such as `ask()` or another delegation

## Telemetry and Tracing

Important span events in the current implementation include:

- `supervision.heuristics_registered`
- `supervision.heuristic_checked`
- `supervision.violation_detected`
- `supervision.heuristic_skipped`
- `executor.supervision_violation`
- `executor.supervision_repeatable_gate_triggered`
- `executor.supervision_final_correction`
- `executor.supervision_correction`
- `executor.supervision_pending_delegations`

The most important recent addition is `supervision.heuristic_skipped`, which makes it visible when a heuristic did not run because it had already been enforced under `once-per-execution` semantics.

## How To Extend This System Safely

If you add or change a supervision heuristic:

1. Decide whether it is a nudge or a gate.
2. Set `enforcementMode` explicitly.
3. Decide whether the detection is objective enough for `skipVerification`.
4. Make sure the correction message points the agent toward structured state transitions, not just prose.
5. Add integration coverage through `PostCompletionChecker` if the heuristic affects completion blocking.

If you change retry behavior:

1. check `SupervisorOrchestrator`
2. check `PostCompletionChecker`
3. check reminder queue semantics in `docs/CONTEXT-MANAGEMENT-AND-REMINDERS.md`
4. check final publish behavior in `AgentExecutor`

If you change the valid ways an agent can stop with unfinished work:

1. update this document
2. update the `pending-todos` correction copy
3. update the relevant tool semantics such as `ask()` or `todo_write`
4. add tests proving the new state is machine-visible to supervision

## Files To Read First

If you need to work on this subsystem, start here:

- `src/agents/supervision/types.ts`
- `src/agents/supervision/registerHeuristics.ts`
- `src/agents/supervision/SupervisorOrchestrator.ts`
- `src/agents/execution/PostCompletionChecker.ts`
- `src/agents/execution/AgentExecutor.ts`
- `src/agents/supervision/heuristics/PendingTodosHeuristic.ts`
- `src/tools/implementations/ask.ts`
- `src/tools/implementations/todo.ts`
- `docs/CONTEXT-MANAGEMENT-AND-REMINDERS.md`
- `docs/DELEGATION-AND-RAL-PROCESSING.md`
