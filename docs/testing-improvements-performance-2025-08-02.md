# TENEX Testing Infrastructure Enhancement: Performance Testing

Date: 2025-08-02

## Summary

Implemented performance and timeout testing capabilities for the TENEX E2E testing framework, addressing one of the key future enhancements identified in E2E_FRAMEWORK.md.

## Problem Identified

The E2E testing framework lacked the ability to test system behavior under performance stress conditions:
- No way to simulate slow LLM responses
- No timeout handling verification
- No stress testing capabilities
- No memory usage testing

## Solution Implemented

### 1. Performance Testing Scenarios

Created `src/test-utils/mock-llm/scenarios/performance-testing.ts` with scenarios for:

- **Slow LLM responses** (5-second delays)
- **Very slow planning phase** (8-second delays) 
- **Timeout simulation** (35-second delays)
- **Memory-intensive responses** (50KB payloads)
- **Recovery after timeout**
- **Rapid sequential requests**

### 2. MockLLMService Enhancements

The MockLLMService already supported `streamDelay` functionality:
- Delays are applied in both `complete()` and `stream()` methods
- Configurable per-response delays
- Works with concurrent requests

### 3. Test Coverage

Created comprehensive E2E tests in `tests/e2e/performance-timeout.test.ts` covering:
- Slow response handling
- Timeout scenarios
- Memory usage tracking
- Concurrent request handling
- Recovery mechanisms

### 4. Integration Challenges

Discovered that the orchestrator agent uses a specialized routing backend that expects pure JSON responses. Updated scenarios to match the expected format.

## Key Files Added/Modified

1. **New Files:**
   - `src/test-utils/mock-llm/scenarios/performance-testing.ts` - Performance test scenarios
   - `tests/e2e/performance-timeout.test.ts` - E2E performance tests
   - `src/test-utils/mock-llm/performance.test.ts` - Unit tests for delay functionality
   - `tests/e2e/performance-simple.test.ts` - Simplified performance test examples

2. **Modified Files:**
   - `src/test-utils/mock-llm/scenarios/index.ts` - Added performance scenario exports

## Usage Examples

### Using Performance Scenarios in Tests

```typescript
// Setup test with performance scenarios
const context = await setupE2ETest(['performance-testing']);

// Execute agent with slow response
await executeAgent(context, "Orchestrator", conversationId, "performance test");
```

### Adding Custom Delays

```typescript
mockLLM.addResponse({
    trigger: { userMessage: /slow operation/ },
    response: {
        streamDelay: 5000, // 5 second delay
        content: "Delayed response"
    }
});
```

## Benefits

1. **Early Detection** - Identify timeout issues before production
2. **Performance Baseline** - Establish expected response times
3. **Stress Testing** - Verify system behavior under load
4. **Memory Safety** - Ensure large responses don't cause memory issues

## Future Improvements

1. **Actual Timeout Enforcement** - Currently delays work but actual timeout enforcement needs implementation at the execution layer
2. **Network Latency Simulation** - Add variable latency patterns
3. **Progressive Degradation** - Test system behavior as performance degrades
4. **Metrics Collection** - Automated performance metrics gathering

## Testing the Implementation

Run performance tests:
```bash
bun test ./tests/e2e/performance-timeout.test.ts --timeout 60000
```

Run unit tests for delay functionality:
```bash
bun test src/test-utils/mock-llm/performance.test.ts
```

## Conclusion

This enhancement addresses the "Performance Testing" future enhancement from E2E_FRAMEWORK.md, providing a foundation for testing system behavior under stress conditions. The implementation is minimal and focused, following the principle of incremental improvements.