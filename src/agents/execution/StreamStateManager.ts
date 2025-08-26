import type { CompletionResponse } from "@/llm/types";
import type { Complete, ToolExecutionResult } from "@/tools/types";

/**
 * Represents the mutable state during stream processing
 */
export interface StreamingState {
  explicitCompletion: Complete | undefined;
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
      explicitCompletion: undefined,
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
   * Set that the complete() tool was called
   */
  setExplicitCompletion(completion: Complete): void {
    this.state.explicitCompletion = completion;
  }

  /**
   * Get the explicit completion if one was set
   */
  getExplicitCompletion(): Complete | undefined {
    return this.state.explicitCompletion;
  }

  /**
   * Check if the complete() tool was called
   */
  hasExplicitCompletion(): boolean {
    return !!this.state.explicitCompletion;
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
      hasExplicitCompletion: !!this.state.explicitCompletion,
      completionType: this.state.explicitCompletion?.type,
      hasFinalResponse: !!this.state.finalResponse,
    };
  }

  // Generic state management methods for extensibility
  private customState: Map<string, unknown> = new Map();

  /**
   * Set a custom state value
   */
  setState(key: string, value: unknown): void {
    this.customState.set(key, value);
  }

  /**
   * Get a custom state value
   */
  getState(key: string): unknown {
    return this.customState.get(key);
  }

  /**
   * Check if a custom state exists
   */
  hasState(key: string): boolean {
    return this.customState.has(key);
  }

  /**
   * Delete a custom state value
   */
  deleteState(key: string): void {
    this.customState.delete(key);
  }

  /**
   * Get all custom state as an object
   */
  getAllState(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    this.customState.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }

  /**
   * Clear all custom state
   */
  clear(): void {
    this.customState.clear();
  }
}
