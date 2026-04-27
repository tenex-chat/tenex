# How Delegation Works

Delegation is TENEX's mechanism for one agent to assign a task to another. It is not a function call or a subroutine — it is a published Nostr event that creates an entirely new, independent conversation for the receiving agent. The delegating agent fires and continues; it does not block waiting for the child. The Rust daemon wakes the parent when the child finishes.

## The Core Idea

When an agent wants another agent to do something, it publishes a Nostr event. That event's ID becomes the child's conversation ID. The child starts fresh — it receives only the task prompt, not the parent's message history. Everything that happens in the child conversation is tracked separately, and the results are injected into the parent's context when the parent resumes.

## The Delegation Event

A delegation is a standard kind-1 Nostr event with specific tags:

| Tag | Purpose |
|-----|---------|
| `p` | Recipient agent pubkey |
| `delegation` | Parent conversation ID — used to route the child's completion back up |
| `a` | Project reference |
| `llm-ral` | Which RAL issued this delegation |
| `branch` | Git branch for worktree isolation (inherited or explicit) |
| `team` | Team name, when delegating to a team |
| `skill` | Zero or more skill event IDs, inherited from the triggering event |
| `variant` | LLM variant selection, for meta-model routing |

Crucially, there is **no `e` tag**. This is intentional: the absence of a root reference means the delegation starts a brand-new conversation thread rather than replying into an existing one.

## How a Delegation Is Initiated

1. The LLM calls the `delegate` tool with a recipient (agent slug or team name) and a task prompt.
2. The tool resolves the recipient slug to a pubkey. For team names it resolves to the team's lead agent.
3. It checks for circular delegation — if the target agent is already in the current delegation chain, the call is rejected.
4. Skills are assembled: first inherit any skills from the event that triggered this execution, then merge in any explicitly requested skills.
5. The event is published through the worker publisher.
6. The worker immediately registers the delegation as pending with the Rust daemon via a `delegation_registered` frame over stdout.
7. The tool returns a `{success, delegationConversationId, delegationEventId}` result to the LLM. The delegate tool returns once the publish is accepted — not when the child finishes.
8. After the LLM turn ends, the worker emits a `waiting_for_delegation` terminal frame, telling Rust the parent is now suspended pending child completion.

## How the Child Agent Receives Its Task

The Rust daemon continuously subscribes to inbound Nostr events addressed to managed agents. When it sees a delegation event p-tagged to one of its agents:

1. It dispatches an `execute` message to an agent worker process.
2. The `execute` message includes the full delegation event as the triggering envelope, with the `delegation` tag parsed into `delegationParentConversationId`.
3. The worker creates a new conversation whose ID equals the delegation event ID.
4. It builds the delegation chain by walking upward from the parent conversation ID through stored conversation metadata. This chain records the full ancestry: `[user → A] → [A → B (you)]`.
5. The child agent's system prompt includes the full delegation chain so it knows its context in the hierarchy.
6. The child sees the delegation event's content as its first (and only) user message. It has no access to the parent's conversation.

## How Completion Works

When the child agent finishes its task, it publishes a completion event: a kind-1 event with:
- `p` tag pointing to the immediate delegator (not the original human)
- `e` tag with `root` marker referencing the delegation conversation ID
- `status: completed` tag
- Runtime/usage metadata tags

Rust identifies this as a completion by matching the inbound event's root conversation target against its table of pending delegations for the expected delegatee. The `status=completed` and `p` tags carry semantic meaning for clients but the Rust routing is based on the conversation match.

On detecting completion, Rust:
1. Records a `delegation_completed` entry in its RAL journal.
2. Appends a completed delegation marker to the parent conversation's stored state.
3. Decides whether to resume the parent immediately or wait for sibling delegations to finish.

On resume, the TypeScript side:
1. Seeds a delegation snapshot from Rust's RAL journal.
2. RAL resolution converts completed delegation markers into `DelegationMarker` records in the conversation store.
3. Message building expands those markers into readable context for the LLM — a formatted, text-focused transcript of the child's work. Tool events are not replayed verbatim; nested delegation sub-transcripts are compacted to avoid explosive context growth.
4. The parent's LLM sees the child's results inline at the point where the delegation was issued and continues its own reasoning.

## Parallel Delegations

An agent can issue multiple `delegate()` calls in a single LLM turn. These are fully independent — each publishes a separate event, each starts its own child conversation with a distinct ID.

The Rust daemon tracks all pending delegations under the parent's RAL entry (keyed by `projectId + agentPubkey + conversationId + ralNumber`). As children complete one by one:

- If the parent has no other outstanding work, Rust resumes it immediately after each completion.
- If sibling delegations are still running, Rust records each completion but holds the parent in the waiting state.
- If the parent itself is still actively running (a live LLM stream), Rust can inject the completion marker directly into the active worker rather than queuing a separate resume.

The parent publishes a final `complete` event only once there are no outstanding delegations, no queued injections, and no unprocessed completions. Until then, any output from the parent mid-loop is published as an intermediate conversation event — same format, but without the `p` tag and `status: completed`, so it does not trigger completion routing.

## Nested Delegation Chains (A → B → C)

The `delegation` tag is the key routing mechanism for deep hierarchies. When agent A delegates to B, the delegation event carries A's conversation ID in the `delegation` tag. When B delegates to C, B's delegation event carries B's conversation ID.

When C completes, its completion event goes to B (not A). B processes C's result, finishes its own work, and publishes its completion to A. A never directly sees C's events; it sees B's response, which may incorporate C's results.

This also matters for `ask` events inside delegated conversations: if a human responds to a question posed by an agent deep in a delegation tree, the stored delegation chain ensures the response routes to the correct delegating agent, not back to the human as a new conversation.

## Completion Recipient Resolution

The completion `p` tag is resolved from the stored delegation chain, not from the triggering event's sender. The immediate delegator is `chain[length - 2].pubkey` — the second-to-last entry. This matters when a human responds inside a delegated conversation: the triggering event's author is the human, but the completion must still route to the delegating agent.

## The RAL (Request/Agent Lifecycle)

Every agent execution has a RAL — a per-execution lifecycle object keyed by `(projectId, agentPubkey, conversationId, ralNumber)`. The `ralNumber` increments within a conversation each time the agent resumes (RAL 1 = first execution, RAL 2 = first resumption, and so on).

The RAL has these states in sequence:
```
allocated → claimed → waiting_for_delegation → completed
                                             → no_response
                                             → error
                                             → aborted
                                             → crashed
```

Rust owns all RAL journal writes. The TypeScript worker reads the journal via `DelegationJournalReader`, which caches on filesystem mtime and maintains an in-session overlay for events the current worker has emitted but Rust has not yet flushed.

A claim token system prevents concurrent executions from racing to resume the same RAL: Rust pre-claims the RAL before dispatching the resume execution, and the worker atomically transfers that claim when it begins streaming.

## Killing Delegations

The `kill` tool can abort a running or pending delegation:

**Active kill** (child is already running): The system calls `abortWithCascade()`, which aborts the child's active LLM stream, recursively kills any sub-delegations the child has issued, emits `delegation_killed` frames so Rust updates its journal, and adds a 15-second cooldown on the `(project, conversation, agent)` triple to prevent immediate re-routing.

**Preemptive kill** (child has not started yet): Rust marks the delegation as killed in the RAL journal. When the child worker eventually starts, it checks this flag and refuses to publish a completion even if the LLM finishes successfully.

## Follow-Up Messages

A parent can send a follow-up message to an already-running child using the `delegate_followup` tool. This publishes a kind-1 event with a root `e` tag pointing at the original delegation conversation and a `p` tag addressing the child. The child sees this as a new message in its ongoing conversation.

## What Agents Know About Each Other

Agents in a delegation chain receive a `<delegation-chain>` block in their system prompt showing the full ancestry tree, with the current agent marked:

```
[user → orchestrator] [conversation a3f9...]
  → [orchestrator → claude-code (you)] [conversation 8b2c...]
```

Orchestrator-type agents also receive guidance to route work to specialists rather than execute everything themselves. All agents receive a reminder to write a todo list before delegating.
