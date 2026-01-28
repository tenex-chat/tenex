import type { AgentMetadataStore } from "@/services/agents";
import type { LLMService } from "@/llm/service";
import type { MCPConfig, MCPServerConfig } from "@/llm/providers/types";
import type { OnStreamStartCallback } from "@/llm/types";
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
    useAISDKAgent?: boolean; // Feature flag: use AI SDK Agent class instead of traditional AgentExecutor
    maxAgentSteps?: number; // Maximum steps for AI SDK Agent agentic loop (default: 10)
    /** Agent-specific MCP server configurations */
    mcpServers?: Record<string, MCPServerConfig>;
    /**
     * Project-scoped PM override flags.
     * Key is project dTag, value is true if this agent is PM for that project.
     * Set via agent_configure tool.
     */
    pmOverrides?: Record<string, boolean>;
    createMetadataStore(conversationId: string): AgentMetadataStore;
    createLLMService(options?: {
        tools?: Record<string, CoreTool>;
        sessionId?: string;
        workingDirectory?: string;
        /** MCP configuration to pass to the provider */
        mcpConfig?: MCPConfig;
        /** Conversation ID for OpenRouter correlation */
        conversationId?: string;
        /**
         * Override the config name to use (for meta model resolution).
         * If provided, uses this config instead of the agent's llmConfig.
         */
        resolvedConfigName?: string;
        /** Callback invoked when Claude Code stream starts, providing the message injector */
        onStreamStart?: OnStreamStartCallback;
    }): LLMService;
    sign(event: NDKEvent): Promise<void>;
}
