import { agentStorage, createStoredAgent, type StoredAgent } from "@/agents/AgentStorage";
import { AgentNotFoundError, AgentValidationError } from "@/agents/errors";
import { installAgentScripts } from "@/agents/script-installer";
import { DEFAULT_AGENT_LLM_CONFIG } from "@/llm/constants";
import { getNDK } from "@/nostr";
import { logger } from "@/utils/logger";
import { toKebabCase } from "@/lib/string";
import type NDK from "@nostr-dev-kit/ndk";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { NDKAgentDefinition } from "@/events/NDKAgentDefinition";

/**
 * agent-installer - Pure Nostr operations for fetching agent definitions
 *
 * ## Responsibility
 * Fetches agent definition events from Nostr relays and saves them to storage.
 * - Fetches events by event ID
 * - Validates event structure
 * - Parses event into StoredAgent format
 * - Generates private keys for agents
 * - Installs bundled scripts from kind 1063 (NIP-94) events
 * - Saves to AgentStorage
 *
 * ## Architecture
 * - **agent-installer** (this): Pure Nostr operations only
 * - **script-installer**: Handles downloading and installing bundled scripts
 * - **AgentStorage**: Handles persistence (uses this)
 * - **agent-loader**: Orchestrates the full loading flow (uses this)
 *
 * ## Separation of Concerns
 * This module is ONLY about Nostr:
 * - No registry logic
 * - No project logic
 * - No in-memory state
 * - Just: fetch → validate → parse → install scripts → save
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
 * @see script-installer for bundled script installation
 */

/**
 * Validate that an NDK event is a valid agent definition event
 */
function validateAgentEvent(agentDef: NDKAgentDefinition): void {
    // Check if event has required fields
    if (!agentDef.id) {
        throw new AgentValidationError("Agent event missing ID");
    }

    // Check if event has a title tag (agents should have titles)
    if (!agentDef.title || agentDef.title.trim() === "") {
        throw new AgentValidationError("Agent event missing title tag");
    }

    // Check if event has instructions
    if (!agentDef.instructions || agentDef.instructions.trim() === "") {
        logger.warn(`Agent event ${agentDef.id} has no instructions`);
    }
}

/**
 * Parse an NDK agent definition event into StoredAgent data structure
 */
function parseAgentEvent(event: NDKEvent, slug: string): Omit<StoredAgent, "nsec" | "projects"> {
    // Wrap in NDKAgentDefinition to use proper accessors
    const agentDef = NDKAgentDefinition.from(event);

    // Validate before parsing
    validateAgentEvent(agentDef);

    const title = agentDef.title || "Unnamed Agent";
    const description = agentDef.description || "";
    const role = agentDef.role || "assistant";
    const instructions = agentDef.instructions || "";
    const useCriteria = agentDef.useCriteria || "";

    // Extract tool requirements from the agent definition event
    const toolTags = event.tags
        .filter((tag) => tag[0] === "tool" && tag[1])
        .map((tag) => tag[1]);

    if (toolTags.length > 0) {
        logger.info(`Agent "${title}" requests access to ${toolTags.length} tool(s):`, toolTags);
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
        tools: toolTags.length > 0 ? toolTags : [],
    };
}

/**
 * Fetch an agent definition event from Nostr and save it to storage.
 *
 * Pure orchestration: fetch → validate → parse → generate keys → install scripts → save → return
 *
 * ## Flow
 * 1. Fetch agent definition event from Nostr relays (by eventId)
 * 2. Validate event structure (has title, content, etc.)
 * 3. Parse event tags (tools, etc.)
 * 4. Check if agent already exists (by eventId) to preserve user config
 * 5. Generate new private key for this agent instance (if new)
 * 6. Install bundled scripts from kind 1063 events (if any e-tags with "script" marker)
 * 7. Save to AgentStorage
 * 8. Return StoredAgent
 *
 * ## Configuration Preservation
 * If an agent with the same eventId already exists, this function preserves:
 * - llmConfig: User's custom LLM model assignment
 * - pmOverrides: Project-scoped PM override settings
 * - nsec: The agent's private key (identity)
 * - projects: Existing project associations
 *
 * This prevents re-adding an agent to a new project from resetting its
 * configuration across all projects that share the same agent definition.
 *
 * ## Script Installation
 * Agent definitions can reference kind 1063 (NIP-94 file metadata) events via e-tags
 * with the "script" marker. These files are downloaded from Blossom servers and
 * installed to the agent's home directory at the path specified in the name tag.
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

    // Check if an agent with this eventId already exists
    // This preserves user configuration (llmConfig, pmOverrides, etc.)
    const existingAgent = await agentStorage.getAgentByEventId(cleanEventId);
    if (existingAgent) {
        logger.debug(
            `Agent with eventId ${cleanEventId} already exists as "${existingAgent.slug}", ` +
            `preserving existing configuration`
        );
        return existingAgent;
    }

    // Fetch the event from Nostr
    logger.debug(`Fetching agent event ${cleanEventId} from Nostr relays`);
    const agentEvent = await ndkInstance.fetchEvent(cleanEventId, { groupable: false });

    if (!agentEvent) {
        throw new AgentNotFoundError(cleanEventId);
    }

    // Wrap in NDKAgentDefinition for proper accessors
    const agentDef = NDKAgentDefinition.from(agentEvent);

    // Generate slug from name if not provided
    const slug = customSlug || toKebabCase(agentDef.title || "unnamed-agent");

    // Parse the event into agent data
    const agentData = parseAgentEvent(agentEvent, slug);

    // Generate a new private key for this agent
    const signer = NDKPrivateKeySigner.generate();

    // Install bundled scripts from kind 1063 events
    const scriptETags = agentDef.getScriptETags();
    if (scriptETags.length > 0) {
        logger.info(`Agent "${agentData.name}" has ${scriptETags.length} bundled script(s)`);
        const scriptResults = await installAgentScripts(scriptETags, signer.pubkey, ndkInstance);

        // Log any script installation failures (but don't fail the agent installation)
        const failures = scriptResults.filter((r) => !r.success);
        if (failures.length > 0) {
            logger.warn(`${failures.length} script(s) failed to install for agent "${agentData.name}"`, {
                failures: failures.map((f) => ({ path: f.relativePath, error: f.error })),
            });
        }
    }

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
        eventId: agentData.eventId,
        projects: [], // Projects are managed by agent-loader
    });

    // Save to storage
    await agentStorage.saveAgent(storedAgent);
    logger.info(`Installed agent "${agentData.name}" (${slug}) from Nostr event ${cleanEventId}`);

    return storedAgent;
}
