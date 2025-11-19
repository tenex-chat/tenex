import { agentStorage, type StoredAgent } from "@/agents/AgentStorage";
import { getDefaultToolsForAgent } from "@/agents/constants";
import { AgentNotFoundError, AgentValidationError } from "@/agents/errors";
import { DEFAULT_AGENT_LLM_CONFIG } from "@/llm/constants";
import { getNDK } from "@/nostr";
import { logger } from "@/utils/logger";
import { toKebabCase } from "@/utils/string";
import type NDK from "@nostr-dev-kit/ndk";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";

/**
 * Pure functions for fetching and installing agents from Nostr.
 * No registry interaction - only Nostr fetching and storage operations.
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
 * This is a pure orchestration function - fetches, parses, saves, returns.
 *
 * @param eventId - The Nostr event ID of the agent definition
 * @param customSlug - Optional custom slug (defaults to kebab-case of agent name)
 * @param ndk - Optional NDK instance (uses default if not provided)
 * @returns The saved StoredAgent
 * @throws Error if event not found or fetch/save fails
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

    // Create StoredAgent with empty projects array (will be set by loader)
    const storedAgent: StoredAgent = {
        ...agentData,
        nsec: signer.nsec,
        projects: [], // Projects are managed by agent-loader
    };

    // Save to storage
    await agentStorage.saveAgent(storedAgent);
    logger.info(`Installed agent "${agentData.name}" (${slug}) from Nostr event ${cleanEventId}`);

    return storedAgent;
}
