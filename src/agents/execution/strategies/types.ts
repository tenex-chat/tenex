import type { ModelMessage } from "ai";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { ExecutionContext } from "../types";

/**
 * Strategy interface for building messages for LLM execution
 */
export interface MessageGenerationStrategy {
  /**
   * Build the messages array for the agent execution
   * @param context - The execution context
   * @param triggeringEvent - The event that triggered this execution
   * @param eventFilter - Optional filter to exclude events (e.g., already sent to Claude Code)
   */
  buildMessages(
    context: ExecutionContext,
    triggeringEvent: NDKEvent,
    eventFilter?: (event: NDKEvent) => boolean
  ): Promise<ModelMessage[]>;
}