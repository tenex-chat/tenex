import type { CompletionResponse } from "@/llm/types";

/**
 * Represents the mutable state during stream processing
 */
export interface StreamingState {
  finalResponse: CompletionResponse | undefined;
  loggedThinkingBlocks: Set<string>;
}

/**
 * Manages the mutable state during LLM stream processing.
 * Provides controlled access and modifications to the streaming state.
 */
export class StreamStateManager {
  private state: StreamingState;

  constructor() {
    this.state = this.createInitialState();
  }

  /**
   * Create a fresh initial state
   */
  private createInitialState(): StreamingState {
    return {
      finalResponse: undefined,
      loggedThinkingBlocks: new Set<string>(),
    };
  }

  /**
   * Reset the state to initial values
   */
  reset(): void {
    this.state = this.createInitialState();
  }




  /**
   * Set the final response from the LLM
   */
  setFinalResponse(response: CompletionResponse): void {
    this.state.finalResponse = response;
  }

  /**
   * Get the final response
   */
  getFinalResponse(): CompletionResponse | undefined {
    return this.state.finalResponse;
  }


  /**
   * Mark a thinking block as logged (using its content hash)
   */
  markThinkingBlockLogged(blockContent: string): void {
    this.state.loggedThinkingBlocks.add(blockContent);
  }

  /**
   * Check if a thinking block has already been logged
   */
  hasThinkingBlockBeenLogged(blockContent: string): boolean {
    return this.state.loggedThinkingBlocks.has(blockContent);
  }

  /**
   * Get the raw state (use sparingly, prefer specific methods)
   */
  getRawState(): Readonly<StreamingState> {
    return this.state;
  }

  /**
   * Get a summary of the current state for logging
   */
  getStateSummary(): Record<string, unknown> {
    return {
      hasFinalResponse: !!this.state.finalResponse,
    };
  }

}
