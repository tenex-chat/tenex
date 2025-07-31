import { logger } from "@/utils/logger";
import type { Tool, Termination } from "../types";
import { success, failure, createZodSchema } from "../types";
import { z } from "zod";

const endConversationSchema = z.object({
    response: z
        .string()
        .describe("Final response to the user summarizing the conversation outcome"),
    summary: z
        .string()
        .optional()
        .describe("Comprehensive summary of the entire conversation (if different from response)"),
});

/**
 * End conversation tool - orchestrator-only tool to conclude conversations
 * Returns final response to the user
 */
export const endConversationTool: Tool<
    {
        response: string;
        summary?: string;
    },
    Termination
> = {
    name: "end_conversation",
    description: "Conclude the conversation and return final response to the user",
    promptFragment: `- Use end_conversation() ONLY when ALL necessary phases are complete
- Ends the conversation permanently with the user
- Include final summary of the entire conversation`,

    parameters: createZodSchema(endConversationSchema),

    execute: async (input, context) => {
        const { response, summary } = input.value;

        // Runtime check for orchestrator
        if (!context.agent.isOrchestrator) {
            return failure({
                kind: "execution",
                tool: "end_conversation",
                message: "Only orchestrator can end conversations",
            });
        }

        logger.info("📬 Orchestrator concluding conversation", {
            tool: "end_conversation",
            conversationId: context.conversationId,
        });

        // Publish the final event directly
        await context.publisher.publishResponse({
            content: response,
            completeMetadata: {
                type: "end_conversation",
                result: {
                    response,
                    summary: summary || response,
                    success: true,
                },
            },
        });

        logger.info("End conversation published final event");

        // Log the completion
        logger.info("✅ Conversation concluded", {
            tool: "end_conversation",
            agent: context.agent.name,
            agentId: context.agent.pubkey,
            returningTo: "user",
            hasResponse: !!response,
            conversationId: context.conversationId,
        });

        // Return properly typed termination
        return success({
            type: "end_conversation",
            result: {
                response,
                summary: summary || response, // Use summary if provided, otherwise use response
                success: true, // Can add logic to determine success based on context
            },
        });
    },
};
