import type { AgentRegistry } from "@/agents/AgentRegistry";
import { agentStorage, type StoredAgent } from "@/agents/AgentStorage";
import { categorizeAgent } from "@/agents/categorizeAgent";
import { resolveCategory, type AgentCategory } from "@/agents/role-categories";
import { processAgentTools } from "@/agents/tool-normalization";
import type { AgentInstance } from "@/agents/types";
import { AgentMetadataStore } from "@/services/agents";
import { DEFAULT_AGENT_LLM_CONFIG } from "@/llm/constants";
import type { MCPConfig } from "@/llm/providers/types";
import { publishAgentProfile } from "@/nostr/AgentProfilePublisher";
import { config } from "@/services/ConfigService";
import { SkillService } from "@/services/skill";
import {
    buildExpandedBlockedSet,
    buildSkillAliasMap,
    filterBlockedSkills,
} from "@/services/skill/skill-blocking";
import { logger } from "@/utils/logger";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

/**
 * Agent loading orchestration.
 * Single entry point for loading agents into registry.
 * Handles the complete flow: registry → storage → Nostr
 */

/**
 * Tracks pubkeys whose lazy categorization is currently in-flight.
 * Prevents duplicate LLM requests when the same agent is loaded concurrently.
 */
const categorizationInFlight = new Set<string>();

/**
 * Create an AgentInstance from stored agent data.
 * This is the hydration step from persistent data to runtime object.
 * Exported for use in agent creation tools (e.g., agents_write).
 *
 * @param storedAgent - The stored agent data
 * @param registry - The agent registry (used for metadata and LLM service creation)
 * @param projectDTag - Optional project dTag for resolving project-scoped config
 */
export async function createAgentInstance(
    storedAgent: StoredAgent,
    registry: AgentRegistry,
    projectDTag?: string
): Promise<AgentInstance> {
    const signer = new NDKPrivateKeySigner(storedAgent.nsec);
    const pubkey = signer.pubkey;

    // Resolve effective configuration: projectOverrides[dTag] ?? default
    const resolvedConfig = agentStorage.getEffectiveConfig(storedAgent, projectDTag);
    const effectiveLLMConfig = resolvedConfig.model;
    const effectiveTools = resolvedConfig.tools;
    const effectiveAlwaysSkills = resolvedConfig.skills;
    const effectiveBlockedSkills = resolvedConfig.blockedSkills;
    const effectiveMcpAccess = resolvedConfig.mcpAccess;

    const availableSkills = await SkillService.getInstance().listAvailableSkills({
        agentPubkey: pubkey,
        projectPath: registry.getBasePath(),
    });
    const availableSkillMap = buildSkillAliasMap(availableSkills);
    const blockedSet = buildExpandedBlockedSet(effectiveBlockedSkills, availableSkillMap);
    const { allowed, blocked } = filterBlockedSkills(
        effectiveAlwaysSkills ?? [],
        blockedSet,
        availableSkillMap
    );

    if (blocked.length > 0) {
        logger.warn("[AgentLoader] Blocked skills removed from alwaysSkills", {
            agent: storedAgent.slug,
            blockedSkills: blocked,
        });
    }

    // Resolve category — domain-experts have restricted tool access (no delegation)
    const resolvedCategory = resolveCategory(storedAgent.category) ?? resolveCategory(storedAgent.inferredCategory);

    // Process tools using pure functions
    const normalizedTools = processAgentTools(effectiveTools || [], resolvedCategory);

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
        tools: normalizedTools,
        eventId: storedAgent.eventId,
        slug: storedAgent.slug,
        mcpServers: storedAgent.mcpServers,
        pmOverrides: storedAgent.pmOverrides,
        isPM: storedAgent.isPM,
        projectOverrides: storedAgent.projectOverrides,
        telegram: storedAgent.telegram,
        alwaysSkills: allowed.length > 0
            ? allowed
            : undefined,
        blockedSkills: effectiveBlockedSkills,
        mcpAccess: effectiveMcpAccess ?? [],
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
                    agentSlug: storedAgent.slug,
                    agentId: pubkey,
                    workingDirectory: options?.workingDirectory ?? registry.getBasePath(),
                    mcpConfig: mergedMcpConfig,
                    conversationId: options?.conversationId,
                    projectId: projectDTag,
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
 * Load an already-installed agent by pubkey into the registry.
 *
 * This is the authoritative project-membership path used for kind:31933
 * lowercase `p` tags. It never mutates project associations in storage.
 */
export async function loadStoredAgentIntoRegistry(
    pubkey: string,
    registry: AgentRegistry,
    options: { publishProfile?: boolean } = {}
): Promise<AgentInstance> {
    const existingAgent = registry.getAgentByPubkey(pubkey);
    if (existingAgent) {
        logger.debug(`Agent ${pubkey.substring(0, 8)} already loaded in registry as ${existingAgent.slug}`);
        return existingAgent;
    }

    const storedAgent = await agentStorage.loadAgent(pubkey);
    if (!storedAgent) {
        throw new Error(`Agent ${pubkey} not found in storage`);
    }

    // Resolve category synchronously so the correct capability policy (tool restrictions)
    // is applied on the very first load. For uncategorized agents, we await the LLM
    // classification before constructing the AgentInstance — this guarantees that
    // domain-expert agents never receive delegation tools, even on first boot.
    let freshlyInferredCategory: AgentCategory | undefined;
    if (!storedAgent.category && !storedAgent.inferredCategory && !categorizationInFlight.has(pubkey)) {
        categorizationInFlight.add(pubkey);
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        try {
            const timeoutPromise = new Promise<never>((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error("categorization timed out after 30s")), 30_000);
            });
            const inferredCategory = await Promise.race([
                categorizeAgent({
                    name: storedAgent.name,
                    role: storedAgent.role,
                    description: storedAgent.description,
                    instructions: storedAgent.instructions,
                    useCriteria: storedAgent.useCriteria,
                }),
                timeoutPromise,
            ]).finally(() => clearTimeout(timeoutId));

            if (inferredCategory) {
                freshlyInferredCategory = inferredCategory;
                logger.info(`[AgentLoader] Categorized agent "${storedAgent.name}" as "${inferredCategory}"`);
                // CAS-style persist: re-read before writing to avoid clobbering concurrent saves.
                void (async () => {
                    const current = await agentStorage.loadAgent(pubkey);
                    if (!current || current.inferredCategory || current.category) return;
                    const updated = await agentStorage.updateInferredCategory(pubkey, inferredCategory);
                    if (!updated) {
                        logger.warn(`[AgentLoader] Failed to persist inferred category for "${storedAgent.name}"`);
                    }
                })();
            }
        } catch (error) {
            logger.warn(`[AgentLoader] Categorization failed for "${storedAgent.name}"`, { error });
        } finally {
            categorizationInFlight.delete(pubkey);
        }
    }

    const projectDTag = registry.getProjectDTag();
    // Merge freshly inferred category into stored agent data so createAgentInstance
    // sees it even before the CAS persist completes.
    const agentForInstance = freshlyInferredCategory
        ? { ...storedAgent, inferredCategory: freshlyInferredCategory }
        : storedAgent;
    const instance = await createAgentInstance(agentForInstance, registry, projectDTag);
    registry.addAgent(instance);

    const ndkProject = registry.getNDKProject();
    if (options.publishProfile !== false && ndkProject) {
        try {
            const projectTitle = ndkProject.tagValue("title") || "Untitled Project";
            const whitelistedPubkeys = config.getWhitelistedPubkeys();
            const signer = new NDKPrivateKeySigner(storedAgent.nsec);

            void publishAgentProfile(
                signer,
                storedAgent.name,
                storedAgent.role,
                projectTitle,
                ndkProject,
                storedAgent.eventId,
                {
                    description: storedAgent.description,
                    instructions: storedAgent.instructions,
                    useCriteria: storedAgent.useCriteria,
                },
                whitelistedPubkeys
            ).catch((error) => {
                logger.warn(`Failed to publish kind:0 profile for agent ${storedAgent.name}`, {
                    error,
                });
            });
        } catch (error) {
            logger.warn(`Failed to publish kind:0 profile for agent ${storedAgent.name}`, { error });
        }
    }

    logger.info(
        `Loaded agent "${instance.name}" (${instance.slug}) into registry for project ${projectDTag}`
    );

    return instance;
}
