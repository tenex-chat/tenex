#!/usr/bin/env bun

import { createAnthropic } from "@ai-sdk/anthropic";
import chalk from "chalk";
import { generateText, stepCountIs, streamText, tool } from "ai";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { z } from "zod";

const MODEL_ID = "claude-haiku-4-5-20251001";
const API_KEY_FILE = resolve(process.cwd(), "tmp", "anthropic-api-key.txt");
const DEFAULT_PROMPT =
    "write 10 poems, 1 per file, after writing each file say what's the title of the haiku you wrote then read each file and say how many words do you read in the file.";
const OAUTH_BETAS = [
    "claude-code-20250219",
    "oauth-2025-04-20",
];

function isOAuthToken(key: string): boolean {
    return key.startsWith("sk-ant-oat");
}

function normalizeSecretInput(raw: string): string {
    let value = raw.trim();

    // Accept direct secret or pasted env assignment lines.
    const assignmentMatch = value.match(
        /^(?:export\s+)?(?:ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN)\s*=\s*(.+)$/
    );
    if (assignmentMatch?.[1]) {
        value = assignmentMatch[1].trim();
    }

    // Strip optional surrounding quotes.
    const quoted = value.match(/^(['"])(.*)\1$/);
    if (quoted?.[2]) {
        value = quoted[2].trim();
    }

    return value;
}

function emitLine(line: string): void {
    console.log(line);
}

function getKind1TagColor(tag: string): (text: string) => string {
    if (tag === "conversation") {
        return chalk.blueBright;
    }
    if (tag === "completion") {
        return chalk.greenBright;
    }
    if (tag === "error") {
        return chalk.redBright;
    }
    if (tag === "tool") {
        return chalk.yellowBright;
    }
    return chalk.white;
}

function shouldIgnoreChunkForAgentExecutor(
    chunk: { type: string } & Record<string, unknown>
): boolean {
    if (chunk.type !== "reasoning-delta") {
        return false;
    }

    const textValue =
        typeof chunk.text === "string"
            ? chunk.text
            : typeof chunk.delta === "string"
                ? chunk.delta
                : "";

    return textValue === "[REDACTED]";
}

function escapeAttr(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("\"", "&quot;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
}

function emitKind1Inline(tag: string, attrs: Record<string, string>, content: string): void {
    const attrsString = Object.entries(attrs)
        .map(([key, value]) => ` ${key}="${escapeAttr(value)}"`)
        .join("");

    const line = `<${tag}${attrsString}>${content}</${tag}>`;
    const color = getKind1TagColor(tag);
    emitLine(`${chalk.magentaBright("[kind1]")} ${color(line)}`);
}

function emitKind1Block(tag: string, attrs: Record<string, string>, content: string): void {
    const attrsString = Object.entries(attrs)
        .map(([key, value]) => ` ${key}="${escapeAttr(value)}"`)
        .join("");

    const color = getKind1TagColor(tag);
    emitLine(`${chalk.magentaBright("[kind1]")} ${color(`<${tag}${attrsString}>`)}`);
    if (content.length > 0) {
        emitLine(chalk.white(content));
    }
    emitLine(color(`</${tag}>`));
}

function truncateText(value: string, maxLength = 220): string {
    if (value.length <= maxLength) {
        return value;
    }
    return `${value.slice(0, maxLength)}... [truncated ${value.length - maxLength} chars]`;
}

function summarizeValue(value: unknown): unknown {
    if (typeof value === "string") {
        return truncateText(value);
    }

    if (Array.isArray(value)) {
        return value.map((item) => summarizeValue(item));
    }

    if (value && typeof value === "object") {
        const summarized: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            if (key === "content" && typeof item === "string") {
                summarized.contentPreview = truncateText(item);
                summarized.contentChars = item.length;
                continue;
            }
            summarized[key] = summarizeValue(item);
        }
        return summarized;
    }

    return value;
}

function formatErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    if (error && typeof error === "object" && "message" in error) {
        const message = (error as { message?: unknown }).message;
        if (typeof message === "string") {
            return message;
        }
    }
    return String(error);
}

class LiveTextRenderer {
    private streamingOpen = false;
    private renderedLength = 0;
    private activeContentLine = false;
    private colorIndex = 0;
    private readonly chunkColors: Array<(value: string) => string> = [
        chalk.greenBright,
        chalk.yellowBright,
        chalk.blueBright,
        chalk.magentaBright,
        chalk.cyanBright,
        chalk.whiteBright,
    ];

    update(content: string): void {
        if (content.length === 0) {
            return;
        }

        if (!this.streamingOpen) {
            emitLine(chalk.cyanBright("<streaming>"));
            this.streamingOpen = true;
            this.renderedLength = 0;
            this.colorIndex = 0;
        }

        if (!this.activeContentLine) {
            process.stdout.write(chalk.green("   "));
            this.activeContentLine = true;
        }

        if (content.length < this.renderedLength) {
            process.stdout.write("\n");
            process.stdout.write(chalk.whiteBright(`   ${content.replaceAll("\n", "\n   ")}`));
            this.renderedLength = content.length;
            return;
        }

        const delta = content.slice(this.renderedLength);
        if (delta.length > 0) {
            const color = this.chunkColors[this.colorIndex % this.chunkColors.length];
            this.colorIndex += 1;
            process.stdout.write(color(delta.replaceAll("\n", "\n   ")));
            this.renderedLength = content.length;
        }
    }

    close(): void {
        if (!this.streamingOpen) {
            return;
        }

        if (this.activeContentLine) {
            process.stdout.write("\n");
            this.activeContentLine = false;
        }

        emitLine(chalk.cyanBright("</streaming>"));
        this.streamingOpen = false;
        this.renderedLength = 0;
        this.colorIndex = 0;
    }
}

class AgentPublishSimulator {
    private previousChunkType: string | undefined;
    private contentBuffer = "";
    private reasoningBuffer = "";
    private cachedContentForComplete = "";
    private readonly liveText = new LiveTextRenderer();
    private readonly startedTools = new Set<string>();
    private readonly completedTools = new Set<string>();
    private readonly toolInfo = new Map<string, { name: string; input?: unknown }>();
    private emittedError = false;

    handleChunk(chunk: { type: string } & Record<string, unknown>): void {
        if (shouldIgnoreChunkForAgentExecutor(chunk)) {
            return;
        }

        if (this.previousChunkType !== undefined && this.previousChunkType !== chunk.type) {
            if (this.previousChunkType === "reasoning-delta") {
                this.flushReasoningBuffer("chunk-type-change");
            }
            if (this.previousChunkType === "text-delta") {
                this.flushContentBuffer("chunk-type-change");
            }
            this.cachedContentForComplete = "";
        }

        this.previousChunkType = chunk.type;

        if (chunk.type === "text-delta") {
            const delta =
                typeof chunk.text === "string"
                    ? chunk.text
                    : typeof chunk.textDelta === "string"
                        ? chunk.textDelta
                        : typeof chunk.delta === "string"
                            ? chunk.delta
                        : "";
            this.contentBuffer += delta;
            this.cachedContentForComplete += delta;
            this.liveText.update(this.contentBuffer);
            return;
        }

        if (chunk.type === "reasoning-delta") {
            const delta =
                typeof chunk.text === "string"
                    ? chunk.text
                    : typeof chunk.delta === "string"
                        ? chunk.delta
                        : "";
            this.reasoningBuffer += delta;
            return;
        }

        if (chunk.type === "tool-input-start") {
            const toolCallId = typeof chunk.id === "string" ? chunk.id : undefined;
            const toolName = typeof chunk.toolName === "string" ? chunk.toolName : "unknown";
            if (toolCallId && !this.startedTools.has(toolCallId)) {
                this.startedTools.add(toolCallId);
                this.toolInfo.set(toolCallId, { name: toolName });
                emitLine(chalk.yellowBright(`<tool name="${escapeAttr(toolName)}" id="${escapeAttr(toolCallId)}">`));
            }
            return;
        }

        if (chunk.type === "tool-call") {
            const toolCallId = typeof chunk.toolCallId === "string" ? chunk.toolCallId : undefined;
            const toolName = typeof chunk.toolName === "string" ? chunk.toolName : "unknown";
            if (toolCallId) {
                if (!this.startedTools.has(toolCallId)) {
                    this.startedTools.add(toolCallId);
                    emitLine(chalk.yellowBright(`<tool name="${escapeAttr(toolName)}" id="${escapeAttr(toolCallId)}">`));
                }
                this.toolInfo.set(toolCallId, { name: toolName, input: chunk.input });
            }
            return;
        }

        if (chunk.type === "tool-result") {
            const toolCallId = typeof chunk.toolCallId === "string" ? chunk.toolCallId : undefined;
            const toolName = typeof chunk.toolName === "string" ? chunk.toolName : "unknown";
            if (toolCallId && !this.completedTools.has(toolCallId)) {
                this.completedTools.add(toolCallId);
                const info = this.toolInfo.get(toolCallId);
                const mergedToolName = info?.name ?? toolName;
                const inputSummary = info?.input !== undefined
                    ? truncateText(JSON.stringify(summarizeValue(info.input)))
                    : "";
                const outputSummary = truncateText(JSON.stringify(summarizeValue(chunk.output)));
                emitKind1Inline(
                    "tool",
                    {
                        name: mergedToolName,
                        id: toolCallId,
                        status: "completed",
                    },
                    `input=${inputSummary} output=${outputSummary}`.trim()
                );
            }
            return;
        }

        if (chunk.type === "tool-error") {
            const toolCallId = typeof chunk.toolCallId === "string" ? chunk.toolCallId : undefined;
            const toolName = typeof chunk.toolName === "string" ? chunk.toolName : "unknown";
            const message = formatErrorMessage(chunk.error);

            emitKind1Inline(
                "tool",
                {
                    name: toolName,
                    id: toolCallId ?? "unknown",
                    status: "error",
                },
                message
            );
        }
    }

    finish(event: {
        text?: string;
        steps: Array<{ text?: string }>;
        finishReason?: string;
        rawFinishReason?: string;
        totalUsage?: unknown;
    }): void {
        // StreamExecutionHandler flushes reasoning at end if still buffered.
        this.flushReasoningBuffer("stream-end");

        // Match FinishHandler fallback logic.
        const cachedContent = this.cachedContentForComplete;
        const text = event.text ?? "";
        const stepsText = event.steps.map((step) => step.text ?? "").join("");
        const fallbackLevel =
            cachedContent.length > 0 ? "cached" :
            text.length > 0 ? "text" :
            stepsText.length > 0 ? "steps" :
            "error";
        const finalMessage =
            fallbackLevel === "cached" ? cachedContent :
            fallbackLevel === "text" ? text :
            fallbackLevel === "steps" ? stepsText :
            "There was an error capturing the work done, please review the conversation for the results";

        this.liveText.close();

        emitKind1Block(
            "completion",
            {
                status: "completed",
                finish_reason: event.finishReason ?? "unknown",
                raw_finish_reason: event.rawFinishReason ?? "unknown",
                fallback: fallbackLevel,
            },
            finalMessage
        );

        this.cachedContentForComplete = "";
    }

    streamError(error: unknown): void {
        const message = formatErrorMessage(error);

        this.liveText.close();
        this.emittedError = true;

        emitKind1Inline(
            "error",
            { status: "completed", type: "execution_error" },
            message
        );
    }

    private flushReasoningBuffer(reason: "chunk-type-change" | "stream-end"): void {
        if (this.reasoningBuffer.trim().length === 0) {
            return;
        }

        const contentToFlush = this.reasoningBuffer;
        this.reasoningBuffer = "";
        this.liveText.close();

        emitKind1Block(
            "conversation",
            { reasoning: "true", reason },
            contentToFlush
        );
    }

    private flushContentBuffer(reason: "chunk-type-change"): void {
        if (this.contentBuffer.trim().length === 0) {
            return;
        }

        const contentToFlush = this.contentBuffer;
        this.contentBuffer = "";
        this.liveText.close();

        emitKind1Block(
            "conversation",
            { reason },
            contentToFlush
        );
    }

    handleFullStreamPart(part: { type: string } & Record<string, unknown>): void {
        if (part.type === "error" && !this.emittedError) {
            this.emittedError = true;
            emitKind1Inline(
                "error",
                { status: "completed", type: "execution_error" },
                formatErrorMessage(part.error)
            );
        }
    }
}

function parseModeInput(rawInput: string): "streamText" | "generateText" {
    const value = rawInput.trim().toLowerCase();

    if (value === "" || value === "1" || value === "stream" || value === "streamtext") {
        return "streamText";
    }

    if (value === "2" || value === "generate" || value === "generatetext") {
        return "generateText";
    }

    throw new Error(`Invalid mode "${rawInput}". Use 1/streamText or 2/generateText.`);
}

function createFileTools() {
    return {
        file_read: tool({
            description:
                "Read a UTF-8 file from the current working directory.",
            inputSchema: z.object({
                path: z.string().describe("Path to the file (relative or absolute within cwd)."),
            }),
            execute: async ({ path }: { path: string }) => {
                const fullPath = resolveToolPath(path);
                const content = await readFile(fullPath, "utf8");
                return {
                    path: fullPath,
                    content,
                    chars: content.length,
                    words: content.trim().length === 0
                        ? 0
                        : content.trim().split(/\s+/).length,
                };
            },
        }),
        file_write: tool({
            description:
                "Write UTF-8 content to a file in the current working directory (creates folders).",
            inputSchema: z.object({
                path: z.string().describe("Path to the file (relative or absolute within cwd)."),
                content: z.string().describe("File content to write."),
            }),
            execute: async ({ path, content }: { path: string; content: string }) => {
                const fullPath = resolveToolPath(path);
                await mkdir(dirname(fullPath), { recursive: true });
                await writeFile(fullPath, content, "utf8");
                return {
                    path: fullPath,
                    bytesWritten: Buffer.byteLength(content, "utf8"),
                };
            },
        }),
    };
}

function resolveToolPath(pathInput: string): string {
    const cwd = process.cwd();
    const absolutePath = isAbsolute(pathInput)
        ? pathInput
        : resolve(cwd, pathInput);
    const relativeToCwd = relative(cwd, absolutePath);

    if (relativeToCwd === ".." || relativeToCwd.startsWith(`..${sep}`)) {
        throw new Error(
            `Path "${pathInput}" resolves outside current working directory (${cwd}).`
        );
    }

    return absolutePath;
}

async function loadSavedApiKey(): Promise<string | null> {
    try {
        const value = (await readFile(API_KEY_FILE, "utf8")).trim();
        return value.length > 0 ? value : null;
    } catch {
        return null;
    }
}

async function saveApiKey(apiKey: string): Promise<void> {
    await mkdir(dirname(API_KEY_FILE), { recursive: true });
    await writeFile(API_KEY_FILE, `${apiKey}\n`, { mode: 0o600 });
}

async function getApiKey(
    rl: ReturnType<typeof createInterface>
): Promise<string> {
    const fromEnv = normalizeSecretInput(process.env.ANTHROPIC_API_KEY ?? "");
    if (fromEnv) {
        return fromEnv;
    }

    const fromAuthEnv = normalizeSecretInput(process.env.ANTHROPIC_AUTH_TOKEN ?? "");
    if (fromAuthEnv) {
        return fromAuthEnv;
    }

    const fromDisk = await loadSavedApiKey();
    if (fromDisk) {
        return normalizeSecretInput(fromDisk);
    }

    console.log(chalk.yellow("Anthropic credentials not found."));
    const entered = (
        await rl.question("Paste your Anthropic API key or setup-token (saved for future runs): ")
    );
    const normalized = normalizeSecretInput(entered);

    if (!normalized) {
        throw new Error("No Anthropic credential provided.");
    }

    await saveApiKey(normalized);
    console.log(chalk.green(`Saved Anthropic credential to ${API_KEY_FILE}`));

    return normalized;
}

async function main(): Promise<void> {
    const rl = createInterface({ input, output });

    try {
        const credential = await getApiKey(rl);
        const anthropic = isOAuthToken(credential)
            ? createAnthropic({
                authToken: credential,
                headers: {
                    "anthropic-beta": OAUTH_BETAS.join(","),
                },
            })
            : createAnthropic({ apiKey: credential });

        const promptInput = (
            await rl.question(
                `${chalk.cyan("Execution mode")} [1=streamText, 2=generateText] (default: 1)\n> `
            )
        ).trim();
        const mode = parseModeInput(promptInput);

        const userPromptInput = (
            await rl.question(
                `${chalk.cyan(`Prompt for ${mode}`)} (press Enter for default)\n${chalk.gray(DEFAULT_PROMPT)}\n> `
            )
        ).trim();

        const prompt = userPromptInput.length > 0 ? userPromptInput : DEFAULT_PROMPT;
        const tools = createFileTools();

        if (mode === "streamText") {
            let streamError: unknown;
            const publishSimulator = new AgentPublishSimulator();
            const result = streamText({
                model: anthropic(MODEL_ID),
                prompt,
                stopWhen: stepCountIs(25),
                tools,
                onChunk: ({ chunk }) => {
                    publishSimulator.handleChunk(chunk);
                },
                onFinish: (event) => {
                    publishSimulator.finish({
                        text: event.text,
                        steps: event.steps.map((step) => ({ text: step.text })),
                        finishReason: event.finishReason,
                        rawFinishReason: event.rawFinishReason,
                        totalUsage: event.totalUsage,
                    });
                },
                onError: ({ error }) => {
                    streamError = error;
                    publishSimulator.streamError(error);
                },
            });

            for await (const part of result.fullStream) {
                publishSimulator.handleFullStreamPart(part);
            }

            if (streamError) {
                throw new Error(formatErrorMessage(streamError));
            }

            console.log(chalk.bold.green("Completed stream."));
            return;
        }

        const result = await generateText({
            model: anthropic(MODEL_ID),
            prompt,
            stopWhen: stepCountIs(25),
            tools,
            onStepFinish: (event) => {
                emitLine(
                    `<generate-step step="${event.stepNumber}" finish_reason="${escapeAttr(
                        event.finishReason ?? "unknown"
                    )}" tool_calls="${event.toolCalls.length}" tool_results="${event.toolResults.length}" />`
                );
            },
            onFinish: (event) => {
                emitLine(
                    `<generate-finish finish_reason="${escapeAttr(
                        event.finishReason ?? "unknown"
                    )}" steps="${event.steps.length}" text_chars="${event.text.length}" />`
                );
            },
        });

        console.log(chalk.bold.green("generateText output:"));
        console.log(result.text);
    } finally {
        rl.close();
    }
}

main().catch((error) => {
    console.error(chalk.red(`Script failed: ${formatErrorMessage(error)}`));
    process.exit(1);
});
