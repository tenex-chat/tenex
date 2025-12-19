# Pairing: Real-Time Delegation Supervision

## Overview

Pairing enables an agent to supervise another agent's work in real-time during delegation. Instead of fire-and-forget delegation where the delegator waits blindly for completion, pairing provides periodic checkpoints where the supervisor can observe progress and provide guidance.

## Mental Model

```
Traditional Delegation:
  A delegates → B works (black box) → B returns result → A continues

Pairing:
  A delegates with pairing → B works → A sees checkpoint → A: "looks good"
                                     → B works → A sees checkpoint → A: "try X instead"
                                     → B adjusts → B works → A sees checkpoint → A: "good"
                                     → B completes → A continues (with full memory of supervision)
```

## How It Works

### 1. Initiating a Paired Delegation

Agent A uses the `delegate` tool with a `pair` configuration:

```typescript
delegate({
  recipient: "implementer",
  prompt: "Build the authentication system with JWT",
  pair: {
    interval: 5  // Checkpoint every 5 tool executions
  }
});
```

### 2. What Gets Observed

Agent B's tool executions are already published as Nostr events:
- Kind 1111 with `t` tag = "tool"
- `e` tag references the delegation event
- Contains tool name, arguments, result summary

The pairing system subscribes to these events.

### 3. Checkpoint Triggering

After every N tool executions (configured by `interval`), the system:
1. Collects the tool execution summaries since last checkpoint
2. Builds a checkpoint context message
3. Resumes Agent A's RAL with this context

### 4. Supervisor's Checkpoint Experience

Agent A's RAL is resumed with a system message:

```
Pairing checkpoint #2 for delegation to @implementer

Tool executions since last checkpoint:
1. shell(npm test): exit 1, "3 tests failed"
2. read_file(src/auth.ts): 150 lines
3. edit(src/auth.ts): modified login() function
4. shell(npm test): exit 1, "2 tests failed"
5. read_file(src/jwt.utils.ts): 80 lines

Total progress: 10 tool calls across 2 checkpoints
```

Agent A then responds naturally:
- **Continue:** "Progress looks good, tests improving." (or say nothing)
- **Correct:** Uses `delegate_followup` to send guidance
- **Observe more:** Just acknowledge and wait for next checkpoint

### 5. Corrections via Followup

If Agent A sees something wrong:

```typescript
delegate_followup({
  recipient: "implementer",
  message: "You're fixing symptoms not the root cause. The JWT secret should come from env vars, not be hardcoded."
});
```

This message is injected into Agent B's context via the existing injection mechanism. Agent B sees it at the next tool boundary and can adjust.

### 6. Completion

When Agent B finishes:
1. Normal delegation completion event is published
2. Pairing observation ends automatically
3. Agent A's RAL is resumed with the final response
4. Agent A's context includes all checkpoints and its observations

---

## Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ Agent A                                                         │
│                                                                 │
│ delegate({ recipient: "B", prompt: "...", pair: { interval: 5 }})
│     │                                                           │
│     ├──▶ Publish delegation event                               │
│     │                                                           │
│     └──▶ Return __stopExecution                                 │
│              + pendingDelegations                               │
│              + pairingConfig ◄────────────────────────┐        │
│                    │                                   │        │
│                    ▼                                   │        │
│              RAL pauses                                │        │
│                    │                                   │        │
└────────────────────┼───────────────────────────────────┼────────┘
                     │                                   │
                     ▼                                   │
          ┌─────────────────────┐                        │
          │  PairingRegistry    │                        │
          │  ─────────────────  │                        │
          │  delegationId       │                        │
          │  supervisorPubkey   │                        │
          │  interval: 5        │                        │
          │  toolsSeen: 0       │                        │
          │  checkpointNum: 0   │                        │
          └─────────────────────┘                        │
                     │                                   │
                     │ subscribes to kind:1111           │
                     │ where e-tag = delegationId        │
                     │ and t-tag = "tool"                │
                     ▼                                   │
┌─────────────────────────────────────────────────────────────────┐
│ Agent B                                                         │
│                                                                 │
│ Receives delegation, starts working                             │
│     │                                                           │
│     ▼                                                           │
│ ┌────────┐   ┌────────┐   ┌────────┐   ┌────────┐   ┌────────┐ │
│ │ tool 1 │──▶│ tool 2 │──▶│ tool 3 │──▶│ tool 4 │──▶│ tool 5 │ │
│ └───┬────┘   └───┬────┘   └───┬────┘   └───┬────┘   └───┬────┘ │
│     │            │            │            │            │       │
└─────┼────────────┼────────────┼────────────┼────────────┼───────┘
      │            │            │            │            │
      ▼            ▼            ▼            ▼            ▼
  ToolEvent    ToolEvent    ToolEvent    ToolEvent    ToolEvent
      │            │            │            │            │
      └────────────┴────────────┴────────────┴────────────┘
                                │
                                ▼ toolsSeen = 5
                    ┌───────────────────────┐
                    │  CHECKPOINT TRIGGER   │
                    └───────────┬───────────┘
                                │
                                ▼
                    Build checkpoint context
                                │
                                ▼
                    Resume Agent A's RAL ─────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│ Agent A (resumed at checkpoint)                                 │
│                                                                 │
│ [System] "Pairing checkpoint #1: [tool summaries]"              │
│                                                                 │
│ Agent responds:                                                 │
│   • "Looks good" ──────────────────────▶ RAL pauses again       │
│   • delegate_followup("try X") ────────▶ sends to B, pauses     │
│   • (no response needed) ──────────────▶ RAL pauses again       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                                │
                                │ repeat until B completes
                                ▼
                    Agent B publishes completion
                                │
                                ▼
                    PairingRegistry clears pairing
                                │
                                ▼
                    Normal completion flow
                    (Agent A resumes with final response)
```

---

## Components

| Component | Responsibility |
|-----------|----------------|
| **delegate tool** | Accept optional `pair` config, include in `__stopExecution` return |
| **PairingRegistry** | Track active pairings: delegationId → supervisor config + state |
| **PairingSubscriptionManager** | Subscribe to tool events, count executions, trigger checkpoints |
| **AgentExecutor** | Detect pairing checkpoint resumption, build checkpoint context |
| **RALRegistry** | Store `pairingConfig` in RAL state alongside `pendingDelegations` |

---

## State Structures

### PairingConfig (in RAL state)

```typescript
interface PairingConfig {
  delegationId: string;
  recipientPubkey: string;
  recipientSlug: string;
  interval: number;
}
```

### PairingRegistryEntry

```typescript
interface PairingRegistryEntry {
  delegationId: string;
  supervisorPubkey: string;
  supervisorConversationId: string;
  interval: number;

  // State
  toolEventBuffer: ToolEventSummary[];
  toolsSinceLastCheckpoint: number;
  totalToolsSeen: number;
  checkpointNumber: number;

  createdAt: number;
  lastCheckpointAt?: number;
}

interface ToolEventSummary {
  tool: string;
  args: Record<string, unknown>;
  resultSummary: string;  // Truncated/summarized result
  timestamp: number;
}
```

---

## Checkpoint Message Format

```
Pairing checkpoint #3 for delegation to @implementer

Tool executions since last checkpoint:
1. shell(npm test): exit 0, "All 12 tests passed"
2. edit(src/auth.ts): added refreshToken() function
3. shell(npm run lint): exit 0, no issues
4. read_file(src/auth.test.ts): 200 lines
5. edit(src/auth.test.ts): added 3 new test cases

Progress: 15 total tool calls | 3 checkpoints | Started 2m ago

You may respond with guidance, use delegate_followup to send corrections,
or continue observing.
```

---

## Agent A's Context After Completion

```
Messages in Agent A's RAL:

[user]      "Build a secure auth system"
[assistant] "I'll delegate this to implementer and supervise..."
[tool]      delegate({ pair: { interval: 5 } })
[system]    Pairing checkpoint #1: [5 tool summaries]
[assistant] "Good start, but watch the error handling."
[system]    Pairing checkpoint #2: [5 tool summaries]
[assistant] delegate_followup("Use httpOnly cookies for the refresh token")
[system]    Pairing checkpoint #3: [5 tool summaries]
[assistant] "Correction applied correctly. Looking good."
[system]    Delegation complete. @implementer responded: "Implemented JWT auth..."
[assistant] "Auth system complete. Let me verify it integrates correctly..."
```

Agent A remembers the entire supervision session and can reference it.

---

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Agent B completes before first checkpoint | Skip straight to completion, no checkpoints |
| Agent B fails/errors | Pairing ends, error propagated to Agent A |
| Agent A sends many followups | All injected into B's context (existing mechanism) |
| Supervisor wants to abort | `delegate_followup("Stop immediately, this approach won't work")` |
| Long-running delegation | Checkpoints continue indefinitely until completion |
| Network interruption | Pairing state persisted in registry, resumes on reconnect |

---

## Not In Scope (for now)

- **Synchronous checkpoints** (Agent B pauses and waits for Agent A's response)
- **Multiple simultaneous pairings** (Agent A supervising multiple delegations)
- **Nested pairing** (Agent B delegates with pairing while being supervised)
- **Checkpoint interval by time** (every N seconds instead of N tool calls)

These can be added later if needed.

---

## Summary

Pairing transforms delegation from a black box into a supervised collaboration. The supervisor sees regular progress updates, can course-correct in real-time via followups, and retains full memory of the supervision session. The supervised agent continues working normally, receiving any corrections through the existing injection mechanism.
