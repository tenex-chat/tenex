# Claude Code session context without duplicate history

Problem: Claude Code preserves its own session history, but TENEX currently sends the full message history on resume. This duplicates context, inflates tokens, and can skew behavior.

- Constraint: keep Claude Code internal memory
- Need: support message injection and tool results
- Goal: move complexity away from AgentExecutor

## Current pipeline snapshot

```
AgentExecutor -> ConversationStore.buildMessagesForRal -> LLMService.stream
    |                          |                           |
    |                          |                           +-- for claudeCode: resume session
    |                          |                               but messages[] still full history
    +-- system prompts + todo + response context are appended every step
```

## Design goals and constraints

### Goals
- Eliminate duplicate history on session resume.
- Preserve Claude Code internal memory and tool behavior.
- Keep injection support (nudge, supervision, dynamic tools).
- Maintain correctness for tool call and tool result replay.
- Keep the solution testable and observable.

### Constraints
- AgentExecutor already complex; avoid piling more branching there.
- ConversationStore is the source of truth for messages.
- Provider capabilities differ (sessionResumption only for some).
- System prompts include both static and per-turn dynamic content.
- Resume must stay safe when worktree or branch changes.

## Alternative A: Session cursor and delta-only messages

### High level
Track the last message that was sent to the provider and only send new messages after that cursor when resuming a session.

### Implementation sketch
- Add a monotonic message index to ConversationStore entries.
- Persist per session cursor in SessionManager metadata.
- Add ConversationStore.buildMessagesForRalSince(cursor).
- When provider supports sessionResumption and sessionId exists, send only delta messages + dynamic system updates.
- Advance cursor on successful completion; keep stable on abort.

### Pros
- Minimal token overhead, avoids duplication entirely.
- Leverages existing SessionManager and ConversationStore.
- Simple mental model once cursor is in place.

### Cons
- Cursor correctness is critical (failure and retries).
- Requires new message indexing or event-to-message mapping.
- Need to decide which system messages are re-sent each turn.

## Alternative B: Provider context strategy layer

### High level
Introduce a context strategy interface that compiles messages based on provider capabilities. AgentExecutor stays clean, strategies handle full history vs session delta.

### Implementation sketch
- Create ContextStrategy in src/llm or src/services/llm.
- Strategies: FullHistoryStrategy, SessionDeltaStrategy, HybridSummaryStrategy.
- Use provider metadata capabilities.sessionResumption to select strategy.
- Strategy handles message slicing and post-send cursor updates.

### Pros
- Centralizes policy decisions outside AgentExecutor.
- Reusable for codex-cli or future agent providers.
- Clear test surface for each strategy.

### Cons
- New abstraction layer to maintain.
- Needs plumbing for provider metadata into LLMService or strategy factory.

## Alternative C: Checkpoint summary plus delta

### High level
When resuming a session, send a compact summary of prior context (checkpoint) plus only the new delta messages. Claude Code keeps its internal memory, but the checkpoint guards against drift.

### Implementation sketch
- Use ConversationSummarizer to maintain rolling summary in metadata.
- Track last summarized event or message index.
- On resume, prepend summary as a user message or system injection.
- Send only messages after the summary checkpoint.

### Pros
- Resilient to session loss or cross-provider fallbacks.
- Balances internal memory with explicit context anchor.

### Cons
- Summary quality risk, especially for tool-heavy sessions.
- Extra summarization cost and lifecycle management.

## Alternative D: Provider history ledger with hashes

### High level
Maintain a ledger of message hashes that were actually sent to the provider. On each request, send only messages not already in the ledger.

### Implementation sketch
- Add ProviderHistoryLedgerService under src/services.
- Hash role + content + tool data for each message.
- Filter messages against the ledger when resuming a session.
- Update ledger only after stream completion succeeds.

### Pros
- Does not require new message IDs or event mapping.
- Portable across providers with session memory.
- Flexible for mixed or reordered message sources.

### Cons
- Hash mismatches if content changes post-send.
- Ledger growth and extra storage overhead.
- Harder to reason about compared to simple cursor.

## Alternative E: Split static vs dynamic system prompts

### High level
Separate system prompts into static (only on session start) and dynamic (every turn). On resume, send only dynamic prompts and the new conversation delta.

### Implementation sketch
- Extend buildSystemPromptMessages to mark prompts as static or dynamic.
- Use compileMessagesForClaudeCode only for static prompts on new session.
- Convert dynamic prompts to user messages when resuming.
- Combine with delta message slicing (Option A or D).

### Pros
- Stops re-sending large static identity context.
- Ensures todo list and response context stay fresh.
- Improves clarity about what changes per turn.

### Cons
- Requires prompt builder refactor.
- Needs decisions on what is static vs dynamic.

## Comparison matrix

| Option | Change scope | Duplication fix | Complexity | Resilience |
| --- | --- | --- | --- | --- |
| A - Session cursor | ConversationStore + SessionManager | Strong | Medium | Medium |
| B - Strategy layer | New strategy module | Strong | Medium | High |
| C - Summary checkpoint | ConversationSummarizer + policy | Medium | High | High |
| D - Hash ledger | New service + filtering | Strong | High | Medium |
| E - Prompt split | Prompt builder refactor | Partial | Medium | Medium |

## Edge cases and guardrails

### Failure and retry
- Advance cursor only after confirmed completion.
- On abort, keep cursor to resend last delta safely.
- Log a mismatch signal if sessionId exists but cursor missing.

### Dynamic system updates
- Todo list and response context should always be re-sent.
- Convert dynamic system prompts to user messages on resume.
- Keep static identity prompt as session start only.

### Session mismatch detection
- Invalidate resume if workingDirectory or branch changes.
- Fallback to new session with full context if mismatch.
- Record metrics for how often resume is disabled.

## Suggested experiments

Start with Option A plus the prompt split in Option E. That gives a minimal path to remove duplication while keeping dynamic context fresh. Wrap it in Option B later if the strategy surface grows.

- Instrument prompt token counts for claudeCode resume vs new session.
- Add tests for cursor advance and resend on abort.
- Validate that tool call results stay in sync across resume.

## Open questions

- Should cursor track NDK event IDs or internal message indices?
- Which system prompt fragments are truly static?
- How should we handle cross-provider switching mid conversation?
- Do we need a user-visible toggle to reset session state?

Draft for discussion. The options can be combined; most likely path is Option A (cursor) + Option E (prompt split) with Option B as a structural refactor once policy grows.
