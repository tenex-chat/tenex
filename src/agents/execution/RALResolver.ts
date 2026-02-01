/**
 * RAL (Request/Agent Lifecycle) resolution for agent execution.
 *
 * Handles the logic of finding or creating a RAL for an execution:
 * - Check for resumable RAL (completed delegations ready to continue)
 * - Check for RAL with queued injections
 * - Create new RAL if none found
 */
import type { Span } from "@opentelemetry/api";
import { RALRegistry } from "@/services/ral";

export interface RALResolutionContext {
    agentPubkey: string;
    conversationId: string;
    /** Project ID for multi-project isolation in daemon mode */
    projectId: string;
    triggeringEventId: string;
    span: Span;
}

export interface RALResolutionResult {
    ralNumber: number;
    isResumption: boolean;
}

/**
 * Resolve which RAL to use for this execution.
 *
 * Priority:
 * 1. Resumable RAL - has completed delegations ready to continue
 * 2. Injection RAL - has queued injections
 * 3. New RAL - create fresh for this execution
 */
export async function resolveRAL(ctx: RALResolutionContext): Promise<RALResolutionResult> {
    const { agentPubkey, conversationId, projectId, triggeringEventId, span } = ctx;
    const ralRegistry = RALRegistry.getInstance();

    // Check for a resumable RAL (one with completed delegations ready to continue)
    const resumableRal = ralRegistry.findResumableRAL(agentPubkey, conversationId);

    // Also check for RAL with queued injections
    const injectionRal = !resumableRal
        ? ralRegistry.findRALWithInjections(agentPubkey, conversationId)
        : undefined;

    let ralNumber: number;
    let isResumption = false;

    if (resumableRal) {
        // Resume existing RAL instead of creating a new one
        ralNumber = resumableRal.ralNumber;
        isResumption = true;

        // Get delegations from conversation storage
        const completedDelegations = ralRegistry.getConversationCompletedDelegations(
            agentPubkey, conversationId, resumableRal.ralNumber
        );
        const pendingDelegations = ralRegistry.getConversationPendingDelegations(
            agentPubkey, conversationId, resumableRal.ralNumber
        );

        // Separate aborted and completed delegations
        const abortedDelegations = completedDelegations.filter(d => d.status === "aborted");
        const successfulDelegations = completedDelegations.filter(d => d.status !== "aborted");

        // Build messages for aborted delegations
        // Only include pending list if there are NO successful delegations (to avoid duplication)
        if (abortedDelegations.length > 0) {
            const includePendingInAbort = successfulDelegations.length === 0;
            const abortMessage = await ralRegistry.buildDelegationAbortMessage(
                abortedDelegations,
                includePendingInAbort ? pendingDelegations : []
            );
            if (abortMessage) {
                ralRegistry.queueUserMessage(
                    agentPubkey,
                    conversationId,
                    ralNumber,
                    abortMessage
                );
            }
        }

        // Build messages for successfully completed delegations (always include pending list)
        if (successfulDelegations.length > 0) {
            const resultsMessage = await ralRegistry.buildDelegationResultsMessage(
                successfulDelegations,
                pendingDelegations
            );
            if (resultsMessage) {
                ralRegistry.queueUserMessage(
                    agentPubkey,
                    conversationId,
                    ralNumber,
                    resultsMessage
                );
            }
        }

        // Don't clear completedDelegations here - they'll be cleared when the RAL ends.
        // This allows subsequent executions to see all completions, not just new ones.

        span.addEvent("executor.ral_resumed", {
            "ral.number": ralNumber,
            "delegation.completed_count": successfulDelegations.length,
            "delegation.aborted_count": abortedDelegations.length,
            "delegation.pending_count": pendingDelegations.length,
        });
    } else if (injectionRal) {
        // Resume RAL with queued injections
        ralNumber = injectionRal.ralNumber;
        isResumption = true;

        const injectionRalPending = ralRegistry.getConversationPendingDelegations(
            agentPubkey, conversationId, injectionRal.ralNumber
        );
        span.addEvent("executor.ral_resumed_for_injection", {
            "ral.number": ralNumber,
            "injection.count": injectionRal.queuedInjections.length,
            pending_delegations: injectionRalPending.length,
        });
    } else {
        // Create a new RAL for this execution
        // Pass projectId for multi-project isolation and trace context for stop event correlation
        const spanContext = span.spanContext();
        ralNumber = ralRegistry.create(
            agentPubkey,
            conversationId,
            projectId,
            triggeringEventId,
            { traceId: spanContext.traceId, spanId: spanContext.spanId }
        );
    }

    span.setAttributes({
        "ral.number": ralNumber,
        "ral.is_resumption": isResumption,
    });

    return { ralNumber, isResumption };
}
