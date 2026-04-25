# Agent event taxonomy — kind:1, p-tags, completion, delegation

This is the single source of truth for what an agent publishes, what it
means, and how the daemon reacts. The TypeScript implementation lives in
`src/nostr/AgentEventEncoder.ts` (functions `encodeCompletion`,
`encodeConversation`, `encodeDelegation`, `encodeAsk`). This document
describes the **contract** those functions implement.

If you find yourself confused about whether to add a p-tag, whether
`waiting_for_delegation` is a thing, or what the worker should emit when
delegations are in flight: read this doc. Don't ask. Don't guess. Don't
add a third option.

## The one rule that drives everything

**p-tag on a kind:1 = "control transfer."** That's the whole semantic.
Two directions:

- **Completion** (kind:1, p-tag = caller, `status: completed`) — "I'm
  done with my turn, control returns to whoever asked me to do this
  work."
- **Delegation** (kind:1, p-tag = delegatee, no `status`) — "I'm asking
  you to do work, control passes to you."

**No p-tag on a kind:1 = "I'm still working, this isn't a control
transfer yet."** Used for conversation/streaming text mid-loop AND for
the turn-end event when the agent has fired off delegations and is
waiting for them to come back.

There is no third semantic. Anything that emits a kind:1 either
transfers control (p-tag) or doesn't (no p-tag).

## The four event shapes the agent publishes

| Intent | Kind | p-tag | `status` tag | e-tag (root) | Meaning |
|---|---|---|---|---|---|
| `ConversationIntent` | 1 | none | none | yes (root of thread) | Mid-loop text. Streaming output, partial reasoning, or any text emitted before the agent's turn ends. |
| `CompletionIntent` | 1 | caller pubkey (delegator or root user) | `completed` | yes | Turn-end. The agent is done with this turn; control returns to the caller. |
| `DelegationIntent` | 1 (one event per delegation target) | delegatee pubkey | none | none (delegations start fresh threads) | Agent is asking another agent (or human) to do work. |
| `AskIntent` | 1 | project owner (or designated human) | none (has `title` + `question` tags) | yes | Agent is asking a human a structured question. |

Note: `Conversation` and `Completion` are both kind:1. The **only**
on-wire difference is the presence of a p-tag and a `status` tag. That
is intentional — it means a downstream consumer can reason about the
"is this a turn-end?" question with one tag check.

## Pending delegations and the turn-end event

This is the part everyone gets wrong. Read it twice.

When an agent's turn ends, the agent has two choices for the **last**
kind:1 it publishes:

1. **No pending delegations.** Publish a `CompletionIntent`. The event
   carries the p-tag back to the caller and `status: completed`. The
   caller knows the work is done.

2. **Pending delegations exist.** Publish a `ConversationIntent` (or
   nothing — but something to acknowledge). **No p-tag.** No
   `status: completed`. The turn-end event looks identical to a mid-loop
   conversation event because semantically that's what it is — the agent
   isn't done, it's just waiting on its delegates.

When the delegated work returns, the daemon resumes the parent agent's
RAL (see "RAL resume" below) and the parent gets another turn. At the
end of *that* turn (assuming no further delegations), the parent
publishes a `CompletionIntent` with the p-tag.

**The rule for "p-tag or no p-tag" on the turn-end event is:**

> p-tag if and only if there are zero pending delegations on the agent's
> RAL at the moment the event is composed.

Not "delegations triggered this turn" — *any* pending delegations. If
the agent delegated three turns ago and one of them still hasn't
returned, the current turn-end is still a no-p-tag conversation event.

## What the worker emits to the daemon

The worker → daemon protocol is `AgentWorkerProtocol.ts`. The worker
emits **one** terminal frame per execute request. The frame's `type`
field is one of:

- `complete` — the agent finished its turn cleanly.
- `no_response` — the agent decided not to respond at all (silent
  completion).
- `error` — execution failed.
- `aborted` — the daemon sent an abort signal during execution.

There is **no** `waiting_for_delegation` frame type. (The current
codebase still has one as of 2026-04-25; it's being removed. If you see
references, treat them as legacy.)

The `complete` frame carries:

```ts
{
    type: "complete",
    finalRalState: "completed",
    publishedUserVisibleEvent: boolean,   // did the agent publish anything p-tagged?
    pendingDelegationsRemain: boolean,    // does the RAL have unresolved delegations?
    pendingDelegations: string[],         // their delegation conversation ids
    finalEventIds: string[],              // event ids the agent published this turn
    // ...
}
```

The daemon decides the **RAL state** to write based on the frame
payload, not on the frame type:

| Frame `type` | `pendingDelegationsRemain` | RAL state daemon writes |
|---|---|---|
| `complete` | `false` | `Completed` |
| `complete` | `true`  | `PendingDelegations` |
| `no_response` | any | `Completed` (with no_response marker) |
| `error` | any | `Crashed` (or `Errored`, depending on retryable) |
| `aborted` | any | `Aborted` |

The daemon-internal RAL state name `PendingDelegations` is the new name
(replacing the legacy `WaitingForDelegation`). The semantics don't
change: it means "the agent's turn ended, but the RAL is not fully done
because there are unresolved delegations; expect a resume when one of
them lands."

## RAL resume — what happens when a delegation completes

1. Delegated agent (call it B) finishes its turn. It publishes a
   `CompletionIntent` with p-tag = parent agent A's pubkey.
2. Daemon ingress sees the completion event, recognizes it as a
   delegation result (because A has a `PendingDelegations` RAL with
   B's delegation_conversation_id in the pending list).
3. Daemon writes the delegation completion to A's RAL journal and
   enqueues a dispatch to wake A back up.
4. The new dispatch runs A's worker. The execute frame includes the
   delegation result (so A's agent loop sees it as injected context).
   A continues from where it left off.
5. A may delegate again, may emit more conversation events, may
   eventually publish a `CompletionIntent` with p-tag = whoever
   originally asked A. Same rules apply each time.

The worker process for A from the *original* turn is long gone. The
"resume" is a fresh process running A's agent loop with the RAL state
hydrated. The only thing carried across is the RAL journal (on disk)
and the conversation store.

## Why this matters

The kind:1 / p-tag distinction is not a UX nicety — it's a **load-
bearing protocol invariant**. Other agents and the UI look at the
absence of a p-tag to decide "agent X is still working, don't show this
as a final answer." If an agent publishes a p-tagged completion when it
has pending delegations, the caller will think the work is done and may
move on, even though the parent agent intends to keep going once the
delegate returns. That's a correctness bug visible to humans.

## Forbidden patterns

- **A `waiting_for_delegation` worker frame type.** Workers don't wait.
  They run to turn-end and emit `complete`. Pending delegations are a
  RAL property, not a worker terminal class.
- **A "completion with no p-tag because pending delegations."** That's
  not a completion — it's a conversation event. Use
  `ConversationIntent`. Don't smuggle the no-p-tag case into
  `CompletionIntent` with a flag.
- **A separate kind for "still working" turn-end.** No new kinds. The
  contract is "kind:1, p-tag or not." Adding a kind:1.5 or a separate
  status value would break every consumer that already understands the
  current contract.
- **`pendingDelegationsRemain` derived from anything other than the
  RAL.** The RAL is authoritative. Don't recompute it from the worker's
  in-memory state, the conversation store, or the inbound queue.
