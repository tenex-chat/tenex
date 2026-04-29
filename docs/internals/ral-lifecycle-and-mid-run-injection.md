---
title: "Rust RAL Lifecycle And Mid-Run Injection"
date: "2026-04-29"
audience: "llms"
scope: "How the Rust project runtime and tenex-agent coordinate RAL tags, driver ownership, concurrent executions, and user messages that arrive while an agent is already running."
status: "investigated"
related_docs:
  - "docs/RUST-AGENT-SPEC.md"
  - "crates/tenex-agent/AGENTS.md"
related_files:
  - "tenex/src/runtime_cmd/mod.rs"
  - "crates/tenex-agent/src/main.rs"
  - "crates/tenex-agent/src/hook.rs"
  - "crates/tenex-agent/src/injections.rs"
  - "crates/tenex-agent/src/runtime_state.rs"
  - "crates/tenex-agent/src/tools/recording.rs"
  - "crates/tenex-context/src/projection.rs"
  - "crates/tenex-context/tests/projection_active_tools.rs"
  - "scripts/tenex-runtime-probe-shell-scenario.ts"
  - "scripts/tenex-runtime-probe-shell-verdicts.ts"
confidence: "high for current Rust source"
---

# Rust RAL Lifecycle And Mid-Run Injection

## Question

How does the Rust TENEX runtime manage a RAL's lifecycle, and what happens when a new user message arrives while the target agent is already running?

## Short Answer

The current Rust runtime does not have the TypeScript `RALRegistry` model. There is no durable RAL object with pending delegations, queued injections, and cleanup state. Instead, the Rust project runtime in `tenex/src/runtime_cmd/mod.rs` owns process dispatch, per-agent/per-conversation scheduling, runtime-control sockets, and conversation persistence. The `tenex-agent` binary in `crates/tenex-agent` is a one-shot process: it reads exactly one triggering Nostr event from stdin, performs one or more internal LLM turns, emits signed Nostr events as NDJSON on stdout, and exits.

In Rust, "RAL" is currently represented on emitted events as the `llm-ral` tag. `crates/tenex-agent/src/emit.rs` stores an invocation-local `AgentMeta { ral }`; `EmitHook` increments it when an LLM streaming response finishes. Intermediate `ConversationIntent` events and the final `CompletionIntent` are tagged with that number. Streaming deltas and tool-use events also use the current value so downstream consumers can associate them with the active response attempt.

Mid-run user-message delivery is coordinated through the conversation database and the runtime dispatch queue. The runtime always persists inbound user events before dispatch. If the target agent/conversation is actively driving an LLM call, the runtime queues the new dispatch. If the current execution has released the driver because it is in a tool call, a second `tenex-agent` execution can start for the new message. Inside `tenex-agent`, `MessageInjectionTracker` scans the persisted conversation for newer user messages and injects them as system reminders before the next LLM call or after a tool result. Consumed event ids are recorded under `conversations.runtime_state_json.rustRuntime.consumedMessages` so the runtime can drop queued jobs that the current run already absorbed.

Active tools are represented twice for later executions. `RecordingTool` writes an in-flight tool record to `rustRuntime.activeTools` as soon as a tool starts, using the synthetic TENEX tool call id it minted at dispatch time. `tenex_context::project()` now reads those active records and projects each one as a structured assistant `tool_call` followed by a `ToolResult` whose content is a `<system-reminder type="pending-tool-result">`. This means a fresh execution sees that an earlier user request already caused a tool call even though the final tool result has not arrived. Tool-specific operational reminders, such as `active-shell-tasks`, still exist separately when a later turn needs runtime control ids like `shell-...` for `kill(target=...)`.

## System Map

`tenex/src/runtime_cmd/mod.rs` is the Rust project runtime. It subscribes to relay events, selects the target project agent, persists inbound user messages, coordinates dispatch for each `(agent_pubkey, conversation_id)`, spawns `tenex-agent`, forwards agent stdout to the relay, and persists eligible assistant events.

`DispatchCoordinator` is the runtime's in-memory scheduler. Each `(agent_pubkey, conversation_id)` has an entry with `active_runs`, `driver_busy`, and a queue of pending `DispatchJob`s. It starts the first job immediately, queues messages while the driver is busy, starts concurrent jobs when the driver is free, and after a run finishes keeps only the newest queued job.

`ConversationStore` is the durable coordination surface. User messages, assistant messages, prompt history, tool messages, and opaque runtime state live in the per-project `conversation.db`. The Rust runtime and `tenex-agent` both open the same database.

`RuntimeStateHandle` in `crates/tenex-agent/src/runtime_state.rs` writes the Rust-specific runtime state under `rustRuntime`: the current driver, active tool calls, consumed injected messages, and telemetry sidecars. Its driver lock is persisted so new runtime dispatch can see a busy LLM even across process boundaries.

`EmitHook` in `crates/tenex-agent/src/hook.rs` bridges the LLM streaming loop to TENEX events and runtime state. It acquires the persistent driver before a provider call, emits text deltas, increments RAL after each streamed LLM response, releases the driver when a tool call starts or a stream finishes, emits tool-use events, and holds the final response for `main.rs` to publish with usage.

`MessageInjectionTracker` in `crates/tenex-agent/src/injections.rs` is the Rust mid-run injection mechanism. It snapshots the triggering message sequence, then later reads the conversation DB for newer injectable user messages. It emits an XML-like system reminder and marks any injected event ids consumed.

`RecordingTool` in `crates/tenex-agent/src/tools/recording.rs` wraps every tool. It records tool calls for later prompt-history persistence, updates active-tool runtime state, and appends active-tool or injected-user-message reminders to successful tool results.

`tenex_context::project()` in `crates/tenex-context/src/projection.rs` owns prompt-history projection. It reads persisted messages, completed tool messages, and current `rustRuntime.activeTools`. Completed tool messages become normal assistant `tool_calls` plus `ToolResult`s. Active tools become synthetic pending pairs, using the same tool-call id and args from runtime state, so providers see a valid tool-use/tool-result ordering rather than an orphan reminder.

The runtime control socket in `tenex/src/runtime_cmd/control.rs` is separate from message injection. It lets tools run shells, list active shell tasks, and kill shell or agent process groups.

## Runtime Flow

1. The Rust project runtime receives a Nostr event from the relay. It filters duplicate events with `seen`, ignores agent-authored events unless they target a project agent, handles stop commands, selects the target agent from `p` tags or the PM fallback, derives the conversation id, and builds a `DispatchJob`.
2. `accept_dispatch()` persists the inbound event to `messages` as a user message before scheduling. Targeted `p` tags are stored in `targeted_pubkeys_json`; untagged project messages remain untargeted.
3. The runtime checks persisted `rustRuntime.driver` for the same agent/conversation and synchronizes that into `DispatchCoordinator.driver_busy`.
4. If no run is active, `DispatchCoordinator` starts the job. If a run is active and the driver is busy, it queues the job. If a run is active but the driver is free, it starts a concurrent job. A whitelisted user can also preempt a busy driver when the runtime sees active shell tasks for that agent/conversation; that child process receives `TENEX_RUNTIME_DRIVER_PREEMPT=1`.
5. `spawn_dispatch_job()` starts `tenex-agent` with the agent JSON path, `TENEX_PROJECT_ID`, `TENEX_EXECUTION_ID`, `TENEX_RUNTIME_CONTROL_SOCKET`, optional MCP socket environment, and exactly one triggering event on stdin. Stdin is then closed.
6. `tenex-agent` opens the project and conversation database, ensures the conversation row exists, creates a `RuntimeStateHandle`, and constructs a `MessageInjectionTracker`. The tracker marks the trigger event consumed and uses the trigger's message sequence as its lower bound.
7. The agent builds the system prompt, loads persisted todos and self-applied skills, loads prompt history through `tenex_context::project()`, builds tools, installs `EmitHook`, and enters the outer `'agent_loop`.
8. At the start of each outer loop iteration, the agent calls `MessageInjectionTracker::take_new_messages()`. If newer injectable user messages exist, it appends an `<system-reminder type="injected-user-messages">` block to the current turn message before calling the LLM.
9. During the provider call, `EmitHook::on_completion_call()` acquires the persistent driver. Text deltas are emitted as kind `24135` stream events. When an LLM streamed response finishes, the hook increments `AgentMeta.ral`, releases the driver, stores the new response as pending, and emits the previous pending response as an intermediate `ConversationIntent`.
10. Before each tool call, `EmitHook::on_tool_call()` releases the driver and emits a `ToolUseIntent` event, except for `delegate`, which emits its own tool-use event after it has a delegation event id to reference.
11. The wrapped tool records active state through `RuntimeStateHandle::start_tool()` and `finish_tool()`. After a successful tool result, `RecordingTool` appends reminders for still-active tools from other executions and calls `MessageInjectionTracker::take_new_messages()` again. This is the main way a user message that arrived during a long tool call enters the currently running execution.
12. After the inner Rig multi-turn stream ends, `main.rs` releases the driver, persists tool messages, records the visible user/assistant turn through `tenex_context::record_turn()`, and emits the final pending response as a `CompletionIntent` with usage unless `no_response` set the shared suppression flag.
13. Post-completion supervision can return `ReEngage`. In that case the agent appends the just-completed user/assistant pair to `re_engage_history`, replaces `current_message`, and repeats the outer loop. That repeat creates another opportunity to inject newer user messages before the next LLM call.
14. The runtime reads each NDJSON event from stdout. It publishes events to the relay, persists eligible plain assistant text back to the conversation DB, dispatches agent-targeted events such as delegations, and updates in-memory driver state: stream-delta events mark the driver busy, and events tagged `tool` mark it free.
15. When the child process exits, the runtime reads `rustRuntime.consumedMessages`, drops queued jobs whose event ids were consumed by the finished run, publishes active status, and starts the newest remaining queued job if any.

## Mid-Run Injection Cases

If a new user event arrives while the current execution is inside an LLM call, the persisted driver is busy. The runtime stores the new user message and queues its dispatch. The already-running agent will not receive new stdin. It can only absorb the message if it later reaches a tool-result boundary or a new outer-loop iteration and `MessageInjectionTracker` reads the DB row. If that happens, the event id is marked consumed and the runtime drops the queued dispatch after the current process exits. If it does not happen, the queued event becomes the trigger for a later `tenex-agent` process.

If a new user event arrives while the current execution is inside a tool call, `EmitHook` has released the driver. The runtime can start a concurrent `tenex-agent` execution for the new event. The new process marks its trigger consumed. The old process may also check for injected messages after the tool result, but `consumedMessages` is the cross-execution guard that prevents already-consumed event ids from being injected twice.

If a new user event arrives after the current execution has released the persistent driver but before process cleanup completes, `accept_dispatch()` re-reads `rustRuntime.driver` and syncs that into the in-memory coordinator. That means a second execution can start before the first child process exits if the DB driver is already free. If no new event arrives, process exit and `finish_run()` clear the scheduler state and start any remaining newest queued job.

If the new event is from a whitelisted user and there are active shell tasks for that agent/conversation, the runtime treats it as a shell intervention. It can start a new execution even when the driver is busy and sets `TENEX_RUNTIME_DRIVER_PREEMPT=1`, causing `RuntimeStateHandle::acquire_driver()` to skip waiting. This is a special intervention path, not general live injection.

## Active Tool Projection

The important concurrency edge case is a foreground tool that is still running when the user sends another message. The first execution has emitted a tool-use Nostr event and has a real OS/process side effect, but it has not yet reached the code path that persists a completed `tool_messages` row or records the finished prompt turn. Without active-tool projection, a fresh execution sees the user request, but not the corresponding tool call, and can incorrectly repeat the work.

The source shows this lifecycle:

1. `RecordingTool::call()` mints a UUID call id before it invokes the inner tool. Rig's `ToolDyn::call` boundary does not surface the provider-assigned tool-use id, so this TENEX id is the canonical id used for prompt projection.
2. `RuntimeStateHandle::start_tool()` writes `agentPubkey`, `conversationId`, `executionId`, `toolCallId`, `toolName`, `args`, and `startedAt` under `rustRuntime.activeTools`.
3. Another execution for the same agent/conversation calls `tenex_context::project()` before its next LLM request. Projection filters active tools to the same agent and conversation, ignores any call ids that already have completed tool messages, sorts them by `startedAt`, and inserts each pending pair into the message stream by timestamp.
4. The projected pair is provider-valid: an empty assistant message with `tool_calls: [{ id, name, arguments }]`, immediately followed by a `ToolResult` with the same `tool_call_id` and a pending-result system reminder.
5. When the original tool finishes, `RuntimeStateHandle::finish_tool()` removes the active entry. The normal completed tool-message path then owns future replay.

For the shell intervention case, this produces two complementary signals in the fresh turn. The structured pending pair tells the model, "the earlier `run sleep 60` already invoked `shell` and is waiting." The shell-control reminder tells it which `shell-...` runtime task id can be killed. The structured pair prevents duplicate work; the shell reminder enables the operational action.

## State And Data

`messages.sequence` is the injection cursor. `MessageInjectionTracker::initial_sequence()` finds the trigger's sequence, or falls back to the current max sequence. Later messages must have a larger sequence to be injectable.

An injectable message must be a user-role message, must not be authored by the same agent pubkey, and must either target the agent's pubkey or be untagged while the current agent is the project PM. Untagged messages are not injected into non-PM workers.

Consumed messages are stored in `runtime_state_json` as:

```json
{
  "rustRuntime": {
    "consumedMessages": {
      "<event-id>": {
        "agentPubkey": "<agent>",
        "conversationId": "<conversation>",
        "executionId": "<execution>",
        "eventId": "<event-id>",
        "consumedAt": 0
      }
    }
  }
}
```

The persistent driver lives in the same `rustRuntime` object. It records `agentPubkey`, `conversationId`, `executionId`, and `acquiredAt`. A driver older than ten minutes is treated as stale by both the agent-side runtime state handle and runtime-side dispatch check.

Active tool state is also persisted under `rustRuntime.activeTools`, keyed by execution id and tool call id:

```json
{
  "rustRuntime": {
    "activeTools": {
      "<execution-id>:<tool-call-id>": {
        "agentPubkey": "<agent>",
        "conversationId": "<conversation>",
        "executionId": "<execution>",
        "toolCallId": "<tool-call-id>",
        "toolName": "shell",
        "args": { "command": "sleep 60" },
        "startedAt": 0
      }
    }
  }
}
```

`toolCallId` exists from the moment the tool starts. It is not the provider's hidden id; it is the UUID minted by TENEX's recording wrapper and later reused as both `ToolCall.id` and `ToolResult.tool_call_id` during projection. `startedAt` is normalized to milliseconds during projection so second-based Nostr timestamps and millisecond runtime timestamps can be ordered together.

The RAL counter is invocation-local. `AgentMeta.ral` starts at `0`; `EmitHook` increments it after each LLM response finishes. The counter is encoded into Nostr tags through `EncodingContext.ral` and `add_standard_tags()`. It is not the TypeScript concept of a durable RAL number with restart recovery or delegation ownership.

The Rust runtime persists plain assistant text events from stdout only when they are kind:1, belong to the current conversation root, have no `p` recipient, and are not tagged as tool/status/intent/reasoning/error. Tool events and stream deltas are published but not materialized as assistant transcript messages by that path.

## Contracts And Invariants

`tenex-agent` must remain one-shot. It reads one event from stdin and cannot accept live user input over stdin after startup. Mid-run injection is implemented by reading already-persisted conversation rows at LLM/tool boundaries.

Only one ordinary execution for an agent/conversation should drive the LLM at a time. The runtime enforces this with `DispatchCoordinator.driver_busy`; the agent enforces it with the persisted `rustRuntime.driver`. Driver release around tool calls is intentional because tools can block for a long time and the system may need to accept fresher user input.

A message consumed as an injected reminder must be recorded in `rustRuntime.consumedMessages`. Without that marker, the runtime would later run the queued dispatch for the same user event and the agent could respond twice.

Queued dispatch is lossy by design after a run finishes: `finish_run()` starts the newest queued job and clears older queued jobs. This relies on either injection consumption or the newest message carrying the latest user intent for that agent/conversation.

`delegate`, `self_delegate`, `delegate_followup`, and `ask` are normal Rust tools that emit Nostr intents. They do not create a TypeScript-style parent RAL entry. The normal `delegate` tool returns a tool result telling the model to stop; the emitted delegation event can be dispatched immediately by the runtime if it targets a project agent.

`no_response` does not stop the process directly. It sets an `Arc<AtomicBool>`. After the LLM loop ends, `main.rs` checks that flag before emitting the final `CompletionIntent`.

Active tool projection must always emit a matched assistant tool call before the pending tool result. A bare `ToolResult` would be rejected by providers that enforce tool-use/result pairing. The pending pair is filtered to the same agent and conversation, and completed tool call ids win over active state so a stale active entry cannot duplicate a finished tool result.

The active-tool pending result is informational, not a successful tool output. Models should account for the in-flight side effect and avoid repeating the same tool call solely because the final result is unavailable. A later tool-specific reminder may still be required to expose external control identifiers, such as shell task ids.

## Failure And Recovery

If a provider produces a single text-only response and exits before another tool or supervision loop happens, a user message queued during that LLM call is not injected into the current process. The runtime handles it by starting a later queued dispatch unless the process consumed it before exit.

If the runtime or agent process dies while holding `rustRuntime.driver`, later dispatch treats the driver as busy until the ten-minute stale threshold passes. There is no source-visible reconstruction of an in-flight Rust agent process from the DB.

If two executions overlap, `consumedMessages` is the deduplication layer. The source shows tests for "already consumed messages are not injected", but exact races between a just-started concurrent process and an old process finishing a tool rely on the order in which each process writes consumed markers.

If active-tool projection is missing or filtered incorrectly, a fresh execution can see the user request that caused the running tool without seeing the tool call. The user-visible symptom is duplicate work, such as a second `sleep 60` shell call after the user asks to kill the first one. The `shell-kill-duplicate` runtime probe captures this regression shape.

If an active-tool entry is left behind after a process crash, future turns can see a pending pair for work that is no longer running. The current source removes active tools on normal tool completion. The doc did not prove a separate active-tool stale-expiration policy analogous to the ten-minute driver stale threshold.

If an agent emits malformed NDJSON, the runtime logs and ignores that line. If the child exits non-zero, the runtime logs the failure, publishes status, and can still continue to queued jobs.

Stop commands are handled outside message injection. The runtime marks the agent blocked in `AgentContextState`, kills active agent process groups and shell tasks through the control state, then publishes active status.

## Observability

Runtime logs include `received event`, `dispatching`, `agent run failed`, `relay publish failed`, and stop-command messages. Runtime dispatch spans are named `tenex.runtime.dispatch` and carry event id, project id, conversation id, agent slug, and agent pubkey.

Agent spans include `tenex.agent.process`, `tenex.agent.turn`, and `tenex.agent.tool_call`. The agent also writes stderr status lines for startup, provider/model choice, trigger event id, history length, completion, and supervision re-engagement.

Wire events expose the lifecycle. Kind `24135` stream deltas carry `llm-ral` and `stream-seq`; tool-use events carry `tool` and optional `tool-args`; final visible responses carry `status=completed` through `CompletionIntent`.

The conversation DB is the best local inspection point. Check `messages` for persisted inbound user rows and assistant text, `agent_context_state` for todos/self-applied skills/blocked state, `tool_messages` and prompt history for tool replay, and `conversations.runtime_state_json.rustRuntime` for driver, active tools, consumed messages, and telemetry.

Useful focused tests are embedded in `crates/tenex-agent/src/injections.rs`, `crates/tenex-agent/src/runtime_state_tests.rs`, `tenex/src/runtime_cmd/mod.rs`, and `tenex/src/runtime_cmd/control_tests.rs`. They cover targeted injection, PM-only untagged injection, consumed-message suppression, driver staleness, dispatch queuing, concurrent dispatch while the driver is free, shell intervention preemption, and control-socket behavior.

`crates/tenex-context/tests/projection_active_tools.rs` proves the prompt-shape contract for active tools. It builds a conversation with `run sleep 60`, an in-flight `shell` active-tool entry, and a later `kill the shell` user message. The expected projection order is user request, assistant tool call, pending tool result, later user message.

The `shell-kill-duplicate` runtime probe in `scripts/tenex-runtime-probe-shell-scenario.ts` exercises the process boundary. It boots the real runtime and relay, starts a foreground `sleep 60`, sends `kill the shell` while the first shell is running, and asserts the fresh model request contains both `active-shell-tasks` and `pending-tool-result`. `scripts/tenex-runtime-probe-shell-verdicts.ts` fails the run if the kill turn launches a second `sleep 60`.

## Source Guide

Read `tenex/src/runtime_cmd/mod.rs` for dispatch, inbound persistence, queueing, driver-state synchronization, child-process spawning, stdout handling, delegation redispatch, consumed-message queue dropping, and status publication.

Read `crates/tenex-agent/src/main.rs` for one-shot process setup, prompt/history construction, outer re-engagement loop, injection-before-turn behavior, tool persistence, prompt-history recording, final completion emission, and `no_response` suppression.

Read `crates/tenex-agent/src/hook.rs` for driver acquire/release, stream deltas, RAL counter increments, intermediate conversation emission, tool-use emission, and pre-tool supervision.

Read `crates/tenex-agent/src/injections.rs` for the precise user-message injection filter and consumed-message marking.

Read `crates/tenex-agent/src/runtime_state.rs` and `runtime_state_json.rs` for the persisted `rustRuntime` schema and atomic DB updates.

Read `crates/tenex-agent/src/tools/recording.rs` for tool-call recording, active-tool state, and after-tool injection/reminder behavior.

Read `crates/tenex-context/src/projection.rs` for how completed tool messages and active tool records become provider-facing message pairs.

Read `crates/tenex-context/tests/projection_active_tools.rs` for the minimal regression fixture for pending active-tool projection.

Read `scripts/tenex-runtime-probe-shell-scenario.ts` and `scripts/tenex-runtime-probe-shell-verdicts.ts` for the end-to-end shell duplicate guard.

Read `crates/tenex-protocol/src/context.rs`, `intent.rs`, and `nostr/encoder.rs` for how `EncodingContext.ral` becomes `llm-ral` tags on emitted Nostr events.

## Open Questions

The source proves DB-based injection at outer-loop and tool-result boundaries. It does not show provider-side live insertion into an already-running LLM request in the Rust path. Treat Rust mid-run injection as boundary-based, not token-stream live-editing.

The Rust delegation path emits and redispatches Nostr events, but it does not yet mirror the TypeScript parent-RAL pending/completed delegation registry described in older docs. Future Rust orchestrator work may add a richer durable ownership model.

The active-tool pending projection relies on the TENEX-minted recording id. The source shows this id is stable inside runtime state and persisted tool messages, but the provider's hidden tool-use id remains unavailable at the `ToolDyn::call` boundary.

No TypeScript comparison was added for active-tool projection. This investigation focused on the current Rust path and the reproduced Rust runtime probe.
