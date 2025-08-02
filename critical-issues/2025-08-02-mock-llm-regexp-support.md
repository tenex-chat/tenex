# Critical Issue: MockLLMService RegExp Support

## Issue Summary
The MockLLMService in the E2E testing framework has a type mismatch issue where it expects `agentName` to be a string but the trigger interface allows it to be a RegExp. This causes a runtime error when trying to call `toLowerCase()` on a RegExp object.

## Impact
- E2E tests using RegExp patterns for agent name matching fail
- Limits flexibility in writing mock scenarios
- Affects the new network resilience test and potentially other tests

## Error Details
```
TypeError: trigger.agentName.toLowerCase is not a function
at findMatchingResponse (/src/test-utils/mock-llm/MockLLMService.ts:163:56)
```

## Root Cause
In MockLLMService.ts line 163:
```typescript
if (trigger.agentName && trigger.agentName.toLowerCase() !== agentName.toLowerCase()) {
    continue;
}
```

The code assumes `trigger.agentName` is always a string, but the type definition allows:
```typescript
agentName?: string | RegExp;
```

## Proposed Solution
Update MockLLMService to properly handle both string and RegExp agent names:

```typescript
if (trigger.agentName) {
    if (typeof trigger.agentName === 'string') {
        if (trigger.agentName.toLowerCase() !== agentName.toLowerCase()) {
            continue;
        }
    } else if (trigger.agentName instanceof RegExp) {
        if (!trigger.agentName.test(agentName)) {
            continue;
        }
    }
}
```

## Workaround
For now, avoid using RegExp patterns in mock scenario triggers. Use exact string matches instead.

## Files Affected
- `/src/test-utils/mock-llm/MockLLMService.ts` - Needs fix for RegExp support
- `/tests/e2e/nostr-network-resilience.test.ts` - New test affected by this issue
- `/src/test-utils/mock-llm/scenarios/network-resilience.ts` - Scenario needs string agent names

## Priority
Medium - This blocks certain E2E test patterns but has a workaround