import { AgentRegistry } from "@/agents/AgentRegistry";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { buildSystemPromptMessages } from "@/prompts/utils/systemPromptBuilder";
import { getProjectContext } from "@/services";
import { mcpService } from "@/services/mcp/MCPManager";
// Tool type removed - using AI SDK tools only
import { handleCliError } from "@/utils/cli-error";
import { colorizeJSON, formatMarkdown } from "@/utils/formatting";
import { logger } from "@/utils/logger";
import { ensureProjectInitialized } from "@/utils/projectInitialization";
import chalk from "chalk";
import { ThreadedConversationFormatter } from "@/conversations/formatters/ThreadedConversationFormatter";
import { NDKFilter, NDKEvent } from "@nostr-dev-kit/ndk";
import { getNDK } from "@/nostr/ndkClient";
import inquirer from "inquirer";
import {
  ThreadWithMemoryStrategy,
  FlattenedChronologicalStrategy,
  type MessageGenerationStrategy
} from "@/agents/execution/strategies";
import type { ExecutionContext } from "@/agents/execution/types";
import { ConversationCoordinator } from "@/conversations/services/ConversationCoordinator";
import { DelegationRegistry } from "@/services/DelegationRegistry";

// Format content with enhancements
function formatContentWithEnhancements(content: string, isSystemPrompt = false): string {
  let formattedContent = content.replace(/\\n/g, "\n");

  if (isSystemPrompt) {
    formattedContent = formatMarkdown(formattedContent);
  }

  // Handle <tool_use> blocks
  formattedContent = formattedContent.replace(
    /<tool_use>([\s\S]*?)<\/tool_use>/g,
    (_match, jsonContent) => {
      try {
        const parsed = JSON.parse(jsonContent.trim());
        const formatted = JSON.stringify(parsed, null, 2);
        return chalk.gray("<tool_use>\n") + colorizeJSON(formatted) + chalk.gray("\n</tool_use>");
      } catch {
        return chalk.gray("<tool_use>") + jsonContent + chalk.gray("</tool_use>");
      }
    }
  );

  return formattedContent;
}

interface DebugSystemPromptOptions {
  agent: string;
  phase: string;
}

interface DebugThreadedFormatterOptions {
  conversationId: string;
  strategy?: string;
  agent?: string;
}

export async function runDebugSystemPrompt(options: DebugSystemPromptOptions): Promise<void> {
  try {
    const projectPath = process.cwd();

    // Initialize project context if needed
    await ensureProjectInitialized(projectPath);

    // Load agent from registry
    const agentRegistry = new AgentRegistry(projectPath, false);
    await agentRegistry.loadFromProject();
    const agent = agentRegistry.getAgent(options.agent);

    logger.info(chalk.cyan("\n=== Agent Information ==="));
    if (agent) {
      logger.info(`${chalk.white("Name:")} ${agent.name}`);
      logger.info(`${chalk.white("Role:")} ${agent.role}`);
      if (options.phase) {
        logger.info(`${chalk.white("Phase:")} ${options.phase}`);
      }
      if (agent.tools && agent.tools.length > 0) {
        logger.info(`${chalk.white("Tools:")} ${agent.tools.join(", ")}`);
      }
    } else {
      logger.warn(`Note: Agent '${options.agent}' not found in registry`);
    }

    logger.info(chalk.cyan("\n=== System Prompt ==="));

    if (agent) {
      const projectCtx = getProjectContext();

      // Get all available agents for delegations
      const availableAgents = Array.from(projectCtx.agents.values());

      // Initialize MCP service to get tools
      let mcpTools: Record<string, unknown> = {};
      try {
        await mcpService.initialize(projectPath);
        mcpTools = mcpService.getCachedTools();
        logger.info(`Loaded ${Object.keys(mcpTools).length} MCP tools`);
      } catch (error) {
        logger.error(`Failed to initialize MCP service: ${error}`);
        // Continue without MCP tools - don't fail the whole debug command
      }

      // Build system prompt using the shared function - exactly as production does
      // Only pass the current agent's lessons
      const agentLessonsMap = new Map<string, NDKAgentLesson[]>();
      const currentAgentLessons = projectCtx.getLessonsForAgent(agent.pubkey);
      if (currentAgentLessons.length > 0) {
        agentLessonsMap.set(agent.pubkey, currentAgentLessons);
      }

      // Check if this agent is the project manager
      const isProjectManager = agent.pubkey === projectCtx.getProjectManager().pubkey;

      const systemMessages = await buildSystemPromptMessages({
        agent,
        project: projectCtx.project,
        availableAgents,
        conversation: undefined, // No conversation in debug mode
        agentLessons: agentLessonsMap,
        isProjectManager,
      });

      // Display each system message separately with metadata
      logger.info(chalk.bold.cyan("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
      logger.info(chalk.bold.cyan("                    SYSTEM PROMPT MESSAGES"));
      logger.info(chalk.bold.cyan("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"));

      for (let i = 0; i < systemMessages.length; i++) {
        const msg = systemMessages[i];

        // Display message metadata
        console.log(chalk.bold.yellow(`\n─── Message ${i + 1} ───`));
        if (msg.metadata?.description) {
          console.log(chalk.dim(`Description: ${msg.metadata.description}`));
        }
        if (msg.metadata?.cacheable) {
          console.log(chalk.green(`✓ Cacheable (key: ${msg.metadata.cacheKey})`));
        }
        console.log();

        // Format and display message content
        const formattedContent = formatContentWithEnhancements(msg.message.content, true);
        console.log(formattedContent);

        if (i < systemMessages.length - 1) {
          console.log(chalk.dim(`\n${"─".repeat(60)}\n`));
        }
      }

      console.log(
        chalk.bold.cyan("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n")
      );
    } else {
      console.log(chalk.yellow(`Agent '${options.agent}' not found in registry`));
    }

    console.log(chalk.cyan("===================\n"));

    logger.info("System prompt displayed successfully");
    process.exit(0);
  } catch (err) {
    handleCliError(err, "Failed to generate system prompt");
  }
}

export async function runDebugThreadedFormatter(options: DebugThreadedFormatterOptions): Promise<void> {
  try {
    const projectPath = process.cwd();
    await ensureProjectInitialized(projectPath);

    const projectCtx = getProjectContext();
    const ndk = getNDK();

    // Select strategy
    let strategyName = options.strategy;
    if (!strategyName) {
      const answer = await inquirer.prompt([
        {
          type: 'list',
          name: 'strategy',
          message: 'Select a message generation strategy:',
          choices: [
            { name: 'Threaded with Memory (shows tree structure with other branches)', value: 'threaded-with-memory' },
            { name: 'Flattened Chronological (flattened chronological view with delegation markers)', value: 'flattened-chronological' }
          ]
        }
      ]);
      strategyName = answer.strategy;
    }

    logger.info(chalk.cyan("\n=== Fetching Conversation ==="));
    logger.info(`Conversation ID: ${options.conversationId.substring(0, 16)}...`);
    logger.info(`Strategy: ${chalk.yellow(strategyName)}`);

    // Fetch the root event and all replies in the conversation
    const [rootEvents, replyEvents] = await Promise.all([
      ndk.fetchEvents({
        kinds: [1111],
        ids: [options.conversationId]
      }),
      ndk.fetchEvents({
        kinds: [1111],
        "#E": [options.conversationId]
      })
    ]);

    const eventArray = [...Array.from(rootEvents), ...Array.from(replyEvents)]
      .sort((a, b) => a.created_at! - b.created_at!);

    logger.info(`Found ${eventArray.length} events in conversation`);

    if (eventArray.length === 0) {
      logger.warn("No events found in conversation");
      process.exit(0);
    }

    // Find the triggering event (last event in conversation)
    const triggeringEvent = eventArray[eventArray.length - 1];

    // Get the first agent from the project to use as context
    const agents = Array.from(projectCtx.agents.values());
    if (agents.length === 0) {
      logger.error("No agents found in project");
      process.exit(1);
    }

    // Select agent (from flag or interactively)
    let agentSlug = options.agent;
    if (!agentSlug) {
      const agentAnswer = await inquirer.prompt([
        {
          type: 'list',
          name: 'agentSlug',
          message: 'Select agent perspective:',
          choices: agents.map(agent => ({ name: agent.name, value: agent.slug }))
        }
      ]);
      agentSlug = agentAnswer.agentSlug;
    }

    const selectedAgent = agents.find(a => a.slug === agentSlug);
    if (!selectedAgent) {
      logger.error(`Agent '${agentSlug}' not found`);
      process.exit(1);
    }

    logger.info(`Viewing from ${chalk.green(selectedAgent.name)}'s perspective`);

    // Create a strategy instance
    let strategy: MessageGenerationStrategy;
    if (strategyName === 'flattened-chronological') {
      strategy = new FlattenedChronologicalStrategy();
    } else {
      strategy = new ThreadWithMemoryStrategy();
    }

    // Initialize DelegationRegistry
    await DelegationRegistry.initialize();

    // Create a mock execution context
    const conversationCoordinator = new ConversationCoordinator(projectPath);
    await conversationCoordinator.initialize();

    // Check if conversation exists, if not create it
    let conversation = conversationCoordinator.getConversation(options.conversationId);
    if (!conversation) {
      // Create conversation from root event
      const rootEvent = eventArray[0];
      conversation = await conversationCoordinator.createConversation(rootEvent);

      // Add remaining events
      for (let i = 1; i < eventArray.length; i++) {
        await conversationCoordinator.addEvent(options.conversationId, eventArray[i]);
      }

      logger.info("Created temporary conversation for debug purposes");
    }

    const mockContext: ExecutionContext = {
      agent: selectedAgent,
      conversationId: options.conversationId,
      conversationCoordinator,
      getConversation: () => conversationCoordinator.getConversation(options.conversationId),
      isDelegationCompletion: false,
      debug: true
    };

    // Build messages using the strategy
    logger.info(chalk.cyan("\n=== Building Messages with Strategy ===\n"));
    const messages = await strategy.buildMessages(mockContext, triggeringEvent);

    // Display the messages
    logger.info(chalk.cyan(`=== Strategy Output (${messages.length} messages) ===\n`));

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      console.log(chalk.bold.yellow(`\n─── Message ${i + 1} (${msg.role}) ───`));

      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2);
      const formattedContent = formatContentWithEnhancements(content, msg.role === 'system');
      console.log(formattedContent);

      if (i < messages.length - 1) {
        console.log(chalk.dim(`\n${"─".repeat(60)}\n`));
      }
    }

    console.log(chalk.cyan("\n" + "═".repeat(80) + "\n"));

    logger.info("Strategy formatting complete");
    process.exit(0);
  } catch (err) {
    handleCliError(err, "Failed to format threaded conversation");
  }
}
