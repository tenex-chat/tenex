/**
 * EscalationService - Handles escalation agent resolution and auto-adding
 *
 * ## Responsibility
 * Resolves escalation targets from config and ensures they're available in the
 * current project context. Handles the auto-add flow when an escalation agent
 * exists in global storage but isn't part of the current project.
 *
 * ## Architecture
 * This service sits between the tool layer (ask.ts) and the agent infrastructure:
 * - Uses AgentStorage for persistence
 * - Uses AgentRegistry for runtime instances
 * - Uses agent-loader utilities for hydration
 * - Coordinates with ProjectContext for daemon notification
 *
 * ## Usage
 * ```typescript
 * import { resolveEscalationTarget } from "@/services/agents/EscalationService";
 *
 * // In a tool implementation
 * const escalationSlug = await resolveEscalationTarget();
 * if (escalationSlug) {
 *   // Route through escalation agent
 * }
 * ```
 */

import { agentStorage } from "@/agents/AgentStorage";
import { createAgentInstance } from "@/agents/agent-loader";
import { resolveRecipientToPubkey } from "@/services/agents/AgentResolution";
import { config as configService } from "@/services/ConfigService";
import { getProjectContext, isProjectContextInitialized } from "@/services/projects";
import { logger } from "@/utils/logger";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";

export interface EscalationResolutionResult {
    /** The escalation agent's slug */
    slug: string;
    /** Whether the agent was auto-added to the project during this resolution */
    wasAutoAdded: boolean;
}

/**
 * Resolve the escalation agent from config, auto-adding to project if necessary.
 *
 * This function handles the complete escalation target resolution:
 * 1. Reads escalation.agent from config
 * 2. Checks if agent is already in project (fast path)
 * 3. If not, checks global storage and auto-adds to project
 *
 * @returns EscalationResolutionResult if escalation agent is available, null otherwise
 */
export async function resolveEscalationTarget(): Promise<EscalationResolutionResult | null> {
    try {
        const config = configService.getConfig();
        const escalationAgentSlug = config.escalation?.agent;

        if (!escalationAgentSlug) {
            return null;
        }

        // Fast path: check if agent is already in the current project
        const existingPubkey = resolveRecipientToPubkey(escalationAgentSlug);
        if (existingPubkey) {
            return { slug: escalationAgentSlug, wasAutoAdded: false };
        }

        // Agent not in project - attempt auto-add
        return await autoAddEscalationAgent(escalationAgentSlug);
    } catch (error) {
        // Distinguish between expected errors (config not loaded during startup)
        // and unexpected errors that should be investigated
        const errorMessage = error instanceof Error ? error.message : String(error);
        const isConfigNotLoaded = errorMessage.includes("not loaded") || errorMessage.includes("not initialized");

        if (isConfigNotLoaded) {
            // Expected during startup - use debug level
            logger.debug("[EscalationService] Config not loaded yet, skipping escalation resolution");
        } else {
            // Unexpected error - use warn level for investigation
            logger.warn("[EscalationService] Unexpected error resolving escalation target", {
                error,
                errorMessage,
            });
        }
        return null;
    }
}

/**
 * Auto-add an escalation agent from global storage to the current project.
 *
 * This is called when the escalation agent is configured but not part of
 * the current project. It performs:
 * 1. Lookup in global storage by slug
 * 2. Association with current project in storage
 * 3. Instance creation and registry registration
 * 4. Daemon notification for routing updates
 *
 * @param escalationAgentSlug - The slug of the escalation agent to add
 * @returns EscalationResolutionResult if successful, null if agent doesn't exist
 */
async function autoAddEscalationAgent(
    escalationAgentSlug: string
): Promise<EscalationResolutionResult | null> {
    // Check global storage for the agent
    const storedAgent = await agentStorage.getAgentBySlug(escalationAgentSlug);
    if (!storedAgent) {
        logger.warn("[EscalationService] Escalation agent configured but not found in system", {
            escalationAgentSlug,
        });
        return null;
    }

    // Verify project context is available
    if (!isProjectContextInitialized()) {
        logger.warn("[EscalationService] Cannot auto-add escalation agent: project context not initialized");
        return null;
    }

    const projectCtx = getProjectContext();
    const agentRegistry = projectCtx.agentRegistry;
    const projectDTag = agentRegistry.getProjectDTag();

    if (!projectDTag) {
        logger.warn("[EscalationService] Cannot auto-add escalation agent: no project dTag available");
        return null;
    }

    logger.info("[EscalationService] Auto-adding escalation agent to project", {
        escalationAgentSlug,
        agentName: storedAgent.name,
        projectDTag,
    });

    // Get the agent's pubkey from its nsec
    const signer = new NDKPrivateKeySigner(storedAgent.nsec);
    const agentPubkey = signer.pubkey;

    // Add agent to project in storage
    await agentStorage.addAgentToProject(agentPubkey, projectDTag);

    // Reload the agent to get fresh state with the project association
    const freshAgent = await agentStorage.loadAgent(agentPubkey);
    if (!freshAgent) {
        logger.error("[EscalationService] Failed to reload escalation agent after adding to project", {
            escalationAgentSlug,
            agentPubkey: agentPubkey.substring(0, 8),
        });
        return null;
    }

    // Create agent instance and add to registry
    const agentInstance = createAgentInstance(freshAgent, agentRegistry);
    agentRegistry.addAgent(agentInstance);

    // Notify the Daemon about the new agent for routing
    projectCtx.notifyAgentAdded(agentInstance);

    logger.info("[EscalationService] Successfully auto-added escalation agent to project", {
        escalationAgentSlug,
        agentPubkey: agentPubkey.substring(0, 8),
        projectDTag,
    });

    return { slug: escalationAgentSlug, wasAutoAdded: true };
}

/**
 * Check if an escalation agent is configured (without auto-adding).
 *
 * Use this for quick checks where you don't need to trigger the auto-add flow.
 *
 * @returns The escalation agent slug if configured, null otherwise
 */
export function getConfiguredEscalationAgent(): string | null {
    try {
        const config = configService.getConfig();
        return config.escalation?.agent || null;
    } catch {
        return null;
    }
}
