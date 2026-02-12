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
import { ConversationStore } from "@/conversations/ConversationStore";
import type { DelegationMarker } from "@/conversations/types";

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

        // Get the parent conversation store to insert markers
        const parentStore = ConversationStore.get(conversationId);

        // Insert delegation markers for each completed delegation
        // Markers are expanded lazily when building messages
        if (parentStore) {
            for (const completion of completedDelegations) {
                const marker: DelegationMarker = {
                    delegationConversationId: completion.delegationConversationId,
                    recipientPubkey: completion.recipientPubkey,
                    parentConversationId: conversationId,
                    completedAt: completion.completedAt,
                    status: completion.status,
                    abortReason: completion.status === "aborted" ? completion.abortReason : undefined,
                };
                parentStore.addDelegationMarker(marker, agentPubkey, ralNumber);
            }

            // Save the store after adding markers
            await parentStore.save();
        }

        // Separate counts for telemetry
        const abortedCount = completedDelegations.filter(d => d.status === "aborted").length;
        const successfulCount = completedDelegations.filter(d => d.status !== "aborted").length;

        // Clear completed delegations after inserting markers
        // This prevents re-processing on subsequent executions
        ralRegistry.clearCompletedDelegations(agentPubkey, conversationId, ralNumber);

        span.addEvent("executor.ral_resumed", {
            "ral.number": ralNumber,
            "delegation.completed_count": successfulCount,
            "delegation.aborted_count": abortedCount,
            "delegation.pending_count": pendingDelegations.length,
            "delegation.markers_inserted": completedDelegations.length,
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
