import type { ToolExecutionResult, Complete } from "@/tools/types";
import type { CompletionResponse } from "@/llm/types";

/**
 * Represents the mutable state during stream processing
 */
export interface StreamingState {
    allToolResults: ToolExecutionResult[];
    termination: Complete | undefined;
    finalResponse: CompletionResponse | undefined;
    fullContent: string;
    startedTools: Set<string>;
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
            allToolResults: [],
            termination: undefined,
            finalResponse: undefined,
            fullContent: "",
            startedTools: new Set<string>(),
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
     * Append content to the accumulated full content
     */
    appendContent(content: string): void {
        this.state.fullContent += content;
    }

    /**
     * Get the current full content
     */
    getFullContent(): string {
        return this.state.fullContent;
    }

    /**
     * Add a tool execution result
     */
    addToolResult(result: ToolExecutionResult): void {
        this.state.allToolResults.push(result);
    }

    /**
     * Get all tool results
     */
    getToolResults(): ToolExecutionResult[] {
        return this.state.allToolResults;
    }

    /**
     * Get all tool results (alias for getToolResults)
     */
    getAllToolResults(): ToolExecutionResult[] {
        return this.state.allToolResults;
    }

    /**
     * Get the last tool result
     */
    getLastToolResult(): ToolExecutionResult | null {
        const results = this.state.allToolResults;
        return results.length > 0 ? results[results.length - 1] : null;
    }


    /**
     * Set the termination (complete)
     */
    setTermination(termination: Complete): void {
        this.state.termination = termination;
    }

    /**
     * Get the termination
     */
    getTermination(): Complete | undefined {
        return this.state.termination;
    }

    /**
     * Check if the stream has terminated
     */
    hasTerminated(): boolean {
        return !!this.state.termination;
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
     * Mark a tool as started
     */
    markToolStarted(toolCallId: string): void {
        this.state.startedTools.add(toolCallId);
    }

    /**
     * Check if a tool has been started
     */
    hasToolStarted(toolNamePattern: string): boolean {
        return Array.from(this.state.startedTools).some(id => id.startsWith(toolNamePattern));
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
            hasContent: this.state.fullContent.length > 0,
            contentLength: this.state.fullContent.length,
            toolResultCount: this.state.allToolResults.length,
            hasTermination: !!this.state.termination,
            terminationType: this.state.termination?.type,
            hasFinalResponse: !!this.state.finalResponse,
            startedToolsCount: this.state.startedTools.size,
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