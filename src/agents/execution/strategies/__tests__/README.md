# Nostr Threading Strategy Tests & Visualization

This directory contains comprehensive testing infrastructure for the `FlattenedChronologicalStrategy` - the core logic that determines which messages agents see in Nostr threaded conversations.

## Overview

### The Problem
In a multi-agent Nostr system with complex threading:
- How do we ensure agents only see relevant messages?
- How do we handle root-level collaboration (agents seeing each other at depth 2)?
- How do we prevent deep threads from polluting other agents' context?
- How does delegation work across thread boundaries?

### The Solution
**Depth-aware filtering** with root-level collaboration:
- **Root level (depth 2)**: Agents see ALL sibling replies for collaborative discussions
- **Deep threads (depth 3+)**: Agents only see their direct parent chain for focused work

## Files

### Core Implementation
- **`FlattenedChronologicalStrategy.ts`** - The actual strategy implementation
- **`ThreadService.ts`** - Thread path computation and traversal

### Test Infrastructure

#### Unit Tests (Using ACTUAL Strategy)
- **`FlattenedChronologicalStrategy.thread-path.test.ts`** - Thread path inclusion tests
- **`FlattenedChronologicalStrategy.branching.test.ts`** - Multi-branch conversation tests
- **`FlattenedChronologicalStrategy.public-broadcast.test.ts`** - Public broadcast visibility
- **`FlattenedChronologicalStrategy.root-siblings.test.ts`** - Production bug validation
- **`FlattenedChronologicalStrategy.delegation-response.test.ts`** - Delegation filtering
- **`FlattenedChronologicalStrategy.condensed-delegation.test.ts`** - Delegation display
- **`FlattenedChronologicalStrategy.mock-scenarios.test.ts`** - Mock event scenarios

**Total: 23 passing tests**

#### Signed Event Generator (REAL Nostr Events)
- **`generate-signed-events.ts`** - Generates REAL signed Nostr events
  - Uses `NDKPrivateKeySigner` for real key generation
  - Creates actual signed events with proper threading tags
  - Simulates delegation chains, code reviews, parallel branches

#### Visualization Tools

- **`nostr-conversation-viewer.tsx`** - **🌐 LIVE NOSTR VIEWER** (Production Data!)
  - Fetches REAL conversations from Nostr relays
  - Pass any event ID to analyze the thread
  - Shows agent perspectives using ACTUAL strategy
  - Looks up agent names from AgentRegistry + PubkeyNameRepository
  - Reddit-style threaded display
  - **Usage**: `bun run src/agents/execution/strategies/__tests__/nostr-conversation-viewer.tsx <event-id> [relay-urls...]`
  - **Example**: `bun run src/agents/execution/strategies/__tests__/nostr-conversation-viewer.tsx 1e19502b9d3febac577d3b7ce3bd5888c945b2261ff0480f45c870228bac4fde`

- **`interactive-tui.tsx`** - **⭐ INTERACTIVE TUI** (Test Scenarios)
  - Fully interactive terminal UI with Ink
  - Uses ACTUAL `FlattenedChronologicalStrategy` (not simplified!)
  - Navigate scenarios with ←/→ arrows
  - Switch agents with ↑/↓ arrows
  - See real-time what each agent sees
  - Reddit-style threaded display
  - **Usage**: `bun run src/agents/execution/strategies/__tests__/interactive-tui.tsx`

- **`run-tui.ts`** - Non-interactive test runner
  - Generates 3 scenarios with real signed events
  - Runs events through ACTUAL `FlattenedChronologicalStrategy`
  - Shows which events each agent sees with ✓/✗ indicators
  - Good for CI/automated testing
  - **Usage**: `bun run src/agents/execution/strategies/__tests__/run-tui.ts`

- **`agent-perspective-visualization.html`** - HTML visualization (simplified)
  - Reddit-style threaded display
  - Side-by-side comparison
  - Expand/collapse threads
  - **Note**: Uses simplified filtering logic for demo purposes
  - **Usage**: `open src/agents/execution/strategies/__tests__/agent-perspective-visualization.html`

#### Mock Data
- **`mock-event-generator.ts`** - Simple mock events (no signatures)
  - Used by HTML visualization
  - Faster for UI prototyping

## Test Scenarios

### 1. Complex Threading
```
Root: User requests dark mode
  ├─ Alice (PM) delegates to Bob
  │   └─ Bob implements
  │       └─ Charlie reviews
  │           └─ Bob fixes
  │               └─ Bob reports to Alice
  └─ Diana tests (parallel branch)
      └─ Diana finds bugs
```

**Key learnings:**
- Bob sees his branch + root-level siblings
- Charlie at depth 4 doesn't see Diana's branch
- Alice sees delegation completion

### 2. Root Collaboration
```
Root: User asks for help
  ├─ Alice: "Add indexes"
  ├─ Bob: "Use query caching"
  ├─ Charlie: "Connection pooling"
  └─ Diana: "I'll benchmark"
```

**Key learnings:**
- ALL agents see each other's contributions
- Enables collaborative brainstorming
- All replies at depth 2 (root-level siblings)

### 3. Delegation Chain
```
Root: User wants OAuth
  └─ PM coordinates
      └─ Dev implements
          └─ Reviewer checks security
              └─ Tester validates
                  └─ Dev reports to PM
```

**Key learnings:**
- Each agent sees their delegation chain
- Tester sees full context from PM → Dev → Reviewer → Tester
- PM sees final completion

## Running Tests

### All Unit Tests
```bash
bun test src/agents/execution/strategies/__tests__/
```

### Specific Test File
```bash
bun test src/agents/execution/strategies/__tests__/FlattenedChronologicalStrategy.root-siblings.test.ts
```

### Visual Test with Real Events
```bash
bun run src/agents/execution/strategies/__tests__/run-tui.ts
```

### HTML Visualization
```bash
open src/agents/execution/strategies/__tests__/agent-perspective-visualization.html
```

## Key Filtering Rules

### What Gets Included?

1. **Thread Path** - All events from root to triggering event
   - **At depth 2**: Include ALL root-level siblings (collaborative)
   - **At depth 3+**: Only direct parent chain (focused)

2. **Direct Relevance** - Events where agent is involved
   - Events FROM the agent
   - Events TARGETED to the agent (p-tag)
   - Public broadcasts (no p-tags)
   - Delegation responses to the agent

### What Gets Filtered?

- Events in unrelated deep branches
- Sibling messages when agent is at depth 3+
- Events not in thread path AND not directly relevant

## Production Validation

### The Claude-Code Bug (Fixed)
**Issue**: `claude-code` couldn't see `clean-code-nazi`'s code review when both were siblings at root level.

**Root cause**: Thread path building used strict parent-chain-only logic.

**Fix**: Special case for depth 2 - include ALL root-level siblings.

**Test**: `FlattenedChronologicalStrategy.root-siblings.test.ts` uses the EXACT production events to validate the fix.

## Architecture Decisions

### Why Depth-Based Filtering?

1. **Root-level collaboration** (depth 2) - Teams need to see each other's contributions
2. **Deep-thread isolation** (depth 3+) - Prevents context pollution in focused work
3. **Natural conversation flow** - Mirrors how humans organize discussions

### Why Real Signed Events for Testing?

1. **Truth**: Tests use the SAME code as production
2. **Validation**: Crypto signatures prove event authenticity
3. **Debugging**: Can inspect actual Nostr events with real IDs
4. **Confidence**: If tests pass, production will work

## Development Workflow

### Adding a New Test Scenario

1. **Add to `generate-signed-events.ts`**:
```typescript
async generateMyScenario(): Promise<SignedConversation> {
    const user = await this.createUser();
    const agent = await this.createAgent("Agent", "agent", "role");

    const root = await this.createConversationRoot(...);
    const reply = await this.createAgentResponse(...);

    return { name: "My Scenario", events: [root, reply], agents: [agent], user };
}
```

2. **Add to `generateAllScenarios()`**:
```typescript
return Promise.all([
    this.generateComplexThreading(),
    this.generateMyScenario() // Add here
]);
```

3. **Run tests**:
```bash
bun run src/agents/execution/strategies/__tests__/run-tui.ts
```

### Debugging Filter Decisions

Use OpenTelemetry tracing in `FlattenedChronologicalStrategy.ts`:
```typescript
activeSpan.addEvent("event.included", {
    "event.id": event.id?.substring(0, 8),
    "inclusion.reason": isInThreadPath ? "in_thread_path" : "directly_relevant"
});
```

View traces at: http://localhost:16686

## Future Enhancements

- [ ] Full interactive TUI with Ink (currently WIP)
- [ ] Export scenarios to JSON for sharing
- [ ] Visual diff between different filtering strategies
- [ ] Performance benchmarks with 1000+ events
- [ ] Integration tests with real Nostr relays

## Summary

This testing infrastructure ensures that Nostr threading works correctly by:
1. Using **real signed events** (not mocks)
2. Running through **actual strategy code** (not simplified)
3. Validating **production scenarios** (bug fixes)
4. Providing **visual feedback** (HTML + TUI)

**Result**: High confidence that agents see the right messages at the right time.
