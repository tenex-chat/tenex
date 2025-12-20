import type { LanguageModelMiddleware } from "ai";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { recordingState } from "../RecordingState";

type WrapGenerateParams = Parameters<NonNullable<LanguageModelMiddleware["wrapGenerate"]>>[0];
type WrapStreamParams = Parameters<NonNullable<LanguageModelMiddleware["wrapStream"]>>[0];

/**
 * Flight recorder configuration
 */
export interface FlightRecorderConfig {
    /** Base directory for recordings (defaults to ~/.tenex/recordings) */
    baseDir?: string;
}

/**
 * Creates a flight recorder middleware that records LLM interactions when enabled.
 * Recording is controlled by the global recordingState - toggle with Ctrl+R in daemon.
 *
 * Recordings are saved to: {baseDir}/YYYY-MM-DD/{timestamp}-{hash}.json
 */
export function createFlightRecorderMiddleware(
    config: FlightRecorderConfig = {}
): LanguageModelMiddleware {
    const baseDir = config.baseDir || join(homedir(), ".tenex", "recordings");

    return {
        async wrapGenerate({ doGenerate, params, model }: WrapGenerateParams) {
            if (!recordingState.isRecording) {
                return doGenerate();
            }

            const startTime = Date.now();
            const hash = createSimpleHash(JSON.stringify(params.prompt));

            const recording = {
                timestamp: new Date().toISOString(),
                type: "generate",
                model: { provider: model.provider, modelId: model.modelId },
                request: {
                    prompt: params.prompt,
                    temperature: params.temperature,
                    maxOutputTokens: params.maxOutputTokens,
                    tools: params.tools,
                    toolChoice: params.toolChoice,
                },
                response: null as any,
                error: null as any,
                duration: 0,
            };

            try {
                const result = await doGenerate();
                recording.response = {
                    content: result.content,
                    finishReason: result.finishReason,
                    usage: result.usage,
                };
                recording.duration = Date.now() - startTime;
                await saveRecording(baseDir, hash, recording);
                return result;
            } catch (error) {
                recording.error = {
                    message: error instanceof Error ? error.message : String(error),
                };
                recording.duration = Date.now() - startTime;
                await saveRecording(baseDir, hash, recording);
                throw error;
            }
        },

        wrapStream({ doStream, params, model }: WrapStreamParams) {
            if (!recordingState.isRecording) {
                return doStream();
            }

            const startTime = Date.now();
            const hash = createSimpleHash(JSON.stringify(params.prompt));

            // Buffer to collect stream content
            const textParts: string[] = [];
            const toolCalls: any[] = [];
            let finishReason: string | undefined;
            let usage: any;

            // Wrap the stream with a TransformStream to intercept chunks
            return doStream().then((result) => {
                const transform = new TransformStream({
                    transform(chunk, controller) {
                        // Pass through the chunk
                        controller.enqueue(chunk);

                        // Collect data for recording
                        if (chunk.type === "text-delta" && chunk.textDelta) {
                            textParts.push(chunk.textDelta);
                        }
                        if (chunk.type === "tool-call") {
                            toolCalls.push({
                                toolCallId: chunk.toolCallId,
                                toolName: chunk.toolName,
                                args: chunk.args,
                            });
                        }
                        if (chunk.type === "finish") {
                            finishReason = chunk.finishReason;
                            usage = chunk.usage;
                        }
                    },
                    flush() {
                        // Stream finished - save the recording
                        const recording = {
                            timestamp: new Date().toISOString(),
                            type: "stream",
                            model: { provider: model.provider, modelId: model.modelId },
                            request: {
                                prompt: params.prompt,
                                temperature: params.temperature,
                                maxOutputTokens: params.maxOutputTokens,
                                tools: params.tools,
                                toolChoice: params.toolChoice,
                            },
                            response: {
                                content: [{ type: "text", text: textParts.join("") }],
                                toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
                                finishReason,
                                usage,
                            },
                            duration: Date.now() - startTime,
                        };
                        saveRecording(baseDir, hash, recording).catch(() => {});
                    },
                });

                return {
                    ...result,
                    stream: result.stream.pipeThrough(transform),
                };
            });
        },
    };
}

async function saveRecording(baseDir: string, hash: string, recording: any): Promise<void> {
    try {
        const now = new Date();
        const dateStr = now.toISOString().split("T")[0];
        const dirPath = join(baseDir, dateStr);
        await mkdir(dirPath, { recursive: true });

        const timestamp = now.toISOString().replace(/[:.]/g, "-");
        const filename = `${timestamp}-${hash}.json`;
        await writeFile(join(dirPath, filename), JSON.stringify(recording, null, 2), "utf-8");
    } catch (error) {
        console.error("[FlightRecorder] Failed to save recording:", error);
    }
}

function createSimpleHash(input: string): string {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
        const char = input.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash = hash & hash;
    }
    return Math.abs(hash).toString(16).substring(0, 8);
}
