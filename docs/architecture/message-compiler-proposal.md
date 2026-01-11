# MessageCompiler: Unified Message Assembly for Provider-Specific Context Management

## Problem Statement

When resuming a Claude Code session, conversation history is duplicated. Claude Code maintains its own internal session history, but TENEX sends the full message history anyway (to support stateless providers like Ollama and OpenRouter). The result: messages appear twice in Claude Code's context, wasting tokens and potentially confusing the model.

Beyond conversation messages, system prompts are also duplicated. Agent identity, project context, and tool definitions are sent every turn, even though Claude Code already has them in its session memory.

## Current Architecture (The Problem)

Message assembly is scattered across multiple components:

```
AgentExecutor.executeStreaming()
    │
    ├── buildSystemPromptMessages()        → System prompts (identity, project, tools)
    │
    ├── conversationStore.buildMessagesForRal()  → Conversation history
    │
    ├── agentTodosFragment.template()      → Todo list injection
    │
    ├── Response context injection         → "Responding to @user, delegations to @agent"
    │
    └── LLMService.prepareMessagesForRequest()
            │
            └── convertSystemMessagesForResume()  → Claude Code-specific transforms
```

Problems with this approach:
- No single place that understands provider memory models
- No tracking of what was already sent to session-stateful providers
- System prompts treated uniformly regardless of whether they change between turns
- AgentExecutor is bloated with message assembly logic it shouldn't own

## Proposed Architecture: MessageCompiler

A single component that owns all message assembly logic and produces provider-appropriate message arrays.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                           MessageCompiler                                 │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  Inputs:                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │ • provider: ProviderMetadata (includes capabilities)                │  │
│  │ • sessionManager: SessionManager (sessionId, cursor position)       │  │
│  │ • conversationStore: ConversationStore                              │  │
│  │ • dynamicContext: { todos, responseContext, delegations, nudges }   │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│  Output:                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │ ModelMessage[] — ready to send to the provider                      │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│  Behavior:                                                                │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │ if (stateless provider OR no active session)                        │  │
│  │     → full system prompts + full conversation history               │  │
│  │                                                                     │  │
│  │ if (session-stateful provider WITH active session)                  │  │
│  │     → dynamic prompts only + conversation delta (after cursor)      │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
└──────────────────────────────────────────────────────────────────────────┘
```

## Provider Memory Models

Providers fall into two categories:

### Stateless Providers
- OpenRouter, Ollama, Anthropic direct, etc.
- No memory between requests
- Require full context every time
- Identified by: `capabilities.sessionResumption === false`

### Session-Stateful Providers
- Claude Code, Codex CLI
- Maintain internal conversation history across requests
- Session resumed via `resume: sessionId`
- Identified by: `capabilities.sessionResumption === true`

## System Prompt Categorization

System prompts are categorized by lifecycle:

### Static Prompts (Session-Start Only)
Content that doesn't change during a conversation:
- Agent identity and role
- Project context and codebase information
- Tool definitions and capabilities
- Base behavioral instructions

For session-stateful providers with an active session, these are already in the provider's memory. Sending them again is waste.

### Dynamic Prompts (Every Turn)
Content that changes or must be fresh:
- Todo list (agent may have modified it)
- Response context ("Your response will be sent to @user")
- Delegation status ("You have delegations to @agent-x, @agent-y")
- Supervision injections
- Nudge content

These must always be sent, even on resume.

## Cursor Management

The MessageCompiler tracks a cursor: the index of the last message sent to the provider.

```
Conversation Store:
┌────────────────────────────────────────────┐
│ [0] User: "Help me build a feature"        │
│ [1] Assistant: "I'll help with that"       │
│ [2] Tool call: read_file                   │
│ [3] Tool result: <file contents>           │
│ [4] Assistant: "I see the code..."         │  ← cursor = 4 (last sent)
│ ─────────────────────────────────────────  │
│ [5] User: "Now add tests"                  │  ← new since cursor
│ [6] Injection: supervision correction      │  ← new since cursor
└────────────────────────────────────────────┘

On resume, only messages [5] and [6] are sent.
Claude Code's internal memory has [0]-[4].
```

### Cursor Advancement Rules

- **Advance on success:** After `stream()` completes successfully, advance cursor to current message count
- **Keep on abort:** If execution is aborted or fails, cursor stays put so delta can be resent
- **Reset on session invalidation:** If workingDirectory changes, session is invalidated and cursor resets

## Message Compilation Logic

```typescript
class MessageCompiler {
    constructor(
        private provider: ProviderMetadata,
        private sessionManager: SessionManager,
        private conversationStore: ConversationStore
    ) {}

    async compile(
        agentPubkey: string,
        ralNumber: number,
        context: {
            agent: AgentInstance;
            project: NDKEvent;
            todos: TodoItem[];
            responseContext: ResponseContext;
            availableAgents: AgentInstance[];
            nudgeContent?: string;
        }
    ): Promise<ModelMessage[]> {
        const session = this.sessionManager.getSession();
        const isStateful = this.provider.capabilities.sessionResumption;
        const hasActiveSession = isStateful && session.sessionId;

        if (hasActiveSession) {
            return this.compileForResume(agentPubkey, ralNumber, context, session.cursor);
        } else {
            return this.compileFullContext(agentPubkey, ralNumber, context);
        }
    }

    private async compileFullContext(...): Promise<ModelMessage[]> {
        // All system prompts (static + dynamic)
        const systemPrompts = await this.buildAllSystemPrompts(context);

        // Full conversation history
        const conversation = await this.conversationStore.buildMessagesForRal(
            agentPubkey,
            ralNumber
        );

        return [...systemPrompts, ...conversation];
    }

    private async compileForResume(
        ...,
        cursor: number
    ): Promise<ModelMessage[]> {
        // Dynamic prompts only, converted to user messages
        const dynamicPrompts = await this.buildDynamicPrompts(context);
        const dynamicAsUser = dynamicPrompts.map(p => ({
            role: 'user' as const,
            content: `[System Context]: ${p.content}`
        }));

        // Conversation messages after cursor
        const delta = await this.conversationStore.buildMessagesAfter(
            agentPubkey,
            ralNumber,
            cursor
        );

        return [...dynamicAsUser, ...delta];
    }

    advanceCursor(): void {
        if (this.provider.capabilities.sessionResumption) {
            const currentCount = this.conversationStore.getMessageCount();
            this.sessionManager.setCursor(currentCount);
        }
    }
}
```

## ConversationStore Changes

Add a method to build messages after a cursor position:

```typescript
class ConversationStore {
    // Existing method - builds full history
    async buildMessagesForRal(
        agentPubkey: string,
        ralNumber: number
    ): Promise<ModelMessage[]>

    // New method - builds delta after cursor
    async buildMessagesAfter(
        agentPubkey: string,
        ralNumber: number,
        afterIndex: number
    ): Promise<ModelMessage[]> {
        const allMessages = this.state.messages;
        const deltaEntries = allMessages.slice(afterIndex + 1);

        // Convert to ModelMessage[] using existing logic
        return this.entriesToMessages(deltaEntries, agentPubkey);
    }

    getMessageCount(): number {
        return this.state.messages.length;
    }
}
```

## SessionManager Changes

Add cursor tracking:

```typescript
interface SessionData {
    sessionId?: string;
    lastSentEventId?: string;
    cursor?: number;  // Index of last message sent to provider
}

class SessionManager {
    // Existing methods...

    getCursor(): number | undefined {
        return this.sessionData.cursor;
    }

    setCursor(index: number): void {
        const metadataStore = this.agent.createMetadataStore(this.conversationId);
        metadataStore.set("cursor", index);
        this.sessionData.cursor = index;
    }

    // On session invalidation (workingDirectory change), cursor is cleared
    // This already happens because loadSession() only loads if workingDirectory matches
}
```

## Prompt Builder Changes

Categorize prompt fragments:

```typescript
type PromptLifecycle = 'static' | 'dynamic';

interface PromptFragment {
    content: string;
    lifecycle: PromptLifecycle;
}

// In buildSystemPromptMessages or equivalent:
const fragments: PromptFragment[] = [
    { content: agentIdentityPrompt, lifecycle: 'static' },
    { content: projectContextPrompt, lifecycle: 'static' },
    { content: toolDefinitionsPrompt, lifecycle: 'static' },
    { content: todoListPrompt, lifecycle: 'dynamic' },
    { content: responseContextPrompt, lifecycle: 'dynamic' },
    { content: delegationStatusPrompt, lifecycle: 'dynamic' },
];
```

MessageCompiler uses this categorization to select which prompts to include.

## AgentExecutor Simplification

Before (scattered across ~100 lines in executeStreaming):

```typescript
// Build system prompts
const systemPromptMessages = await buildSystemPromptMessages({
    agent: context.agent,
    project: projectContext.project,
    // ... many params
});

// Build conversation
const conversationMessages = await conversationStore.buildMessagesForRal(
    context.agent.pubkey,
    ralNumber
);

// Combine
const messages: ModelMessage[] = [
    ...systemPromptMessages.map((sm) => sm.message),
    ...conversationMessages,
];

// Append todos
const todoContent = await agentTodosFragment.template({...});
if (todoContent) {
    messages.push({ role: "system", content: todoContent });
}

// Append response context
messages.push({ role: "system", content: responseContextContent });

// Provider-specific prep
const processedMessages = this.prepareMessagesForRequest(messages);
```

After:

```typescript
const compiler = new MessageCompiler(
    provider,
    sessionManager,
    conversationStore
);

const messages = await compiler.compile(context.agent.pubkey, ralNumber, {
    agent: context.agent,
    project: projectContext.project,
    todos: conversationStore.getTodos(context.agent.pubkey),
    responseContext: {
        respondingTo: context.triggeringEvent.pubkey,
        delegations: pendingDelegations,
    },
    availableAgents: Array.from(projectContext.agents.values()),
    nudgeContent,
});

// After successful completion:
compiler.advanceCursor();
```

## File Structure

```
src/llm/
├── MessageCompiler.ts          # New: unified message assembly
├── service.ts                  # Unchanged (receives compiled messages)
├── prompts/
│   └── PromptBuilder.ts        # Modified: adds lifecycle categorization
└── ...

src/agents/execution/
├── AgentExecutor.ts            # Simplified: delegates to MessageCompiler
├── SessionManager.ts           # Modified: adds cursor tracking
└── ...

src/conversations/
└── ConversationStore.ts        # Modified: adds buildMessagesAfter()
```

## Behavior Summary

| Scenario | System Prompts | Conversation Messages |
|----------|---------------|----------------------|
| Stateless provider | All (static + dynamic) | Full history |
| Session-stateful, no session | All (static + dynamic) | Full history |
| Session-stateful, active session | Dynamic only (as user messages) | Delta (after cursor) |

## Edge Cases

### Cursor Invalidation
If cursor points beyond current message count (corruption, manual editing), fall back to full context:

```typescript
if (cursor === undefined || cursor >= this.conversationStore.getMessageCount()) {
    return this.compileFullContext(...);
}
```

### Session Mismatch
Already handled by SessionManager: if workingDirectory changes, session is not loaded, so `hasActiveSession` will be false and full context is sent.

### Injections
Injections (supervision, nudges, delegation results) are added to ConversationStore AFTER the cursor is saved. They naturally appear in the delta on next compile. No special handling needed.

### Tool Call/Result Consistency
Tool calls and results are part of the conversation store. If they're before the cursor, Claude Code has them in memory. If after, they're in the delta. The cursor keeps them in sync.

## Benefits

1. **Single responsibility:** One component owns message assembly
2. **Provider-aware:** Behavior adapts to provider capabilities automatically
3. **Testable:** MessageCompiler can be unit tested with mock providers and stores
4. **AgentExecutor cleanup:** Removes ~100 lines of scattered message logic
5. **Token efficiency:** No duplicate history or system prompts on resume
6. **Extensible:** New provider memory models can be added by extending compile logic

## Implementation Notes

- MessageCompiler should be instantiated per-execution (not singleton) since it holds provider/session state
- Cursor advancement must happen AFTER successful stream completion, not before
- The `[System Context]:` prefix for dynamic prompts on resume matches existing `convertSystemMessagesForResume` behavior
- Static/dynamic categorization can start simple (hardcoded) and become configurable if needed
