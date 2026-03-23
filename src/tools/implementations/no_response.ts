import { RALRegistry } from "@/services/ral";
import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const noResponseSchema = z.object({});

type NoResponseInput = z.infer<typeof noResponseSchema>;

interface NoResponseOutput {
    success: boolean;
    mode: "silent-complete";
    message: string;
}

async function executeNoResponse(
    _input: NoResponseInput,
    context: ToolExecutionContext
): Promise<NoResponseOutput> {
    const requested = RALRegistry.getInstance().requestSilentCompletion(
        context.agent.pubkey,
        context.conversationId,
        context.ralNumber
    );

    if (!requested) {
        throw new Error("Unable to request silent completion because the active RAL could not be found.");
    }

    logger.info("[no_response] Silent completion requested", {
        agent: context.agent.slug,
        conversationId: context.conversationId,
        ralNumber: context.ralNumber,
    });

    return {
        success: true,
        mode: "silent-complete",
        message:
            "Silent completion requested. This turn ends immediately with no assistant text, acknowledgement, emoji, or filler.",
    };
}

export function createNoResponseTool(context: ToolExecutionContext): AISdkTool {
    const aiTool = tool({
        description:
            "Request a silent completion for this turn. Use ONLY when the latest user message explicitly asks for no reply, including note-to-self or counting-aloud cases where the user does not want acknowledgements or filler. Calling this tool immediately ends the turn with no assistant text.",
        inputSchema: noResponseSchema,
        execute: async (input: NoResponseInput) => {
            return await executeNoResponse(input, context);
        },
    });

    Object.defineProperty(aiTool, "hasSideEffects", {
        value: true,
        enumerable: false,
        configurable: true,
    });

    return aiTool as AISdkTool;
}
