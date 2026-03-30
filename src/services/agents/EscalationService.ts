/**
 * EscalationService - Handles escalation agent resolution
 *
 * ## Responsibility
 * Resolves escalation targets from config and ensures they're already available
 * in the current project context. Project membership is authoritative in the
 * project's kind:31933 lowercase `p` tags.
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

import { resolveRecipientToPubkey } from "@/services/agents/AgentResolution";
import { config as configService } from "@/services/ConfigService";
import { logger } from "@/utils/logger";

export interface EscalationResolutionResult {
    /** The escalation agent's slug */
    slug: string;
}

/**
 * Resolve the escalation agent from config if it is already assigned to the project.
 *
 * This function handles the complete escalation target resolution:
 * 1. Reads escalation.agent from config
 * 2. Checks if agent is already in project
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
            return { slug: escalationAgentSlug };
        }

        logger.warn("[EscalationService] Escalation agent is not assigned to this project", {
            escalationAgentSlug,
        });
        return null;
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
 * Project membership is authoritative in kind:31933, so escalation agents are
 * never auto-added during project startup.
 *
 * Retained as a compatibility shim for callers that still invoke this helper.
 */
export async function loadEscalationAgentIntoRegistry(
    _agentRegistry: unknown,
    projectDTag: string | undefined
): Promise<boolean> {
    if (!projectDTag?.trim()) return false;
    logger.debug("[EscalationService] Skipping proactive escalation load; project membership is authoritative", {
        projectDTag,
    });
    return false;
}
