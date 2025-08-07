import type { ToolExecutionResult, ContinueFlow, Complete, EndConversation } from "@/tools/types";
import type { CompletionResponse } from "@/llm/types";
import type { StreamPublisher } from "@/nostr/NostrPublisher";

/**
 * Represents the mutable state during stream processing
 */
export interface StreamingState {
    allToolResults: ToolExecutionResult[];
    continueFlow: ContinueFlow | undefined;
    termination: Complete | EndConversation | undefined;
    finalResponse: CompletionResponse | undefined;
    fullContent: string;
    streamPublisher: StreamPublisher | undefined;
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
            continueFlow: undefined,
            termination: undefined,
            finalResponse: undefined,
            fullContent: "",
            streamPublisher: undefined,
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
     * Reset state for a retry attempt (keeps streamPublisher)
     */
    resetForRetry(): void {
        const streamPublisher = this.state.streamPublisher;
        this.state = this.createInitialState();
        this.state.streamPublisher = streamPublisher;
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
     * Set the continue flow (only if not already set)
     */
    setContinueFlow(flow: ContinueFlow): boolean {
        if (this.state.continueFlow) {
            return false; // Already set, ignore
        }
        this.state.continueFlow = flow;
        return true;
    }

    /**
     * Get the continue flow
     */
    getContinueFlow(): ContinueFlow | undefined {
        return this.state.continueFlow;
    }

    /**
     * Set the termination (complete or end_conversation)
     */
    setTermination(termination: Complete | EndConversation): void {
        this.state.termination = termination;
    }

    /**
     * Get the termination
     */
    getTermination(): Complete | EndConversation | undefined {
        return this.state.termination;
    }

    /**
     * Check if the stream has terminated (either continue flow or termination)
     */
    hasTerminated(): boolean {
        return !!(this.state.termination || this.state.continueFlow);
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
     * Set the stream publisher
     */
    setStreamPublisher(publisher: StreamPublisher): void {
        this.state.streamPublisher = publisher;
    }

    /**
     * Get the stream publisher
     */
    getStreamPublisher(): StreamPublisher | undefined {
        return this.state.streamPublisher;
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
            hasContinueFlow: !!this.state.continueFlow,
            hasTermination: !!this.state.termination,
            terminationType: this.state.termination?.type,
            hasFinalResponse: !!this.state.finalResponse,
            startedToolsCount: this.state.startedTools.size,
        };
    }

    // Generic state management methods for extensibility
    private customState: Map<string, any> = new Map();

    /**
     * Set a custom state value
     */
    setState(key: string, value: any): void {
        this.customState.set(key, value);
    }

    /**
     * Get a custom state value
     */
    getState(key: string): any {
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
    getAllState(): Record<string, any> {
        const result: Record<string, any> = {};
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