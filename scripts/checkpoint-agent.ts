#!/usr/bin/env bun
/**
 * Checkpoint Agent Runner
 *
 * A script that demonstrates storing and resuming agent RAL (Reasoning-Action Loop)
 * checkpoints using the Vercel AI SDK with Claude Code's built-in tools.
 *
 * Usage:
 *   bun scripts/checkpoint-agent.ts                    # Run fresh
 *   bun scripts/checkpoint-agent.ts --resume           # Resume from last checkpoint
 *   bun scripts/checkpoint-agent.ts --list             # List available checkpoints
 *   bun scripts/checkpoint-agent.ts --from <step>      # Resume from specific step
 */

import { streamText, type CoreMessage } from "ai";
import { claudeCode } from "ai-sdk-provider-claude-code";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

// Checkpoint file path
const CHECKPOINT_FILE = path.join(process.cwd(), ".agent-checkpoints.json");

// Types for checkpoint storage
interface Checkpoint {
  stepNumber: number;
  timestamp: string;
  messages: CoreMessage[];
  toolCalls: ToolCallRecord[];
  toolResults: ToolResultRecord[];
  text?: string;
  finishReason?: string;
}

interface ToolCallRecord {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

interface ToolResultRecord {
  toolCallId: string;
  toolName: string;
  result: unknown;
}

interface CheckpointStore {
  sessionId: string;
  prompt: string;
  createdAt: string;
  checkpoints: Checkpoint[];
}

// Logging utilities with chalk colors
const log = {
  header: (msg: string) => console.log(chalk.bold.cyan(`\n${"=".repeat(60)}\n${msg}\n${"=".repeat(60)}`)),
  step: (num: number) => console.log(chalk.bold.magenta(`\n--- Step ${num} ---`)),
  event: (type: string, msg: string) => console.log(chalk.yellow(`[${type}] ${msg}`)),
  toolInputStart: (name: string, id: string) => console.log(chalk.green(`[tool-input-start] ${chalk.bold(name)} (${id})`)),
  toolInputDelta: (delta: string) => console.log(chalk.green(`   -> delta: ${delta.substring(0, 100)}${delta.length > 100 ? "..." : ""}`)),
  toolCall: (name: string, id: string, args: unknown) => {
    console.log(chalk.green(`[tool-call] ${chalk.bold(name)} (${id})`));
    const argsStr = args ? JSON.stringify(args, null, 2) : "(undefined)";
    console.log(chalk.green(`  args: ${argsStr.split("\n").join("\n  ")}`));
  },
  toolResult: (name: string, id: string, result: unknown) => {
    console.log(chalk.blue(`[tool-result] ${chalk.bold(name)} (${id})`));
    const resultStr = result == null ? "(no result)" : (typeof result === "string" ? result.substring(0, 500) : JSON.stringify(result, null, 2).substring(0, 500));
    console.log(chalk.blue(`  result: ${resultStr.split("\n").join("\n  ")}${resultStr.length >= 500 ? "..." : ""}`));
  },
  toolError: (name: string, error: unknown) => {
    console.log(chalk.red(`[tool-error] ${chalk.bold(name)}`));
    console.log(chalk.red(`  error: ${error}`));
  },
  textDelta: (text: string) => process.stdout.write(chalk.white(text)),
  message: (role: string, content: string) => {
    const color = role === "assistant" ? chalk.cyan : role === "user" ? chalk.white : chalk.gray;
    console.log(color(`[${role}] ${content.substring(0, 200)}${content.length > 200 ? "..." : ""}`));
  },
  checkpoint: (num: number) => console.log(chalk.bgGreen.black(` CHECKPOINT SAVED: Step ${num} `)),
  info: (msg: string) => console.log(chalk.gray(`[info] ${msg}`)),
  error: (msg: string) => console.log(chalk.red(`[error] ${msg}`)),
  success: (msg: string) => console.log(chalk.green(`[success] ${msg}`)),
};

// Allow all tools callback for Claude Code
const allowAllTools: CanUseTool = async (_toolName, input) => ({
  behavior: "allow",
  updatedInput: input,
});

// Save checkpoint to file
function saveCheckpoint(store: CheckpointStore): void {
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(store, null, 2));
  log.info(`Checkpoints saved to ${CHECKPOINT_FILE}`);
}

// Load checkpoint from file
function loadCheckpoint(): CheckpointStore | null {
  if (!fs.existsSync(CHECKPOINT_FILE)) {
    return null;
  }
  const data = fs.readFileSync(CHECKPOINT_FILE, "utf-8");
  return JSON.parse(data);
}

// List available checkpoints
function listCheckpoints(): void {
  const store = loadCheckpoint();
  if (!store) {
    log.error("No checkpoints found");
    return;
  }

  log.header("Available Checkpoints");
  console.log(chalk.gray(`Session: ${store.sessionId}`));
  console.log(chalk.gray(`Prompt: ${store.prompt}`));
  console.log(chalk.gray(`Created: ${store.createdAt}`));
  console.log();

  for (const cp of store.checkpoints) {
    const toolsUsed = cp.toolCalls.map((t) => t.toolName).join(", ") || "none";
    console.log(
      chalk.cyan(`  Step ${cp.stepNumber}`) +
        chalk.gray(` [${cp.timestamp}]`) +
        chalk.yellow(` tools: ${toolsUsed}`) +
        (cp.text ? chalk.green(` text: ${cp.text.substring(0, 50)}...`) : "")
    );
  }
}

// Interactive prompt to select checkpoint
async function selectCheckpoint(store: CheckpointStore): Promise<number> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    listCheckpoints();
    console.log();
    rl.question(chalk.yellow("Enter step number to resume from (or 'last'): "), (answer) => {
      rl.close();
      if (answer.toLowerCase() === "last") {
        resolve(store.checkpoints.length - 1);
      } else {
        const step = parseInt(answer, 10);
        if (isNaN(step) || step < 0 || step >= store.checkpoints.length) {
          log.error(`Invalid step number. Using last checkpoint.`);
          resolve(store.checkpoints.length - 1);
        } else {
          resolve(step);
        }
      }
    });
  });
}

// Rebuild messages from checkpoints for resumption
function rebuildMessagesFromCheckpoints(
  prompt: string,
  checkpoints: Checkpoint[],
  fromStep: number
): CoreMessage[] {
  const messages: CoreMessage[] = [
    { role: "user", content: prompt },
  ];

  for (const cp of checkpoints) {
    if (cp.stepNumber > fromStep) break;
    messages.push(...cp.messages);
  }

  return messages;
}

// Main agent runner
async function runAgent(options: {
  prompt?: string;
  resume?: boolean;
  fromStep?: number;
  list?: boolean;
}): Promise<void> {
  if (options.list) {
    listCheckpoints();
    return;
  }

  let initialMessages: CoreMessage[] = [];
  let store: CheckpointStore;
  let startStep = 0;

  const defaultPrompt = "List the files in the current directory, then read the package.json and tell me what this project is about.";

  if (options.resume || options.fromStep !== undefined) {
    const existingStore = loadCheckpoint();
    if (!existingStore) {
      log.error("No checkpoints found to resume from. Starting fresh.");
      store = {
        sessionId: crypto.randomUUID(),
        prompt: options.prompt || defaultPrompt,
        createdAt: new Date().toISOString(),
        checkpoints: [],
      };
    } else {
      store = existingStore;
      const targetStep =
        options.fromStep !== undefined
          ? options.fromStep
          : await selectCheckpoint(existingStore);

      startStep = targetStep;
      initialMessages = rebuildMessagesFromCheckpoints(store.prompt, store.checkpoints, targetStep);

      // Trim checkpoints to the resume point
      store.checkpoints = store.checkpoints.filter((cp) => cp.stepNumber <= targetStep);

      log.header(`Resuming from Step ${targetStep}`);
      log.info(`Rebuilt ${initialMessages.length} messages from checkpoints`);

      // Log the rebuilt conversation
      console.log(chalk.gray("\n--- Rebuilt Conversation ---"));
      for (const msg of initialMessages) {
        if (typeof msg.content === "string") {
          log.message(msg.role, msg.content);
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === "tool-call") {
              log.toolCall(part.toolName, (part as any).toolCallId, (part as any).input ?? (part as any).args);
            } else if (part.type === "tool-result") {
              const output = (part as any).output;
              const displayValue = output?.value ?? output;
              log.toolResult(part.toolName, (part as any).toolCallId, displayValue);
            } else if (part.type === "text") {
              log.message(msg.role, part.text);
            }
          }
        }
      }
      console.log(chalk.gray("--- End Rebuilt Conversation ---\n"));
    }
  } else {
    store = {
      sessionId: crypto.randomUUID(),
      prompt: options.prompt || defaultPrompt,
      createdAt: new Date().toISOString(),
      checkpoints: [],
    };
    initialMessages = [{ role: "user", content: store.prompt }];
  }

  log.header("Checkpoint Agent Runner (Claude Code)");
  log.info(`Session ID: ${store.sessionId}`);
  log.info(`Prompt: ${store.prompt}`);
  log.info(`Starting from step: ${startStep}`);
  log.info(`Working directory: ${process.cwd()}`);

  // Track step number for onStepFinish callback (closure variable)
  let stepNumber = startStep;

  try {
    const result = streamText({
      model: claudeCode("haiku", {
        streamingInput: "always",
        canUseTool: allowAllTools,
        permissionMode: "bypassPermissions",
        allowedTools: ["Bash", "Read", "Glob", "Grep", "LS"],
        cwd: process.cwd(),
      }),
      stopWhen: ({ steps }) => {
        const lastStep = steps[steps.length - 1];
        const shouldStop = lastStep.finishReason === "stop" || lastStep.toolCalls.length === 0;

        console.log(chalk.red(`\n[stopWhen] Evaluating after ${steps.length} step(s)`));
        console.log(chalk.red(`[stopWhen] Last step finish reason: ${lastStep.finishReason}`));
        console.log(chalk.red(`[stopWhen] Last step tool calls: ${lastStep.toolCalls.length}`));
        console.log(chalk.red(`[stopWhen] Last step text: ${lastStep.text?.substring(0, 100) || "(none)"}${lastStep.text && lastStep.text.length > 100 ? "..." : ""}`));
        console.log(chalk.red.bold(`[stopWhen] Should stop: ${shouldStop}`));

        return shouldStop;
      },
      onStepFinish: (step) => {
        stepNumber++;
        log.event("onStepFinish", `Step ${stepNumber} finished with reason: ${step.finishReason}`);

        // Build checkpoint from step data
        const toolCalls: ToolCallRecord[] = step.toolCalls.map((tc: any) => ({
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          args: tc.input ?? tc.args,
        }));

        const toolResults: ToolResultRecord[] = step.toolResults.map((tr: any) => ({
          toolCallId: tr.toolCallId,
          toolName: tr.toolName,
          result: (tr as any).output ?? (tr as any).result,
        }));

        // Build messages for checkpoint
        const messages: CoreMessage[] = [];

        // Add assistant message with tool calls
        if (step.toolCalls.length > 0) {
          messages.push({
            role: "assistant",
            content: step.toolCalls.map((tc: any) => ({
              type: "tool-call" as const,
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              input: tc.input ?? tc.args,
            })),
          } as CoreMessage);

          // Add tool results
          for (const tr of step.toolResults) {
            const rawOutput = (tr as any).output ?? (tr as any).result;
            const formattedOutput = typeof rawOutput === "string"
              ? { type: "text" as const, value: rawOutput }
              : typeof rawOutput === "object" && rawOutput !== null && "type" in rawOutput
                ? rawOutput
                : { type: "json" as const, value: rawOutput };

            messages.push({
              role: "tool",
              content: [{
                type: "tool-result" as const,
                toolCallId: tr.toolCallId,
                toolName: tr.toolName,
                output: formattedOutput,
              }],
            } as CoreMessage);
          }
        }

        // Add text response if present
        if (step.text) {
          messages.push({
            role: "assistant",
            content: step.text,
          });
        }

        // Save checkpoint
        if (toolCalls.length > 0 || step.text) {
          const checkpoint: Checkpoint = {
            stepNumber,
            timestamp: new Date().toISOString(),
            messages,
            toolCalls,
            toolResults,
            text: step.text || undefined,
            finishReason: step.finishReason,
          };
          store.checkpoints.push(checkpoint);
          saveCheckpoint(store);
          log.checkpoint(stepNumber);
        }
      },
      messages: initialMessages,
      maxSteps: 10,
    });

    log.info("Streaming Claude Code response...\n");

    const stream = result.fullStream as AsyncIterable<any>;

    // Track step number for stream logging (separate from onStepFinish)
    let streamStepNumber = startStep;

    for await (const part of stream) {
      switch (part.type) {
        case "start":
          log.event("start", "Generation started");
          break;

        case "start-step":
          streamStepNumber++;
          log.step(streamStepNumber);
          break;

        case "stream-start":
          log.event("stream-start", "Stream started");
          break;

        case "response-metadata":
          log.event("metadata", `Session ${part.id ?? "unknown"} (model ${part.modelId ?? "unknown"})`);
          break;

        case "tool-input-start":
          log.toolInputStart(part.toolName, part.id);
          break;

        case "tool-input-delta":
          log.toolInputDelta(part.delta);
          break;

        case "tool-input-end":
          log.event("tool-input-end", `Tool input complete (${part.id})`);
          break;

        case "tool-call":
          log.toolCall(part.toolName, part.toolCallId, part.args ?? part.input);
          break;

        case "tool-result":
          log.toolResult(part.toolName, part.toolCallId, part.result ?? part.output);
          break;

        case "tool-error":
          log.toolError(part.toolName, part.error);
          break;

        case "text-start":
          log.event("text-start", "Text generation started");
          break;

        case "text-delta": {
          const chunk = part.delta ?? part.text;
          if (typeof chunk === "string") {
            log.textDelta(chunk);
          }
          break;
        }

        case "text-end":
          console.log(); // New line after text
          log.event("text-end", "Text generation complete");
          break;

        case "finish-step":
          log.event("finish-step", `Step finished: ${part.finishReason}`);
          // Checkpoint saving is handled by onStepFinish callback
          break;

        case "finish":
          log.event("finish", `Generation complete: ${part.finishReason}`);
          if (part.usage) {
            log.info(`Usage: ${JSON.stringify(part.usage)}`);
          }
          break;

        case "error":
          log.error(`Stream error: ${part.error}`);
          break;

        default:
          log.event(part.type, JSON.stringify(part).substring(0, 100));
          break;
      }
    }

    log.header("Agent Completed");
    log.success(`Total checkpoints saved: ${store.checkpoints.length}`);

  } catch (error) {
    log.error(`Agent failed: ${error}`);
    log.info(`Checkpoints saved: ${store.checkpoints.length}`);
    throw error;
  }
}

// CLI argument parsing
const args = process.argv.slice(2);
const options: {
  prompt?: string;
  resume?: boolean;
  fromStep?: number;
  list?: boolean;
} = {};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--resume" || arg === "-r") {
    options.resume = true;
  } else if (arg === "--list" || arg === "-l") {
    options.list = true;
  } else if (arg === "--from" || arg === "-f") {
    options.fromStep = parseInt(args[++i], 10);
  } else if (arg === "--prompt" || arg === "-p") {
    options.prompt = args[++i];
  } else if (arg === "--help" || arg === "-h") {
    console.log(`
${chalk.bold("Checkpoint Agent Runner (Claude Code)")}

Usage:
  bun scripts/checkpoint-agent.ts [options]

Options:
  --prompt, -p <text>   Set the initial prompt
  --resume, -r          Resume from last checkpoint (interactive selection)
  --from, -f <step>     Resume from specific step number
  --list, -l            List available checkpoints
  --help, -h            Show this help message

Examples:
  # Run with custom prompt
  bun scripts/checkpoint-agent.ts --prompt "List files and read the README"

  # List checkpoints
  bun scripts/checkpoint-agent.ts --list

  # Resume from step 2
  bun scripts/checkpoint-agent.ts --from 2

  # Interactive resume
  bun scripts/checkpoint-agent.ts --resume

Claude Code Tools Available:
  - Bash: Execute shell commands
  - Read: Read file contents
  - Glob: Find files by pattern
  - Grep: Search file contents
  - LS: List directory contents
`);
    process.exit(0);
  }
}

// Run the agent
runAgent(options).catch((error) => {
  console.error(error);
  process.exit(1);
});
