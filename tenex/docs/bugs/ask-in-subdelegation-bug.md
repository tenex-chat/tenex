# Bug: `ask()` in Sub-Delegation Silently Drops Response

**Status:** Confirmed  
**Severity:** High — interaction-breaking  
**Filed:** 2026-04-07  
**Investigated by:** human-replica (conversation fd201ac81877b6c05f)

---

## Summary

When a sub-delegated agent calls `ask()` to request user input, the user's response is silently dropped. The delegation completes before the user responds, and any reply that arrives afterward is discarded.

## Symptoms

- Sub-delegated agent calls `ask()` — the question is published to the user
- The delegation chain completes and the parent agent moves on
- No response from the user ever reaches the delegated agent
- No error is surfaced — it silently fails

## Root Cause

### How `ask()` works at top-level:
1. Agent calls `ask()` → publishes ask event to owner pubkey
2. Registers a `PendingDelegation` of type `"ask"` in the RALRegistry, tagged to the agent's conversation
3. Agent turn completes — RAL keeps the conversation alive waiting for the reply
4. User replies → `handleDelegationCompletion` checks for matching pending delegation → resumes parent conversation

### What breaks in sub-delegations:
When a sub-delegated agent calls `ask()`:
1. It publishes the ask event correctly
2. It registers the pending delegation in the RALRegistry under **its own sub-delegation conversation**
3. Its turn ends → the parent agent receives "DELEGATION COMPLETED" → considers the delegation done
4. The sub-delegation conversation is closed
5. When the user replies, `handleDelegationCompletion` finds the RAL entry is no longer active → **silently drops the reply** (line 214: `reply.completion_dropped_no_waiting_ral`)

The fundamental problem: the delegation protocol uses the sub-agent's final message as a completion signal. There is no mechanism for a sub-agent to say "I'm suspended, waiting for user input — don't close this delegation yet."

## Fix Options

### Option 1: Agent holds completion until ask resolves
A sub-delegated agent with an outstanding `ask` should not send its final "completed" message until the `ask` response arrives. This requires the agent runtime to detect that it's in a sub-delegation context and has pending asks.

### Option 2: RAL blocks parent completion for outstanding asks (Recommended)
When the RALRegistry detects that a delegation has an outstanding `ask` (i.e., a child pending delegation of type `ask`), it should NOT mark the parent delegation as complete. The parent waits until all child asks are resolved.

This is the cleanest fix — it handles the general case where any child of a delegation is still waiting.

### Option 3: `ask()` escalates through the delegation chain
Instead of publishing directly to the user, `ask()` in a sub-delegation should escalate: send the ask request to the parent delegation's conversation, which propagates it up the chain until it reaches the top-level agent, which then presents it to the user. The response propagates back down.

This is the most architecturally correct but most complex to implement.

## Recommended Fix

**Option 2** is the right approach: the RALRegistry should track whether any pending `ask` exists in the context of a delegation and block parent completion accordingly.

## References

- Investigation conversation: `fd201ac81877b6c05f`
- Explore agent analysis: `58aff38b6c48df3637`
- Test that reproduced the bug: `0b6beaa8ab45142896`
