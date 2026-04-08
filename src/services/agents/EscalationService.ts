/**
 * EscalationService - Handles escalation agent resolution
 *
 * ## Responsibility
 * Resolves escalation targets from config and ensures they're available in the
 * current project context. Escalation agents are a config-driven exception to
 * ordinary kind:31933 membership and may be auto-added to the active project
 * when first needed.
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

import type { AgentRegistry } from "@/agents/AgentRegistry";
import { agentStorage, deriveAgentPubkeyFromNsec } from "@/agents/AgentStorage";
import { createAgentInstance } from "@/agents/agent-loader";
import { resolveRecipientToPubkey } from "@/services/agents/AgentResolution";
import { config as configService } from "@/services/ConfigService";
import { getProjectContext } from "@/services/projects";
import { logger } from "@/utils/logger";

export interface EscalationResolutionResult {
    /** The escalation agent's slug */
    slug: string;
    /** Whether the agent had to be loaded into the current project at runtime */
    wasAutoAdded: boolean;
}

/**
 * Resolve the escalation agent from config, auto-adding it to the current
 * project when needed.
 *
 * This function handles the complete escalation target resolution:
 * 1. Reads escalation.agent from config
 * 2. Checks if agent is already in project
 * 3. If missing, loads it from storage into the current project/registry
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
            return {
                slug: escalationAgentSlug,
                wasAutoAdded: false,
            };
        }

        const projectContext = getProjectContext();
        const projectDTag = projectContext.agentRegistry.getProjectDTag();

        if (!projectDTag?.trim()) {
            logger.warn("[EscalationService] Cannot auto-add escalation agent without project dTag", {
                escalationAgentSlug,
            });
            return null;
        }

        const agent = await ensureEscalationAgentInRegistry(
            projectContext.agentRegistry,
            projectDTag,
            escalationAgentSlug
        );
        if (!agent) {
            return null;
        }

        projectContext.notifyAgentAdded(agent);
        return {
            slug: escalationAgentSlug,
            wasAutoAdded: true,
        };
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

/**
 * Ensure the configured escalation agent is loaded into a specific project registry.
 *
 * Used by callers that need the runtime instance available before ordinary
 * tool-level escalation resolution occurs.
 */
export async function loadEscalationAgentIntoRegistry(
    agentRegistry: AgentRegistry,
    projectDTag: string | undefined
): Promise<boolean> {
    if (!projectDTag?.trim()) return false;

    try {
        const escalationAgentSlug = getConfiguredEscalationAgent();
        if (!escalationAgentSlug) {
            return false;
        }

        const agent = await ensureEscalationAgentInRegistry(
            agentRegistry,
            projectDTag,
            escalationAgentSlug
        );
        return agent !== null;
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const isConfigNotLoaded = errorMessage.includes("not loaded") || errorMessage.includes("not initialized");

        if (isConfigNotLoaded) {
            logger.debug("[EscalationService] Config not loaded yet, skipping proactive escalation load");
        } else {
            logger.warn("[EscalationService] Failed to load escalation agent into registry", {
                projectDTag,
                error: errorMessage,
            });
        }
        return false;
    }
}

async function ensureEscalationAgentInRegistry(
    agentRegistry: AgentRegistry,
    projectDTag: string,
    escalationAgentSlug: string
) {
    const existingAgent = agentRegistry.getAgent(escalationAgentSlug);
    if (existingAgent) {
        return existingAgent;
    }

    const storedAgent = await agentStorage.getAgentBySlug(escalationAgentSlug);
    if (!storedAgent) {
        logger.warn("[EscalationService] Escalation agent not found in storage", {
            escalationAgentSlug,
            projectDTag,
        });
        return null;
    }

    const escalationPubkey = deriveAgentPubkeyFromNsec(storedAgent.nsec);
    await agentStorage.addAgentToProject(escalationPubkey, projectDTag);

    const reloadedAgent = await agentStorage.loadAgent(escalationPubkey);
    if (!reloadedAgent) {
        logger.warn("[EscalationService] Escalation agent could not be reloaded after project assignment", {
            escalationAgentSlug,
            projectDTag,
        });
        return null;
    }

    const instance = await createAgentInstance(reloadedAgent, agentRegistry, projectDTag);
    agentRegistry.addAgent(instance);
    logger.info("[EscalationService] Auto-added escalation agent to project", {
        escalationAgentSlug,
        projectDTag,
        agentPubkey: escalationPubkey.substring(0, 8),
    });
    return instance;
}
