import { ClaudeCodeExecutor, type ClaudeCodeResult } from "@/claude/executor";
import { formatAnyError } from "@/utils/error-formatter";
import { colorizeJSON } from "@/utils/formatting";
import { logDebug, logError, logInfo } from "@/utils/logger";
import type { SDKMessage } from "@anthropic-ai/claude-code";
import type { TextBlock } from "@anthropic-ai/sdk/resources/messages/messages";
import chalk from "chalk";

interface DebugClaudeCodeOptions {
  timeout?: number;
}

export async function runDebugClaudeCode(
  prompt: string,
  options: DebugClaudeCodeOptions
): Promise<void> {
  try {
    const projectPath = process.cwd();

    logInfo("Starting Claude Code debug execution...");
    console.log(chalk.cyan("\n=== Claude Code Debug ==="));
    console.log(chalk.gray("Project Path:"), projectPath);
    console.log(chalk.gray("Prompt:"), prompt);
    if (options.timeout) {
      console.log(chalk.gray("Timeout:"), `${options.timeout}ms`);
    }
    console.log(chalk.cyan("========================\n"));

    // Create executor with options
    const executor = new ClaudeCodeExecutor({
      prompt,
      projectPath,
      timeout: options.timeout,
    });

    // Track message types for summary
    const messageTypeCounts: Record<string, number> = {};
    let lastAssistantMessage = "";

    // Execute and stream messages
    console.log(chalk.yellow("Streaming SDK messages...\n"));

    // Create the generator
    const generator = executor.execute();
    let finalResult: ClaudeCodeResult;

    // Process messages using the same pattern as ClaudeTaskOrchestrator
    while (true) {
      const { value, done } = await generator.next();

      if (done) {
        // The value is the final ClaudeCodeResult
        finalResult = value;
        break;
      }

      // value is an SDKMessage
      const message = value;

      // Track message type counts
      messageTypeCounts[message.type] = (messageTypeCounts[message.type] || 0) + 1;

      // Display message based on type
      displaySDKMessage(message);

      // Track last assistant message for summary
      if (message.type === "assistant" && message.message?.content) {
        const content = message.message.content as Array<TextBlock | { type: string }>;
        lastAssistantMessage = content
          .filter((c): c is TextBlock => c.type === "text")
          .map((c) => c.text)
          .join("");
      }
    }

    // Display execution summary
    console.log(chalk.cyan("\n\n=== Execution Summary ==="));
    console.log(chalk.white("Success:"), finalResult.success ? chalk.green("✓") : chalk.red("✗"));
    console.log(chalk.white("Session ID:"), finalResult.sessionId || "N/A");
    console.log(chalk.white("Duration:"), `${finalResult.duration}ms`);
    console.log(chalk.white("Total Cost:"), `$${finalResult.totalCost.toFixed(4)}`);
    console.log(chalk.white("Message Count:"), finalResult.messageCount);

    if (finalResult.error) {
      console.log(chalk.red("Error:"), finalResult.error);
    }

    // Display message type breakdown
    console.log(chalk.cyan("\n=== Message Types ==="));
    Object.entries(messageTypeCounts)
      .sort(([a], [b]) => a.localeCompare(b))
      .forEach(([type, count]) => {
        console.log(chalk.gray(`  ${type}:`), count);
      });

    // Display last assistant message if available
    if (lastAssistantMessage) {
      console.log(chalk.cyan("\n=== Last Assistant Response ==="));
      console.log(lastAssistantMessage);
    }

    console.log(chalk.cyan("\n========================\n"));
    logInfo("Claude Code debug execution completed");
  } catch (err) {
    const errorMessage = formatAnyError(err);
    logError(`Failed to execute Claude Code debug: ${errorMessage}`);
    console.error(chalk.red("\nError:"), errorMessage);
    process.exit(1);
  }
}

/**
 * Display an SDK message with appropriate formatting
 */
function displaySDKMessage(message: SDKMessage): void {
  const timestamp = new Date().toISOString();

  const messageType = message.type as string;
  switch (messageType) {
    case "start":
      console.log(chalk.blue(`[${timestamp}] START`));
      console.log(
        chalk.gray("Session ID:"),
        (message as SDKMessage & { session_id?: string }).session_id || "N/A"
      );
      break;

    case "human":
      console.log(chalk.green(`[${timestamp}] HUMAN`));
      if ((message as SDKMessage & { message?: { content: string } }).message?.content) {
        const msg = (message as SDKMessage & { message?: { content: string } }).message;
        if (msg?.content) {
          console.log(chalk.gray("Content:"), msg.content);
        }
      }
      break;

    case "assistant":
      console.log(chalk.magenta(`[${timestamp}] ASSISTANT`));
      if (
        "message" in message &&
        (message as SDKMessage & { message?: { content: unknown[] } }).message?.content
      ) {
        const blocks = (message as SDKMessage & { message: { content: unknown[] } }).message
          .content as Array<TextBlock | { type: string; name?: string; input?: unknown }>;
        blocks.forEach((block) => {
          if (block.type === "text") {
            console.log(chalk.gray("Text:"), (block as TextBlock).text);
          } else if (block.type === "tool_use") {
            const toolBlock = block as { type: string; name: string; input: unknown };
            console.log(chalk.yellow("Tool Use:"), toolBlock.name);
            console.log(
              chalk.gray("Input:"),
              colorizeJSON(JSON.stringify(toolBlock.input, null, 2))
            );
          }
        });
      }
      break;

    case "tool":
      console.log(chalk.yellow(`[${timestamp}] TOOL`));
      if ("tool_name" in message) {
        console.log(
          chalk.gray("Tool:"),
          (message as SDKMessage & { tool_name?: string }).tool_name || "unknown"
        );
      }
      if (
        "tool_result" in message &&
        (message as SDKMessage & { tool_result?: unknown }).tool_result
      ) {
        const toolMessage = message as SDKMessage & { tool_result?: unknown };
        const result =
          typeof toolMessage.tool_result === "string"
            ? toolMessage.tool_result
            : JSON.stringify(toolMessage.tool_result, null, 2);

        // Truncate very long results
        const maxLength = 500;
        if (result.length > maxLength) {
          console.log(chalk.gray("Result:"), `${result.substring(0, maxLength)}... [truncated]`);
        } else {
          console.log(chalk.gray("Result:"), result);
        }
      }
      break;

    case "result":
      console.log(chalk.cyan(`[${timestamp}] RESULT`));
      if ("total_cost_usd" in message) {
        console.log(chalk.gray("Total Cost:"), `$${message.total_cost_usd}`);
      }
      break;

    case "error":
      console.log(chalk.red(`[${timestamp}] ERROR`));
      if ("error" in message && (message as SDKMessage & { error?: string }).error) {
        console.log(chalk.red("Error:"), (message as SDKMessage & { error?: string }).error);
      }
      break;

    default:
      // Log unknown message types for debugging
      console.log(chalk.gray(`[${timestamp}] ${message.type.toUpperCase()}`));
      logDebug(`Unknown message type: ${message.type}`, "general", "debug", message);
  }

  console.log(); // Empty line for readability
}
