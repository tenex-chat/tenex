import type { AgentMetadataStore } from "@/services/agents";
import type { LLMService } from "@/llm/service";
import type { MCPConfig, MCPServerConfig } from "@/llm/providers/types";
import type { OnStreamStartCallback } from "@/llm/types";
import type { AgentCategory } from "@/agents/role-categories";
import type { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import type { Tool as CoreTool } from "ai";
import type { AgentProjectConfig } from "./storage";

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
    /**
     * Agent category for semantic classification and organizational purposes.
     * Resolved from the agent definition's category tag.
     * No restrictions are applied based on category — all agents have access to all tools.
     */
    category?: AgentCategory;
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
     */
    pmOverrides?: Record<string, boolean>;
    /**
     * Global PM designation flag.
     * When true, this agent is designated as PM for ALL projects where it exists.
     * Set via kind 24020 TenexAgentConfigUpdate event with ["pm"] tag (without a-tag).
     * Takes precedence over pmOverrides and project tag designations.
     */
    isPM?: boolean;
    /**
     * Per-project configuration overrides.
     * Key is project dTag, value contains project-specific settings including isPM.
     * Set via kind 24020 TenexAgentConfigUpdate events WITH an a-tag specifying the project.
     */
    projectOverrides?: Record<string, AgentProjectConfig>;
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
