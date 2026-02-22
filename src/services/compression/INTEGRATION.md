# Compression System Integration Guide

## Overview

The compression system is implemented with a clean 4-file architecture:

1. **compression-types.ts** - Type definitions and interfaces
2. **compression-schema.ts** - Zod schemas for LLM generateObject()
3. **compression-utils.ts** - Pure utility functions for compression logic
4. **CompressionService.ts** - Orchestrator service that delegates to utils

## Current Status

✅ **Phase 1: Foundation - COMPLETE**
- 4 core files created
- ConversationStore extended with compression methods
- Config schema with compression settings
- CompressionService working at ConversationEntry level

## Integration Points (Phase 2)

### 1. LLM Middleware Hook - Proactive Compression

**Location**: `src/agents/execution/StreamExecutionHandler.ts`

**After line 342** (after `llmService.on("complete", ...)` handler), add:

```typescript
// Trigger proactive compression after LLM response
llmService.on("complete", async () => {
    try {
        const compressionService = createCompressionService(
            context.conversation,
            llmService
        );
        await compressionService.maybeCompressAsync(context.conversation.id);
    } catch (error) {
        // Non-blocking - just log
        logger.warn("Proactive compression failed", { error });
    }
});
```

**Import needed**:
```typescript
import { createCompressionService } from "@/services/compression/CompressionService.js";
```

### 2. MessageCompiler Integration - Reactive Compression

**Location**: `src/agents/execution/MessageCompiler.ts`

**In the `compile()` method**, before building messages from conversation history, apply compression:

```typescript
// Around line 107, before building conversation messages
const compressionService = createCompressionService(
    this.conversationStore,
    // Note: Need to pass LLMService instance here
    // This requires modifying MessageCompiler constructor to accept LLMService
);

// Get existing compressions and apply them
const segments = await compressionService.getSegments(
    context.conversation.id
);

// Get entries with compressions applied
let entries = this.conversationStore.getAllMessages();
if (segments.length > 0) {
    entries = compressionService.applyExistingCompressions(entries, segments);
}

// Then build messages from compressed entries
const conversationMessages = await buildMessagesFromEntries(entries, {
    viewingAgentPubkey: context.agent.pubkey,
    ralNumber: context.ralNumber,
    activeRals,
    totalMessages: entries.length,
    projectRoot: context.projectBasePath,
});
```

**Note**: This requires refactoring `buildMessagesForRal()` in ConversationStore to accept pre-compressed entries, OR creating a new method `buildMessagesForRalWithCompression()`.

### 3. Configuration

Users can configure compression in `~/.tenex/config.json`:

```json
{
  "compression": {
    "enabled": true,
    "tokenThreshold": 50000,
    "tokenBudget": 40000,
    "slidingWindowSize": 50
  }
}
```

For testing with low thresholds:
```json
{
  "compression": {
    "enabled": true,
    "tokenThreshold": 100,
    "tokenBudget": 80,
    "slidingWindowSize": 10
  }
}
```

## Storage

Compression segments are stored at:
```
~/.tenex/projects/{projectId}/conversations/compressions/{conversationId}.json
```

Format:
```json
{
  "conversationId": "abc123",
  "segments": [
    {
      "fromEventId": "event1",
      "toEventId": "event5",
      "compressed": "Summary of messages...",
      "createdAt": 1234567890,
      "model": "claude-3-5-sonnet-20241022"
    }
  ],
  "updatedAt": 1234567890
}
```

## API Reference

### CompressionService

```typescript
class CompressionService {
  // Proactive: Fire-and-forget compression after LLM response
  async maybeCompressAsync(conversationId: string): Promise<void>

  // Reactive: Blocking compression when budget exceeded
  async ensureUnderLimit(conversationId: string, tokenBudget: number): Promise<void>

  // Get existing segments
  async getSegments(conversationId: string): Promise<CompressionSegment[]>

  // Apply compressions to entries (for MessageBuilder)
  applyExistingCompressions(
    entries: ConversationEntry[],
    segments: CompressionSegment[]
  ): ConversationEntry[]
}
```

### ConversationStore Extensions

```typescript
// Load compression log for conversation
loadCompressionLog(conversationId: string): CompressionSegment[]

// Append new segments
async appendCompressionSegments(
  conversationId: string,
  segments: CompressionSegment[]
): Promise<void>
```

## Testing

### Unit Tests

Test pure functions in `compression-utils.ts`:
- `estimateTokens()` - Token estimation for CompiledMessage arrays
- `estimateTokensFromEntries()` - Token estimation for ConversationEntry arrays
- `selectCandidateRange()` - Range selection for CompiledMessage arrays
- `selectCandidateRangeFromEntries()` - Range selection for ConversationEntry arrays
- `validateSegments()` - Validation for CompiledMessage arrays
- `validateSegmentsForEntries()` - Validation for ConversationEntry arrays
- `applySegments()` - Apply compressions to CompiledMessage arrays
- `applySegmentsToEntries()` - Apply compressions to ConversationEntry arrays
- `truncateSlidingWindow()` - Sliding window for CompiledMessage arrays
- `truncateSlidingWindowEntries()` - Sliding window for ConversationEntry arrays

All unit tests are in `__tests__/compression-utils.test.ts` with comprehensive coverage of:
- Valid and invalid inputs
- Edge cases (empty arrays, small arrays)
- Ordering and contiguity validation
- Deterministic behavior (timestamp injection)

### Integration Tests

1. **Basic Compression Flow**:
   - Create conversation with 100+ messages
   - Set low tokenThreshold (e.g., 100)
   - Trigger proactive compression
   - Verify segments created in filesystem
   - Verify messages are compressed when retrieved

2. **Fallback Behavior**:
   - Mock LLM failure
   - Verify fallback logging (no data loss in Phase 1)

3. **Reactive Compression**:
   - Create conversation exceeding tokenBudget
   - Call `ensureUnderLimit()`
   - Verify compression applied

## Future Enhancements

- Add compression health checks and monitoring
- Add cache eviction for old compression logs
- Add detailed compression metrics and telemetry
- Implement parallel compression for very long conversations
- Support incremental compression (compress in smaller chunks)

## Architecture Compliance

✅ **4-file architecture** - Clean separation of concerns
✅ **Pure utility functions** - All logic in compression-utils.ts is deterministic and testable
✅ **Service delegation** - CompressionService delegates to utils, handles I/O and LLM calls
✅ **Config-driven** - All thresholds configurable via ConfigService
✅ **Well tested** - Comprehensive unit tests (40+ test cases covering utils and service)
✅ **Telemetry** - All operations have OpenTelemetry spans
✅ **Graceful failure** - Fallback uses pure utility function for index-based truncation
✅ **Multi-project safe** - Uses instance-level paths, not global registry
✅ **Strong validation** - Checks ordering, contiguity, range coverage, and event ID existence
