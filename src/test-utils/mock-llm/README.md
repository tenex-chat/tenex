# Mock LLM Service

**Status: Ready for Use** ✅

This Mock LLM Service is fully functional and ready to be integrated into the new e2e testing infrastructure.

## What This Does

Provides a deterministic LLM service for testing that returns pre-scripted responses based on conversation context, instead of calling real LLM APIs.

## Components

### MockLLMService (`MockLLMService.ts`)
The core mock implementation that:
- Accepts trigger conditions (agent name, iteration count, message patterns, etc.)
- Matches incoming requests against triggers (priority-sorted)
- Returns appropriate responses (content + tool calls)
- Tracks conversation context

### Scenarios (`scenarios/`)
Pre-built test scenarios:
- `error-handling.ts` - Error detection and recovery
- `concurrency-workflow.ts` - Multiple concurrent conversations
- `state-persistence.ts` - State save/load
- `network-resilience.ts` - Network issue handling
- `threading-workflow.ts` - Thread-based conversations
- `performance-testing.ts` - Performance and timeout testing

### Types (`types.ts`)
Type definitions for triggers, responses, and scenarios.

## Usage Example

```typescript
import { createMockLLMService } from "@/test-utils/mock-llm";

// Create mock with a scenario
const mockLLM = createMockLLMService(["error-handling"], {
  debug: true
});

// Or create with custom responses
const mockLLM = createMockLLMService([], {
  responses: [
    {
      trigger: {
        agentName: "executor",
        iterationCount: 1
      },
      response: {
        content: "I've implemented the feature",
        toolCalls: [{
          name: "continue",
          params: { phase: "verification" }
        }]
      },
      priority: 100
    }
  ]
});

// Use in tests
const response = await mockLLM.complete({
  messages: [
    { role: "system", content: "You are the executor agent" },
    { role: "user", content: "Implement authentication" }
  ],
  options: { configName: "test-model" }
});
```

## Trigger Conditions

Responses can match on:
- `systemPrompt`: Regex or string match on system prompt
- `userMessage`: Regex or string match on user message
- `agentName`: Specific agent name
- `iterationCount`: How many times this agent has been called
- `previousAgent`: Which agent executed previously
- `messageContains`: Keyword in any message
- `phase`: Current conversation phase
- `previousToolCalls`: Tools called in previous turns

## Priority Matching

Triggers are checked in priority order (higher = first):
```typescript
responses = [
  { priority: 120, trigger: {...}, response: {...} },  // Checked first
  { priority: 100, trigger: {...}, response: {...} },
  { priority: 90, trigger: {...}, response: {...} },   // Checked last
];
```

## Context Tracking

The mock maintains per-conversation context:
- Agent iteration counts
- Last agent executed
- Last continue caller
- Overall iteration count

This enables context-aware responses that change based on conversation flow.

## Integration with E2E Tests

When the e2e testing infrastructure is rebuilt, this MockLLMService will be used to:

1. Replace real LLM API calls in tests
2. Provide deterministic, predictable responses
3. Enable testing of complex multi-agent workflows
4. Simulate error conditions and edge cases

See `E2E_TESTING_ARCHITECTURE.md` in the project root for the full architecture design.

## Adding New Scenarios

Create a new file in `scenarios/`:

```typescript
import type { MockLLMScenario } from "../types";

export const myScenario: MockLLMScenario = {
  name: "my-scenario",
  description: "Description of the workflow",
  responses: [
    {
      trigger: {
        // Matching conditions
      },
      response: {
        // Response to return
      },
      priority: 100
    }
  ]
};
```

Then export it from `scenarios/index.ts`:

```typescript
export * from "./my-scenario";
import { myScenario } from "./my-scenario";

export const allScenarios: MockLLMScenario[] = [
  // ... existing scenarios
  myScenario,
];
```

## Current Status

✅ MockLLMService - Complete and tested
✅ Predefined scenarios - Ready to use
✅ Type definitions - Complete
❌ E2E test harness - Not yet rebuilt (see E2E_TESTING_ARCHITECTURE.md)
❌ Test execution utilities - Not yet rebuilt
❌ Assertion helpers - Not yet rebuilt

This MockLLMService is production-ready and waiting for the e2e test infrastructure to be rebuilt around it.
