import { success, createToolDefinition } from "../types";
import { z } from "zod";
import type { CompletionIntent } from "@/nostr/AgentEventEncoder";

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
            "Comprehensive summary of work done for the delegating agent's context (if different from response)"
        ),
});

/**
 * Complete tool - signals task completion and returns control to the delegating agent
 * 
 * IMPORTANT: This tool returns control to whoever delegated to you (PM or another agent).
 * Use this when:
 * - You've completed your assigned task
 * - You need to report back with results
 * - You've gathered enough information to move forward (e.g., requirements are clear)
 * 
 * DO NOT use this for conversational responses - just respond normally for those.
 * YOUR JOB IS NOT DONE UNTIL YOU EXPLICITLY USE THIS TOOL
 */
export const completeTool = createToolDefinition<z.infer<typeof completeSchema>, CompletionIntent>({
    name: "complete",
    description:
        "Signal task completion and return control to the delegating agent",
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

        // Simply return the completion intent
        // RAL will handle event creation and publishing
        const intent: CompletionIntent = {
            type: 'completion',
            content: response,
            summary: summary
        };

        // Debug logging
        const { logger } = await import("@/utils/logger");
        logger.info("[complete() tool] Returning completion intent", {
            agent: context.agent.name,
            contentLength: response.length,
            hasSummary: !!summary
        });

        return success(intent);
    },
});
