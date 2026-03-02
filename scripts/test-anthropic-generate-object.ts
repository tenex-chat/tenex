#!/usr/bin/env bun

import { createAnthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import inquirer from "inquirer";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

interface ScriptInputs {
    apiKey: string;
    model: string;
    prompt: string;
    outputFile: string;
}

const demoSchema = z.object({
    title: z.string().describe("Short title of the result"),
    summary: z.string().describe("One concise paragraph"),
    tags: z.array(z.string()).min(1).max(6).describe("Keyword tags"),
    confidence: z.number().min(0).max(1).describe("Confidence score between 0 and 1"),
});

function formatError(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}

async function extractAnthropicChatModelIds(): Promise<string[]> {
    const baseDir = process.cwd();
    const candidateFiles = [
        path.join(baseDir, "node_modules/@ai-sdk/anthropic/src/anthropic-messages-options.ts"),
        path.join(baseDir, "node_modules/@ai-sdk/anthropic/dist/index.d.ts"),
    ];

    for (const file of candidateFiles) {
        try {
            const content = await readFile(file, "utf-8");
            const match = content.match(
                /(?:export\s+)?type\s+AnthropicMessagesModelId\s*=\s*([\s\S]*?)\|\s*\(string\s*&\s*\{\}\)\s*;/
            );
            if (!match) {
                continue;
            }

            const literals = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
            const unique = [...new Set(literals)];
            if (unique.length > 0) {
                return unique;
            }
        } catch {
            // ignore and try next file
        }
    }

    return [];
}

async function printAnthropicModelSupportInfo(): Promise<void> {
    const chatModels = await extractAnthropicChatModelIds();
    if (chatModels.length === 0) {
        return;
    }

    console.error("Chat/message model IDs available in this installed package:");
    for (const model of chatModels) {
        console.error(`- ${model}`);
    }
}

function looksLikeModelIssue(message: string): boolean {
    const lower = message.toLowerCase();
    return (
        lower.includes("model") &&
        (lower.includes("not found") ||
            lower.includes("invalid") ||
            lower.includes("unknown") ||
            lower.includes("unsupported"))
    );
}

async function collectInputs(): Promise<ScriptInputs> {
    const answers = await inquirer.prompt<ScriptInputs>([
        {
            type: "password",
            name: "apiKey",
            message: "Anthropic API key:",
            mask: "*",
            validate: (value: string) => value.trim().length > 0 || "API key is required",
        },
        {
            type: "input",
            name: "model",
            message: "Anthropic model id:",
            default: "claude-sonnet-4-6",
            validate: (value: string) => value.trim().length > 0 || "Model id is required",
        },
        {
            type: "input",
            name: "prompt",
            message: "Object generation prompt:",
            default: "Summarize TENEX as a software project in a practical way",
            validate: (value: string) => value.trim().length > 0 || "Prompt is required",
        },
        {
            type: "input",
            name: "outputFile",
            message: "Output file path:",
            default: "anthropic-generate-object-test.json",
            validate: (value: string) => value.trim().length > 0 || "Output file path is required",
        },
    ]);

    return {
        apiKey: answers.apiKey.trim(),
        model: answers.model.trim(),
        prompt: answers.prompt.trim(),
        outputFile: answers.outputFile.trim(),
    };
}

async function main(): Promise<void> {
    const { apiKey, model, prompt, outputFile } = await collectInputs();
    const anthropic = createAnthropic({ apiKey });

    console.log(`Testing AI SDK generateObject with Anthropic model "${model}"...`);

    try {
        const { object, usage, finishReason, warnings } = await generateObject({
            model: anthropic(model),
            schema: demoSchema,
            prompt,
        });

        const outputPath = path.resolve(outputFile);
        await writeFile(outputPath, `${JSON.stringify(object, null, 2)}\n`, "utf-8");

        console.log(`Success. Wrote object to: ${outputPath}`);
        console.log(`Finish reason: ${finishReason}`);
        console.log(`Usage: promptTokens=${usage.inputTokens}, completionTokens=${usage.outputTokens}`);

        if (warnings.length > 0) {
            console.log("Warnings:");
            for (const warning of warnings) {
                console.log(`- ${JSON.stringify(warning)}`);
            }
        }
    } catch (error) {
        const message = formatError(error);
        console.error("generateObject test failed.");
        console.error(message);

        if (looksLikeModelIssue(message)) {
            await printAnthropicModelSupportInfo();
        }

        process.exitCode = 1;
    }
}

await main();
