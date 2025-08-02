# Critical Issue: E2E Test Failures

**Date**: 2025-01-02
**Severity**: High
**Component**: E2E Testing Infrastructure

## Summary

Multiple E2E tests are failing due to recent changes in the codebase. The test harness and several tests need to be updated to match the current implementation.

## Impact

- 66 out of 70 E2E tests are failing
- New performance timeout tests cannot run properly due to infrastructure issues
- Testing infrastructure is not properly validating system behavior

## Root Causes

1. **RoutingBackend expects AgentExecutor in context**
   - Error: "AgentExecutor not available in context"
   - The RoutingBackend now expects `context.agentExecutor` to be present

2. **ConfigService API changes**
   - Error: "configService.setProjectConfig is not a function"
   - The ConfigService interface has changed and tests are using outdated methods

3. **ExecutionContext missing conversationId**
   - Error: "undefined is not an object (evaluating 'context.conversationId')"
   - ExecutionContext now requires conversationId field

4. **JSON parsing errors in routing decisions**
   - Error: "Failed to parse routing decision: No JSON found in response"
   - Mock responses need to return proper JSON format for orchestrator routing

## Proposed Solution

### 1. Update Test Harness
- Add agentExecutor to execution context
- Update ConfigService usage to match current API
- Ensure ExecutionContext includes all required fields

### 2. Fix Mock Responses
- Ensure orchestrator responses return valid JSON
- Update response format to match expected routing decision structure

### 3. Update Individual Tests
- Update all tests to use new API signatures
- Fix context creation to include all required fields
- Update mock expectations to match current behavior

## Priority Actions

1. **Immediate**: Update test harness to fix context issues
2. **Short-term**: Fix all E2E tests to pass with current codebase
3. **Medium-term**: Add validation to prevent API changes from breaking tests

## Technical Details

### Failed Test Categories:
- Agent Error Recovery: 5 tests
- Complete Tool Integration: 2 tests  
- MCP Service Error Handling: 8 tests
- Performance Execution Timeout: 5 tests (newly added)
- Various other E2E tests: ~46 tests

### Example Fix for ExecutionContext:
```typescript
const executionContext: ExecutionContext = {
    conversationId: conversationId, // Add this field
    conversation: conversation!,
    conversationManager: context.conversationManager,
    agent: context.agentRegistry.getAgent("Orchestrator")!,
    agentExecutor: executor, // Add this field
    // ... rest of context
};
```

## Next Steps

1. Create a comprehensive fix for the test harness
2. Update all mock scenarios to use correct response formats
3. Run full E2E test suite to ensure all tests pass
4. Add CI checks to prevent test infrastructure breakage