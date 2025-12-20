import * as path from "node:path";
import { AgentRegistry } from "@/agents/AgentRegistry";
import {
    FlattenedChronologicalStrategy,
    type MessageGenerationStrategy,
    ThreadWithMemoryStrategy,
} from "@/agents/execution/strategies";
import { createExecutionContext } from "@/agents/execution/ExecutionContextFactory";
import { ConversationCoordinator } from "@/conversations/services/ConversationCoordinator";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { LLMLogger } from "@/logging/LLMLogger";
import { getNDK, initNDK } from "@/nostr/ndkClient";
import { buildSystemPromptMessages } from "@/prompts/utils/systemPromptBuilder";
import { getProjectContext } from "@/services/ProjectContext";
import { config } from "@/services/ConfigService";
import { ProjectContext } from "@/services/ProjectContext";
import { projectContextStore } from "@/services/ProjectContextStore";
import { mcpService } from "@/services/mcp/MCPManager";
// Tool type removed - using AI SDK tools only
import { handleCliError } from "@/utils/cli-error";
import { colorizeJSON, formatMarkdown } from "@/lib/formatting";
import { logger } from "@/utils/logger";
import { NDKProject } from "@nostr-dev-kit/ndk";
import chalk from "chalk";
import inquirer from "inquirer";

/**
 * Load and initialize project context for debug commands.
 */
async function loadProjectContext(
    projectNaddr: string
): Promise<{ context: ProjectContext; projectPath: string; metadataPath: string }> {
    // Initialize NDK if not already initialized
    await initNDK();
    const ndk = getNDK();

    // Fetch project from Nostr using naddr
    const filter = {
        kinds: [31933],
        "#d": [projectNaddr.split(":")[2]], // Extract d-tag from naddr
        authors: [projectNaddr.split(":")[1]], // Extract author from naddr
        limit: 1,
    };

    const projectEvents = await ndk.fetchEvents(filter);
    const projectEvent = Array.from(projectEvents)[0];

    if (!projectEvent) {
        throw new Error(`Could not fetch project from Nostr: ${projectNaddr}`);
    }

    const project = new NDKProject(ndk, projectEvent.rawEvent());

    // Build project ID and path in daemon-managed location
    const dTag = project.tagValue("d");
    if (!dTag) {
        throw new Error("Project missing d tag");
    }
    const projectId = `31933:${project.pubkey}:${dTag}`;

    // Get projects base directory
    await config.loadConfig(); // Load global config
    const projectsBase = config.getProjectsBase();
    const projectPath = path.join(projectsBase, dTag);
    const metadataPath = path.join(path.dirname(projectsBase), ".tenex", "projects", dTag);

    // Load agents using AgentRegistry
    const agentRegistry = new AgentRegistry(projectPath, metadataPath);
    await agentRegistry.loadFromProject(project);

    // Create LLM logger
    const llmLogger = new LLMLogger();
    llmLogger.initialize(metadataPath);

    // Create and return ProjectContext
    const context = new ProjectContext(project, agentRegistry, llmLogger);

    logger.debug("Loaded project context for debug command", {
        projectId,
        projectTitle: project.tagValue("title"),
        projectPath,
        metadataPath,
        agentCount: agentRegistry.getAllAgents().length,
    });

    return { context, projectPath, metadataPath };
}

// Trim content to max length if needed
function trimContent(content: string, maxLength: number): string {
    if (content.length <= maxLength) {
        return content;
    }
    return (
        content.substring(0, maxLength) +
        chalk.dim(` ... [trimmed ${content.length - maxLength} chars]`)
    );
}

// Format content with enhancements
function formatContentWithEnhancements(
    content: string,
    isSystemPrompt = false,
    trim = false,
    maxLength = 500
): string {
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
                return (
                    chalk.gray("<tool_use>\n") +
                    colorizeJSON(formatted) +
                    chalk.gray("\n</tool_use>")
                );
            } catch {
                return chalk.gray("<tool_use>") + jsonContent + chalk.gray("</tool_use>");
            }
        }
    );

    // Apply trimming if requested
    if (trim) {
        formattedContent = trimContent(formattedContent, maxLength);
    }

    return formattedContent;
}

interface DebugSystemPromptOptions {
    project: string; // Project naddr
    agent: string;
    phase: string;
}

interface DebugThreadedFormatterOptions {
    project: string; // Project naddr
    conversationId: string;
    strategy?: string;
    agent?: string;
    dontTrim?: boolean;
}

export async function runDebugSystemPrompt(options: DebugSystemPromptOptions): Promise<void> {
    try {
        // Load project context
        const { context, projectPath } = await loadProjectContext(options.project);

        // Wrap all operations in projectContextStore.run() to establish AsyncLocalStorage context
        await projectContextStore.run(context, async () => {
            // Now getProjectContext() will work correctly inside this scope
            const projectCtx = getProjectContext();
            const agent = projectCtx.agentRegistry.getAgent(options.agent);

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

                // Get current branch for worktree context
                const { getCurrentBranch } = await import("@/utils/git/initializeGitRepo");
                let currentBranch: string | undefined;
                try {
                    currentBranch = await getCurrentBranch(projectPath);
                } catch {
                    // If we can't get the branch, just skip worktree context
                    currentBranch = undefined;
                }

                const systemMessages = await buildSystemPromptMessages({
                    agent,
                    project: projectCtx.project,
                    projectBasePath: projectPath, // In debug mode, base path is what we have
                    workingDirectory: projectPath, // Use same as base in debug mode
                    currentBranch,
                    availableAgents,
                    conversation: undefined, // No conversation in debug mode
                    agentLessons: agentLessonsMap,
                    isProjectManager,
                });

                // Display each system message separately with metadata
                logger.info(
                    chalk.bold.cyan(
                        "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                    )
                );
                logger.info(chalk.bold.cyan("                    SYSTEM PROMPT MESSAGES"));
                logger.info(
                    chalk.bold.cyan(
                        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
                    )
                );

                for (let i = 0; i < systemMessages.length; i++) {
                    const msg = systemMessages[i];

                    // Display message metadata
                    console.log(chalk.bold.yellow(`\n─── Message ${i + 1} ───`));
                    if (msg.metadata?.description) {
                        console.log(chalk.dim(`Description: ${msg.metadata.description}`));
                    }
                    console.log();

                    // Format and display message content
                    const messageContent =
                        typeof msg.message.content === "string"
                            ? msg.message.content
                            : JSON.stringify(msg.message.content, null, 2);
                    const formattedContent = formatContentWithEnhancements(
                        messageContent,
                        true
                    );
                    console.log(formattedContent);

                    if (i < systemMessages.length - 1) {
                        console.log(chalk.dim(`\n${"─".repeat(60)}\n`));
                    }
                }

                console.log(
                    chalk.bold.cyan(
                        "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
                    )
                );
            } else {
                console.log(chalk.yellow(`Agent '${options.agent}' not found in registry`));
            }

            console.log(chalk.cyan("===================\n"));

            logger.info("System prompt displayed successfully");
        }); // End projectContextStore.run()

        process.exit(0);
    } catch (err) {
        handleCliError(err, "Failed to generate system prompt");
    }
}

export async function runDebugThreadedFormatter(
    options: DebugThreadedFormatterOptions
): Promise<void> {
    try {
        // Load project context
        const { context, metadataPath, projectPath } = await loadProjectContext(options.project);

        // Wrap all operations in projectContextStore.run() to establish AsyncLocalStorage context
        await projectContextStore.run(context, async () => {
            const projectCtx = getProjectContext();
            const ndk = getNDK();

            // Select strategy
            let strategyName = options.strategy;
            if (!strategyName) {
                const answer = await inquirer.prompt([
                    {
                        type: "list",
                        name: "strategy",
                        message: "Select a message generation strategy:",
                        choices: [
                            {
                                name: "Threaded with Memory (shows tree structure with other branches)",
                                value: "threaded-with-memory",
                            },
                            {
                                name: "Flattened Chronological (flattened chronological view with delegation markers)",
                                value: "flattened-chronological",
                            },
                        ],
                    },
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
                    ids: [options.conversationId],
                }),
                ndk.fetchEvents({
                    kinds: [1111],
                    "#E": [options.conversationId],
                }),
            ]);

            const eventArray = [...Array.from(rootEvents), ...Array.from(replyEvents)].sort(
                (a, b) => (a.created_at || 0) - (b.created_at || 0)
            );

            logger.info(`Found ${eventArray.length} events in conversation`);

            if (eventArray.length === 0) {
                logger.warn("No events found in conversation");
                return; // Exit the .run() wrapper instead of process.exit
            }

            // Find the triggering event (last event in conversation)
            const triggeringEvent = eventArray[eventArray.length - 1];

            // Get the first agent from the project to use as context
            const agents = Array.from(projectCtx.agents.values());
            if (agents.length === 0) {
                logger.error("No agents found in project");
                return; // Exit the .run() wrapper instead of process.exit
            }

            // Select agent (from flag or interactively)
            let agentSlug = options.agent;
            if (!agentSlug) {
                const agentAnswer = await inquirer.prompt([
                    {
                        type: "list",
                        name: "agentSlug",
                        message: "Select agent perspective:",
                        choices: agents.map((agent) => ({ name: agent.name, value: agent.slug })),
                    },
                ]);
                agentSlug = agentAnswer.agentSlug;
            }

            const selectedAgent = agents.find((a) => a.slug === agentSlug);
            if (!selectedAgent) {
                logger.error(`Agent '${agentSlug}' not found`);
                return; // Exit the .run() wrapper instead of process.exit
            }

            logger.info(`Viewing from ${chalk.green(selectedAgent.name)}'s perspective`);

            // Create a strategy instance
            let strategy: MessageGenerationStrategy;
            if (strategyName === "flattened-chronological") {
                strategy = new FlattenedChronologicalStrategy();
            } else {
                strategy = new ThreadWithMemoryStrategy();
            }

            // Create a mock execution context
            const conversationCoordinator = new ConversationCoordinator(metadataPath);
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

            const { AgentPublisher } = await import("@/nostr/AgentPublisher");
            const mockAgentPublisher = new AgentPublisher(selectedAgent);

            const mockContext = await createExecutionContext({
                agent: selectedAgent,
                conversationId: options.conversationId,
                projectBasePath: projectPath, // In debug mode, project path is the base
                triggeringEvent,
                conversationCoordinator,
                agentPublisher: mockAgentPublisher,
                isDelegationCompletion: false,
                debug: true,
            });

            // Build messages using the strategy
            logger.info(chalk.cyan("\n=== Building Messages with Strategy ===\n"));
            const messages = await strategy.buildMessages(mockContext, triggeringEvent);

            // Display the messages
            const shouldTrim = !options.dontTrim;
            logger.info(chalk.cyan(`=== Strategy Output (${messages.length} messages) ===\n`));
            if (shouldTrim) {
                logger.info(
                    chalk.dim(
                        "(Messages trimmed to 500 chars. Use --dont-trim to see full content)\n"
                    )
                );
            }

            for (let i = 0; i < messages.length; i++) {
                const msg = messages[i];
                console.log(chalk.bold.yellow(`\n─── Message ${i + 1} (${msg.role}) ───`));

                const content =
                    typeof msg.content === "string"
                        ? msg.content
                        : JSON.stringify(msg.content, null, 2);
                const formattedContent = formatContentWithEnhancements(
                    content,
                    msg.role === "system",
                    shouldTrim
                );
                console.log(formattedContent);

                if (i < messages.length - 1) {
                    console.log(chalk.dim(`\n${"─".repeat(60)}\n`));
                }
            }

            console.log(chalk.cyan(`\n${"═".repeat(80)}\n`));

            logger.info("Strategy formatting complete");
        }); // End projectContextStore.run()

        process.exit(0);
    } catch (err) {
        handleCliError(err, "Failed to format threaded conversation");
    }
}
