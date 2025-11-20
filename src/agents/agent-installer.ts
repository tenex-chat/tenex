import { agentStorage, createStoredAgent, type StoredAgent } from "@/agents/AgentStorage";
import { getDefaultToolsForAgent } from "@/agents/constants";
import { AgentNotFoundError, AgentValidationError } from "@/agents/errors";
import { DEFAULT_AGENT_LLM_CONFIG } from "@/llm/constants";
import { getNDK } from "@/nostr";
import { logger } from "@/utils/logger";
import { toKebabCase } from "@/lib/string";
import type NDK from "@nostr-dev-kit/ndk";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";

/**
 * agent-installer - Pure Nostr operations for fetching agent definitions
 *
 * ## Responsibility
 * Fetches agent definition events from Nostr relays and saves them to storage.
 * - Fetches events by event ID
 * - Validates event structure
 * - Parses event into StoredAgent format
 * - Generates private keys for agents
 * - Saves to AgentStorage
 *
 * ## Architecture
 * - **agent-installer** (this): Pure Nostr operations only
 * - **AgentStorage**: Handles persistence (uses this)
 * - **agent-loader**: Orchestrates the full loading flow (uses this)
 *
 * ## Separation of Concerns
 * This module is ONLY about Nostr:
 * - No registry logic
 * - No project logic
 * - No in-memory state
 * - Just: fetch → validate → parse → save
 *
 * ## Usage
 * Typically called by agent-loader when an agent is not found in storage.
 * Can also be used standalone to pre-install agents.
 *
 * @example
 * // Install agent from Nostr
 * const stored = await installAgentFromNostr('nostr:event123', 'my-agent');
 * console.log('Installed:', stored.name);
 *
 * @see agent-loader for the complete loading orchestration
 * @see AgentStorage for persistence operations
 */

/**
 * Validate that an NDK event is a valid agent definition event
 */
function validateAgentEvent(event: NDKEvent): void {
    // Check if event has required fields
    if (!event.id) {
        throw new AgentValidationError("Agent event missing ID");
    }

    // Check if event has a title tag (agents should have titles)
    const title = event.tagValue("title");
    if (!title || title.trim() === "") {
        throw new AgentValidationError("Agent event missing title tag");
    }

    // Check if event has content or instructions
    if (!event.content || event.content.trim() === "") {
        logger.warn(`Agent event ${event.id} has no instructions (empty content)`);
    }
}

/**
 * Parse an NDK agent definition event into StoredAgent data structure
 */
function parseAgentEvent(event: NDKEvent, slug: string): Omit<StoredAgent, "nsec" | "projects"> {
    // Validate before parsing
    validateAgentEvent(event);

    const title = event.tagValue("title") || "Unnamed Agent";
    const description = event.tagValue("description") || "";
    const role = event.tagValue("role") || "assistant";
    const instructions = event.content || "";
    const useCriteria = event.tagValue("use-criteria") || "";

    // Extract tool requirements from the agent definition event
    const toolTags = event.tags
        .filter((tag) => tag[0] === "tool" && tag[1])
        .map((tag) => tag[1]);

    if (toolTags.length > 0) {
        logger.info(`Agent "${title}" requests access to ${toolTags.length} tool(s):`, toolTags);
    }

    // Extract phase definitions from the agent definition event
    const phaseTags = event.tags.filter((tag) => tag[0] === "phase" && tag[1] && tag[2]);
    let phases: Record<string, string> | undefined;
    if (phaseTags.length > 0) {
        phases = {};
        for (const [, phaseName, phaseInstructions] of phaseTags) {
            phases[phaseName] = phaseInstructions;
        }
        logger.info(
            `Agent "${title}" defines ${Object.keys(phases).length} phase(s):`,
            Object.keys(phases)
        );
    }

    return {
        eventId: event.id,
        slug,
        name: title,
        role,
        description,
        instructions,
        useCriteria,
        llmConfig: DEFAULT_AGENT_LLM_CONFIG,
        tools: toolTags.length > 0 ? toolTags : getDefaultToolsForAgent({ phases }),
        phases,
    };
}

/**
 * Fetch an agent definition event from Nostr and save it to storage.
 *
 * Pure orchestration: fetch → validate → parse → generate keys → save → return
 *
 * ## Flow
 * 1. Fetch agent definition event from Nostr relays (by eventId)
 * 2. Validate event structure (has title, content, etc.)
 * 3. Parse event tags (tools, phases, etc.)
 * 4. Generate new private key for this agent instance
 * 5. Save to AgentStorage
 * 6. Return StoredAgent
 *
 * ## Note
 * This does NOT add the agent to any registry or project. That happens
 * later in agent-loader.ts. This function is ONLY about Nostr → storage.
 *
 * @param eventId - The Nostr event ID of the agent definition (with or without "nostr:" prefix)
 * @param customSlug - Optional custom slug (defaults to kebab-case of agent name)
 * @param ndk - Optional NDK instance (uses default if not provided)
 * @returns The saved StoredAgent (with generated private key)
 * @throws AgentNotFoundError if event not found on relays
 * @throws AgentValidationError if event structure is invalid
 *
 * @example
 * // Install agent with default slug
 * const agent = await installAgentFromNostr('event123');
 *
 * @example
 * // Install with custom slug
 * const agent = await installAgentFromNostr('event123', 'my-custom-slug');
 */
export async function installAgentFromNostr(
    eventId: string,
    customSlug?: string,
    ndk?: NDK
): Promise<StoredAgent> {
    // Use provided NDK or get default
    const ndkInstance = ndk || getNDK();

    // Clean the event ID (remove nostr: prefix if present)
    const cleanEventId = eventId.startsWith("nostr:") ? eventId.substring(6) : eventId;

    // Fetch the event from Nostr
    logger.debug(`Fetching agent event ${cleanEventId} from Nostr relays`);
    const agentEvent = await ndkInstance.fetchEvent(cleanEventId, { groupable: false });

    if (!agentEvent) {
        throw new AgentNotFoundError(cleanEventId);
    }

    // Generate slug from name if not provided
    const slug = customSlug || toKebabCase(agentEvent.tagValue("title") || "unnamed-agent");

    // Parse the event into agent data
    const agentData = parseAgentEvent(agentEvent, slug);

    // Generate a new private key for this agent
    const signer = NDKPrivateKeySigner.generate();

    // Create StoredAgent using factory
    const storedAgent = createStoredAgent({
        nsec: signer.nsec,
        slug: agentData.slug,
        name: agentData.name,
        role: agentData.role,
        description: agentData.description,
        instructions: agentData.instructions,
        useCriteria: agentData.useCriteria,
        llmConfig: agentData.llmConfig,
        tools: agentData.tools,
        phases: agentData.phases,
        eventId: agentData.eventId,
        projects: [], // Projects are managed by agent-loader
    });

    // Save to storage
    await agentStorage.saveAgent(storedAgent);
    logger.info(`Installed agent "${agentData.name}" (${slug}) from Nostr event ${cleanEventId}`);

    return storedAgent;
}
