import { NDKKind } from "@/nostr/kinds";
import type NDK from "@nostr-dev-kit/ndk";
import { NDKEvent, type NDKRawEvent } from "@nostr-dev-kit/ndk";

/**
 * NDKProjectStatus represents a TenexProjectStatus event
 * Used to indicate project status including online agents and model configurations
 */
export class NDKProjectStatus extends NDKEvent {
    static kind = NDKKind.TenexProjectStatus;
    static kinds = [NDKKind.TenexProjectStatus];

    constructor(ndk?: NDK, event?: NDKEvent | NDKRawEvent) {
        super(ndk, event);
        this.kind ??= NDKKind.TenexProjectStatus;
    }

    static from(event: NDKEvent): NDKProjectStatus {
        return new NDKProjectStatus(event.ndk, event);
    }

    /**
     * Get the project this status refers to
     * Returns the value of the "a" tag (replaceable event reference)
     */
    get projectReference(): string | undefined {
        return this.tagValue("a");
    }

    /**
     * Set the project this status refers to
     * @param projectTagId The tag ID of the NDKProject event (format: kind:pubkey:dTag)
     */
    set projectReference(projectTagId: string | undefined) {
        this.removeTag("a");
        if (projectTagId) {
            this.tags.push(["a", projectTagId]);
        }
    }

    /**
     * Get all agent entries from this status event
     * Returns an array of {pubkey, slug} objects
     */
    get agents(): Array<{ pubkey: string; slug: string }> {
        const agentTags = this.tags.filter((tag) => tag[0] === "agent" && tag[1] && tag[2]);
        return agentTags.map((tag) => ({
            pubkey: tag[1],
            slug: tag[2],
        }));
    }

    /**
     * Add an agent to the status
     * @param pubkey The agent's public key
     * @param slug The agent's slug/identifier
     */
    addAgent(pubkey: string, slug: string): void {
        this.tags.push(["agent", pubkey, slug]);
    }

    /**
     * Remove an agent from the status
     * @param pubkey The agent's public key to remove
     */
    removeAgent(pubkey: string): void {
        this.tags = this.tags.filter((tag) => !(tag[0] === "agent" && tag[1] === pubkey));
    }

    /**
     * Clear all agents from the status
     */
    clearAgents(): void {
        this.tags = this.tags.filter((tag) => tag[0] !== "agent");
    }

    /**
     * Check if a specific agent is in the status
     * @param pubkey The agent's public key
     */
    hasAgent(pubkey: string): boolean {
        return this.tags.some((tag) => tag[0] === "agent" && tag[1] === pubkey);
    }

    /**
     * Get all model configurations from this status event
     * Returns an array of {modelSlug, agents} objects where agents is an array of agent slugs
     */
    get models(): Array<{ modelSlug: string; agents: string[] }> {
        const modelTags = this.tags.filter((tag) => tag[0] === "model" && tag[1]);
        return modelTags.map((tag) => ({
            modelSlug: tag[1],
            agents: tag.slice(2).filter((a) => a), // Get all agent slugs from index 2 onwards
        }));
    }

    /**
     * Add a model with its agent access list
     * @param modelSlug The model slug identifier (e.g., "gpt-4", "claude-3")
     * @param agentSlugs Array of agent slugs that use this model
     */
    addModel(modelSlug: string, agentSlugs: string[]): void {
        // Remove existing model tag if it exists
        this.removeModel(modelSlug);
        // Add new model tag with all agent slugs
        this.tags.push(["model", modelSlug, ...agentSlugs]);
    }

    /**
     * Remove a model from the status
     * @param modelSlug The model slug to remove
     */
    removeModel(modelSlug: string): void {
        this.tags = this.tags.filter((tag) => !(tag[0] === "model" && tag[1] === modelSlug));
    }

    /**
     * Clear all model configurations from the status
     */
    clearModels(): void {
        this.tags = this.tags.filter((tag) => tag[0] !== "model");
    }

    /**
     * Check if a specific model exists
     * @param modelSlug The model slug
     */
    hasModel(modelSlug: string): boolean {
        return this.tags.some((tag) => tag[0] === "model" && tag[1] === modelSlug);
    }

    /**
     * Get agents that use a specific model
     * @param modelSlug The model slug
     * @returns Array of agent slugs that use this model
     */
    getModelAgents(modelSlug: string): string[] {
        const modelTag = this.tags.find((tag) => tag[0] === "model" && tag[1] === modelSlug);
        return modelTag ? modelTag.slice(2).filter((a) => a) : [];
    }

    /**
     * Check if a specific agent uses a model
     * @param modelSlug The model slug
     * @param agentSlug The agent slug
     */
    agentUsesModel(modelSlug: string, agentSlug: string): boolean {
        const agents = this.getModelAgents(modelSlug);
        return agents.includes(agentSlug);
    }

    /**
     * Get all models used by a specific agent
     * @param agentSlug The agent slug
     * @returns Array of model slugs used by this agent
     */
    getAgentModels(agentSlug: string): string[] {
        return this.models
            .filter((model) => model.agents.includes(agentSlug))
            .map((model) => model.modelSlug);
    }

    /**
     * Get the status message/content
     */
    get status(): string {
        return this.content;
    }

    /**
     * Set the status message/content
     */
    set status(value: string) {
        this.content = value;
    }

    /**
     * Get all tools with their agent access information
     * Returns an array of {toolName, agents} objects where agents is an array of agent slugs
     */
    get tools(): Array<{ toolName: string; agents: string[] }> {
        const toolTags = this.tags.filter((tag) => tag[0] === "tool" && tag[1]);
        return toolTags.map((tag) => ({
            toolName: tag[1],
            agents: tag.slice(2).filter((a) => a), // Get all agent slugs from index 2 onwards
        }));
    }

    /**
     * Add a tool with its agent access list
     * @param toolName The name of the tool
     * @param agentSlugs Array of agent slugs that have access to this tool
     */
    addTool(toolName: string, agentSlugs: string[]): void {
        // Remove existing tool tag if it exists
        this.removeTool(toolName);
        // Add new tool tag with all agent slugs
        this.tags.push(["tool", toolName, ...agentSlugs]);
    }

    /**
     * Remove a tool from the status
     * @param toolName The tool name to remove
     */
    removeTool(toolName: string): void {
        this.tags = this.tags.filter((tag) => !(tag[0] === "tool" && tag[1] === toolName));
    }

    /**
     * Clear all tools from the status
     */
    clearTools(): void {
        this.tags = this.tags.filter((tag) => tag[0] !== "tool");
    }

    /**
     * Check if a specific tool exists
     * @param toolName The tool name
     */
    hasTool(toolName: string): boolean {
        return this.tags.some((tag) => tag[0] === "tool" && tag[1] === toolName);
    }

    /**
     * Get agents that have access to a specific tool
     * @param toolName The tool name
     * @returns Array of agent slugs that have access to this tool
     */
    getToolAgents(toolName: string): string[] {
        const toolTag = this.tags.find((tag) => tag[0] === "tool" && tag[1] === toolName);
        return toolTag ? toolTag.slice(2).filter((a) => a) : [];
    }

    /**
     * Check if a specific agent has access to a tool
     * @param toolName The tool name
     * @param agentSlug The agent slug
     */
    agentHasTool(toolName: string, agentSlug: string): boolean {
        const agents = this.getToolAgents(toolName);
        return agents.includes(agentSlug);
    }

    /**
     * Get all tools accessible by a specific agent
     * @param agentSlug The agent slug
     * @returns Array of tool names accessible by this agent
     */
    getAgentTools(agentSlug: string): string[] {
        return this.tools
            .filter((tool) => tool.agents.includes(agentSlug))
            .map((tool) => tool.toolName);
    }
}
