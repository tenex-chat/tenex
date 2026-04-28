# tenex-supervision

Library crate. Provides supervision heuristics for the TENEX agent runner. Detects misbehavior patterns (missing todo lists, incomplete work) and produces correction signals without invoking an LLM.

Sits between the agent runner loop (`tenex-agent`) and the rig hook layer. No dependencies on rig, tenex-protocol, or any I/O.

## Public API

- `heuristics::default_supervisor()` — constructs a `Supervisor` wired with all default heuristics.
- `Supervisor::check_pre_tool(tool_name, todos, category) -> Option<String>` — called before each tool invocation. Returns a block reason if the call should be rejected.
- `Supervisor::check_post_completion(todos, pending_delegation_count, triggering_message) -> PostCompletionOutcome` — called after each agent completion. Returns `Accept` or `ReEngage { message }`.
- `Supervisor::record_tool_call(tool_name)` — must be called for every tool that was not blocked, so heuristics have an accurate call count.

Key types: `AgentCategory`, `TodoEntry`, `TodoStatus`, `PostCompletionContext`, `PreToolContext`, `Detection`, `EnforcementMode`, `PostCompletionOutcome`.

## Heuristics

Three heuristics are wired by `default_supervisor()`:

| Name | Kind | Trigger | Enforcement |
|---|---|---|---|
| `pending-todos` | post-completion | active todos exist | `RepeatUntilResolved` |
| `consecutive-tools-without-todo` | post-completion | 5+ tool calls, no todos, not yet nudged | `OncePerExecution` |
| `worker-todo-before-file-or-shell` | pre-tool | `worker` category, no todos, protected tool | `RepeatUntilResolved` |

## How to approach changes

1. New heuristics live as `src/heuristics/<name>.rs` plus registration in `src/heuristics/mod.rs::default_supervisor()`.
2. Each post-completion heuristic implements `PostCompletionHeuristic`; each pre-tool heuristic implements `PreToolHeuristic`.
3. No LLM calls, no I/O, no async. All checks are pure synchronous logic over the context structs.
4. Do not import crates from the broader workspace — this crate has no workspace dependencies by design.
