import type { ExecutionContext } from "@/agents/execution/types";
// import { getNDK } from "@/nostr/ndkClient"; // Unused after RAL migration
import type { AISdkTool } from "@/tools/types";
// import { formatAnyError } from "@/lib/error-formatter"; // Unused after RAL migration
// import { logger } from "@/utils/logger"; // Unused after RAL migration
// import { normalizeNostrIdentifier, parseNostrUser } from "@/utils/nostr-entity-parser"; // Unused after RAL migration
// import { NDKEvent } from "@nostr-dev-kit/ndk"; // Unused after RAL migration
import { tool } from "ai";
import { z } from "zod";

const delegateExternalSchema = z.object({
    content: z.string().describe("The content of the chat message to send"),
    recipient: z.string().describe("The recipient's pubkey or npub (will be p-tagged)"),
    projectId: z
        .string()
        .optional()
        .describe(
            "Optional project event ID (naddr1...) to reference in the message. This should be the project the agent you are delegating TO works on (if you know it)"
        ),
});

type DelegateExternalInput = z.infer<typeof delegateExternalSchema>;

// Core implementation - extracted from existing execute function
// TODO: This needs to be updated to use RALRegistry (see Task 7 in implementation plan)
async function executeDelegateExternal(
    _input: DelegateExternalInput,
    _context: ExecutionContext
): Promise<any> {
    throw new Error("Delegate external tool not yet migrated to RAL system. See Task 7 in experimental-delegation-implementation.md");
}

// AI SDK tool factory
export function createDelegateExternalTool(context: ExecutionContext): AISdkTool {
    const aiTool = tool({
        description: `Delegate a task to an external agent or user and wait for their response. Use this tool only to engage with agents in OTHER projects. If you don't know their pubkey you can use nostr_projects tools.

You can also use this tool to delegate to yourself in the context of a different project by providing your own pubkey along with a projectId. This enables cross-project self-delegation.

When using this tool, provide context to the recipient, introduce yourself and explain you are an agent and the project you are working on. It's important for the recipient to understand where you're coming from.

`,
        inputSchema: delegateExternalSchema,
        execute: async (input: DelegateExternalInput) => {
            return await executeDelegateExternal(input, context);
        },
    });

    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: (args: unknown) => {
            // Defensive: handle cases where args might not be properly typed
            if (!args || typeof args !== "object") {
                return "Delegating to external agent";
            }

            const { recipient, projectId } = args as Partial<DelegateExternalInput>;

            if (!recipient) {
                return "Delegating to external agent";
            }

            let message = `Delegating to external agent ${recipient}`;
            if (projectId) {
                message += ` in project ${projectId}`;
            }
            return message;
        },
        enumerable: false,
        configurable: true,
    });

    return aiTool as AISdkTool;
}
