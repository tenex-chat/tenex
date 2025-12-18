import type { LanguageModelV2Middleware } from "@ai-sdk/provider";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

/**
 * Flight recorder configuration
 */
export interface FlightRecorderConfig {
    /** Base directory for recordings (defaults to ~/.tenex/recordings) */
    baseDir?: string;
    /** Whether to enable the flight recorder (defaults to true) */
    enabled?: boolean;
}

/**
 * Creates a flight recorder middleware that records all LLM interactions.
 * Unlike VCR (which is for testing), the flight recorder is always-on and
 * saves interactions to timestamped directories for debugging and analysis.
 *
 * Recordings are saved to: {baseDir}/YYYY-MM-DD/{timestamp}-{hash}.json
 *
 * @param config - Flight recorder configuration
 * @returns A middleware that records all interactions
 */
export function createFlightRecorderMiddleware(
    config: FlightRecorderConfig = {}
): LanguageModelV2Middleware {
    const baseDir =
        config.baseDir || join(homedir(), ".tenex", "recordings");
    const enabled = config.enabled ?? true;

    if (!enabled) {
        return {};
    }

    return {
        middlewareVersion: "v2",

        async wrapGenerate({ doGenerate, params, model }) {
            const startTime = Date.now();

            // Create hash of request for filename
            const hash = createSimpleHash(JSON.stringify(params.prompt));

            // Prepare recording metadata
            const recording = {
                timestamp: new Date().toISOString(),
                model: {
                    provider: model.provider,
                    modelId: model.modelId,
                },
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

                // Record successful response
                recording.response = {
                    content: result.content,
                    finishReason: result.finishReason,
                    usage: result.usage,
                    providerMetadata: result.providerMetadata,
                };
                recording.duration = Date.now() - startTime;

                // Save recording
                await saveRecording(baseDir, hash, recording);

                return result;
            } catch (error) {
                // Record error
                recording.error = {
                    message: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined,
                };
                recording.duration = Date.now() - startTime;

                // Save recording even on error
                await saveRecording(baseDir, hash, recording);

                throw error;
            }
        },
    };
}

/**
 * Saves a recording to disk
 */
async function saveRecording(
    baseDir: string,
    hash: string,
    recording: any
): Promise<void> {
    try {
        // Create directory structure: baseDir/YYYY-MM-DD/
        const now = new Date();
        const dateStr = now.toISOString().split("T")[0]; // YYYY-MM-DD
        const dirPath = join(baseDir, dateStr);

        await mkdir(dirPath, { recursive: true });

        // Create filename: timestamp-hash.json
        const timestamp = now.toISOString().replace(/[:.]/g, "-");
        const filename = `${timestamp}-${hash}.json`;
        const filePath = join(dirPath, filename);

        // Write recording
        const content = JSON.stringify(recording, null, 2);
        await writeFile(filePath, content, "utf-8");
    } catch (error) {
        // Don't throw - flight recorder should not break the application
        console.error("[FlightRecorder] Failed to save recording:", error);
    }
}

/**
 * Creates a simple hash for filename purposes
 */
function createSimpleHash(input: string): string {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
        const char = input.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(16).substring(0, 8);
}
