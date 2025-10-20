# Quick Start Guide - Nostr Threading Visualization

## 🌐 View Production Conversations from Nostr

**Best for**: Debugging real issues, understanding actual agent behavior

```bash
# View any Nostr conversation thread
bun run src/agents/execution/strategies/__tests__/nostr-conversation-viewer.tsx <event-id>

# Example with the claude-code bug we fixed
bun run src/agents/execution/strategies/__tests__/nostr-conversation-viewer.tsx \
  1e19502b9d3febac577d3b7ce3bd5888c945b2261ff0480f45c870228bac4fde

# Specify custom relays
bun run src/agents/execution/strategies/__tests__/nostr-conversation-viewer.tsx \
  <event-id> \
  wss://relay.damus.io \
  wss://nos.lol
```

### Features:
- ✅ Fetches LIVE events from Nostr relays
- ✅ Shows actual agent filtering using production code
- ✅ Resolves participant names from AgentRegistry + PubkeyNameRepository
- ✅ Interactive - switch between participants with ↑/↓
- ✅ Reddit-style threaded view with visual indicators

### Controls:
- **↑/↓**: Select different participants (agents or users)
- **Q or ESC**: Quit

### What You'll See:
```
Select Participant (↑↓):
→ Alice (PM) - sees 7/10 (70%)
  Bob (Developer) - sees 9/10 (90%)
  Charlie (Reviewer) - sees 5/10 (50%)
  User - all events

Alice's View - 7/10 events
Green = Visible | Gray = Filtered Out
  ✓ User: 🚀 Starting new feature...
  ✓ User: @alice can you coordinate...
  ✓ Alice: @bob-dev Implement dark mode...
  ✗ Bob: Starting implementation...    <- Filtered out
  ✗ Bob: Implementation complete...    <- Filtered out
  ✓ Bob: Dark mode complete (to Alice)
```

---

## ⭐ Interactive Test Scenarios

**Best for**: Understanding the filtering strategy, testing edge cases

```bash
bun run src/agents/execution/strategies/__tests__/interactive-tui.tsx
```

### Features:
- ✅ 3 pre-built scenarios with real signed events
- ✅ Switch scenarios with ←/→
- ✅ Switch agents with ↑/↓
- ✅ See exactly what each agent sees

### Controls:
- **←/→**: Change scenario
- **↑/↓**: Select agent
- **Q or ESC**: Quit

### Scenarios:
1. **Complex Threading** - Multi-level delegation with code review
2. **Root Collaboration** - All agents at root level (collaborative)
3. **Delegation Chain** - PM → Dev → Reviewer → Tester

---

## 📊 Non-Interactive Report

**Best for**: CI/CD, automated testing, generating reports

```bash
bun run src/agents/execution/strategies/__tests__/run-tui.ts
```

Outputs a detailed text report showing which events each agent sees.

---

## 🧪 Run Unit Tests

**Best for**: Verifying the strategy works correctly

```bash
# Run all tests
bun test src/agents/execution/strategies/__tests__/

# Run specific test
bun test src/agents/execution/strategies/__tests__/FlattenedChronologicalStrategy.root-siblings.test.ts
```

**23 tests** covering:
- Thread path inclusion
- Branching conversations
- Public broadcasts
- Root-level collaboration
- Delegation filtering

---

## 🎯 Common Use Cases

### Debug a Production Issue
```bash
# Get the root event ID from your logs or Jaeger traces
bun run src/agents/execution/strategies/__tests__/nostr-conversation-viewer.tsx <event-id>

# Navigate to the agent that's having issues with ↑/↓
# See exactly which events they see (green ✓) vs filtered out (gray ✗)
```

### Understand Agent Perspective
```bash
# Run interactive TUI
bun run src/agents/execution/strategies/__tests__/interactive-tui.tsx

# Use ←/→ to explore different conversation patterns
# Use ↑/↓ to see how different agents see the same conversation
```

### Validate a Fix
```bash
# Run the test suite
bun test src/agents/execution/strategies/__tests__/

# Check the root-siblings test (the claude-code bug we fixed)
bun test src/agents/execution/strategies/__tests__/FlattenedChronologicalStrategy.root-siblings.test.ts
```

---

## 💡 Understanding the Output

### Event Visibility Indicators
- **Green ✓** - Event is visible to the selected agent
- **Gray ✗** - Event is filtered out
- **Bold name** - Event author
- **Indentation** - Shows parent-child threading

### Why Events Get Filtered
An event is visible if **EITHER**:
1. **In thread path**: From root to agent's triggering event
   - At depth 2: Includes ALL root-level siblings (collaborative)
   - At depth 3+: Only direct parent chain (focused)
2. **Directly relevant**:
   - Event FROM the agent
   - Event TARGETED to the agent (p-tag)
   - Public broadcast (no p-tags)
   - Delegation response to the agent

### Visibility Percentage
- **100%** - Non-agent participants see everything
- **70-90%** - Typical for agents involved in the conversation
- **30-50%** - Agents in deep sub-threads (intentionally filtered)

---

## 🐛 Troubleshooting

### "NDK not initialized"
The Nostr viewer needs to connect to relays. This is normal and happens during initialization.

### "No events found"
- Check the event ID is correct
- Try different relays
- Make sure the event exists on public relays

### "Agent not found in registry"
- Make sure you're in a project directory with `.tenex/` folder
- Check that `agents.json` exists and has the agent defined

### Event visibility seems wrong
1. Check which event triggered the agent (shown in output)
2. Verify the thread structure (indentation shows parent-child)
3. Remember: depth 2 includes siblings, depth 3+ doesn't
4. Run the test suite to verify strategy is working: `bun test`

---

## 📚 Related Documentation

- **Main README**: `src/agents/execution/strategies/__tests__/README.md`
- **Strategy Implementation**: `src/agents/execution/strategies/FlattenedChronologicalStrategy.ts`
- **Thread Service**: `src/conversations/services/ThreadService.ts`

---

## 🎨 Example Session

```bash
$ bun run src/agents/execution/strategies/__tests__/nostr-conversation-viewer.tsx 1e19502b
Fetching conversation for event: 1e19502b...
Found root event. Fetching thread...
Fetched 10 events in thread

┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ 🌐 Nostr Conversation Viewer (Live from Relays)   ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

Root Event: 1e19502b9d3febac...
Total Events: 10 | Participants: 4

┌─────────────────────────────────────────────┐
│ Select Participant (↑↓):                    │
│ → claude-code (assistant) - sees 8/10 (80%)│
│   clean-code-nazi (reviewer) - sees 5/10    │
│   User - all events                         │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ claude-code's View - 8/10 events            │
│ Green = Visible | Gray = Filtered Out       │
│                                              │
│ ✓ User: @clean-code-nazi review the chat    │
│   ✗ clean-code-nazi: [tool call]            │
│   ✓ clean-code-nazi: This is unacceptable!  │
│ ✓ User: @claude-code thoughts?             │
└─────────────────────────────────────────────┘

↑↓ Select participant | Q/ESC Quit
```

That's it! Now you can explore any Nostr conversation and see exactly what each agent sees. 🚀
