import type { CompiledMessage } from "@/agents/execution/MessageCompiler";

/**
 * Represents a compressed segment of conversation history.
 * Replaces a range of messages (fromEventId -> toEventId) with a summary.
 */
export interface CompressionSegment {
  /** Starting event ID of the compressed range */
  fromEventId: string;
  /** Ending event ID of the compressed range */
  toEventId: string;
  /** The compressed/summarized content */
  compressed: string;
  /** When this segment was created */
  createdAt: number;
  /** Model used for compression */
  model: string;
}

/**
 * Persistent log of all compression segments for a conversation.
 * Stored in filesystem at compressions/{conversationId}.json
 */
export interface CompressionLog {
  conversationId: string;
  segments: CompressionSegment[];
  updatedAt: number;
}

/**
 * Input to compression operations.
 */
export interface CompressionInput {
  conversationId: string;
  messages: CompiledMessage[];
  tokenBudget: number;
  modelId: string;
}

/**
 * Result of a compression operation.
 */
export interface CompressionOutcome {
  /** Messages after applying compression (or fallback) */
  messages: CompiledMessage[];
  /** Newly created segments (if any) */
  addedSegments: CompressionSegment[];
  /** True if fallback (sliding window) was used instead of LLM compression */
  usedFallback: boolean;
}

/**
 * Range of messages to compress (by array indices).
 */
export interface CompressionRange {
  startIndex: number;
  endIndex: number;
}

/**
 * Result of validating LLM-generated segments.
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Plan for compression operation.
 */
export interface CompressionPlan {
  range: CompressionRange | null;
  tokenEstimate: number;
}
