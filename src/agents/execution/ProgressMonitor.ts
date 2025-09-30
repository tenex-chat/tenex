import type { ToolCall } from "@/agents/types";
import { logger } from "@/utils/logger";
import type { LanguageModel } from "ai";
import { generateText } from "ai";

export class ProgressMonitor {
    private stepCount = 0;
    private readonly REVIEW_THRESHOLD = 50;

    constructor(private readonly reviewModel: LanguageModel) {}

    async check(toolCalls: ToolCall[]): Promise<boolean> {
        this.stepCount++;

        if (this.stepCount < this.REVIEW_THRESHOLD) {
            return true;
        }

        this.stepCount = 0;

        try {
            const toolCallSummary = toolCalls.map((tc, i) => 
                `${i + 1}. ${tc.tool}`
            ).join('\n');

            const result = await generateText({
                model: this.reviewModel,
                messages: [{
                    role: 'user',
                    content: `Review these ${toolCalls.length} tool calls. Is the agent making progress or stuck?\n\n${toolCallSummary}\n\nRespond with only "continue" or "stop":`
                }],
                maxOutputTokens: 10,
                temperature: 0
            });

            const shouldContinue = result.text.trim().toLowerCase().includes('continue');

            logger.info("[ProgressMonitor] Review completed", {
                shouldContinue,
                toolCallCount: toolCalls.length
            });

            return shouldContinue;
        } catch (error) {
            logger.error("[ProgressMonitor] Review failed, stopping", {
                error: error instanceof Error ? error.message : String(error)
            });
            return false;
        }
    }
}