# Using NDK Test Utilities in Tenex

## Overview

The NDK (Nostr Development Kit) provides comprehensive testing infrastructure that can replace our custom mocks. These utilities are available in the installed package at `@nostr-dev-kit/ndk/test`.

## Available Test Utilities

### 1. **RelayPoolMock**
- Mock implementation of a relay pool
- Methods: `addMockRelay()`, `simulateEventOnAll()`, `disconnectAll()`
- Simulates multiple relay connections without network calls

### 2. **RelayMock**
- Individual mock relay implementation
- Methods: `connect()`, `disconnect()`, `simulateEvent()`, `simulateEOSE()`
- Can simulate receiving events and connection states

### 3. **UserGenerator**
- Provides deterministic test users
- Available users: alice, bob, carol, dave, eve
- Always returns the same pubkeys/privkeys for consistent testing
- Example: `const alice = await UserGenerator.getUser("alice", ndk)`

### 4. **SignerGenerator**
- Creates signers for test users
- Can sign events with deterministic keys
- Example: `const signer = SignerGenerator.getSigner("alice")`

### 5. **EventGenerator**
- Helper to create various event types
- Generates properly formatted Nostr events
- Useful for creating test data

### 6. **TimeController**
- Controls time in tests
- Allows setting specific times and advancing time
- Useful for time-dependent logic testing

### 7. **TestEventFactory**
- Factory for creating test events
- Provides shortcuts for common event types

## Migration Strategy

### Current State
- Custom mocks in `/src/agents/execution/strategies/__tests__/test-mocks.ts`
- Simple NDKEvent mock that avoids network initialization
- Custom PubkeyNameRepository mock

### Recommended Approach

1. **For new tests**: Use NDK test utilities directly
2. **For existing tests**: Keep working tests as-is, migrate gradually
3. **For failing tests**: Consider using NDK utilities if it simplifies the fix

## Example Usage

```typescript
import { beforeEach, describe, expect, it } from "bun:test";
import NDK, { NDKEvent } from "@nostr-dev-kit/ndk";
import { RelayPoolMock, UserGenerator, SignerGenerator } from "@nostr-dev-kit/ndk/test";

describe("Example Test", () => {
    let ndk: NDK;
    let pool: RelayPoolMock;

    beforeEach(() => {
        pool = new RelayPoolMock();
        ndk = new NDK({ explicitRelayUrls: ["wss://relay.test.com"] });
        // @ts-expect-error - Replace pool for testing
        ndk.pool = pool;

        const relay = pool.addMockRelay("wss://relay.test.com");
        relay.connect();
    });

    it("should create signed events", async () => {
        const alice = await UserGenerator.getUser("alice", ndk);
        const event = new NDKEvent(ndk);
        event.kind = 1;
        event.content = "Test message";
        event.pubkey = alice.pubkey;

        const signer = SignerGenerator.getSigner("alice");
        await event.sign(signer);

        expect(event.sig).toBeDefined();
    });
});
```

## Benefits

1. **Consistency**: Uses the same infrastructure as NDK's own tests
2. **Realism**: Tests use actual NDK classes instead of mocks
3. **Deterministic**: Test users and events are reproducible
4. **Maintenance**: Less custom mock code to maintain
5. **Feature-Complete**: Supports relay simulation, EOSE, subscriptions, etc.

## Files Created for Reference

1. `/src/__tests__/ndk-test-example.test.ts` - Basic examples with comments
2. `/src/__tests__/verify-ndk-test-import.test.ts` - Verifies utilities can be imported
3. `/src/__tests__/using-ndk-test-utils.test.ts` - Practical usage examples

## Current Test Status

After our test suite improvements:
- **562 passing tests** (up from 538)
- **81 failing tests** (down from 179)
- Successfully migrated from Vitest to Bun test
- Fixed major API mismatches and missing exports
- Cleaned up obsolete tests

## Next Steps

1. Use NDK test utilities for new test files
2. When fixing complex relay/event tests, consider migrating to NDK utilities
3. Keep simple unit tests with existing mocks if they work well
4. Document patterns as we establish them

## Notes

- The NDK test utilities are in the distributed package (`node_modules/@nostr-dev-kit/ndk/dist/test/`)
- TypeScript types are available
- Some implementation details may differ from our custom mocks
- The utilities are designed for Vitest but work with Bun test as well