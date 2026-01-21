import { readFile, readdir, stat } from "node:fs/promises";
import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { toolMessageStorage } from "@/conversations/persistence/ToolMessageStorage";
import { isPathWithinDirectory, isWithinAgentHome } from "@/lib/agent-home";
import { formatAnyError } from "@/lib/error-formatter";
import { llmServiceFactory } from "@/llm";
import { config } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const DEFAULT_LINE_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000;

const readPathSchema = z.object({
    path: z
        .string()
        .optional()
        .describe("The absolute path to the file or directory to read. Required unless using 'tool' parameter."),
    description: z
        .string()
        .min(1, "Description is required and cannot be empty")
        .describe(
            "REQUIRED: A clear, concise description of why you're reading this file (5-10 words). Helps provide human-readable context for the operation."
        ),
    offset: z
        .number()
        .min(1)
        .optional()
        .describe("Line number to start reading from (1-based). If omitted, starts from line 1."),
    limit: z
        .number()
        .min(1)
        .optional()
        .describe(`Maximum number of lines to read. Defaults to ${DEFAULT_LINE_LIMIT}.`),
    allowOutsideWorkingDirectory: z
        .boolean()
        .optional()
        .describe("Set to true to read files outside the working directory. Required when path is not within the project."),
    tool: z
        .string()
        .optional()
        .describe("Event ID of a tool execution to read its result. When provided, 'path' is ignored and the tool's output is returned. Useful for retrieving truncated tool results."),
    prompt: z
        .string()
        .optional()
        .describe("Optional prompt to analyze the content. When provided, the content (file or tool result) will be processed through an LLM which will provide an explanation based on this prompt. Useful for extracting specific information or getting a summary."),
});

/**
 * Fetch and format a tool execution result by event ID
 */
async function executeReadToolResult(eventId: string): Promise<string> {
    const messages = await toolMessageStorage.load(eventId);

    if (!messages) {
        throw new Error(`No tool result found for event ID: ${eventId}`);
    }

    // Extract tool call and result from messages
    // Format: [{ role: "assistant", content: [{ type: "tool-call", ... }] }, { role: "tool", content: [{ type: "tool-result", ... }] }]
    const assistantMessage = messages.find((m) => m.role === "assistant");
    const toolMessage = messages.find((m) => m.role === "tool");

    if (!assistantMessage || !toolMessage) {
        throw new Error(`Invalid tool result format for event ID: ${eventId}`);
    }

    // Extract tool call details
    const toolCallContent = Array.isArray(assistantMessage.content)
        ? assistantMessage.content.find((c) => typeof c === "object" && "type" in c && c.type === "tool-call")
        : null;

    // Extract tool result
    const toolResultContent = Array.isArray(toolMessage.content)
        ? toolMessage.content.find((c) => typeof c === "object" && "type" in c && c.type === "tool-result")
        : null;

    if (!toolCallContent || !toolResultContent) {
        throw new Error(`Could not extract tool call/result for event ID: ${eventId}`);
    }

    // Format output
    const toolName = "toolName" in toolCallContent ? toolCallContent.toolName : "unknown";
    const input = "input" in toolCallContent ? toolCallContent.input : {};
    const output = "output" in toolResultContent ? toolResultContent.output : null;

    // Extract the actual output value
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
 * Core implementation of the fs_read functionality
 */
async function executeFsRead(
    path: string,
    workingDirectory: string,
    agentPubkey: string,
    offset?: number,
    limit?: number,
    allowOutsideWorkingDirectory?: boolean,
): Promise<string> {
    if (!path.startsWith("/")) {
        throw new Error(`Path must be absolute, got: ${path}`);
    }

    // Check if path is within working directory (using secure path normalization)
    const isWithinWorkDir = isPathWithinDirectory(path, workingDirectory);

    // Always allow access to agent's home directory without requiring allowOutsideWorkingDirectory
    const isInAgentHome = isWithinAgentHome(path, agentPubkey);

    if (!isWithinWorkDir && !isInAgentHome && !allowOutsideWorkingDirectory) {
        return `Path "${path}" is outside your working directory "${workingDirectory}". If this was intentional, retry with allowOutsideWorkingDirectory: true`;
    }

    const stats = await stat(path);

    if (stats.isDirectory()) {
        const files = await readdir(path);
        const fileList = files.map((file) => `  - ${file}`).join("\n");
        return `Directory listing for ${path}:\n${fileList}\n\nTo read a specific file, please specify the full path to the file.`;
    }

    const rawContent = await readFile(path, "utf-8");
    const lines = rawContent.split("\n");
    const totalLines = lines.length;

    // 1-based offset, default to line 1
    const startLine = offset ?? 1;
    const startIndex = startLine - 1;

    if (startIndex >= totalLines) {
        return `File has only ${totalLines} line(s), but offset ${offset} was requested.`;
    }

    // Apply limit (default to DEFAULT_LINE_LIMIT)
    const effectiveLimit = limit ?? DEFAULT_LINE_LIMIT;
    const endIndex = Math.min(startIndex + effectiveLimit, totalLines);
    const selectedLines = lines.slice(startIndex, endIndex);

    // Format with line numbers and truncate long lines
    const numberedLines = selectedLines
        .map((line, idx) => {
            const lineNum = startIndex + idx + 1;
            const truncatedLine = line.length > MAX_LINE_LENGTH
                ? line.slice(0, MAX_LINE_LENGTH) + "..."
                : line;
            return `${lineNum.toString().padStart(6)}\t${truncatedLine}`;
        })
        .join("\n");

    // Add info about truncation if we didn't read the whole file
    const remainingLines = totalLines - endIndex;
    if (remainingLines > 0) {
        return `${numberedLines}\n\n[Showing lines ${startLine}-${endIndex} of ${totalLines}. ${remainingLines} more lines available. Use offset=${endIndex + 1} to continue.]`;
    }

    return numberedLines;
}

/**
 * Synthesize content using an LLM based on a prompt
 */
async function synthesizeContent(content: string, prompt: string, source: string): Promise<string> {
    // Get LLM configuration - use summarization config if set, otherwise default
    const { llms } = await config.loadConfig();
    const configName = llms.summarization || llms.default;

    if (!configName) {
        logger.warn("No LLM configuration available for content synthesis");
        return content;
    }

    const llmConfig = config.getLLMConfig(configName);

    // Create LLM service
    const llmService = llmServiceFactory.createService(llmConfig, {
        agentName: "content-synthesizer",
        sessionId: `synthesizer-${Date.now()}`,
    });

    // Generate synthesis using the LLM
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
    const toolInstance = tool({
        description:
            `Read a file, directory, or tool result. For files: returns contents with line numbers, up to ${DEFAULT_LINE_LIMIT} lines by default. Use offset (1-based) and limit to paginate. Lines over ${MAX_LINE_LENGTH} chars are truncated. Path must be absolute. Reading outside working directory requires allowOutsideWorkingDirectory: true. For tool results: use the 'tool' parameter with an event ID to read a tool execution's output (useful for retrieving results from other agents' tool calls).`,

        inputSchema: readPathSchema,

        execute: async ({ path, description, offset, limit, allowOutsideWorkingDirectory, tool: toolEventId, prompt }: { path?: string; description: string; offset?: number; limit?: number; allowOutsideWorkingDirectory?: boolean; tool?: string; prompt?: string }) => {
            // Log the read operation with context
            logger.info("Reading file or tool result", {
                path: path || undefined,
                description,
                tool: toolEventId || undefined,
                hasPrompt: !!prompt,
            });

            try {
                let content: string;
                let source: string;

                // If tool parameter is provided, fetch tool result instead of reading a file
                if (toolEventId) {
                    content = await executeReadToolResult(toolEventId);
                    source = `tool result ${toolEventId}`;
                } else {
                    // Otherwise, read the file/directory
                    if (!path) {
                        throw new Error("Either 'path' or 'tool' parameter is required");
                    }
                    content = await executeFsRead(path, context.workingDirectory, context.agent.pubkey, offset, limit, allowOutsideWorkingDirectory);
                    source = path;
                }

                // If a prompt is provided, synthesize the content
                if (prompt) {
                    try {
                        return await synthesizeContent(content, prompt, source);
                    } catch (synthError) {
                        logger.error("Failed to synthesize content, returning raw content", {
                            source,
                            error: synthError instanceof Error ? synthError.message : String(synthError),
                        });
                        return `[Synthesis failed: ${synthError instanceof Error ? synthError.message : String(synthError)}]\n\n${content}`;
                    }
                }

                return content;
            } catch (error: unknown) {
                const target = toolEventId ? `tool result ${toolEventId}` : path;
                throw new Error(`Failed to read ${target}: ${formatAnyError(error)}`);
            }
        },
    });

    Object.defineProperty(toolInstance, "getHumanReadableContent", {
        value: ({ path, description, tool: toolEventId, prompt }: { path?: string; description: string; tool?: string; prompt?: string }) => {
            const action = prompt ? "Analyzing" : "Reading";
            if (toolEventId) {
                return `${action} tool result ${toolEventId.substring(0, 16)}... (${description})`;
            }
            return `${action} ${path} (${description})`;
        },
        enumerable: false,
        configurable: true,
    });

    return toolInstance as AISdkTool;
}
