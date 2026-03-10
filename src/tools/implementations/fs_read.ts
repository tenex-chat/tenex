import {
    createFsReadTool as createPortableFsReadTool,
    type FsReadInput,
} from "ai-sdk-fs-tools";
import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { toolMessageStorage } from "@/conversations/persistence/ToolMessageStorage";
import { llmServiceFactory } from "@/llm";
import { config } from "@/services/ConfigService";
import { attachTranscriptArgs } from "@/tools/utils/transcript-args";
import { logger } from "@/utils/logger";
import { z } from "zod";
import {
    adaptOutsideWorkingDirectoryResult,
    assertAbsolutePath,
    createTenexFsToolsOptions,
    withDescription,
} from "./fs-tool-adapter";

/**
 * Fetch and format a tool execution result by event ID
 */
async function executeReadToolResult(eventId: string): Promise<string> {
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

    const toolName = "toolName" in toolCallContent ? toolCallContent.toolName : "unknown";
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

/**
 * Synthesize content using an LLM based on a prompt
 */
async function synthesizeContent(content: string, prompt: string, source: string): Promise<string> {
    const { llms } = await config.loadConfig();
    const configName = llms.summarization || llms.default;

    if (!configName) {
        logger.warn("No LLM configuration available for content synthesis");
        return content;
    }

    const llmConfig = config.getLLMConfig(configName);
    const llmService = llmServiceFactory.createService(llmConfig, {
        agentName: "content-synthesizer",
        sessionId: `synthesizer-${Date.now()}`,
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

    logger.info("✅ Content synthesized with prompt", {
        source,
        promptLength: prompt.length,
        contentLength: content.length,
    });

    return result.explanation;
}

/**
 * Create an AI SDK tool for reading paths
 */
export function createFsReadTool(context: ToolExecutionContext): AISdkTool {
    const portableTool = createPortableFsReadTool(
        createTenexFsToolsOptions(context, {
            agentsMd: true,
            analyzeContent: ({ content, prompt, source }) => synthesizeContent(content, prompt, source),
            loadToolResult: executeReadToolResult,
        })
    );
    const executeBase = portableTool.execute.bind(portableTool);
    const toolInstance = portableTool as unknown as AISdkTool<FsReadInput>;

    Object.defineProperty(toolInstance, "execute", {
        value: async (input: FsReadInput) => {
            const normalizedInput = withDescription(input);

            logger.info("Reading file or tool result", {
                path: normalizedInput.path || undefined,
                description: normalizedInput.description,
                tool: normalizedInput.tool || undefined,
                hasPrompt: !!normalizedInput.prompt,
            });

            if (normalizedInput.path) {
                assertAbsolutePath(normalizedInput.path);
            }

            const result = await executeBase(normalizedInput);

            if (normalizedInput.path) {
                return adaptOutsideWorkingDirectoryResult(
                    result,
                    normalizedInput.path,
                    context.workingDirectory
                );
            }

            return result;
        },
        enumerable: true,
        configurable: true,
        writable: true,
    });

    Object.defineProperty(toolInstance, "getHumanReadableContent", {
        value: ({ path, description, tool: toolEventId, prompt }: FsReadInput) => {
            const action = prompt ? "Analyzing" : "Reading";
            if (toolEventId) {
                return `${action} tool result ${toolEventId.substring(0, 16)}... (${description ?? "no description"})`;
            }
            return `${action} ${path} (${description ?? "no description"})`;
        },
        enumerable: false,
        configurable: true,
    });

    attachTranscriptArgs(toolInstance as AISdkTool, [{ key: "path", attribute: "file_path" }]);
    return toolInstance as AISdkTool;
}
