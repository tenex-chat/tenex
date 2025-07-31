import { loadLLMRouter } from "@/llm";
import { logger } from "@/utils/logger";
import { generateRepomixOutput } from "@/utils/repomix";
import { Message } from "multi-llm-ts";
import { z } from "zod";
import type { Tool } from "../types";
import { createZodSchema } from "../types";

const analyzeSchema = z.object({
    prompt: z.string().min(1).describe("The analysis prompt or question about the codebase"),
    targetDirectory: z
        .string()
        .optional()
        .describe(
            "Optional: Specific directory to analyze relative to project root (e.g., 'src/components' or 'packages/web-app'). If not provided, analyzes the entire project."
        ),
});

interface AnalyzeInput {
    prompt: string;
    targetDirectory?: string;
}

interface AnalyzeOutput {
    analysis: string;
    repoSize: number;
}

export const analyze: Tool<AnalyzeInput, AnalyzeOutput> = {
    name: "analyze",
    description:
        "Deeply analyze a topic or question, GREAT for reasoning and performing detailed reviews of work that was done or to validate a plan with a full view of everything involved. Can analyze the entire project or focus on a specific directory for more targeted analysis in monorepos.",

    parameters: createZodSchema(analyzeSchema),

    execute: async (input, context) => {
        const { prompt, targetDirectory } = input.value;

        logger.info("Running analyze tool", { prompt, targetDirectory });

        // Publish custom typing indicator
        try {
            await context.publisher.publishTypingIndicator("start");
        } catch (error) {
            logger.warn("Failed to publish typing indicator", { error });
        }

        let repomixResult;
        try {
            repomixResult = await generateRepomixOutput(context.projectPath, targetDirectory);
        } catch (error) {
            return {
                ok: false,
                error: {
                    kind: "execution" as const,
                    tool: "analyze",
                    message: `Failed to generate repomix output: ${error instanceof Error ? error.message : String(error)}`,
                    cause: error,
                },
            };
        }

        try {
            // Prepare the prompt for the LLM
            const analysisPrompt = `You are analyzing a ${targetDirectory ? `specific directory (${targetDirectory})` : "complete"} codebase. Here is the ${targetDirectory ? "directory" : "repository"} content in XML format from repomix:

<repository>
${repomixResult.content}
</repository>

Based on this ${targetDirectory ? "directory" : "codebase"}, please answer the following:

${prompt}

Provide a clear, structured response focused on the specific question asked.`;

            // Call the LLM with the analyze-specific configuration
            const llmRouter = await loadLLMRouter(context.projectPath);
            const userMessage = new Message("user", analysisPrompt);
            const response = await llmRouter.complete({
                messages: [userMessage],
                options: {
                    temperature: 0.3,
                    maxTokens: 4000,
                    configName: "defaults.analyze",
                },
            });

            logger.info("Analysis completed successfully");

            // Stop typing indicator
            try {
                await context.publisher.publishTypingIndicator("stop");
            } catch (error) {
                logger.warn("Failed to stop typing indicator", { error });
            }

            return {
                ok: true,
                value: {
                    analysis: response.content || "",
                    repoSize: repomixResult.size,
                },
            };
        } catch (error) {
            logger.error("Analyze tool failed", { error });

            // Stop typing indicator on error
            try {
                await context.publisher.publishTypingIndicator("stop");
            } catch (error) {
                logger.warn("Failed to stop typing indicator", { error });
            }

            return {
                ok: false,
                error: {
                    kind: "execution" as const,
                    tool: "analyze",
                    message: error instanceof Error ? error.message : String(error),
                    cause: error,
                },
            };
        } finally {
            repomixResult.cleanup();
        }
    },
};
