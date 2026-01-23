#!/usr/bin/env npx tsx
/**
 * Debug Tool Failure Script
 *
 * Tests what events and callbacks are emitted when a Claude Code tool
 * execution FAILS (e.g., file not found).
 *
 * Purpose: Understand why `tool-did-execute` events are sometimes not emitted.
 *
 * Usage:
 *   npx tsx scripts/debug-tool-failure.ts
 */

import { streamText } from "ai";
import { claudeCode } from "ai-sdk-provider-claude-code";

// Simple colored logging
const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  bold: "\x1b[1m",
};

function log(color: keyof typeof colors, prefix: string, message: string, data?: unknown) {
  const timestamp = new Date().toISOString().substring(11, 23);
  const colorCode = colors[color];
  const dataStr = data !== undefined ? `\n${colors.gray}    ${JSON.stringify(data, null, 2).split("\n").join("\n    ")}${colors.reset}` : "";
  console.log(`${colors.gray}[${timestamp}]${colors.reset} ${colorCode}[${prefix}]${colors.reset} ${message}${dataStr}`);
}

async function main() {
  console.log(`${colors.bold}${colors.cyan}
================================================================================
  DEBUG TOOL FAILURE SCRIPT
  Testing events when tool execution FAILS (file not found)
================================================================================
${colors.reset}`);

  log("cyan", "INFO", "Starting streamText with Claude Code provider");
  log("cyan", "INFO", `Working directory: ${process.cwd()}`);
  log("cyan", "INFO", "Prompt: Read the file /tmp/this-file-does-not-exist-12345.txt");

  try {
    const result = streamText({
      model: claudeCode("haiku", {
        permissionMode: "bypassPermissions",
        allowedTools: ["Read", "Bash", "Glob"],
        cwd: process.cwd(),
      }),
      messages: [
        {
          role: "user",
          content: "Read the file /tmp/this-file-does-not-exist-12345.txt and tell me what's in it.",
        },
      ],
      maxSteps: 5,

      // Callback: onChunk
      onChunk: ({ chunk }) => {
        log("yellow", "onChunk", `type=${chunk.type}`, chunk);
      },

      // Callback: onStepFinish
      onStepFinish: (step) => {
        log("magenta", "onStepFinish", `finishReason=${step.finishReason}`, {
          text: step.text?.substring(0, 200),
          toolCallsCount: step.toolCalls.length,
          toolResultsCount: step.toolResults.length,
          toolCalls: step.toolCalls.map((tc: any) => ({
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            args: tc.input ?? tc.args,
          })),
          toolResults: step.toolResults.map((tr: any) => ({
            toolCallId: tr.toolCallId,
            toolName: tr.toolName,
            result: typeof (tr.output ?? tr.result) === "string"
              ? (tr.output ?? tr.result).substring(0, 300)
              : tr.output ?? tr.result,
          })),
        });
      },

      // Callback: onError
      onError: ({ error }) => {
        log("red", "onError", "Error received!", error);
      },

      // Callback: onFinish
      onFinish: (result) => {
        log("green", "onFinish", "Stream finished!", {
          finishReason: result.finishReason,
          text: result.text?.substring(0, 200),
          usage: result.usage,
          stepsCount: result.steps?.length,
          toolCallsCount: result.toolCalls?.length,
          toolResultsCount: result.toolResults?.length,
        });
      },
    });

    log("cyan", "INFO", "Consuming fullStream...");

    // Process the full stream to see all events
    const stream = result.fullStream as AsyncIterable<any>;

    for await (const part of stream) {
      // Log every stream event with full details
      switch (part.type) {
        case "start":
          log("blue", "STREAM", "start - Generation started");
          break;

        case "start-step":
          log("blue", "STREAM", "start-step - New step beginning");
          break;

        case "stream-start":
          log("blue", "STREAM", "stream-start - Stream started");
          break;

        case "response-metadata":
          log("blue", "STREAM", "response-metadata", {
            id: part.id,
            modelId: part.modelId,
          });
          break;

        case "tool-input-start":
          log("green", "STREAM", `tool-input-start - Tool: ${part.toolName}`, {
            toolName: part.toolName,
            id: part.id,
          });
          break;

        case "tool-input-delta":
          log("green", "STREAM", `tool-input-delta`, {
            delta: part.delta?.substring(0, 100),
          });
          break;

        case "tool-input-end":
          log("green", "STREAM", `tool-input-end - id=${part.id}`);
          break;

        case "tool-call":
          log("green", "STREAM", `tool-call - ${part.toolName}`, {
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            args: part.args ?? part.input,
          });
          break;

        case "tool-result":
          log("cyan", "STREAM", `tool-result - ${part.toolName}`, {
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            result: typeof (part.result ?? part.output) === "string"
              ? (part.result ?? part.output).substring(0, 500)
              : part.result ?? part.output,
          });
          break;

        case "tool-error":
          log("red", "STREAM", `tool-error - ${part.toolName}`, {
            toolName: part.toolName,
            error: part.error,
          });
          break;

        case "tool-did-execute":
          log("magenta", "STREAM", `tool-did-execute - ${part.toolName}`, part);
          break;

        case "text-start":
          log("blue", "STREAM", "text-start");
          break;

        case "text-delta":
          const text = part.delta ?? part.text;
          if (text) {
            process.stdout.write(`${colors.gray}${text}${colors.reset}`);
          }
          break;

        case "text-end":
          console.log(); // newline after text
          log("blue", "STREAM", "text-end");
          break;

        case "finish-step":
          log("blue", "STREAM", `finish-step - reason=${part.finishReason}`, {
            finishReason: part.finishReason,
            usage: part.usage,
          });
          break;

        case "finish":
          log("green", "STREAM", `finish - reason=${part.finishReason}`, {
            finishReason: part.finishReason,
            usage: part.usage,
          });
          break;

        case "error":
          log("red", "STREAM", `error`, {
            error: part.error,
          });
          break;

        default:
          // Log any unknown event types
          log("yellow", "STREAM", `UNKNOWN EVENT: ${part.type}`, part);
          break;
      }
    }

    // Wait for the final result
    const finalText = await result.text;
    const finalUsage = await result.usage;

    log("cyan", "INFO", "Final result obtained", {
      text: typeof finalText === "string" ? finalText.substring(0, 200) : finalText,
      usage: finalUsage,
    });

    console.log(`${colors.bold}${colors.green}
================================================================================
  DEBUG COMPLETE
================================================================================
${colors.reset}`);

  } catch (error) {
    log("red", "ERROR", "Caught exception!", error);
    console.error(error);
    process.exit(1);
  }
}

main();
