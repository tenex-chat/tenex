# E2E Tests Migration

This directory contains E2E test files that need to be migrated from the older `executeAgent()` approach to the newer `executeConversationFlow()` approach.

## Why These Tests Need Migration

These tests use the deprecated `executeAgent()` function which:
- Manually executes individual agents without orchestrator routing
- Doesn't reflect real-world usage where the orchestrator always routes messages
- Requires more complex mock setup and manual phase management
- Doesn't provide comprehensive execution tracking

## Tests to Migrate

1. **agent-error-recovery.test.ts**
   - Tests error recovery mechanisms across different agents
   - Needs conversion to use orchestrator-driven flow with error scenarios

2. **concurrency-multiple-conversations.test.ts**
   - Tests handling of multiple concurrent conversations
   - Needs conversion to spawn multiple `executeConversationFlow()` calls

3. **nostr-network-resilience.test.ts**
   - Tests resilience to Nostr network issues
   - Needs conversion to use flow execution with network error mocks

4. **performance-timeout.test.ts**
   - Tests performance and timeout handling
   - Needs conversion to use flow execution with timeout scenarios

## Migration Guidelines

To migrate a test from `executeAgent()` to `executeConversationFlow()`:

1. **Update Mock Responses**
   - Add orchestrator routing responses for each phase transition
   - Ensure agents use `continue` or `complete` tools appropriately
   - Use `previousAgent` trigger for orchestrator routing decisions

2. **Replace Manual Agent Execution**
   ```typescript
   // Old approach:
   await executeAgent(context, "executor", conversationId, "message");
   
   // New approach:
   const trace = await executeConversationFlow(
     context,
     conversationId,
     "message",
     { maxIterations: 10 }
   );
   ```

3. **Update Assertions**
   - Use trace-based assertions: `assertAgentSequence()`, `assertPhaseTransitions()`, `assertToolCalls()`
   - Check execution trace instead of manual state checks

4. **Handle Special Cases**
   - Error scenarios: Mock responses should include error conditions
   - Timeouts: Use `maxIterations` parameter to prevent infinite loops
   - Concurrency: Run multiple `executeConversationFlow()` calls in parallel

## Example Migration Pattern

See `orchestrator-workflow.test.ts` and `state-persistence.test.ts` for examples of properly migrated tests using `executeConversationFlow()`.

## Note on executeAgent()

The `executeAgent()` function in `test-harness.ts` should be deprecated and eventually removed once all tests are migrated. It's currently kept for backwards compatibility during the migration process.