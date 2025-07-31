import type { ExecutionContext } from "./types";
import type { Tool } from "@/tools/types";
import type { NostrPublisher } from "@/nostr/NostrPublisher";

/**
 * Interface for agent execution backends.
 * Different backends can implement different execution strategies
 * (e.g., reason-act loops, direct tool execution, etc.)
 */
export interface ExecutionBackend {
    /**
     * Execute the agent's task
     * @param messages - The messages to send to the LLM
     * @param tools - The tools available to the agent
     * @param context - The execution context
     * @param publisher - The NostrPublisher for publishing events
     */
    execute(
        messages: Array<import("multi-llm-ts").Message>,
        tools: Tool[],
        context: ExecutionContext,
        publisher: NostrPublisher
    ): Promise<void>;
}
