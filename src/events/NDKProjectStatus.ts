import { NDKEvent, type NDKRawEvent } from "@nostr-dev-kit/ndk";
import type NDK from "@nostr-dev-kit/ndk";

/**
 * NDKProjectStatus represents a kind 24010 event
 * Used to indicate project status including online agents and model configurations
 */
export class NDKProjectStatus extends NDKEvent {
    static kind = 24010;
    static kinds = [24010];

    constructor(ndk?: NDK, event?: NDKEvent | NDKRawEvent) {
        super(ndk, event);
        this.kind ??= 24010;
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
        const agentTags = this.tags.filter(tag => tag[0] === "agent");
        return agentTags.map(tag => ({
            pubkey: tag[1] || "",
            slug: tag[2] || ""
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
        this.tags = this.tags.filter(tag => 
            !(tag[0] === "agent" && tag[1] === pubkey)
        );
    }

    /**
     * Clear all agents from the status
     */
    clearAgents(): void {
        this.tags = this.tags.filter(tag => tag[0] !== "agent");
    }

    /**
     * Check if a specific agent is in the status
     * @param pubkey The agent's public key
     */
    hasAgent(pubkey: string): boolean {
        return this.tags.some(tag => 
            tag[0] === "agent" && tag[1] === pubkey
        );
    }

    /**
     * Get all model configurations from this status event
     * Returns an array of {model, configName} objects
     */
    get models(): Array<{ model: string; configName: string }> {
        const modelTags = this.tags.filter(tag => tag[0] === "model");
        return modelTags.map(tag => ({
            model: tag[1] || "",
            configName: tag[2] || ""
        }));
    }

    /**
     * Add a model configuration to the status
     * @param model The model identifier (e.g., "gpt-4", "claude-3")
     * @param configName The configuration name
     */
    addModel(model: string, configName: string): void {
        this.tags.push(["model", model, configName]);
    }

    /**
     * Remove a model configuration from the status
     * @param configName The configuration name to remove
     */
    removeModel(configName: string): void {
        this.tags = this.tags.filter(tag => 
            !(tag[0] === "model" && tag[2] === configName)
        );
    }

    /**
     * Clear all model configurations from the status
     */
    clearModels(): void {
        this.tags = this.tags.filter(tag => tag[0] !== "model");
    }

    /**
     * Check if a specific model configuration exists
     * @param configName The configuration name
     */
    hasModel(configName: string): boolean {
        return this.tags.some(tag => 
            tag[0] === "model" && tag[2] === configName
        );
    }

    /**
     * Get a specific model by config name
     * @param configName The configuration name
     * @returns The model name or undefined if not found
     */
    getModel(configName: string): string | undefined {
        const modelTag = this.tags.find(tag => 
            tag[0] === "model" && tag[2] === configName
        );
        return modelTag?.[1];
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
        const toolTags = this.tags.filter(tag => tag[0] === "tool");
        return toolTags.map(tag => ({
            toolName: tag[1] || "",
            agents: tag.slice(2).filter(a => a) // Get all agent slugs from index 2 onwards
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
        this.tags = this.tags.filter(tag => 
            !(tag[0] === "tool" && tag[1] === toolName)
        );
    }

    /**
     * Clear all tools from the status
     */
    clearTools(): void {
        this.tags = this.tags.filter(tag => tag[0] !== "tool");
    }

    /**
     * Check if a specific tool exists
     * @param toolName The tool name
     */
    hasTool(toolName: string): boolean {
        return this.tags.some(tag => 
            tag[0] === "tool" && tag[1] === toolName
        );
    }

    /**
     * Get agents that have access to a specific tool
     * @param toolName The tool name
     * @returns Array of agent slugs that have access to this tool
     */
    getToolAgents(toolName: string): string[] {
        const toolTag = this.tags.find(tag => 
            tag[0] === "tool" && tag[1] === toolName
        );
        return toolTag ? toolTag.slice(2).filter(a => a) : [];
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
            .filter(tool => tool.agents.includes(agentSlug))
            .map(tool => tool.toolName);
    }
}