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
    pendingDelegations: Array<{ recipientSlug?: string; delegationConversationId: string }>;
    createdAt: number;
}

interface ConcurrentRALContextArgs {
    otherRALs: RALContextSummary[];
    currentRALNumber: number;
    toolAvailability: RALToolAvailability[];
    /** Action history for each RAL (tool calls, text output) */
    actionHistory: Map<number, string>;
}

/**
 * Build the RAL descriptions section
 */
function buildRALDescriptions(rals: RALContextSummary[], actionHistory: Map<number, string>): string {
    return rals.map(ral => {
        const status = ral.isStreaming ? "actively streaming" :
            ral.hasPendingDelegations ? "waiting on delegations" : "idle";

        const ageMinutes = Math.round((Date.now() - ral.createdAt) / 60000);

        let delegationInfo = "";
        if (ral.pendingDelegations.length > 0) {
            const delegationList = ral.pendingDelegations
                .map(d => `${d.recipientSlug || "agent"} (conversation_id: ${d.delegationConversationId.substring(0, 8)}...)`)
                .join("\n    ");
            delegationInfo = `\n  Pending delegations:\n    ${delegationList}`;
        }

        const history = actionHistory.get(ral.ralNumber);
        const historySection = history ? `\n  Actions taken:\n${history.split("\n").map(l => `    ${l}`).join("\n")}` : "";

        return `RAL #${ral.ralNumber} (${status}, started ${ageMinutes}m ago):
  Current tool: ${ral.currentTool || "none"}${delegationInfo}${historySection}`;
    }).join("\n\n");
}

/**
 * Build coordination guidance based on what the paused RALs are doing
 */
function buildCoordinationGuidance(otherRALs: RALContextSummary[]): string {
    const ralsWithDelegations = otherRALs.filter(r => r.pendingDelegations.length > 0);
    const ralsWithoutDelegations = otherRALs.filter(r => r.pendingDelegations.length === 0);

    let guidance = "CRITICAL: You must coordinate with paused RALs before proceeding:\n";

    // If there are RALs with delegations, that's the primary case to address
    if (ralsWithDelegations.length > 0) {
        const delegationExamples = ralsWithDelegations.flatMap(r =>
            r.pendingDelegations.map(d => ({
                ralNumber: r.ralNumber,
                recipientSlug: d.recipientSlug || "agent",
                conversationId: d.delegationConversationId
            }))
        );
        const example = delegationExamples[0];

        guidance += `
1. If the user's request CHANGES what a delegated agent is doing:
   → Use delegate_followup to send instructions DIRECTLY to the delegated agent
   → Example: delegate_followup("${example.conversationId.substring(0, 8)}...", "User changed request: ...")
   → This sends your message immediately to ${example.recipientSlug}

2. If the user wants to cancel the delegation entirely:
   → Use ral_abort if available, OR ral_inject to tell RAL #${example.ralNumber} to stop`;
    }

    // If there are RALs without delegations (doing direct work)
    if (ralsWithoutDelegations.length > 0) {
        const example = ralsWithoutDelegations[0];
        const itemNum = ralsWithDelegations.length > 0 ? 3 : 1;

        guidance += `
${itemNum}. If the user's request CHANGES what RAL #${example.ralNumber} is doing directly:
   → Use ral_inject to send the new instruction
   → Example: ral_inject(${example.ralNumber}, "STOP. User changed request: ...")`;
    }

    // Always add the unrelated case
    const lastItemNum = (ralsWithDelegations.length > 0 ? 2 : 0) + (ralsWithoutDelegations.length > 0 ? 1 : 0) + 1;
    guidance += `

${lastItemNum}. If the user's request is UNRELATED to the paused RALs:
   → Proceed with your own work (the paused RALs will resume automatically)`;

    return guidance;
}

/**
 * Build the tool instructions section based on availability
 */
function buildToolInstructions(
    toolAvailability: RALToolAvailability[],
    otherRALs: RALContextSummary[]
): string {
    const abortableRALs = toolAvailability.filter(t => t.canAbort);
    const nonAbortableRALs = toolAvailability.filter(t => !t.canAbort);
    const ralsWithDelegations = otherRALs.filter(r => r.pendingDelegations.length > 0);

    let toolInstructions = `Available tools for coordination:
- ral_inject(ral_number, message): Send an instruction to that RAL (it will see it ONLY when it resumes - NOT during active delegations)`;

    // If any RAL has pending delegations, explain delegate_followup
    if (ralsWithDelegations.length > 0) {
        toolInstructions += `
- delegate_followup(delegation_conversation_id, message): Send a message DIRECTLY to an active delegation (use this to communicate with delegated agents!)`;
    }

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

    // Add important clarification about ral_inject vs delegate_followup
    if (ralsWithDelegations.length > 0) {
        toolInstructions += `

IMPORTANT - ral_inject vs delegate_followup:
- ral_inject sends to the PAUSED RAL in this conversation - it won't see your message until AFTER its delegations complete
- delegate_followup sends DIRECTLY to the delegated agent - use this to modify ongoing delegation work`;
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
    template: ({ otherRALs, currentRALNumber, toolAvailability, actionHistory }) => {
        if (otherRALs.length === 0) return "";

        const ralDescriptions = buildRALDescriptions(otherRALs, actionHistory);
        const toolInstructions = buildToolInstructions(toolAvailability, otherRALs);

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

${buildCoordinationGuidance(otherRALs)}

The paused RALs will resume after you make your first tool call. Decide NOW.
`;
    },
    validateArgs: (args): args is ConcurrentRALContextArgs => {
        const a = args as Record<string, unknown>;
        return Array.isArray(a.otherRALs) &&
            typeof a.currentRALNumber === "number" &&
            Array.isArray(a.toolAvailability) &&
            a.actionHistory instanceof Map;
    },
    expectedArgs: "{ otherRALs: RALContextSummary[], currentRALNumber: number, toolAvailability: RALToolAvailability[], actionHistory: Map<number, string> }",
};
