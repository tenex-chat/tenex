import type { Tool, Termination } from "../types";
import { success, createZodSchema } from "../types";
import { z } from "zod";
import { handleAgentCompletion } from "@/agents/execution/completionHandler";

const completeSchema = z.object({
    response: z
        .string()
        .describe(
            "Your main answer or a detailed report of what was accomplished and the results achieved."
        ),
    summary: z
        .string()
        .optional()
        .describe(
            "Comprehensive summary of work done for the orchestrator's context (if different from response)"
        ),
});

/**
 * Complete tool - signals task completion and returns control to orchestrator
 * 
 * IMPORTANT: This tool ALWAYS routes to the orchestrator, regardless of who invoked you.
 * Use this when:
 * - You've completed your assigned task
 * - You need the orchestrator to decide next steps or phase transitions
 * - You've gathered enough information to move forward (e.g., requirements are clear)
 * 
 * DO NOT use this for conversational responses - just respond normally for those.
 * YOUR JOB IS NOT DONE UNTIL YOU EXPLICITLY USE THIS TOOL
 */
export const completeTool: Tool<
    {
        response: string;
        summary?: string;
    },
    Termination
> = {
    name: "complete",
    description:
        "Signal task completion and return control to the orchestrator for next steps",
    promptFragment: `- Use this tool to signal task completion and return control to the orchestrator
- During CHAT phase: Use when requirements are clear and ready for next phase
- During other phases: Use when your assigned task is complete
- Include a clear summary of what was accomplished or learned
- DO NOT use this for conversational exchanges - just respond normally
- Example in CHAT: complete("User wants to add authentication with OAuth providers")
- Example in EXECUTE: complete("Implemented OAuth with Google and GitHub providers")`,

    parameters: createZodSchema(completeSchema),

    execute: async (input, context) => {
        const { response, summary } = input.value;

        // Use the shared completion handler
        const completion = await handleAgentCompletion({
            response,
            summary,
            agent: context.agent,
            conversationId: context.conversationId,
            publisher: context.publisher,
            triggeringEvent: context.triggeringEvent,
        });

        // Return success with the completion
        return success(completion);
    },
};
