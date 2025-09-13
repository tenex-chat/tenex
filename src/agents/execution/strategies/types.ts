import type { ModelMessage } from "ai";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { ExecutionContext } from "../types";

/**
 * Strategy interface for building messages for LLM execution
 */
export interface MessageGenerationStrategy {
  /**
   * Build the messages array for the agent execution
   */
  buildMessages(
    context: ExecutionContext,
    triggeringEvent: NDKEvent
  ): Promise<ModelMessage[]>;
}