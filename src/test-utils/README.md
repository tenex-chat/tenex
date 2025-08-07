# Test Utilities

This directory contains reusable test utilities for the TENEX backend.

## Mock Setup Helpers

The `mock-setup.ts` file provides common mock setup functions to reduce duplication across test files:

### Usage Example

```typescript
import { setupCommonTestMocks } from "@/test-utils";

describe("MyComponent", () => {
    beforeEach(() => {
        // Setup all common mocks at once
        setupCommonTestMocks("/test/project");
        
        // Or setup individual mocks as needed
        setupServicesMock("/test/project");
        setupExecutionLoggerMock();
        setupTracingMock();
    });
});
```

### Available Functions

- `setupServicesMock(projectPath)` - Mocks the @/services module
- `setupExecutionTimeMock()` - Mocks execution time tracking
- `setupExecutionLoggerMock()` - Mocks the execution logger
- `setupTracingMock()` - Mocks tracing context
- `setupAgentUtilsMock(tools)` - Mocks agent utilities
- `setupToolRegistryMock()` - Mocks the tool registry
- `setupCommonTestMocks(projectPath)` - Sets up all mocks at once

## Mock Factories

The `mock-factories.ts` file provides factory functions for creating mock objects:

- `createMockNDKEvent()` - Creates a mock Nostr event
- `createMockAgent()` - Creates a mock agent
- `createMockConversation()` - Creates a mock conversation
- `createMockExecutionContext()` - Creates a mock execution context
- `createMockToolCall()` - Creates a mock tool call
- `createMockPhaseTransition()` - Creates a mock phase transition
- `createMockFileSystem()` - Creates a mock file system structure
- `MockBuilder` - A builder class for complex mock objects
- `MockFactory` - Namespace providing all factory functions for backwards compatibility

## Mock LLM Service

The `mock-llm/` directory provides a comprehensive mock LLM service for deterministic testing:

- `MockLLMService` - A mock implementation of the LLM service
- Predefined scenarios for common workflows
- Support for custom response patterns
- Deterministic behavior for E2E testing

## Error Handler Utility

The `error-handler.ts` file provides consistent error handling patterns:

- `handleAsyncError()` - Handle async operations with logging
- `handleSyncError()` - Handle sync operations with logging  
- `logAndThrow()` - Log errors and re-throw
- `retryWithBackoff()` - Retry operations with exponential backoff

## Test Assertions

Custom assertion helpers are available via the `assertions` object:

- `toThrowAsync()` - Assert async functions throw errors
- `toContainObjectMatching()` - Assert arrays contain matching objects

## Other Utilities

- `createTempDir()` - Create temporary directories for testing
- `cleanupTempDir()` - Clean up temporary directories
- `resetAllMocks()` - Reset all mocks and singletons
- `waitFor()` - Wait for conditions to be met
- `mockFileSystem()` - Mock file system operations
- `ConsoleCapture` - Capture console output during tests