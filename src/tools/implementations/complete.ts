import type { Termination } from "../types";
import { success, createToolDefinition } from "../types";
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
export const completeTool = createToolDefinition<z.infer<typeof completeSchema>, Termination>({
    name: "complete",
    description:
        "Signal task completion and return control to the orchestrator for next steps",
    promptFragment: `CRITICAL USAGE INSTRUCTIONS:
- When using complete(), put YOUR ENTIRE RESPONSE inside the tool call
- DO NOT write explanations before/after - everything goes INSIDE complete()
- The response you provide is the ONLY thing the next agent will see

❌ WRONG (response outside the tool):
"I've analyzed the code and found several issues..."
complete("Found issues")

✅ CORRECT (everything inside):
complete("I've analyzed the code and found several issues: 1) Memory leak in UserService 2) SQL injection in search endpoint 3) Missing rate limiting")

WHEN TO USE:
- Task completion (brief is OK): complete("LGTM")
- With findings: complete("Found 3 bugs: [full list here]")
- With a plan: complete("Implementation plan: [entire plan here]")
- After implementation: complete("Implemented: [all changes made]")

REMEMBER:
- Brief responses are fine when appropriate (e.g., "LGTM", "No issues found")
- Complex responses need full details (plans, analyses, implementations)
- Whatever you write in complete() is ALL the next agent sees
- DO NOT add text outside the complete() call - it will be lost`,
    schema: completeSchema,
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
            conversationManager: context.conversationManager,
        });

        // Return success with the completion
        return success(completion);
    },
});
