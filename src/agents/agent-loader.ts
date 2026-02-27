import type { AgentRegistry } from "@/agents/AgentRegistry";
import { agentStorage, type StoredAgent } from "@/agents/AgentStorage";
import { installAgentFromNostr } from "@/agents/agent-installer";
import { AgentSlugConflictError } from "@/agents/errors";
import { resolveCategory, filterDeniedTools } from "@/agents/role-categories";
import { processAgentTools } from "@/agents/tool-normalization";
import type { AgentInstance } from "@/agents/types";
import { AgentMetadataStore } from "@/services/agents";
import { DEFAULT_AGENT_LLM_CONFIG } from "@/llm/constants";
import type { MCPConfig } from "@/llm/providers/types";
import { AgentProfilePublisher } from "@/nostr/AgentProfilePublisher";
import { config } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

/**
 * Agent loading orchestration.
 * Single entry point for loading agents into registry.
 * Handles the complete flow: registry → storage → Nostr
 */

/**
 * Create an AgentInstance from stored agent data.
 * This is the hydration step from persistent data to runtime object.
 * Exported for use in agent creation tools (e.g., agents_write).
 *
 * @param storedAgent - The stored agent data
 * @param registry - The agent registry (used for metadata and LLM service creation)
 * @param projectDTag - Optional project dTag for resolving project-scoped config
 */
export function createAgentInstance(
    storedAgent: StoredAgent,
    registry: AgentRegistry,
    projectDTag?: string
): AgentInstance {
    const signer = new NDKPrivateKeySigner(storedAgent.nsec);
    const pubkey = signer.pubkey;

    // Resolve effective configuration: projectOverrides[dTag] ?? default
    const resolvedConfig = agentStorage.getEffectiveConfig(storedAgent, projectDTag);
    const effectiveLLMConfig = resolvedConfig.model;
    const effectiveTools = resolvedConfig.tools;

    // Process tools using pure functions
    const normalizedTools = processAgentTools(effectiveTools || [], storedAgent.slug);

    // Apply category-based tool restrictions (TIP-01)
    const resolvedCategory = resolveCategory(storedAgent.category);
    const validToolNames = filterDeniedTools(normalizedTools, resolvedCategory);

    // Build agent-specific MCP config from stored mcpServers
    const agentMcpConfig: MCPConfig | undefined = storedAgent.mcpServers
        ? {
            enabled: true,
            servers: storedAgent.mcpServers,
        }
        : undefined;

    const agent: AgentInstance = {
        name: storedAgent.name,
        pubkey,
        signer,
        role: storedAgent.role,
        category: resolvedCategory,
        description: storedAgent.description,
        instructions: storedAgent.instructions,
        useCriteria: storedAgent.useCriteria,
        llmConfig: effectiveLLMConfig || DEFAULT_AGENT_LLM_CONFIG,
        tools: validToolNames,
        eventId: storedAgent.eventId,
        slug: storedAgent.slug,
        mcpServers: storedAgent.mcpServers,
        pmOverrides: storedAgent.pmOverrides,
        isPM: storedAgent.isPM,
        projectOverrides: storedAgent.projectOverrides,
        createMetadataStore: (conversationId: string) => {
            const metadataPath = registry.getMetadataPath();
            return new AgentMetadataStore(conversationId, storedAgent.slug, metadataPath);
        },
        createLLMService: (options) => {
            // Merge passed mcpConfig with agent's own mcpConfig
            // Agent-specific servers override project-level servers on name collision
            // Project-level enabled flag takes precedence (default to true if not specified)
            let mergedMcpConfig: MCPConfig | undefined;
            if (options?.mcpConfig && agentMcpConfig) {
                mergedMcpConfig = {
                    enabled: options.mcpConfig.enabled !== false,
                    servers: {
                        ...options.mcpConfig.servers, // project-level first
                        ...agentMcpConfig.servers, // agent-specific overrides
                    },
                };
            } else {
                mergedMcpConfig = options?.mcpConfig || agentMcpConfig;
            }

            // Use resolved config name if provided (for meta model resolution),
            // otherwise use the agent's llmConfig
            const configName = options?.resolvedConfigName || agent.llmConfig || DEFAULT_AGENT_LLM_CONFIG;

            return config.createLLMService(
                configName,
                {
                    tools: options?.tools ?? {},
                    agentName: storedAgent.name,
                    sessionId: options?.sessionId,
                    workingDirectory: options?.workingDirectory ?? registry.getBasePath(),
                    mcpConfig: mergedMcpConfig,
                    conversationId: options?.conversationId,
                    onStreamStart: options?.onStreamStart,
                }
            );
        },
        sign: async (event: NDKEvent) => {
            await event.sign(signer, { pTags: false });
        },
    };

    return agent;
}

/**
 * Load an agent by eventId into the registry.
 * This is the ONLY function needed for loading agents.
 *
 * Flow (no redundant checks):
 * 1. Check if already in registry → return
 * 2. Check storage → load and return
 * 3. Not in storage → fetch from Nostr → save → load → return
 *
 * @param eventId - The Nostr event ID of the agent definition
 * @param registry - The AgentRegistry to load the agent into
 * @param customSlug - Optional custom slug for the agent
 * @returns The loaded AgentInstance
 * @throws Error if agent cannot be loaded
 */
export async function loadAgentIntoRegistry(
    eventId: string,
    registry: AgentRegistry,
    customSlug?: string
): Promise<AgentInstance> {
    // Clean event ID
    const cleanEventId = eventId.startsWith("nostr:") ? eventId.substring(6) : eventId;

    // Step 1: Check if already in registry by eventId
    const existingByEventId = registry.getAgentByEventId(cleanEventId);
    if (existingByEventId) {
        logger.debug(`Agent ${cleanEventId} already loaded in registry as ${existingByEventId.slug}`);
        return existingByEventId;
    }

    // If custom slug provided, also check by slug
    if (customSlug) {
        const existingBySlug = registry.getAgent(customSlug);
        if (existingBySlug) {
            if (existingBySlug.eventId === cleanEventId) {
                logger.debug(`Agent ${customSlug} already loaded with same event ID`);
                return existingBySlug;
            }
            throw new AgentSlugConflictError(customSlug, existingBySlug.eventId, cleanEventId);
        }
    }

    // Step 2: Check storage by eventId
    let storedAgent = await agentStorage.getAgentByEventId(cleanEventId);

    if (!storedAgent) {
        // Step 3: Not in storage - fetch from Nostr and save
        logger.debug(`Agent ${cleanEventId} not in storage, fetching from Nostr`);
        storedAgent = await installAgentFromNostr(cleanEventId, customSlug);
    } else {
        logger.debug(`Agent ${cleanEventId} found in storage as ${storedAgent.slug}`);
    }

    // If custom slug provided and different from stored slug, update it
    if (customSlug && storedAgent.slug !== customSlug) {
        // Check if the custom slug is already taken by a different agent
        const existingWithCustomSlug = await agentStorage.getAgentBySlug(customSlug);
        if (existingWithCustomSlug) {
            throw new AgentSlugConflictError(
                customSlug,
                existingWithCustomSlug.eventId,
                cleanEventId
            );
        }

        // Update slug
        storedAgent.slug = customSlug;
        await agentStorage.saveAgent(storedAgent);
        logger.info(`Updated agent slug to ${customSlug}`);
    }

    // Ensure agent is associated with this project using storage method
    const projectDTag = registry.getProjectDTag();
    const signer = new NDKPrivateKeySigner(storedAgent.nsec);
    const pubkey = signer.pubkey;

    if (projectDTag) {
        await agentStorage.addAgentToProject(pubkey, projectDTag);
    }

    // Reload agent after project association to ensure fresh state
    const freshAgent = await agentStorage.loadAgent(pubkey);
    if (!freshAgent) {
        throw new Error(`Agent ${storedAgent.slug} disappeared after project association`);
    }

    // Create instance and add to registry
    // Pass projectDTag so project-scoped config can be resolved
    const instance = createAgentInstance(freshAgent, registry, projectDTag);
    registry.addAgent(instance);

    // Publish kind:0 profile for this agent now that it's associated with the project
    const ndkProject = registry.getNDKProject();
    if (ndkProject) {
        try {
            const projectTitle = ndkProject.tagValue("title") || "Untitled Project";
            const whitelistedPubkeys = config.getWhitelistedPubkeys(undefined, config.getConfig());

            AgentProfilePublisher.publishAgentProfile(
                signer,
                freshAgent.name,
                freshAgent.role,
                projectTitle,
                ndkProject,
                freshAgent.eventId,
                {
                    description: freshAgent.description,
                    instructions: freshAgent.instructions,
                    useCriteria: freshAgent.useCriteria,
                },
                whitelistedPubkeys
            );

            logger.debug(`Published kind:0 profile for agent ${freshAgent.name} on project ${projectDTag}`);
        } catch (error) {
            logger.warn(`Failed to publish kind:0 profile for agent ${freshAgent.name}`, { error });
        }
    }

    logger.info(
        `Loaded agent "${instance.name}" (${instance.slug}) into registry for project ${projectDTag}`
    );

    return instance;
}
