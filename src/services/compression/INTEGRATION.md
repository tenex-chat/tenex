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

**Status**: ✅ IMPLEMENTED

Proactive compression is triggered after each LLM response via `triggerProactiveCompression()` method.

**Requirements**:
- AgentRegistry is obtained via `getProjectContext().agentRegistry`
- Non-blocking (fire-and-forget)
- Errors are logged but don't affect main flow

### 2. MessageCompiler Integration - Reactive Compression

**Location**: `src/agents/execution/MessageCompiler.ts`

**Status**: ✅ IMPLEMENTED

Reactive compression is applied in `applyCompression()` method, called during `compile()`.

**Requirements**:
- MessageCompiler constructor accepts optional `llmService` and `agentRegistry` parameters
- AgentRegistry is passed from StreamSetup via `projectContext.agentRegistry`
- Compression only runs when both LLMService and AgentRegistry are available
- Uses blocking `ensureUnderLimit()` to guarantee budget compliance

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
  constructor(
    conversationStore: ConversationStore,
    llmService: LLMService,
    agentRegistry: AgentRegistry  // Required for speaker attribution
  )

  // Proactive: Fire-and-forget compression after LLM response
  async maybeCompressAsync(conversationId: string): Promise<void>

  // Reactive: Blocking compression when budget exceeded
  async ensureUnderLimit(conversationId: string, tokenBudget?: number): Promise<void>

  // Get existing segments
  async getSegments(conversationId: string): Promise<CompressionSegment[]>

  // Apply compressions to entries (for MessageBuilder)
  applyExistingCompressions(
    entries: ConversationEntry[],
    segments: CompressionSegment[]
  ): ConversationEntry[]
}
```

**Key Updates**:
- ✅ AgentRegistry required for speaker attribution (resolving pubkeys to agent slugs)
- ✅ Compression prompt includes XML-formatted messages with:
  - Event IDs (full 64-char IDs in `id` attribute, short 12-char IDs in `shortId` for readability)
  - Speaker attribution (`from` field with agent slug, using `senderPubkey ?? pubkey`)
  - Timestamps (ISO 8601 format)
  - Target information (`to` field with agent slugs from p-tags)
  - Tool call/result summaries
  - XML escaping for all attributes and CDATA wrapping for content
- ✅ No fixed sentence count - LLM can use appropriate length for content complexity
- ✅ **CRITICAL**: Segments MUST be contiguous with full coverage from first to last event ID
  - At least one segment required
  - No gaps allowed between segments
  - First segment must start at range beginning
  - Last segment must end at range end

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
