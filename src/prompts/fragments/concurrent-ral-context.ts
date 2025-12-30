import type { PromptFragment } from "../core/types";

/**
 * Tool availability information for a RAL
 */
export interface RALToolAvailability {
    ralNumber: number;
    canAbort: boolean;
    abortReason?: string;
}

/**
 * Summary of a RAL for building context
 */
interface RALContextSummary {
    ralNumber: number;
    isStreaming: boolean;
    hasPendingDelegations: boolean;
    currentTool?: string;
    pendingDelegations: Array<{ recipientSlug?: string; eventId: string }>;
    createdAt: number;
}

interface ConcurrentRALContextArgs {
    otherRALs: RALContextSummary[];
    currentRALNumber: number;
    toolAvailability: RALToolAvailability[];
}

/**
 * Build the RAL descriptions section
 */
function buildRALDescriptions(rals: RALContextSummary[]): string {
    return rals.map(ral => {
        const status = ral.isStreaming ? "actively streaming" :
            ral.hasPendingDelegations ? "waiting on delegations" : "idle";

        const ageMinutes = Math.round((Date.now() - ral.createdAt) / 60000);

        let delegationInfo = "";
        if (ral.pendingDelegations.length > 0) {
            const delegationList = ral.pendingDelegations
                .map(d => `${d.recipientSlug || "agent"} (event_id: ${d.eventId.substring(0, 8)}...)`)
                .join("\n    ");
            delegationInfo = `\n  Pending delegations:\n    ${delegationList}`;
        }

        return `RAL #${ral.ralNumber} (${status}, started ${ageMinutes}m ago):
  Current tool: ${ral.currentTool || "none"}${delegationInfo}`;
    }).join("\n\n");
}

/**
 * Build the tool instructions section based on availability
 */
function buildToolInstructions(toolAvailability: RALToolAvailability[]): string {
    const abortableRALs = toolAvailability.filter(t => t.canAbort);
    const nonAbortableRALs = toolAvailability.filter(t => !t.canAbort);

    let toolInstructions = `Available tools for coordination:
- ral_inject(ral_number, message): Send an instruction to that RAL (it will see it when it next processes)`;

    if (abortableRALs.length > 0) {
        toolInstructions += `
- ral_abort(ral_number): Immediately stop a RAL (available for: ${abortableRALs.map(t => `#${t.ralNumber}`).join(", ")})`;
    }

    if (nonAbortableRALs.length > 0) {
        const reasons = nonAbortableRALs.map(t => `RAL #${t.ralNumber}: ${t.abortReason}`).join("\n  ");
        toolInstructions += `

Note: Some RALs cannot be aborted directly:
  ${reasons}`;
    }

    return toolInstructions;
}

/**
 * Fragment for concurrent RAL context
 * Applied when an agent needs to be aware of other active RALs in the same conversation.
 */
export const concurrentRALContextFragment: PromptFragment<ConcurrentRALContextArgs> = {
    id: "concurrent-ral-context",
    priority: 90, // High priority for coordination context
    template: ({ otherRALs, currentRALNumber, toolAvailability }) => {
        if (otherRALs.length === 0) return "";

        const ralDescriptions = buildRALDescriptions(otherRALs);
        const toolInstructions = buildToolInstructions(toolAvailability);

        return `
CONCURRENT EXECUTION CONTEXT:
YOU ARE RAL #${currentRALNumber} - a NEW execution that just started.
You are NOT any of the other RALs listed below. They are PAUSED waiting for YOUR decision.

IMPORTANT: All RALs in this conversation share the SAME conversation history.
The paused RALs have already seen all prior messages (including any instructions, constraints, or context from earlier in the conversation).
Only inject NEW information that occurred AFTER the paused RAL started - do NOT repeat information from the shared conversation history.

Other active executions in this conversation (currently PAUSED):

${ralDescriptions}

${toolInstructions}

CRITICAL: You must coordinate with paused RALs before proceeding:

1. If the user's NEW request CONFLICTS with or CHANGES what a paused RAL is doing:
   → Use ral_inject to tell that RAL about the NEW user instruction only
   → Do NOT repeat instructions or constraints that were in the original conversation - they already have those
   → Example: User says "write jokes instead" while RAL #1 is writing poems
   → Call: ral_inject(1, "STOP. User changed request: write jokes instead of poems.")

2. If the user wants to CANCEL a paused RAL entirely:
   → Use ral_abort if available, OR ral_inject with stop instruction if it has delegations

3. If the user's request is UNRELATED to the paused RALs:
   → Proceed with your own work (the paused RALs will resume automatically)

The paused RALs will resume after you make your first tool call. Decide NOW.
`;
    },
    validateArgs: (args): args is ConcurrentRALContextArgs => {
        const a = args as Record<string, unknown>;
        return Array.isArray(a.otherRALs) &&
            typeof a.currentRALNumber === "number" &&
            Array.isArray(a.toolAvailability);
    },
    expectedArgs: "{ otherRALs: RALContextSummary[], currentRALNumber: number, toolAvailability: RALToolAvailability[] }",
};
