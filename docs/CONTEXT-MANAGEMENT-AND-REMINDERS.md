# TENEX Context Management And Reminders

This document explains how request-time context management works in TENEX after reminder handling was merged into `ai-sdk-context-management`.

The short version:

- TENEX keeps the canonical transcript immutable.
- TENEX keeps a separate per-agent prompt-view history of what was actually sent.
- Reminders are computed at request time by `RemindersStrategy`.
- Runtime-only reminders are stored as append-only prompt overlays, not as edits to old user messages.

## Design Invariants

These rules are intentional and should not be broken by future refactors:

1. Canonical conversation history is the source of truth for the transcript.
2. Historical prompt state is append-only per agent.
3. Runtime reminders must not rewrite historical transcript messages.
4. Reminder delta/full bookkeeping is separate from prompt-history storage.

The bug that drove this design was prompt corruption from repeatedly appending runtime reminder content into older user messages. That caused prompt drift, duplicated reminder blocks, and unbounded prompt growth. The current architecture exists to prevent that.

## Main Pieces

### TENEX runtime wiring

- `src/agents/execution/context-management/runtime.ts`
- `src/agents/execution/request-preparation.ts`
- `src/agents/execution/StreamSetup.ts`
- `src/agents/execution/StreamCallbacks.ts`

TENEX constructs an `ai-sdk-context-management` runtime per execution context and passes current request facts into it.

### Library strategies

- `ai-sdk-context-management/src/strategies/reminders/index.ts`

`RemindersStrategy` owns reminder production and placement.

### TENEX reminder providers

- `src/agents/execution/system-reminders.ts`

TENEX supplies provider-specific reminder facts and reminder renderers for:

- `datetime`
- `todo-list`
- `response-routing`
- `delegations`
- `conversations`
- `loaded-skills`

Non-loaded skills are not exposed through a system reminder. Agents must use `skill_list` to discover available skills on demand.

TENEX also enables the library-owned built-in reminder sources for:

- context utilization
- context-window status

### Runtime-only reminder queue

- `src/llm/system-reminder-context.ts`

This is an `AsyncLocalStorage` queue for current-cycle reminders such as supervision corrections or one-shot runtime notices. It supports:

- `queue(...)`
- `defer(...)`
- `advance()`
- `collect()`

This queue is not the main reminder engine. It is an ingress path for transient reminders that should affect the current or next request without being written into the canonical transcript.

### Persistence

- `src/conversations/ConversationStore.ts`
- `src/conversations/types.ts`

TENEX persists three different kinds of state:

1. Canonical transcript state
2. Per-agent prompt history
3. Per-agent reminder engine state

Those are separate on purpose.

## End-To-End Request Flow

### 1. Compile canonical prompt material

`MessageCompiler` compiles the canonical conversation projection for the current turn.

That output is still canonical conversation state. It does not yet include request-time overlays from context management.

### 2. Promote deferred current-cycle reminders

At the start of execution, `StreamSetup.ts` calls:

```ts
getSystemReminderContext().advance();
```

This promotes reminders that were deferred from the previous cycle into the current queued reminder set.

### 3. Build `reminderData`

TENEX assembles current turn facts in `StreamSetup.ts` or `StreamCallbacks.ts`, including:

- the agent
- the conversation store
- the responding principal
- pending and completed delegations
- rendered conversation summary content
- loaded skills
- skill tool permissions
- project path

This object is passed into context management as `reminderData`.

### 4. Build prompt history from canonical messages only

Before context management runs, TENEX calls:

- `buildPromptHistoryMessages(...)` in `src/agents/execution/prompt-history.ts`

This appends any newly visible canonical messages into the agent's frozen prompt history.

Important: this first pass does not inject runtime overlays yet.

### 5. Prepare the provider-facing request

`prepareLLMRequest(...)` in `src/agents/execution/request-preparation.ts` does the request-time transformation step.

It:

1. normalizes legacy message shapes
2. collects queued current-cycle reminders from `getSystemReminderContext().collect()`
3. maps them into `queuedReminders`
4. calls `contextManagement.prepareRequest(...)`

At this point TENEX passes two reminder inputs into the library:

- `reminderData`: the persistent, domain-level facts for the turn
- `queuedReminders`: transient current-cycle reminders from the async reminder context

### 6. Strategy stack runs inside `ai-sdk-context-management`

In `src/agents/execution/context-management/runtime.ts`, TENEX currently wires a stack shaped like:

1. `ScratchpadStrategy` when available
2. `CompactionToolStrategy` when enabled
3. `ToolResultDecayStrategy` when enabled
4. `RemindersStrategy` when enabled

The exact toggles come from `src/agents/execution/context-management/settings.ts`.

### 7. `RemindersStrategy` computes reminder output

`RemindersStrategy` is now the only strategy allowed to apply reminders to the prompt.

It owns:

- built-in reminder sources
- provider full/delta/skip logic
- reminder placement
- deferred reminder replay
- reminder state persistence via the store callback

It returns reminder content in one of three placements:

- `overlay-user`
- `latest-user-append`
- `fallback-system`

### 8. Runtime overlays are appended to prompt history

If context management returned `runtimeOverlays`, TENEX performs a second append-only prompt-history pass:

- `StreamSetup.ts`
- `StreamCallbacks.ts`

These overlays are added as standalone `runtime-overlay` prompt-history entries.

This is the key safety property:

- old user messages remain unchanged
- new runtime-only prompt material is stored as new prompt-history entries

### 9. Save only when state changed

TENEX saves the conversation if any of these changed:

- canonical prompt-history entries were appended
- runtime overlay prompt-history entries were appended
- reminder engine state changed

## Reminder Placement Model

### `overlay-user`

Used for dynamic reminder content that should remain separate from historical user content.

The library emits a standalone user-role overlay message and TENEX stores it as a runtime overlay in prompt history.

This is the safest placement for volatile state.

### `latest-user-append`

Used when reminder content should be appended to the latest user message in the outgoing prompt only.

This affects the current request but does not rewrite the canonical transcript stored in `ConversationStore`.

### `fallback-system`

Used when reminder content should be emitted as a secondary system message.

## Reminder State Persistence

Reminder engine state is stored in:

- `ConversationState.contextManagementReminderStates`

and accessed via:

- `getContextManagementReminderState(agentPubkey)`
- `setContextManagementReminderState(agentPubkey, state)`
- `clearContextManagementReminderState(agentPubkey)`

This state tracks things like:

- prior provider snapshots
- turns since full reminder emission
- deferred reminders

It is separate from prompt history because these are different concerns:

- prompt history answers "what did the model see?"
- reminder state answers "what reminder facts were already conveyed?"

## Prompt History Model

Per-agent prompt history lives in `src/agents/execution/prompt-history.ts`.

Each frozen entry is either:

- `canonical`
- `runtime-overlay`

Canonical entries come from the conversation projection.

Runtime-overlay entries come from request-time overlays such as system reminders.

This preserves a stable, append-only history of what each agent actually saw without mutating the underlying conversation record.

## Current-Cycle Reminder Queue

The async reminder context in `src/llm/system-reminder-context.ts` is for transient reminders that should not become part of canonical reminder facts.

Examples:

- a supervision correction for this cycle only
- a deferred one-shot reminder that should appear on the next cycle

Behavior:

- `queue(...)` affects the next `collect()`
- `defer(...)` affects a future cycle after `advance()`
- `collect()` drains the queued reminders

These reminders are passed to `RemindersStrategy` as `queuedReminders`, so the placement and overlay logic still stays inside the main reminder strategy.

## Configuration Surface

`src/agents/execution/context-management/settings.ts` currently exposes these strategy toggles:

- `reminders`
- `scratchpad`
- `toolResultDecay`
- `compaction`
- `contextUtilizationReminder`
- `contextWindowStatus`

Other relevant controls:

- `tokenBudget`
- `forceScratchpadThresholdPercent`
- `utilizationWarningThresholdPercent`
- `compactionThresholdPercent`

## What Changed Compared To The Older Design

Older design:

- reminder logic was split between a separate reminder package, TENEX host-side wiring, and prompt-history mutation logic
- reminder deltas could leak into old transcript messages
- Anthropic system-prompt behavior was partly treated as a separate reminder concern in the host

Current design:

- reminder orchestration lives in `RemindersStrategy`
- TENEX supplies facts and reminder providers, not the reminder engine itself
- prompt history remains append-only
- runtime overlays remain isolated from canonical transcript history

## Files To Read First

If you need to change this system, start with these files:

- `src/agents/execution/context-management/runtime.ts`
- `src/agents/execution/request-preparation.ts`
- `src/agents/execution/prompt-history.ts`
- `src/agents/execution/system-reminders.ts`
- `src/llm/system-reminder-context.ts`
- `src/agents/execution/StreamSetup.ts`
- `src/agents/execution/StreamCallbacks.ts`
- `src/conversations/ConversationStore.ts`

Then read the library side:

- `../ai-sdk-context-management/src/strategies/reminders/index.ts`
- `../ai-sdk-context-management/src/types.ts`
