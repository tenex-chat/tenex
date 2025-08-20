import { promises as fs } from "node:fs";
import * as path from "node:path";
import { ConversationCoordinator } from "@/conversations/ConversationCoordinator";
import type { LLMCallLogEntry } from "@/llm/callLogger";
import type { ToolCallLogEntry } from "@/tools/toolLogger";
import { formatDuration } from "@/utils/formatting";
import { logError, logInfo, logWarning } from "@/utils/logger";
import chalk from "chalk";
import type { CommandModule } from "yargs";
import { selectConversation } from "./conversationSelector";

interface TimelineEvent {
  timestamp: number;
  type: "conversation_start" | "llm_call" | "tool_call" | "phase_transition" | "message";
  agent?: string;
  description: string;
  details?: Record<string, unknown>;
  duration?: number;
}

export const timeline: CommandModule<Record<string, never>, { conversationId?: string }> = {
  command: "timeline [conversationId]",
  describe: "Display a timeline of all events in a conversation",

  builder: (yargs) => {
    return yargs.positional("conversationId", {
      describe: "The conversation ID to analyze (if not provided, shows a list)",
      type: "string",
      demandOption: false,
    });
  },

  async handler(argv) {
    try {
      const projectPath = process.cwd();

      // Initialize conversation manager
      const conversationManager = new ConversationCoordinator(projectPath);
      await conversationManager.initialize();

      // Get conversation ID either from argument or selector
      let conversationId = argv.conversationId;
      if (!conversationId) {
        const selectedId = await selectConversation(conversationManager);
        if (!selectedId) {
          logWarning("No conversation selected.");
          process.exit(0);
        }
        conversationId = selectedId;
      }

      logInfo(chalk.bold.blue(`\n📊 Timeline Analysis for Conversation: ${conversationId}\n`));

      // Get conversation data
      const conversation = conversationManager.getConversation(conversationId);
      if (!conversation) {
        logError(`Conversation ${conversationId} not found`);
        process.exit(1);
      }

      // Collect all timeline events
      const events: TimelineEvent[] = [];

      // Get the conversation start time from the first event
      const startedAt = conversation.history[0]?.created_at
        ? conversation.history[0].created_at * 1000
        : Date.now();

      // 1. Add conversation start
      events.push({
        timestamp: startedAt,
        type: "conversation_start",
        description: `Conversation started: "${conversation.title}"`,
        details: {
          phase: conversation.phase,
          title: conversation.title,
        },
      });

      // 2. Add phase transitions
      for (const transition of conversation.phaseTransitions) {
        events.push({
          timestamp: transition.timestamp,
          type: "phase_transition",
          agent: transition.agentName,
          description: `Phase: ${transition.from} → ${transition.to}`,
          details: {
            message: `${transition.message?.substring(0, 100)}...`,
          },
        });
      }

      // 3. Load LLM calls
      const llmLogPath = path.join(projectPath, ".tenex", "logs", "llms");
      const llmLogFiles = await findLogFiles(llmLogPath, conversationId);

      for (const file of llmLogFiles) {
        const content = await fs.readFile(file, "utf-8");
        const lines = content.split("\n").filter(Boolean);

        for (const line of lines) {
          try {
            const entry: LLMCallLogEntry = JSON.parse(line);

            // Only include entries for this conversation
            if (entry.request.options?.conversationId !== conversationId) continue;

            events.push({
              timestamp: entry.timestampMs,
              type: "llm_call",
              agent: entry.agentName,
              description: `LLM Call: ${entry.config.model}`,
              details: {
                model: entry.config.model,
                provider: entry.config.provider,
                messageCount: entry.request.messageCount,
                status: entry.status,
                tokensUsed: entry.response?.usage?.totalTokens,
                reasoning: extractReasoning(entry.response?.content),
              },
              duration: entry.durationMs,
            });
          } catch {
            // Skip invalid lines
          }
        }
      }

      // 4. Load tool calls
      const toolLogPath = path.join(projectPath, ".tenex", "logs", "tools");
      const toolLogFiles = await findLogFiles(toolLogPath, conversationId);

      for (const file of toolLogFiles) {
        const content = await fs.readFile(file, "utf-8");
        const lines = content.split("\n").filter(Boolean);

        for (const line of lines) {
          try {
            const entry: ToolCallLogEntry = JSON.parse(line);

            // Only include entries for this conversation
            if (entry.conversationId !== conversationId) continue;

            events.push({
              timestamp: entry.timestampMs,
              type: "tool_call",
              agent: entry.agentName,
              description: `Tool: ${entry.toolName}`,
              details: {
                tool: entry.toolName,
                status: entry.status,
                phase: entry.phase,
                error: entry.error,
                metadata: entry.metadata,
              },
              duration: entry.performance.durationMs,
            });
          } catch {
            // Skip invalid lines
          }
        }
      }

      // 5. Add messages from history
      for (const event of conversation.history) {
        const timestamp = event.created_at ? event.created_at * 1000 : Date.now();
        const agentTag = event.tags.find((tag) => tag[0] === "agent");
        const agent = agentTag ? agentTag[1] : undefined;

        events.push({
          timestamp,
          type: "message",
          agent,
          description: `${event.content?.substring(0, 80)}...` || "Empty message",
          details: {
            eventId: event.id,
            tags: event.tags,
          },
        });
      }

      // Sort events by timestamp
      events.sort((a, b) => a.timestamp - b.timestamp);

      // Display timeline
      logInfo(chalk.bold("Timeline:\n"));

      let lastTimestamp = startedAt;
      for (const event of events) {
        const timeSinceLast = event.timestamp - lastTimestamp;
        const timeOffset = event.timestamp - startedAt;

        // Format timestamp
        const time = new Date(event.timestamp).toLocaleTimeString();
        const relativeTime = formatDuration(timeOffset);

        // Choose color based on event type
        let color = chalk.white;
        let icon = "📌";
        switch (event.type) {
          case "conversation_start":
            color = chalk.green;
            icon = "🚀";
            break;
          case "phase_transition":
            color = chalk.cyan;
            icon = "🔄";
            break;
          case "llm_call":
            color = chalk.magenta;
            icon = "🤖";
            break;
          case "tool_call":
            color = chalk.yellow;
            icon = "🔧";
            break;
          case "message":
            color = chalk.blue;
            icon = "💬";
            break;
        }

        // Main timeline entry
        logInfo(color(`${icon} [${time}] +${relativeTime} ${event.description}`));

        // Agent info
        if (event.agent) {
          logInfo(chalk.gray(`   Agent: ${event.agent}`));
        }

        // Duration
        if (event.duration) {
          logInfo(chalk.gray(`   Duration: ${formatDuration(event.duration)}`));
        }

        // Key details
        if (event.details) {
          for (const [key, value] of Object.entries(event.details)) {
            if (value && key !== "reasoning") {
              logInfo(chalk.gray(`   ${key}: ${String(value)}`));
            }
          }

          // Show reasoning separately if present
          if (event.details.reasoning) {
            logInfo(chalk.italic.gray(`   Reasoning: ${event.details.reasoning}`));
          }
        }

        // Time gap indicator
        if (timeSinceLast > 5000) {
          logInfo(chalk.dim(`   [${formatDuration(timeSinceLast)} gap]`));
        }

        logInfo("");
        lastTimestamp = event.timestamp;
      }

      // Summary statistics
      const totalDuration =
        conversation.executionTime?.totalSeconds ||
        ((events[events.length - 1]?.timestamp || 0) - startedAt) / 1000;

      const llmCalls = events.filter((e) => e.type === "llm_call").length;
      const toolCalls = events.filter((e) => e.type === "tool_call").length;
      const phaseTransitions = events.filter((e) => e.type === "phase_transition").length;

      logInfo(chalk.bold("\n📈 Summary Statistics:\n"));
      logInfo(`Total Duration: ${formatDuration(totalDuration * 1000)}`);
      logInfo(`Total Events: ${events.length}`);
      logInfo(`LLM Calls: ${llmCalls}`);
      logInfo(`Tool Calls: ${toolCalls}`);
      logInfo(`Phase Transitions: ${phaseTransitions}`);
      logInfo(`Final Phase: ${conversation.phase}`);

      // Performance insights
      const avgLLMDuration =
        events
          .filter((e) => e.type === "llm_call" && e.duration)
          .reduce((sum, e) => sum + (e.duration || 0), 0) / (llmCalls || 1);

      const avgToolDuration =
        events
          .filter((e) => e.type === "tool_call" && e.duration)
          .reduce((sum, e) => sum + (e.duration || 0), 0) / (toolCalls || 1);

      if (llmCalls > 0) {
        logInfo(`Avg LLM Response Time: ${formatDuration(avgLLMDuration)}`);
      }
      if (toolCalls > 0) {
        logInfo(`Avg Tool Execution Time: ${formatDuration(avgToolDuration)}`);
      }
    } catch (error) {
      logError("Error generating timeline:", error);
      process.exit(1);
    }
  },
};

// Helper function to find log files
async function findLogFiles(logDir: string, _conversationId: string): Promise<string[]> {
  try {
    const files = await fs.readdir(logDir);
    return files.filter((f) => f.endsWith(".jsonl")).map((f) => path.join(logDir, f));
  } catch {
    return [];
  }
}

// Helper function to format duration

// Helper function to extract reasoning from LLM response
function extractReasoning(content?: string): string | undefined {
  if (!content) return undefined;

  const thinkingMatch = content.match(/<thinking>([\s\S]*?)<\/thinking>/);
  if (thinkingMatch?.[1]) {
    const thinking = thinkingMatch[1].trim();
    // Extract key decision if present
    const decisionMatch = thinking.match(/- Decision: (.+)/);
    if (decisionMatch?.[1]) {
      return decisionMatch[1].trim();
    }
    // Otherwise return first line of thinking
    return thinking.split("\n")[0]?.substring(0, 100) || "";
  }

  return undefined;
}
