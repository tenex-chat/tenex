import { toolMessageStorage } from "@/conversations/persistence/ToolMessageStorage";
import { llmServiceFactory } from "@/llm";
import { config } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import { z } from "zod";

export async function executeReadToolResult(eventId: string): Promise<string> {
    const messages = await toolMessageStorage.load(eventId);

    if (!messages) {
        throw new Error(`No tool result found for event ID: ${eventId}`);
    }

    const assistantMessage = messages.find((message) => message.role === "assistant");
    const toolMessage = messages.find((message) => message.role === "tool");

    if (!assistantMessage || !toolMessage) {
        throw new Error(`Invalid tool result format for event ID: ${eventId}`);
    }

    const toolCallContent = Array.isArray(assistantMessage.content)
        ? assistantMessage.content.find((content) => typeof content === "object" && "type" in content && content.type === "tool-call")
        : null;
    const toolResultContent = Array.isArray(toolMessage.content)
        ? toolMessage.content.find((content) => typeof content === "object" && "type" in content && content.type === "tool-result")
        : null;

    if (!toolCallContent || !toolResultContent) {
        throw new Error(`Could not extract tool call/result for event ID: ${eventId}`);
    }

    const toolName = "toolName" in toolCallContent ? toolCallContent.toolName : undefined;
    if (typeof toolName !== "string" || toolName.length === 0) {
        throw new Error(`Missing tool name in tool call for event ID: ${eventId}`);
    }

    const input = "input" in toolCallContent ? toolCallContent.input : {};
    const output = "output" in toolResultContent ? toolResultContent.output : null;

    let outputValue: string;
    if (output && typeof output === "object" && "value" in output) {
        outputValue = String(output.value);
    } else if (typeof output === "string") {
        outputValue = output;
    } else {
        outputValue = JSON.stringify(output, null, 2);
    }

    const inputStr = typeof input === "object" ? JSON.stringify(input, null, 2) : String(input);

    return `Tool: ${toolName}\nEvent ID: ${eventId}\n\n--- Input ---\n${inputStr}\n\n--- Output ---\n${outputValue}`;
}

export async function synthesizeContent(content: string, prompt: string, source: string): Promise<string> {
    const { llms } = await config.loadConfig();
    const configName = llms.summarization || llms.default;

    if (!configName) {
        logger.warn("No LLM configuration available for content synthesis");
        return content;
    }

    const llmConfig = config.getLLMConfig(configName);
    const llmService = llmServiceFactory.createService(llmConfig, {
        agentName: "content-synthesizer",
    });

    const { object: result } = await llmService.generateObject(
        [
            {
                role: "system",
                content: `You are a helpful assistant that analyzes content and provides explanations based on user prompts.

CRITICAL REQUIREMENTS:
1. VERBATIM QUOTES: You MUST include relevant parts of the content verbatim in your response. Quote the exact text that supports your analysis.
2. PRESERVE IDENTIFIERS: All IDs, file paths, function names, variable names, and other technical identifiers must be preserved exactly as they appear.
3. Base your analysis ONLY on what is explicitly present in the content.

FORMAT: Structure your response with:
- Your analysis/explanation
- Verbatim quotes from relevant parts (use quotation marks)
- All referenced identifiers preserved exactly`,
            },
            {
                role: "user",
                content: `Please analyze the following content based on this prompt: "${prompt}"

IMPORTANT: Include verbatim quotes from the relevant parts that support your analysis.

SOURCE: ${source}

CONTENT:
${content}`,
            },
        ],
        z.object({
            explanation: z
                .string()
                .describe(
                    "A detailed explanation based on the user's prompt. MUST include verbatim quotes from relevant content and preserve all important identifiers."
                ),
        })
    );

    logger.info("Content synthesized with prompt", {
        source,
        promptLength: prompt.length,
        contentLength: content.length,
    });

    return result.explanation;
}
