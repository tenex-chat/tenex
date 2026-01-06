import type { AgentMetadataStore } from "@/services/agents";
import type { LLMService } from "@/llm/service";
import type { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import type { Tool as CoreTool } from "ai";

/**
 * Simplified agent representation for UI display and selection.
 */
export interface AgentSummary {
    name: string;
    role: string;
    pubkey: string;
}

/**
 * Complete agent configuration and identity used during execution.
 */
export interface AgentInstance {
    name: string;
    pubkey: string;
    signer: NDKPrivateKeySigner;
    role: string;
    description?: string;
    instructions?: string;
    customInstructions?: string; // Custom system prompt instructions
    useCriteria?: string;
    llmConfig: string;
    tools: string[];
    eventId?: string;
    slug: string;
    phase?: string;
    phases?: Record<string, string>;
    useAISDKAgent?: boolean; // Feature flag: use AI SDK Agent class instead of traditional AgentExecutor
    maxAgentSteps?: number; // Maximum steps for AI SDK Agent agentic loop (default: 10)
    createMetadataStore(conversationId: string): AgentMetadataStore;
    createLLMService(options?: {
        tools?: Record<string, CoreTool>;
        sessionId?: string;
        workingDirectory?: string;
    }): LLMService;
    sign(event: NDKEvent): Promise<void>;
}
