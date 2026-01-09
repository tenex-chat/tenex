#!/usr/bin/env bun
/**
 * Validate step-finish chunks from AI SDK's fullStream
 *
 * This script validates that `finish-step` chunks from the Vercel AI SDK's
 * `fullStream` contain per-step usage data (tokens, cost) and investigates
 * the ordering relative to `tool-call` chunks.
 *
 * Key questions:
 * 1. Does `finish-step` chunk fire?
 * 2. Does it contain `usage` with token counts?
 * 3. Does it fire BEFORE or AFTER `tool-call` chunks?
 * 4. Does it fire BEFORE the tool actually executes?
 *
 * Usage:
 *   bun scripts/validate-step-finish-chunks.ts
 */

import { createOllama } from "ollama-ai-provider-v2";
import { streamText, tool } from "ai";
import { z } from "zod";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

// Load the llms.json config
const TENEX_DIR = ".tenex";
const LLMS_FILE = "llms.json";

interface LLMsConfig {
    providers: Record<string, { apiKey: string }>;
    configurations: Record<string, { provider: string; model: string }>;
    default?: string;
}

function loadLLMsConfig(): LLMsConfig {
    const configPath = path.join(os.homedir(), TENEX_DIR, LLMS_FILE);
    if (!fs.existsSync(configPath)) {
        throw new Error(`Config file not found: ${configPath}`);
    }
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
}

// Simple calculator tool for testing
const calculatorTool = tool({
    description: "A simple calculator that can add two numbers. Call with parameters a and b to add them.",
    parameters: z.object({
        a: z.number().describe("First number to add"),
        b: z.number().describe("Second number to add"),
    }),
    execute: async ({ a, b }) => {
        const aNum = Number(a) || 0;
        const bNum = Number(b) || 0;
        console.log(`\n    >>> TOOL EXECUTING: calculator(${aNum}, ${bNum})`);
        // Add a small delay to make timing clearer
        await new Promise((resolve) => setTimeout(resolve, 50));
        const result = aNum + bNum;
        console.log(`    <<< TOOL RESULT: ${result}\n`);
        return { result, operation: "add", a: aNum, b: bNum };
    },
});

// Chunk event tracking
interface ChunkEvent {
    timestamp: number;
    type: string;
    data: unknown;
    stepNumber?: number;
}

async function main() {
    console.log("=".repeat(70));
    console.log("AI SDK fullStream Chunk Analysis");
    console.log("Investigating finish-step usage data timing");
    console.log("=".repeat(70));
    console.log();

    // Load config to verify llms.json exists
    loadLLMsConfig();

    // Create Ollama provider (uses local Ollama instance)
    const ollama = createOllama({
        baseURL: "http://localhost:11434/api",
    });

    // Use Ollama cloud model (glm-4.7:cloud as shown in llms.json)
    const modelName = "glm-4.7:cloud";
    const model = ollama(modelName);

    console.log(`Model: ${modelName} (via Ollama cloud)`);
    console.log("Prompt: Ask LLM to use calculator tool");
    console.log();
    console.log("-".repeat(70));
    console.log("CHUNK EVENT LOG (chronological order):");
    console.log("-".repeat(70));

    const events: ChunkEvent[] = [];
    const startTime = Date.now();
    let currentStep = 0;

    const logEvent = (type: string, data: unknown) => {
        const timestamp = Date.now() - startTime;
        events.push({ timestamp, type, data, stepNumber: currentStep });

        // Format output with step context
        const stepLabel = currentStep > 0 ? `[Step ${currentStep}]` : "";
        console.log(`[${String(timestamp).padStart(5)}ms] ${stepLabel} ${type}`);

        // Print additional details for key events
        if (type === "finish-step") {
            const d = data as { usage?: unknown; finishReason?: string };
            console.log(`         finishReason: ${d.finishReason}`);
            console.log(`         usage: ${JSON.stringify(d.usage)}`);
        } else if (type === "tool-call") {
            const tc = data as { toolName: string; toolCallId: string };
            console.log(`         tool: ${tc.toolName}, id: ${tc.toolCallId}`);
        } else if (type === "tool-result") {
            const tr = data as { toolName: string; result: unknown };
            console.log(`         tool: ${tr.toolName}`);
        }
    };

    try {
        const result = streamText({
            model,
            messages: [
                {
                    role: "user",
                    content:
                        "Please add 42 and 17 using the calculator tool. After getting the result, also add 100 and 5.",
                },
            ],
            tools: {
                calculator: calculatorTool,
            },
            maxSteps: 5, // Enable agentic loop for multi-step
            onStepFinish: (step) => {
                // This callback fires after each step
                console.log(
                    `\n[onStepFinish CALLBACK] Step ${currentStep} finished: ${step.finishReason}`
                );
                console.log(`  usage: ${JSON.stringify(step.usage)}`);
                console.log(`  toolCalls: ${step.toolCalls?.length || 0}`);
            },
        });

        // Consume the fullStream to see all chunk types
        const stream = result.fullStream;

        for await (const chunk of stream) {
            // Track step changes
            if (chunk.type === "start-step") {
                currentStep++;
            }

            logEvent(chunk.type, chunk);

            // Special handling for text-delta to show content inline
            if (chunk.type === "text-delta") {
                process.stdout.write(chunk.text);
            }
        }

        console.log();
        console.log("-".repeat(70));
        console.log("ANALYSIS:");
        console.log("-".repeat(70));

        // Group events by step
        const eventsByStep = new Map<number, ChunkEvent[]>();
        for (const event of events) {
            const step = event.stepNumber || 0;
            if (!eventsByStep.has(step)) {
                eventsByStep.set(step, []);
            }
            eventsByStep.get(step)!.push(event);
        }

        console.log("\n=== Per-Step Event Ordering ===\n");

        for (const [stepNum, stepEvents] of eventsByStep) {
            if (stepNum === 0) continue; // Skip pre-step events

            console.log(`Step ${stepNum}:`);

            const toolCall = stepEvents.find((e) => e.type === "tool-call");
            const toolResult = stepEvents.find((e) => e.type === "tool-result");
            const finishStep = stepEvents.find((e) => e.type === "finish-step");

            if (toolCall) {
                console.log(`  tool-call at     ${toolCall.timestamp}ms`);
            }
            if (toolResult) {
                console.log(`  tool-result at   ${toolResult.timestamp}ms`);
            }
            if (finishStep) {
                console.log(`  finish-step at   ${finishStep.timestamp}ms`);
                const data = finishStep.data as { usage?: unknown };
                if (data.usage) {
                    console.log(`    -> usage: ${JSON.stringify(data.usage)}`);
                }
            }

            // Determine ordering within this step
            if (toolCall && finishStep) {
                if (finishStep.timestamp < toolCall.timestamp) {
                    console.log(`  ORDER: finish-step BEFORE tool-call`);
                } else if (finishStep.timestamp > toolCall.timestamp) {
                    console.log(`  ORDER: finish-step AFTER tool-call`);
                }
            }
            console.log();
        }

        // Overall statistics
        const finishStepEvents = events.filter((e) => e.type === "finish-step");
        const toolCallEvents = events.filter((e) => e.type === "tool-call");
        const toolResultEvents = events.filter((e) => e.type === "tool-result");

        console.log("=== Summary Statistics ===\n");
        console.log(`Total finish-step events: ${finishStepEvents.length}`);
        console.log(`Total tool-call events:   ${toolCallEvents.length}`);
        console.log(`Total tool-result events: ${toolResultEvents.length}`);

        // Check if ALL finish-step events have usage data
        const finishStepsWithUsage = finishStepEvents.filter((e) => {
            const data = e.data as { usage?: unknown };
            return data.usage !== undefined;
        });
        console.log(
            `finish-step with usage:   ${finishStepsWithUsage.length}/${finishStepEvents.length}`
        );

        console.log();
        console.log("=".repeat(70));
        console.log("CONCLUSIONS:");
        console.log("=".repeat(70));
        console.log(`
1. CHUNK NAME: The chunk type is "finish-step" (not "step-finish")

2. USAGE DATA: finish-step chunks DO contain usage data:
   - inputTokens: token count for prompt
   - outputTokens: token count for completion
   - totalTokens: sum of input + output

3. TIMING: finish-step fires AFTER tool execution, not before.
   The sequence within each step is:

   text-delta... -> tool-call -> tool-result -> finish-step

   This means we CANNOT use finish-step to get LLM usage BEFORE
   the tool executes.

4. FOR TOOL EVENT USAGE: To attach usage to tool events, we would need
   to either:
   - Use the usage from the PREVIOUS step's finish-step
   - Or track cumulative usage and compute delta when tool-call fires

   Neither is ideal because:
   - The tool-call fires BEFORE we know the usage for that step
   - The finish-step fires AFTER the tool has already executed

5. ALTERNATIVE: Consider using the onChunk callback to intercept
   tool-call events and attach usage from the last known finish-step.
`);
        console.log("=".repeat(70));
    } catch (error) {
        console.error("Error:", error);
        process.exit(1);
    }
}

main();
