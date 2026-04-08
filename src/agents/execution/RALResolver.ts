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
import type { ProjectDTag } from "@/types/project-ids";

export interface RALResolutionContext {
    agentPubkey: string;
    conversationId: string;
    /** Project d-tag for multi-project isolation in daemon mode */
    projectId: ProjectDTag;
    triggeringEventId: string;
    span: Span;
    /**
     * RAL number pre-claimed by the dispatcher (via
     * `RALRegistry.tryAcquireResumptionClaim`) for this execution. When set,
     * `resolveRAL` MUST resume this specific RAL rather than independently
     * re-running discovery via `findResumableRAL`/`findRALWithInjections`.
     *
     * This closes a second race: without threading the claimed ralNumber,
     * `findResumableRAL` could return a different RAL than the one the
     * dispatcher observed via `getState` (which returns the highest-numbered
     * entry) — because `findResumableRAL` returns the first entry with
     * completed delegations. Different indices mean different RALs in
     * pathological cases. The claim is on the entry returned by `getState`;
     * that exact entry is what must be resumed.
     */
    preferredRalNumber?: number;
}

export interface RALResolutionResult {
    ralNumber: number;
    isResumption: boolean;
    /** Delegation markers that need to be published to Nostr */
    markersToPublish?: Array<{
        delegationConversationId: string;
        recipientPubkey: string;
        parentConversationId: string;
        status: "completed" | "aborted";
        completedAt: number;
        abortReason?: string;
    }>;
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
    const { agentPubkey, conversationId, projectId, triggeringEventId, span, preferredRalNumber } = ctx;
    const ralRegistry = RALRegistry.getInstance();

    // If the dispatcher pre-claimed a specific RAL for us, resume that exact
    // entry. This is the serialization guarantee: the claim was taken on the
    // RAL returned by `getState` (highest-numbered), and that RAL is what
    // must be resumed — not whatever `findResumableRAL` happens to find,
    // which uses first-match semantics and can pick a different entry.
    const preferredRal = preferredRalNumber !== undefined
        ? ralRegistry.getRAL(agentPubkey, conversationId, preferredRalNumber)
        : undefined;

    // When a preferred RAL was claimed, pin discovery to that exact entry:
    // route it through the resumable branch if it has completed delegations
    // (so markers get processed), otherwise through the injection branch.
    // The claim itself is sufficient reason to use the preferred RAL even
    // if it has no outstanding work — the dispatcher has already queued the
    // triggering message onto it, so the create-new-RAL path is never taken.
    const resumableRal = preferredRal
        ? (ralRegistry.getConversationCompletedDelegations(agentPubkey, conversationId, preferredRal.ralNumber).length > 0
            ? preferredRal
            : undefined)
        : ralRegistry.findResumableRAL(agentPubkey, conversationId);

    const injectionRal = !resumableRal
        ? (preferredRal ?? ralRegistry.findRALWithInjections(agentPubkey, conversationId))
        : undefined;

    let ralNumber: number;
    let isResumption = false;
    const markersToPublish: Array<{
        delegationConversationId: string;
        recipientPubkey: string;
        parentConversationId: string;
        status: "completed" | "aborted";
        completedAt: number;
        abortReason?: string;
    }> = [];

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

        // Get the parent conversation store to update/insert markers
        const parentStore = ConversationStore.get(conversationId);

        // Update delegation markers for each completed delegation (or create if not found)
        // Markers are expanded lazily when building messages
        if (parentStore) {
            for (const completion of completedDelegations) {
                // Try to update existing pending marker first
                const updated = parentStore.updateDelegationMarker(
                    completion.delegationConversationId,
                    {
                        status: completion.status,
                        completedAt: completion.completedAt,
                        abortReason: completion.status === "aborted" ? completion.abortReason : undefined,
                    }
                );

                // If no pending marker found, create a new one (backward compatibility)
                if (!updated) {
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

                // Collect markers to publish to Nostr
                markersToPublish.push({
                    delegationConversationId: completion.delegationConversationId,
                    recipientPubkey: completion.recipientPubkey,
                    parentConversationId: conversationId,
                    status: completion.status,
                    completedAt: completion.completedAt,
                    abortReason: completion.status === "aborted" ? completion.abortReason : undefined,
                });
            }

            // Save the store after adding/updating markers
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

    return {
        ralNumber,
        isResumption,
        markersToPublish: markersToPublish.length > 0 ? markersToPublish : undefined,
    };
}
