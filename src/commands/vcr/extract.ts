import { Command } from "commander";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import chalk from "chalk";
import type { VCRCassette, VCRInteraction } from "@/test-utils/vcr";

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
            join(homedir(), ".tenex", "recordings")
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

        // Convert recording to VCR interaction
        const interaction: VCRInteraction = {
            hash: createHash(recording.request.prompt),
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

function createHash(prompt: any): string {
    const input = JSON.stringify(prompt, null, 0);
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
        const char = input.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash = hash & hash;
    }
    return Math.abs(hash).toString(16).substring(0, 16).padStart(16, "0");
}
