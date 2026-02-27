import { agentStorage, createStoredAgent, type StoredAgent } from "@/agents/AgentStorage";
import { AgentNotFoundError, AgentValidationError } from "@/agents/errors";
import { isValidCategory, type AgentCategory } from "@/agents/role-categories";
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
 * - Installs bundled files from kind 1063 (NIP-94) events via e-tags
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
interface ParsedAgentEvent {
    eventId: string;
    slug: string;
    name: string;
    role: string;
    category?: AgentCategory;
    description: string;
    instructions: string;
    useCriteria: string;
    defaultConfig: { model: string; tools?: string[] };
    definitionDTag?: string;
    definitionAuthor?: string;
    definitionCreatedAt?: number;
}

function parseAgentEvent(event: NDKEvent, slug: string): ParsedAgentEvent {
    // Wrap in NDKAgentDefinition to use proper accessors
    const agentDef = NDKAgentDefinition.from(event);

    // Validate before parsing
    validateAgentEvent(agentDef);

    const title = agentDef.title || "Unnamed Agent";
    const description = agentDef.description || "";
    const role = agentDef.role || "assistant";
    const rawCategory = agentDef.category || undefined;
    const category = rawCategory && isValidCategory(rawCategory) ? rawCategory : undefined;
    const instructions = agentDef.instructions || "";
    const useCriteria = agentDef.useCriteria || "";

    // Extract definition tracking metadata for auto-upgrade monitoring
    const definitionDTag = event.tagValue("d") || undefined;
    const definitionAuthor = event.pubkey || undefined;

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
        category,
        description,
        instructions,
        useCriteria,
        defaultConfig: {
            model: DEFAULT_AGENT_LLM_CONFIG,
            tools: toolTags.length > 0 ? toolTags : undefined,
        },
        definitionDTag,
        definitionAuthor,
        definitionCreatedAt: event.created_at,
    };
}

/**
 * Install an agent from an already-fetched NDKEvent.
 *
 * Core installation logic: validate → parse → generate keys → install scripts → save → return
 *
 * @param event - The NDKEvent containing the agent definition
 * @param customSlug - Optional custom slug (defaults to kebab-case of agent name)
 * @param ndk - Optional NDK instance (uses default if not provided, needed for script downloads)
 * @returns The saved StoredAgent (with generated private key)
 * @throws AgentValidationError if event structure is invalid
 */
export async function installAgentFromNostrEvent(
    event: NDKEvent,
    customSlug?: string,
    ndk?: NDK
): Promise<StoredAgent> {
    const ndkInstance = ndk || getNDK();

    // Check if an agent with this eventId already exists
    // This preserves user configuration (llmConfig, pmOverrides, etc.)
    if (event.id) {
        const existingAgent = await agentStorage.getAgentByEventId(event.id);
        if (existingAgent) {
            logger.debug(
                `Agent with eventId ${event.id} already exists as "${existingAgent.slug}", ` +
                `preserving existing configuration`
            );
            return existingAgent;
        }
    }

    const agentDef = NDKAgentDefinition.from(event);

    // Generate slug: prefer customSlug > event's d-tag > derived from title
    const slug = customSlug || agentDef.slug || toKebabCase(agentDef.title || "unnamed-agent");

    // Parse and validate the event into agent data
    const agentData = parseAgentEvent(event, slug);

    // Generate a new private key for this agent
    const signer = NDKPrivateKeySigner.generate();

    // Install bundled files from kind 1063 events (referenced via e-tags)
    const fileETags = agentDef.getETags();
    if (fileETags.length > 0) {
        logger.info(`Agent "${agentData.name}" has ${fileETags.length} bundled file(s)`);
        const fileResults = await installAgentScripts(fileETags, signer.pubkey, ndkInstance);

        const failures = fileResults.filter((r) => !r.success);
        if (failures.length > 0) {
            logger.warn(`${failures.length} file(s) failed to install for agent "${agentData.name}"`, {
                failures: failures.map((f) => ({ path: f.relativePath, error: f.error })),
            });
        }
    }

    const storedAgent = createStoredAgent({
        nsec: signer.nsec,
        slug: agentData.slug,
        name: agentData.name,
        role: agentData.role,
        category: agentData.category,
        description: agentData.description,
        instructions: agentData.instructions,
        useCriteria: agentData.useCriteria,
        defaultConfig: agentData.defaultConfig,
        eventId: agentData.eventId,
        definitionDTag: agentData.definitionDTag,
        definitionAuthor: agentData.definitionAuthor,
        definitionCreatedAt: agentData.definitionCreatedAt,
    });

    await agentStorage.saveAgent(storedAgent);
    logger.info(`Installed agent "${agentData.name}" (${slug}) from Nostr event ${event.id}`);

    return storedAgent;
}

/**
 * Fetch an agent definition event from Nostr by ID and install it.
 *
 * @param eventId - The Nostr event ID (with or without "nostr:" prefix)
 * @param customSlug - Optional custom slug (defaults to kebab-case of agent name)
 * @param ndk - Optional NDK instance (uses default if not provided)
 * @returns The saved StoredAgent (with generated private key)
 * @throws AgentNotFoundError if event not found on relays
 * @throws AgentValidationError if event structure is invalid
 */
export async function installAgentFromNostr(
    eventId: string,
    customSlug?: string,
    ndk?: NDK
): Promise<StoredAgent> {
    const ndkInstance = ndk || getNDK();
    const cleanEventId = eventId.startsWith("nostr:") ? eventId.substring(6) : eventId;

    logger.debug(`Fetching agent event ${cleanEventId} from Nostr relays`);
    const agentEvent = await ndkInstance.fetchEvent(cleanEventId, { groupable: false });

    if (!agentEvent) {
        throw new AgentNotFoundError(cleanEventId);
    }

    return installAgentFromNostrEvent(agentEvent, customSlug, ndkInstance);
}
