import { z } from "zod";

/**
 * Zod schema for LLM-generated compression segments.
 * Used with generateObject() to get structured output from LLM.
 *
 * The LLM receives a range of messages and returns one or more segments
 * that summarize different parts of that range.
 */
export const CompressionSegmentSchema = z.object({
  /** Starting event ID of the compressed range */
  fromEventId: z.string().min(1, "fromEventId cannot be empty"),
  /** Ending event ID of the compressed range */
  toEventId: z.string().min(1, "toEventId cannot be empty"),
  /** The compressed/summarized content */
  compressed: z.string().min(1, "Compressed content cannot be empty"),
});

/**
 * Schema for the array of segments returned by LLM.
 * Typically 1-3 segments depending on the content diversity.
 */
export const CompressionSegmentsSchema = z.array(CompressionSegmentSchema);

/**
 * Type inference from schema for type safety.
 */
export type CompressionSegmentInput = z.infer<typeof CompressionSegmentSchema>;
