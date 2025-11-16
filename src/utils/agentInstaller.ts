import type { AgentRegistry } from "@/agents/AgentRegistry";
import type { AgentInstance } from "@/agents/types";
import { getNDK } from "@/nostr";
import { logger } from "@/utils/logger";
import { toKebabCase } from "@/utils/string";
import type NDK from "@nostr-dev-kit/ndk";
import type { NDKProject } from "@nostr-dev-kit/ndk";

/**
 * Result of installing an agent from an event
 */
export interface AgentInstallResult {
    success: boolean;
    agent?: AgentInstance;
    slug?: string;
    message?: string;
    error?: string;
    alreadyExists?: boolean;
}

/**
 * Installs an agent from a Nostr event into a project.
 * This is the shared business logic for adding agents from definition events.
 *
 * @param eventId - The event ID of the agent definition (can include "nostr:" prefix)
 * @param projectPath - The path to the project
 * @param ndkProject - Optional NDK project for publishing events
 * @param customSlug - Optional custom slug for the agent
 * @param ndk - Optional NDK instance (will use default if not provided)
 * @param agentRegistry - AgentRegistry to use (required - cannot be created without metadataPath)
 * @returns Result of the installation
 */
export async function installAgentFromEvent(
    eventId: string,
    projectPath: string,
    ndkProject?: NDKProject,
    customSlug?: string,
    ndk?: NDK,
    agentRegistry?: AgentRegistry
): Promise<AgentInstallResult> {
    try {
        // Use provided NDK or get default
        const ndkInstance = ndk || getNDK();

        // Clean the event ID
        const cleanEventId = eventId.startsWith("nostr:") ? eventId.substring(6) : eventId;

        // Fetch the full event to get access to tags
        logger.debug(`Fetching agent event ${cleanEventId} from Nostr relays`);
        const agentEvent = await ndkInstance.fetchEvent(cleanEventId, { groupable: false });

        if (!agentEvent) {
            return {
                success: false,
                error: `Agent event ${cleanEventId} not found on Nostr relays. The event may not have been published yet or your relays may not have it.`,
            };
        }

        // Parse agent definition from the event
        const agentDef = {
            id: agentEvent.id,
            title: agentEvent.tagValue("title") || "Unnamed Agent",
            description: agentEvent.tagValue("description") || "",
            role: agentEvent.tagValue("role") || "assistant",
            instructions: agentEvent.content || "",
            useCriteria: agentEvent.tagValue("use-criteria") || "",
        };

        // Generate slug from name if not provided
        const slug = customSlug || toKebabCase(agentDef.title);

        // Require registry to be provided - we can't create one without metadataPath
        if (!agentRegistry) {
            return {
                success: false,
                error: "AgentRegistry must be provided - cannot create one without metadataPath",
            };
        }

        const registry = agentRegistry;
        // Note: loadFromProject is called by ProjectManager, not here

        // Check if agent already exists
        const existingAgent = registry.getAgent(slug);
        if (existingAgent) {
            if (existingAgent.eventId === agentDef.id) {
                return {
                    success: true,
                    alreadyExists: true,
                    message: `Agent "${agentDef.title}" is already installed in the project`,
                    agent: existingAgent,
                    slug,
                };
            }
            return {
                success: false,
                error: `An agent with slug "${slug}" already exists but with a different event ID`,
            };
        }

        // Extract tool requirements from the agent definition event
        const toolTags = agentEvent.tags
            .filter((tag) => tag[0] === "tool" && tag[1])
            .map((tag) => tag[1]);

        if (toolTags.length > 0) {
            logger.info(
                `Agent "${agentDef.title}" requests access to ${toolTags.length} tool(s):`,
                toolTags
            );
        }

        // Extract phase definitions from the agent definition event
        const phaseTags = agentEvent.tags.filter((tag) => tag[0] === "phase" && tag[1] && tag[2]);
        let phases: Record<string, string> | undefined;
        if (phaseTags.length > 0) {
            phases = {};
            for (const [, phaseName, instructions] of phaseTags) {
                phases[phaseName] = instructions;
            }
            logger.info(
                `Agent "${agentDef.title}" defines ${Object.keys(phases).length} phase(s):`,
                Object.keys(phases)
            );
        }

        // Create agent configuration
        const agentConfig = {
            name: agentDef.title,
            role: agentDef.role,
            description: agentDef.description,
            instructions: agentDef.instructions,
            useCriteria: agentDef.useCriteria,
            tools: toolTags, // Include the requested tools
            eventId: agentDef.id,
            ...(phases && { phases }), // Include phases if defined
        };

        // Register the agent
        const agent = await registry.ensureAgent(slug, agentConfig, ndkProject);
        logger.info("Registered new agent", { slug, name: agentDef.title });

        return {
            success: true,
            agent,
            slug,
            message: `Successfully installed agent "${agentDef.title}"`,
        };
    } catch (error) {
        logger.error("Failed to install agent from event", { error, eventId });
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Installs multiple agents from events in parallel
 *
 * @param eventIds - Array of event IDs to install
 * @param projectPath - The path to the project
 * @param ndkProject - Optional NDK project for publishing events
 * @param ndk - Optional NDK instance
 * @param agentRegistry - Optional AgentRegistry to use
 * @returns Array of installation results
 */
export async function installAgentsFromEvents(
    eventIds: string[],
    projectPath: string,
    ndkProject?: NDKProject,
    ndk?: NDK,
    agentRegistry?: AgentRegistry
): Promise<AgentInstallResult[]> {
    const results = await Promise.all(
        eventIds.map((eventId) =>
            installAgentFromEvent(eventId, projectPath, ndkProject, undefined, ndk, agentRegistry)
        )
    );

    const successCount = results.filter((r) => r.success).length;
    const failureCount = results.filter((r) => !r.success).length;

    if (successCount > 0) {
        logger.info(`Successfully installed ${successCount} agent(s)`);
    }
    if (failureCount > 0) {
        logger.warn(`Failed to install ${failureCount} agent(s)`);
    }

    return results;
}
