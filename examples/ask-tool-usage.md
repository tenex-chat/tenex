# Ask Tool Usage Examples

The Ask tool allows agents to ask questions to the project manager or human user and wait for their responses. This is particularly useful when agents need clarification, approval, or guidance during task execution.

## Tool Signature

```typescript
Ask(content: string, suggestions?: string[])
```

## Usage Examples

### 1. Open-Ended Questions

When an agent needs general input without specific constraints:

```javascript
// In an agent's tool usage
const response = await tools.ask({
  content: "What naming convention should I use for this new service?",
});
```

**Nostr Event Generated:**
```json
{
  "kind": 1111,
  "content": "What naming convention should I use for this new service?",
  "tags": [
    ["p", "<owner_pubkey>"],
    ["intent", "ask"],
    ["E", "<conversation_root>"],
    ["e", "<triggering_event>"]
  ]
}
```

### 2. Yes/No Questions

For binary decisions:

```javascript
const response = await tools.ask({
  content: "Should I proceed with the database migration?",
  suggestions: ["Yes", "No"]
});
```

**Nostr Event Generated:**
```json
{
  "kind": 1111,
  "content": "Should I proceed with the database migration?",
  "tags": [
    ["p", "<owner_pubkey>"],
    ["intent", "ask"],
    ["suggestion", "Yes"],
    ["suggestion", "No"],
    ["E", "<conversation_root>"],
    ["e", "<triggering_event>"]
  ]
}
```

### 3. Multiple Choice Questions

When there are specific options to choose from:

```javascript
const response = await tools.ask({
  content: "Which testing framework should I use for this project?",
  suggestions: ["Jest", "Vitest", "Mocha", "Bun Test"]
});
```

**Nostr Event Generated:**
```json
{
  "kind": 1111,
  "content": "Which testing framework should I use for this project?",
  "tags": [
    ["p", "<owner_pubkey>"],
    ["intent", "ask"],
    ["suggestion", "Jest"],
    ["suggestion", "Vitest"],
    ["suggestion", "Mocha"],
    ["suggestion", "Bun Test"],
    ["E", "<conversation_root>"],
    ["e", "<triggering_event>"]
  ]
}
```

## When to Use the Ask Tool

### Good Use Cases

1. **Ambiguous Requirements**: When implementation details are unclear
2. **Critical Decisions**: Before making breaking changes or architectural decisions
3. **User Preferences**: When multiple valid approaches exist
4. **Approval Gates**: Before proceeding with destructive operations
5. **Configuration Values**: When specific values aren't provided

### Example Scenarios

```javascript
// Asking for clarification on requirements
await tools.ask({
  content: "The requirement mentions 'user authentication' - should this include OAuth providers or just email/password?",
  suggestions: ["Email/Password only", "Include OAuth", "Both"]
});

// Getting approval for a critical change
await tools.ask({
  content: "This refactoring will modify 47 files. Should I proceed?",
  suggestions: ["Yes", "No", "Show me the changes first"]
});

// Asking about implementation approach
await tools.ask({
  content: "I found three ways to implement this feature. Which approach do you prefer?",
  suggestions: ["Option A: Simple but limited", "Option B: Complex but flexible", "Option C: Balanced approach"]
});
```

## Response Handling

The tool waits synchronously for a response from the project manager/human user:

```javascript
const response = await tools.ask({
  content: "Continue with deployment?",
  suggestions: ["Yes", "No", "Abort"]
});

// Response structure
// {
//   type: "delegation_responses",
//   responses: [{
//     response: "Yes",
//     from: "<owner_pubkey>"
//   }]
// }

// Acting on the response
if (response.responses[0].response === "Yes") {
  // Proceed with deployment
} else if (response.responses[0].response === "No") {
  // Skip deployment
} else {
  // Abort the operation
}
```

## Integration with Delegation System

The Ask tool uses the same underlying delegation infrastructure as other delegation tools, ensuring:

1. **Consistent Behavior**: Responses are tracked and handled the same way as delegations
2. **Proper Threading**: Questions maintain conversation context through E/e tags
3. **Event-Driven**: The agent pauses execution until a response event is received
4. **Reliable Delivery**: Uses the same robust event publishing and tracking mechanisms

## Implementation Notes

- The tool automatically determines the project owner from the project context
- Questions are published as kind:1111 events following NIP-22
- Suggestions are included as individual tags for client parsing
- The tool integrates with the DelegationRegistry for response tracking
- Responses follow the same completion flow as delegation responses