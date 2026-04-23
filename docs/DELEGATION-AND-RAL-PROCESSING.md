# Delegation and RAL Processing

This document describes how delegation and RAL (Reason-Act Loop) state is tracked and resumed in the current implementation.

## Key Components

| File | Responsibility |
| --- | --- |
| `src/services/ral/RALRegistry.ts` | Stores RAL state, pending/completed delegations, and queued injections |
| `src/services/ral/types.ts` | RAL, delegation, and injection type definitions |
| `src/agents/execution/AgentExecutor.ts` | Executes agents, handles stop signals, and resumes RALs |
| `src/agents/execution/ToolExecutionTracker.ts` | Publishes tool-use events and records delegation references |
| `crates/tenex-daemon/src/inbound_runtime.rs` | Routes inbound Nostr/Telegram envelopes into filesystem worker dispatch records |
| `crates/tenex-daemon/src/worker_session_loop.rs` | Starts Bun worker executions from filesystem dispatch records |
| `src/nostr/AgentPublisher.ts` | Publishes delegation, completion, ask, and tool-use events |
| `src/nostr/AgentEventEncoder.ts` | Defines event tags and shared encoding logic |

## Event Types and Tags

### Delegation request
- **Kind:** `1` (text)
- **Tags:** `["p", <recipient_pubkey>]`, optional `["phase", ...]`, `["phase-instructions", ...]`, `["branch", ...]`
- **Threading:** No `e` tag; a delegation starts its own conversation thread
- **Metadata:** Standard tags include project `a` tag and `llm-ral`

### Delegation completion
- **Kind:** `1`
- **Tags:** `["status", "completed"]`, `["p", <delegator_pubkey>]`, `["e", <delegation_event_id>]`
- **Detection:** Rust ingress routes completion events into filesystem worker dispatch records. The Bun worker consumes local RAL state during execution/resumption.

### Tool usage events
- **Kind:** `1`
- **Tags:** `["tool", <tool_name>]`, optional `["tool-args", <json>]`
- **Delegation references:** For delegation tools, `ToolExecutionTracker` adds `["q", <delegation_event_id>]` tags

### Ask events
- **Kind:** `1`
- **Tags:** `["intent", "ask"]`, `["suggestion", ...]` (optional), `["p", <project_owner_pubkey>]`

### Follow-up messages
- **Kind:** `1`
- **Threading:** Replies to the delegation response thread (inherits root `e` tag)

## RAL Registry State

RAL state is tracked in memory by `RALRegistry` and is independent from conversation persistence.

```ts
interface RALRegistryEntry {
  id: string;
  ralNumber: number;
  agentPubkey: string;
  conversationId: string;
  queuedInjections: Array<{ role: "user" | "system"; content: string; queuedAt: number }>;
  isStreaming: boolean;
  currentTool?: string;
  toolStartedAt?: number;
  createdAt: number;
  lastActivityAt: number;
  originalTriggeringEventId?: string;
  traceId?: string;
  executionSpanId?: string;
}
```

Delegations are stored separately per agent+conversation:

```ts
interface PendingDelegation {
  delegationConversationId: string;
  recipientPubkey: string;
  senderPubkey: string;
  prompt: string;
  ralNumber: number;
  type?: "standard" | "followup" | "external" | "ask";
}

interface CompletedDelegation {
  delegationConversationId: string;
  recipientPubkey: string;
  senderPubkey: string;
  transcript: Array<{ senderPubkey: string; recipientPubkey: string; content: string; timestamp: number }>;
  completedAt: number;
  ralNumber: number;
}
```

## Execution Flow

### 1. Delegation request
1. `delegate` tool resolves recipients and publishes a delegation event via `AgentPublisher.delegate`.
2. The tool records the delegation in `RALRegistry` with `mergePendingDelegations`.
3. The parent execution continues normally; delegation does not synchronously wait for the child to finish.
4. If the parent later finishes while delegation work is still outstanding, the RAL stays resumable instead of being cleared.

### 2. Delegated agent runs
The delegated agent’s conversation root is the delegation event, so all of its tool-use events inherit the delegation `e` tag.

### 3. Delegation completion
1. The delegated agent publishes a completion event (kind `1`, `status=completed`).
2. Rust ingress writes the next worker dispatch/session state for the relevant conversation.
3. The Bun worker records the completion in `RALRegistry` when the parent is idle. If the parent is currently streaming/executing, the completion remains queued for the next resumable turn.

### 4. Resumption
1. Rust dispatch state carries completion/follow-up work to the Bun worker.
2. `AgentExecutor` checks `RALRegistry.findResumableRAL` and resumes when completed delegations exist and the parent is not already streaming.
3. `RALResolver` inserts delegation result markers into the conversation before the resumed model step.

### 5. Message injection
1. Rust dispatch/session state and the Bun worker queue injections on active RALs (streaming or waiting).
2. `AgentExecutor` consumes injections in `prepareStep` with `getAndConsumeInjections`.
3. Injections are persisted into `ConversationStore` so they become part of the conversation history.

## Worktree Context

Delegation events can include a `branch` tag. `ExecutionContextFactory` uses that tag to:
- Switch the agent working directory to `.worktrees/<sanitized_branch>/`
- Create the worktree on demand if it does not exist
