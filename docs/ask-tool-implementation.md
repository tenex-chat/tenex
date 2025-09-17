# Ask Tool Implementation Summary

## Overview

The Ask tool has been successfully implemented to allow agents to ask questions to the project manager or human user and wait for responses. The tool seamlessly integrates with the existing delegation infrastructure while providing a specialized interface for question-answer interactions.

## Implementation Details

### 1. Tool Implementation (`src/tools/implementations/ask.ts`)

- **Function**: `createAskTool(context: ExecutionContext)`
- **Input Schema**:
  - `content`: The question to ask (required)
  - `suggestions`: Optional array of suggested responses
- **Output**: `DelegationResponses` containing the user's response

Key features:
- Automatically resolves project owner as the recipient
- Supports open-ended, yes/no, and multiple-choice questions
- Uses DelegationService for consistent response handling
- Provides human-readable content generation for logging

### 2. Nostr Event Encoding (`src/nostr/AgentEventEncoder.ts`)

Added new encoding functionality:
- **Intent Type**: `AskIntent` with content and optional suggestions
- **Encoding Function**: `encodeAsk(intent: AskIntent, context: EventContext)`

Event structure:
- Kind: 1111 (NIP-22 conversation event)
- Content: The question text
- Tags:
  - `["p", "<owner_pubkey>"]` - Recipient
  - `["intent", "ask"]` - Marks as ask event
  - `["suggestion", "..."]` - One tag per suggestion (if provided)
  - Standard conversation threading tags (E, K, P, e)

### 3. Agent Publisher Integration (`src/nostr/AgentPublisher.ts`)

Added new publishing method:
- **Function**: `ask(intent: AskIntent, context: EventContext)`
- Handles event signing and publishing
- Registers with DelegationRegistry for response tracking
- Returns event ID and batch ID for tracking

### 4. Delegation Service Extension (`src/services/DelegationService.ts`)

Extended to handle ask intent:
- Recognizes `type: "ask"` in delegation intent
- Routes to appropriate publisher method
- Maintains consistent response waiting behavior

### 5. Tool Registry (`src/tools/registry.ts`)

- Added `"ask"` to `ToolName` type
- Registered `createAskTool` in `toolFactories`
- Tool is now available to all agents

## Testing

### Unit Tests

1. **AgentEventEncoder Tests** (`src/nostr/__tests__/AgentEventEncoder.test.ts`)
   - Tests for open-ended questions
   - Tests for yes/no questions  
   - Tests for multiple-choice questions
   - Verification of tag structure

2. **Ask Tool Tests** (`src/tools/implementations/__tests__/ask.test.ts`)
   - Tool metadata verification
   - Execution tests for all question types
   - Human-readable content generation
   - Error handling for missing project owner

All tests pass successfully.

## Usage Example

```typescript
// In an agent's execution
const response = await tools.ask({
  content: "Which approach should we take?",
  suggestions: ["Approach A", "Approach B", "Custom approach"]
});

// Process the response
const userChoice = response.responses[0].response;
if (userChoice === "Approach A") {
  // Implement approach A
} else if (userChoice === "Approach B") {
  // Implement approach B
} else {
  // Handle custom approach
}
```

## Design Decisions

1. **Reuse of Delegation Infrastructure**: The Ask tool leverages the existing DelegationService and DelegationRegistry, ensuring consistent behavior and reducing code duplication.

2. **Event Kind 1111**: Uses the same conversation event kind as delegations, maintaining compatibility with existing Nostr clients.

3. **Suggestion Tags**: Each suggestion is a separate tag rather than a single array, making it easier for clients to parse and display options.

4. **Intent Tag**: The `["intent", "ask"]` tag distinguishes ask events from regular delegations, allowing clients to provide specialized UI.

5. **Automatic Owner Resolution**: The tool automatically determines the project owner from context, simplifying usage for agents.

## Integration Points

- **DelegationService**: Handles the waiting mechanism
- **DelegationRegistry**: Tracks pending questions and responses
- **AgentPublisher**: Manages event creation and publishing
- **AgentEventEncoder**: Ensures consistent event structure
- **Tool Registry**: Makes the tool available to agents

## Benefits

1. **User Control**: Agents can now request human input for critical decisions
2. **Flexibility**: Supports various question types based on context
3. **Integration**: Seamlessly works with existing delegation flow
4. **Clarity**: Explicit questions with optional suggestions improve UX
5. **Tracking**: Questions and responses are properly logged in Nostr

## Future Enhancements

Potential improvements could include:
- Timeout handling for unanswered questions
- Priority levels for urgent questions
- Rich media support in questions (images, code blocks)
- Question templates for common scenarios
- Analytics on question/response patterns