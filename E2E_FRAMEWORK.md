# TENEX E2E Testing Framework

## Overview

This document describes the End-to-End (E2E) testing framework for TENEX, which enables comprehensive testing of agent workflows without relying on actual LLM services. The framework uses deterministic mock responses to simulate complete agent interactions.

## Architecture

### Core Components

1. **Mock LLM Service** - Simulates LLM responses based on predefined scenarios
2. **Test Harness** - Sets up the test environment and manages test lifecycle
3. **Scenario Definitions** - Predefined agent conversation flows
4. **Assertion Utilities** - Custom assertions for agent-specific validations

### Key Design Decisions

1. **Deterministic Responses**: All LLM responses are predefined based on triggers (agent name, phase, message content, previous tools)
2. **Real Component Integration**: We use real ConversationManager, AgentExecutor, and tool implementations - only the LLM is mocked
3. **Scenario-Based Testing**: Complex workflows are defined as reusable scenarios
4. **Phase-Aware Testing**: Tests validate proper phase transitions throughout the workflow

## Test Structure

### 1. Setup Phase
```typescript
// Initialize test environment
const testDir = await createTempDir();
const projectPath = path.join(testDir, "test-project");

// Create mock LLM with scenarios
const mockLLM = createMockLLMService(['orchestrator-workflow']);

// Initialize real components
const conversationManager = new ConversationManager(projectPath);
const agentRegistry = new AgentRegistry(projectPath);
```

### 2. Execution Phase
```typescript
// Create conversation
const conversation = await conversationManager.createConversation(event);

// Execute agent
const executor = new AgentExecutor(executionContext);
await executor.execute();
```

### 3. Validation Phase
```typescript
// Verify phase transitions
expect(conversation.phase).toBe("VERIFICATION");
expect(conversation.phaseTransitions).toHaveLength(3);

// Verify tool calls
const history = mockLLM.getRequestHistory();
expect(history).toContainToolCall("continue");
```

## Scenario Development

### Anatomy of a Scenario

Each scenario consists of:
1. **Triggers** - Conditions that must match for the response to be used
2. **Responses** - The content and tool calls to return
3. **Priority** - Higher priority responses are checked first

Example:
```typescript
{
    trigger: {
        agentName: "Orchestrator",
        phase: "CHAT",
        userMessage: /create.*authentication/i
    },
    response: {
        content: "I'll help you create an authentication system.",
        toolCalls: [{
            id: "1",
            type: "function",
            function: {
                name: "continue",
                arguments: JSON.stringify({
                    summary: "Creating auth system",
                    suggestedPhase: "PLAN"
                })
            }
        }]
    },
    priority: 10
}
```

## Test Patterns

### 1. Full Workflow Test
Tests complete agent workflow from initial request to completion.

### 2. Error Recovery Test
Validates system behavior when tools fail or return errors.

### 3. Phase Transition Test
Ensures correct phase transitions and state management.

### 4. Multi-Agent Collaboration Test
Tests handoffs between different agents.

## Running Tests

```bash
# Run all E2E tests
bun test tests/e2e

# Run specific test
bun test ./tests/e2e/orchestrator-workflow.test.ts

# Run with debug output
DEBUG=true bun test ./tests/e2e/orchestrator-workflow.test.ts

# Run with extended timeout
bun test ./tests/e2e/orchestrator-workflow.test.ts --timeout 30000
```

## Best Practices

1. **Isolation**: Each test should create its own temporary directory
2. **Cleanup**: Always cleanup temp directories and reset singletons
3. **Determinism**: Avoid randomness in tests - use fixed IDs and timestamps
4. **Debugging**: Use `mockLLM.getRequestHistory()` to debug test failures
5. **Scenarios**: Reuse scenarios across tests for consistency

## Extending the Framework

### Adding New Scenarios

1. Create a new scenario file in `src/test-utils/mock-llm/scenarios/`
2. Define triggers and responses for your workflow
3. Export the scenario and add to `allScenarios`

### Adding Custom Assertions

1. Add assertion functions to `src/test-utils/assertions.ts`
2. Focus on agent-specific validations (phase transitions, tool sequences, etc.)

## Troubleshooting

### Common Issues

1. **"No matching response found"** - Check trigger conditions match exactly
2. **Phase mismatch** - Ensure conversation phase is updated correctly
3. **Tool validation errors** - Verify tool arguments are valid JSON

### Debug Mode

Enable debug logging:
```typescript
const mockLLM = createMockLLMService(['scenario'], {
    debug: true // Logs all trigger matching attempts
});
```

## Lessons Learned

### Module Mocking Challenges

1. **Import Order Matters** - Mocks must be defined before importing modules that use them
2. **Cached Modules** - Bun caches imported modules, making it difficult to mock dependencies after import
3. **Deep Dependencies** - Some modules have deep dependency chains that require extensive mocking

### Successful Patterns

1. **Mock LLM Service** - Works well for deterministic testing of agent behaviors
2. **Scenario-Based Testing** - Predefined response sequences effectively test complex workflows
3. **Tool Call Verification** - Tracking tool calls provides good validation of agent decisions

### Recommendations

1. **Start Simple** - Begin with unit tests for individual components before full E2E
2. **Mock at Boundaries** - Mock external services (LLM, Nostr, filesystem) not internal logic
3. **Use Real Components** - When possible, use real implementations with mocked I/O

## Future Enhancements

1. **Performance Testing** - Add scenarios with delays to test timeout handling
2. **Concurrency Testing** - Test multiple simultaneous conversations
3. **State Persistence** - Test conversation recovery after restart
4. **Real Nostr Integration** - Optional tests with local Nostr relay
5. **Test Harness Improvements** - Better module isolation and mock management