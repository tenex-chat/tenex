import type { ExecutionContext } from "@/agents/execution/types";
// import { getProjectContext } from "@/services/ProjectContext"; // Unused after RAL migration
import type { AISdkTool } from "@/tools/types";
// import { logger } from "@/utils/logger"; // Unused after RAL migration
import { tool } from "ai";
import { z } from "zod";

const askSchema = z.object({
    content: z.string().describe("The question to ask the project manager or human user"),
    suggestions: z
        .array(z.string())
        .optional()
        .describe(
            "Optional suggestions for response. Empty/not provided for open-ended questions, ['Yes', 'No'] for yes/no questions, or any custom list for multiple choice"
        ),
});

type AskInput = z.infer<typeof askSchema>;

// Core implementation
// TODO: This needs to be updated to use RALRegistry (see Task 5 in implementation plan)
async function executeAsk(_input: AskInput, _context: ExecutionContext): Promise<any> {
    throw new Error("Ask tool not yet migrated to RAL system. See Task 5 in experimental-delegation-implementation.md");
}

// AI SDK tool factory
export function createAskTool(context: ExecutionContext): AISdkTool {
    const aiTool = tool({
        description:
            "Ask a question to the project owner and wait for their response. Supports open-ended questions (no suggestions), yes/no questions (suggestions=['Yes', 'No']), or multiple choice questions (custom suggestions list). Use criteria: ONLY use this tool when you need clarification or help FROM A HUMAN, do not use this to ask questions to other agents.",
        inputSchema: askSchema,
        execute: async (input: AskInput) => {
            return await executeAsk(input, context);
        },
    });

    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: ({ content, suggestions }: AskInput) => {
            if (suggestions && suggestions.length > 0) {
                return `Asking: "${content}" [${suggestions.join(", ")}]`;
            }
            return `Asking: "${content}"`;
        },
        enumerable: false,
        configurable: true,
    });

    return aiTool as AISdkTool;
}

/**
 * Ask tool - enables agents to ask questions to the project manager or human user
 *
 * This tool allows an agent to escalate a question and pause execution until receiving a response.
 * It uses the delegation service backend to handle the waiting mechanism, ensuring consistent
 * behavior with other delegation tools.
 *
 * Question Types:
 * - Open-ended: When suggestions is empty or not provided
 * - Yes/No: When suggestions is ['Yes', 'No']
 * - Multiple choice: Any custom list of string suggestions
 *
 * The tool publishes a special Nostr event that includes:
 * - The question as the event content
 * - Each suggestion as a separate ['suggestion', '...'] tag
 * - Proper conversation threading via E/e tags
 *
 * The agent will wait for a response before continuing execution.
 * This is particularly useful when:
 * - The agent needs clarification on requirements
 * - Multiple valid approaches exist and user preference is needed
 * - Critical decisions require human approval
 * - The agent encounters ambiguous instructions
 */
