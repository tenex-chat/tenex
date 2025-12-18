import type { ExecutionContext } from "@/agents/execution/types";
import type { AISdkTool } from "@/tools/types";
// import { resolveRecipientToPubkey } from "@/utils/agent-resolution"; // Unused after RAL migration
// import { logger } from "@/utils/logger"; // Unused after RAL migration
import { tool } from "ai";
import { z } from "zod";

const delegateFollowupSchema = z.object({
    recipient: z
        .string()
        .describe(
            "Agent slug (e.g., 'architect'), name (e.g., 'Architect'), npub, or hex pubkey of the agent you delegated to"
        ),
    message: z.string().describe("Your follow-up question or clarification request"),
});

type DelegateFollowupInput = z.infer<typeof delegateFollowupSchema>;

// Core implementation
// TODO: This needs to be updated to use RALRegistry (see Task 6 in implementation plan)
async function executeDelegateFollowup(
    _input: DelegateFollowupInput,
    _context: ExecutionContext
): Promise<any> {
    throw new Error("Delegate followup tool not yet migrated to RAL system. See Task 6 in experimental-delegation-implementation.md");
}

// AI SDK tool factory
export function createDelegateFollowupTool(context: ExecutionContext): AISdkTool {
    const aiTool = tool({
        description:
            "Send a follow-up question to an agent you previously delegated to. Use after delegate to ask clarifying questions about their response. The tool will wait for their response before continuing.",
        inputSchema: delegateFollowupSchema,
        execute: async (input: DelegateFollowupInput) => {
            return await executeDelegateFollowup(input, context);
        },
    });

    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: () => "Sending follow-up question",
        enumerable: false,
        configurable: true,
    });

    return aiTool as AISdkTool;
}

/**
 * Delegate Follow-up tool - enables multi-turn conversations during delegations
 *
 * This tool allows an agent to ask follow-up questions after receiving a delegation response:
 * 1. Takes a recipient parameter to identify which delegation to follow up on
 * 2. Looks up the delegation in DelegationRegistry using agent+conversation+recipient
 * 3. Creates a reply to the stored response event
 * 4. Waits synchronously for the response (just like delegate)
 * 5. Can be chained for multiple follow-ups
 *
 * Example flow:
 * - Agent1 delegates to architect: "Design auth system"
 * - Architect responds: "I suggest OAuth2..."
 * - Agent1 uses delegate_followup(recipient: "architect", message: "What about refresh tokens?")
 * - Architect responds: "Use rotating tokens with 7-day expiry"
 * - Agent1 can continue with more follow-ups or proceed
 */
