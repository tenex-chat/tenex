/**
 * RAL (Request/Agent Lifecycle) resolution for agent execution.
 *
 * Handles the logic of finding or creating a RAL for an execution:
 * - Check for resumable RAL (completed delegations ready to continue)
 * - Check for RAL with queued injections (pairing checkpoint)
 * - Create new RAL if none found
 * - Handle delegation runtime accumulation
 */
import type { Span } from "@opentelemetry/api";
import { RALRegistry } from "@/services/ral";

export interface RALResolutionContext {
    agentPubkey: string;
    conversationId: string;
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
 * 2. Injection RAL - has queued injections (e.g., pairing checkpoint)
 * 3. New RAL - create fresh for this execution
 */
export async function resolveRAL(ctx: RALResolutionContext): Promise<RALResolutionResult> {
    const { agentPubkey, conversationId, triggeringEventId, span } = ctx;
    const ralRegistry = RALRegistry.getInstance();

    // Check for a resumable RAL (one with completed delegations ready to continue)
    const resumableRal = ralRegistry.findResumableRAL(agentPubkey, conversationId);

    // Also check for RAL with queued injections (e.g., pairing checkpoint)
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

        // Calculate MAX llmRuntime from completed delegations
        // For parallel delegations, we take the longest one (critical path)
        const maxDelegationRuntime = completedDelegations.reduce((max, d) => {
            return Math.max(max, d.llmRuntime ?? 0);
        }, 0);

        // Add delegation runtime to parent's accumulated runtime
        if (maxDelegationRuntime > 0) {
            ralRegistry.addToAccumulatedRuntime(
                agentPubkey,
                conversationId,
                ralNumber,
                maxDelegationRuntime
            );
        }

        // Inject delegation results into the RAL as user message
        // Include pending delegations so agent knows what's still outstanding
        const resultsMessage = await ralRegistry.buildDelegationResultsMessage(
            completedDelegations,
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

        // Don't clear completedDelegations here - they'll be cleared when the RAL ends.
        // This allows subsequent executions to see all completions, not just new ones.

        span.addEvent("executor.ral_resumed", {
            "ral.number": ralNumber,
            "delegation.completed_count": completedDelegations.length,
            "delegation.pending_count": pendingDelegations.length,
            "delegation.max_runtime_ms": maxDelegationRuntime,
        });
    } else if (injectionRal) {
        // Resume RAL with queued injections (pairing checkpoint)
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
        // Pass trace context so stop events can be correlated
        const spanContext = span.spanContext();
        ralNumber = ralRegistry.create(
            agentPubkey,
            conversationId,
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
