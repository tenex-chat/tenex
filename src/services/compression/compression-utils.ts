import type { CompiledMessage } from "@/agents/execution/MessageCompiler";
import type { ConversationEntry } from "@/conversations/types";
import type {
  CompressionSegment,
  CompressionRange,
  ValidationResult,
} from "./compression-types.js";

/**
 * Estimate token count for messages using rough heuristic (chars/4).
 * This is faster than actual tokenization and sufficient for compression decisions.
 *
 * @param messages - Messages to estimate
 * @returns Estimated token count
 */
export function estimateTokens(
  messages: CompiledMessage[]
): number {
  const totalChars = messages.reduce((sum, msg) => {
    const contentLength = typeof msg.content === "string"
      ? msg.content.length
      : JSON.stringify(msg.content).length;
    return sum + contentLength;
  }, 0);

  // Rough estimate: 1 token ≈ 4 characters
  return Math.ceil(totalChars / 4);
}

/**
 * Select a range of messages to compress.
 * Strategy: Skip recent messages (keep context fresh), compress older middle section.
 *
 * @param messages - All messages in conversation
 * @param lastSegment - Most recent compression segment (to avoid re-compressing)
 * @returns Range to compress, or null if no suitable range found
 */
export function selectCandidateRange(
  messages: CompiledMessage[],
  lastSegment: CompressionSegment | null
): CompressionRange | null {
  if (messages.length < 10) {
    // Too few messages to compress meaningfully
    return null;
  }

  // Keep last 20% of messages uncompressed (fresh context)
  const keepRecentCount = Math.max(5, Math.floor(messages.length * 0.2));
  const endIndex = messages.length - keepRecentCount;

  // Find start index (after last compressed segment, or from beginning)
  let startIndex = 0;
  if (lastSegment) {
    const lastCompressedIndex = messages.findIndex(
      (m) => m.eventId === lastSegment.toEventId
    );
    if (lastCompressedIndex >= 0) {
      startIndex = lastCompressedIndex + 1;
    }
  }

  // Need at least 5 messages to make compression worthwhile
  if (endIndex - startIndex < 5) {
    return null;
  }

  return { startIndex, endIndex };
}

/**
 * Validate that LLM-generated segments are valid for the given message range.
 *
 * Checks:
 * 1. All event IDs exist in the message range
 * 2. Segments are in chronological order
 * 3. No gaps or overlaps between segments
 * 4. First segment starts at range beginning
 * 5. Last segment ends at range end
 *
 * @param segments - LLM-generated segments
 * @param messages - All messages
 * @param range - The range that was compressed
 * @returns Validation result
 */
export function validateSegments(
  segments: CompressionSegment[],
  messages: CompiledMessage[],
  range: CompressionRange
): ValidationResult {
  if (segments.length === 0) {
    return { valid: false, error: "No segments provided" };
  }

  const rangeMessages = messages.slice(range.startIndex, range.endIndex);
  const messagesWithEventIds = rangeMessages.filter((m) => m.eventId);

  if (messagesWithEventIds.length === 0) {
    return { valid: false, error: "No messages with eventIds in range" };
  }

  const eventIds = new Set(messagesWithEventIds.map((m) => m.eventId!));

  // Check all event IDs exist
  for (const segment of segments) {
    if (!eventIds.has(segment.fromEventId)) {
      return {
        valid: false,
        error: `fromEventId ${segment.fromEventId} not found in range`,
      };
    }
    if (!eventIds.has(segment.toEventId)) {
      return {
        valid: false,
        error: `toEventId ${segment.toEventId} not found in range`,
      };
    }
  }

  // Check that first segment starts at range start
  const firstMessageWithEventId = messagesWithEventIds[0];
  const firstSegment = segments[0];
  if (firstSegment.fromEventId !== firstMessageWithEventId.eventId) {
    return {
      valid: false,
      error: `First segment must start at range beginning (expected ${firstMessageWithEventId.eventId}, got ${firstSegment.fromEventId})`,
    };
  }

  // Check that last segment ends at range end
  const lastMessageWithEventId = messagesWithEventIds[messagesWithEventIds.length - 1];
  const lastSegment = segments[segments.length - 1];
  if (lastSegment.toEventId !== lastMessageWithEventId.eventId) {
    return {
      valid: false,
      error: `Last segment must end at range end (expected ${lastMessageWithEventId.eventId}, got ${lastSegment.toEventId})`,
    };
  }

  // Check chronological order and no gaps
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const fromIndex = rangeMessages.findIndex(
      (m) => m.eventId === segment.fromEventId
    );
    const toIndex = rangeMessages.findIndex(
      (m) => m.eventId === segment.toEventId
    );

    if (fromIndex > toIndex) {
      return {
        valid: false,
        error: `Segment ${i}: fromEventId comes after toEventId`,
      };
    }

    // Check for gaps between segments
    if (i > 0) {
      const prevSegment = segments[i - 1];
      const prevToIndex = rangeMessages.findIndex(
        (m) => m.eventId === prevSegment.toEventId
      );
      if (fromIndex !== prevToIndex + 1) {
        return {
          valid: false,
          error: `Gap between segment ${i - 1} and ${i}`,
        };
      }
    }
  }

  return { valid: true };
}

/**
 * Validate that LLM-generated segments are valid for the given entry range.
 * This is the ConversationEntry version of validateSegments.
 *
 * Checks:
 * 1. All event IDs exist in the entry range
 * 2. Segments are in chronological order
 * 3. No gaps or overlaps between segments
 * 4. First segment starts at range beginning
 * 5. Last segment ends at range end
 *
 * @param segments - LLM-generated segments
 * @param entries - All entries
 * @param range - The range that was compressed
 * @returns Validation result
 */
export function validateSegmentsForEntries(
  segments: CompressionSegment[],
  entries: ConversationEntry[],
  range: CompressionRange
): ValidationResult {
  if (segments.length === 0) {
    return { valid: false, error: "No segments provided" };
  }

  const rangeEntries = entries.slice(range.startIndex, range.endIndex);
  const entriesWithEventIds = rangeEntries.filter((e) => e.eventId);

  if (entriesWithEventIds.length === 0) {
    return { valid: false, error: "No entries with eventIds in range" };
  }

  const eventIds = new Set(entriesWithEventIds.map((e) => e.eventId!));

  // Check all event IDs exist
  for (const segment of segments) {
    if (!eventIds.has(segment.fromEventId)) {
      return {
        valid: false,
        error: `fromEventId ${segment.fromEventId} not found in range`,
      };
    }
    if (!eventIds.has(segment.toEventId)) {
      return {
        valid: false,
        error: `toEventId ${segment.toEventId} not found in range`,
      };
    }
  }

  // Check that first segment starts at range start
  const firstEntryWithEventId = entriesWithEventIds[0];
  const firstSegment = segments[0];
  if (firstSegment.fromEventId !== firstEntryWithEventId.eventId) {
    return {
      valid: false,
      error: `First segment must start at range beginning (expected ${firstEntryWithEventId.eventId}, got ${firstSegment.fromEventId})`,
    };
  }

  // Check that last segment ends at range end
  const lastEntryWithEventId = entriesWithEventIds[entriesWithEventIds.length - 1];
  const lastSegment = segments[segments.length - 1];
  if (lastSegment.toEventId !== lastEntryWithEventId.eventId) {
    return {
      valid: false,
      error: `Last segment must end at range end (expected ${lastEntryWithEventId.eventId}, got ${lastSegment.toEventId})`,
    };
  }

  // Check chronological order and no gaps
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const fromIndex = rangeEntries.findIndex(
      (e) => e.eventId === segment.fromEventId
    );
    const toIndex = rangeEntries.findIndex(
      (e) => e.eventId === segment.toEventId
    );

    if (fromIndex > toIndex) {
      return {
        valid: false,
        error: `Segment ${i}: fromEventId comes after toEventId`,
      };
    }

    // Check for gaps between segments
    if (i > 0) {
      const prevSegment = segments[i - 1];
      const prevToIndex = rangeEntries.findIndex(
        (e) => e.eventId === prevSegment.toEventId
      );
      if (fromIndex !== prevToIndex + 1) {
        return {
          valid: false,
          error: `Gap between segment ${i - 1} and ${i}`,
        };
      }
    }
  }

  return { valid: true };
}

/**
 * Apply compression segments to messages, replacing ranges with summaries.
 *
 * Creates new "system" role messages with compressed content.
 * Preserves all other messages unchanged.
 *
 * @param messages - Original messages
 * @param segments - Compression segments to apply
 * @returns New message array with compressions applied
 */
export function applySegments(
  messages: CompiledMessage[],
  segments: CompressionSegment[]
): CompiledMessage[] {
  if (segments.length === 0) {
    return messages;
  }

  const result: CompiledMessage[] = [];
  let currentIndex = 0;

  for (const segment of segments) {
    const fromIndex = messages.findIndex(
      (m) => m.eventId === segment.fromEventId
    );
    const toIndex = messages.findIndex((m) => m.eventId === segment.toEventId);

    if (fromIndex < 0 || toIndex < 0) {
      // Segment doesn't match current messages, skip it
      continue;
    }

    // Add messages before this segment
    while (currentIndex < fromIndex) {
      result.push(messages[currentIndex]);
      currentIndex++;
    }

    // Add compressed summary as user message
    // NOTE: Cannot use "system" role here because Anthropic requires all system
    // messages at the top of the prompt, not interleaved with user/assistant turns.
    result.push({
      role: "user",
      content: `[Compressed history]\n${segment.compressed}`,
      eventId: `compressed-${segment.fromEventId}-${segment.toEventId}`,
    });

    // Skip the compressed range
    currentIndex = toIndex + 1;
  }

  // Add remaining messages after last segment
  while (currentIndex < messages.length) {
    result.push(messages[currentIndex]);
    currentIndex++;
  }

  return result;
}

/**
 * Emergency fallback: truncate to sliding window of recent messages.
 * Used when LLM compression fails or is unavailable.
 *
 * NOTE: This utility is currently unused in production but maintained as part of
 * the public API for future use cases (e.g., client-side compression, direct
 * truncation without segment creation). See createFallbackSegmentForEntries for
 * the production fallback implementation.
 *
 * @param messages - All messages
 * @param windowSize - Number of recent messages to keep
 * @param currentTimestamp - Current timestamp (for deterministic testing)
 * @returns Truncated message array
 */
export function truncateSlidingWindow(
  messages: CompiledMessage[],
  windowSize: number,
  currentTimestamp: number
): CompiledMessage[] {
  if (messages.length <= windowSize) {
    return messages;
  }

  const kept = messages.slice(-windowSize);

  // Add a user message at the start indicating truncation
  // NOTE: Cannot use "system" role because Anthropic requires all system
  // messages at the top of the prompt, not interleaved with user/assistant turns.
  return [
    {
      role: "user",
      content: `[Earlier messages truncated. Showing last ${windowSize} messages.]`,
      eventId: `truncated-${currentTimestamp}`,
    },
    ...kept,
  ];
}

/**
 * Apply compression segments to conversation entries, replacing ranges with summaries.
 * This is the ConversationEntry version of applySegments.
 *
 * Creates new "system" entries with compressed content.
 * Preserves all other entries unchanged.
 *
 * @param entries - Original entries
 * @param segments - Compression segments to apply
 * @returns New entry array with compressions applied
 */
export function applySegmentsToEntries(
  entries: ConversationEntry[],
  segments: CompressionSegment[]
): ConversationEntry[] {
  if (segments.length === 0) {
    return entries;
  }

  const result: ConversationEntry[] = [];
  let currentIndex = 0;

  for (const segment of segments) {
    const fromIndex = entries.findIndex((e) => e.eventId === segment.fromEventId);
    const toIndex = entries.findIndex((e) => e.eventId === segment.toEventId);

    if (fromIndex < 0 || toIndex < 0) {
      // Segment doesn't match current entries, skip it
      continue;
    }

    // Add entries before this segment
    while (currentIndex < fromIndex) {
      result.push(entries[currentIndex]);
      currentIndex++;
    }

    // Add compressed summary as user entry with explicit role
    // NOTE: Cannot use "system" role here because Anthropic requires all system
    // messages at the top of the prompt, not interleaved with user/assistant turns.
    result.push({
      pubkey: "system",
      content: `[Compressed history]\n${segment.compressed}`,
      messageType: "text",
      eventId: `compressed-${segment.fromEventId}-${segment.toEventId}`,
      timestamp: segment.createdAt / 1000,
      role: "user",
    });

    // Skip the compressed range
    currentIndex = toIndex + 1;
  }

  // Add remaining entries after last segment
  while (currentIndex < entries.length) {
    result.push(entries[currentIndex]);
    currentIndex++;
  }

  return result;
}

/**
 * Estimate the character count for a single conversation entry.
 * Accounts for both text content and tool payloads (toolData).
 */
function estimateEntryChars(entry: ConversationEntry): number {
  let chars = entry.content.length;
  if (entry.toolData && entry.toolData.length > 0) {
    chars += JSON.stringify(entry.toolData).length;
  }
  return chars;
}

/**
 * Estimate token count for conversation entries using rough heuristic (chars/4).
 * This is faster than actual tokenization and sufficient for compression decisions.
 *
 * Accounts for both text content and tool payloads (toolData) to prevent
 * tool-heavy conversations from bypassing compression thresholds.
 *
 * @param entries - Entries to estimate
 * @returns Estimated token count
 */
export function estimateTokensFromEntries(entries: ConversationEntry[]): number {
  const totalChars = entries.reduce((sum, entry) => sum + estimateEntryChars(entry), 0);
  return Math.ceil(totalChars / 4);
}

/**
 * Compute how many trailing entries fit within a token budget.
 * Walks entries backwards, accumulating estimated tokens, and stops when the budget is exhausted.
 *
 * @param entries - All conversation entries
 * @param tokenBudget - Maximum tokens the trailing window should contain
 * @returns Number of trailing entries that fit within the budget (minimum 1)
 */
export function computeTokenAwareWindowSize(
  entries: ConversationEntry[],
  tokenBudget: number
): number {
  let accumulatedTokens = 0;
  let count = 0;

  for (let i = entries.length - 1; i >= 0; i--) {
    const entryTokens = Math.ceil(estimateEntryChars(entries[i]) / 4);
    if (accumulatedTokens + entryTokens > tokenBudget && count > 0) {
      break;
    }
    accumulatedTokens += entryTokens;
    count++;
  }

  return Math.max(1, count);
}

/**
 * Select a range of entries to compress.
 * Strategy: Skip recent entries (keep context fresh), compress older middle section.
 *
 * @param entries - All entries in conversation
 * @param lastSegment - Most recent compression segment (to avoid re-compressing)
 * @returns Range to compress, or null if no suitable range found
 */
export function selectCandidateRangeFromEntries(
  entries: ConversationEntry[],
  lastSegment: CompressionSegment | null
): CompressionRange | null {
  if (entries.length < 10) {
    // Too few entries to compress meaningfully
    return null;
  }

  // Keep last 20% of entries uncompressed (fresh context)
  const keepRecentCount = Math.max(5, Math.floor(entries.length * 0.2));
  const endIndex = entries.length - keepRecentCount;

  // Find start index (after last compressed segment, or from beginning)
  let startIndex = 0;
  if (lastSegment) {
    const lastCompressedIndex = entries.findIndex(
      (e) => e.eventId === lastSegment.toEventId
    );
    if (lastCompressedIndex >= 0) {
      startIndex = lastCompressedIndex + 1;
    }
  }

  // Need at least 5 entries to make compression worthwhile
  if (endIndex - startIndex < 5) {
    return null;
  }

  return { startIndex, endIndex };
}

/**
 * Emergency fallback: truncate entries to sliding window.
 * This is the ConversationEntry version of truncateSlidingWindow.
 *
 * NOTE: This utility is currently unused in production but maintained as part of
 * the public API for future use cases (e.g., direct truncation without segment
 * creation). See createFallbackSegmentForEntries for the production fallback.
 *
 * @param entries - All entries
 * @param windowSize - Number of recent entries to keep
 * @param currentTimestamp - Current timestamp (for deterministic testing)
 * @returns Truncated entry array
 */
export function truncateSlidingWindowEntries(
  entries: ConversationEntry[],
  windowSize: number,
  currentTimestamp: number
): ConversationEntry[] {
  if (entries.length <= windowSize) {
    return entries;
  }

  const kept = entries.slice(-windowSize);

  // Add a synthetic entry indicating truncation
  // NOTE: Explicit role: "user" because Anthropic requires all system
  // messages at the top of the prompt, not interleaved with user/assistant turns.
  const truncationEntry: ConversationEntry = {
    pubkey: "system",
    content: `[Earlier messages truncated. Showing last ${windowSize} messages.]`,
    messageType: "text",
    timestamp: currentTimestamp / 1000,
    role: "user",
  };

  return [truncationEntry, ...kept];
}

/**
 * Create a fallback compression segment for entries using index-based approach.
 * Works even when entries lack eventIds by finding the nearest entries with eventIds.
 *
 * @param entries - All entries in conversation
 * @param windowSize - Number of recent entries to keep uncompressed
 * @returns Fallback segment or null if cannot create one
 */
export function createFallbackSegmentForEntries(
  entries: ConversationEntry[],
  windowSize: number
): CompressionSegment | null {
  if (entries.length <= windowSize) {
    // Nothing to compress
    return null;
  }

  // Find entries with eventIds
  const entriesWithEventIds = entries
    .map((e, index) => ({ entry: e, index }))
    .filter((item) => item.entry.eventId);

  if (entriesWithEventIds.length < 2) {
    // Need at least 2 event IDs to create a valid segment
    return null;
  }

  // Calculate how many entries to compress (before sliding window)
  const truncateCount = entries.length - windowSize;

  // Find the first entry with an eventId
  const fromEventId = entriesWithEventIds[0].entry.eventId!;

  // Find the last entry with eventId in the range to compress
  // Use the entry at or before truncateCount-1
  let toEntry = entriesWithEventIds[0];
  for (const item of entriesWithEventIds) {
    if (item.index < truncateCount) {
      toEntry = item;
    } else {
      break;
    }
  }

  const toEventId = toEntry.entry.eventId!;

  return {
    fromEventId,
    toEventId,
    compressed: `[Truncated ${truncateCount} earlier messages due to compression failure]`,
    createdAt: Date.now(),
    model: "fallback-truncation",
  };
}
