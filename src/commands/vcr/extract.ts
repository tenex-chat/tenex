import { Command } from "commander";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import chalk from "chalk";
import { getTenexBasePath } from "@/constants";
import { hashRequest, type VCRCassette, type VCRInteraction } from "@/test-utils/vcr";

/**
 * Extracts a flight recording to a VCR cassette file
 */
export function createExtractCommand(): Command {
    const cmd = new Command("extract")
        .description("Extract a recording to a VCR cassette")
        .argument("<recording>", "Path to the recording file (relative to recordings dir or absolute)")
        .argument("<cassette>", "Path to the cassette file to create")
        .option(
            "--dir <path>",
            "Recordings directory",
            join(getTenexBasePath(), "recordings")
        )
        .option("--append", "Append to existing cassette instead of replacing")
        .action(async (recording, cassette, options) => {
            await extractRecording(recording, cassette, options);
        });

    return cmd;
}

async function extractRecording(
    recordingPath: string,
    cassettePath: string,
    options: {
        dir: string;
        append?: boolean;
    }
): Promise<void> {
    try {
        // Resolve recording path
        let fullRecordingPath = recordingPath;
        if (!recordingPath.startsWith("/")) {
            fullRecordingPath = join(options.dir, recordingPath);
        }

        // Read the recording
        const recordingContent = await readFile(fullRecordingPath, "utf-8");
        const recording = JSON.parse(recordingContent);

        // Check if this is a stream recording (no response captured)
        if (!recording.response) {
            if (recording.type === "stream") {
                console.error(chalk.red("Cannot extract stream recording - response was not captured."));
                console.error(chalk.gray("Stream recordings only save the request. Use generateText() instead of streamText() to capture full interactions."));
            } else {
                console.error(chalk.red("Recording has no response data."));
            }
            process.exit(1);
        }

        // Convert recording to VCR interaction
        const interaction: VCRInteraction = {
            hash: hashRequest({ prompt: recording.request.prompt }),
            request: {
                prompt: recording.request.prompt,
                temperature: recording.request.temperature,
                maxOutputTokens: recording.request.maxOutputTokens,
                tools: recording.request.tools,
                toolChoice: recording.request.toolChoice,
            },
            response: {
                content: recording.response.content,
                finishReason: recording.response.finishReason,
                usage: recording.response.usage,
                providerMetadata: recording.response.providerMetadata,
            },
            metadata: {
                timestamp: recording.timestamp,
                modelId: recording.model.modelId,
                provider: recording.model.provider,
                duration: recording.duration,
            },
        };

        // Load existing cassette or create new one
        let cassette: VCRCassette;
        if (options.append) {
            try {
                const existingContent = await readFile(
                    cassettePath,
                    "utf-8"
                );
                cassette = JSON.parse(existingContent);
            } catch (error) {
                if (
                    error &&
                    typeof error === "object" &&
                    "code" in error &&
                    error.code === "ENOENT"
                ) {
                    cassette = createEmptyCassette(cassettePath);
                } else {
                    throw error;
                }
            }
        } else {
            cassette = createEmptyCassette(cassettePath);
        }

        // Add interaction (replaces if same hash exists)
        const existingIndex = cassette.interactions.findIndex(
            (i) => i.hash === interaction.hash
        );
        if (existingIndex >= 0) {
            cassette.interactions[existingIndex] = interaction;
            console.log(
                chalk.yellow("Updated existing interaction with same hash")
            );
        } else {
            cassette.interactions.push(interaction);
        }

        // Save cassette
        await writeFile(
            cassettePath,
            JSON.stringify(cassette, null, 2),
            "utf-8"
        );

        console.log(
            chalk.green(
                `Extracted recording to cassette: ${cassettePath}`
            )
        );
        console.log(
            chalk.gray(
                `Cassette now has ${cassette.interactions.length} interaction(s)`
            )
        );
    } catch (error) {
        console.error(chalk.red("Failed to extract recording:"), error);
        process.exit(1);
    }
}

function createEmptyCassette(cassettePath: string): VCRCassette {
    const name = cassettePath.split("/").pop()?.replace(".json", "") || "unnamed";
    return {
        name,
        version: "1.0",
        interactions: [],
        metadata: {
            createdAt: new Date().toISOString(),
            description: "Extracted from flight recordings",
        },
    };
}

