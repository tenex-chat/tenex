# Mock Scenario ToolCall Structure Issue

## Severity: Medium

## Description
The mock scenario files in `src/test-utils/mock-llm/scenarios/` have incorrect toolCall structures after an attempted automated fix. The toolCalls need to match the LlmToolCall type from multi-llm-ts.

## Files Affected
- src/test-utils/mock-llm/scenarios/error-handling.ts
- src/test-utils/mock-llm/scenarios/inventory-generation.ts
- src/test-utils/mock-llm/scenarios/network-resilience.ts
- src/test-utils/mock-llm/scenarios/orchestrator-workflow.ts
- src/test-utils/mock-llm/scenarios/performance-testing.ts
- src/test-utils/mock-llm/scenarios/state-persistence.ts

## Current Issue
The toolCalls currently have a malformed structure where `function` property contains an object `{ name, arguments }` but the type system expects different structure based on LlmToolCall from multi-llm-ts.

## Correct Structure
Based on working tests, the structure should be:
```typescript
toolCalls: [{
    id: "1",
    type: "function",
    function: {
        name: "toolName",
        arguments: JSON.stringify({ /* args */ })
    }
}]
```

## Recommendation
1. Review the exact LlmToolCall type definition from multi-llm-ts
2. Create a consistent helper function to create toolCalls
3. Update all mock scenarios to use the correct structure
4. Consider adding type checking to prevent future issues

## Risk
Medium - These are test utilities and fixing them requires careful attention to maintain test coverage while ensuring type safety.