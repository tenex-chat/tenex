import * as readline from "node:readline";
import { AgentRegistry } from "@/agents/AgentRegistry";
import { AgentExecutor } from "@/agents/execution/AgentExecutor";
import type { ExecutionContext } from "@/agents/execution/types";
import type { Agent } from "@/agents/types";
import { ConversationManager } from "@/conversations/ConversationManager";
import { PHASES } from "@/conversations/phases";
import type { Conversation } from "@/conversations/types";
import { createAgentAwareLLMService, loadLLMRouter } from "@/llm";
import { DEFAULT_AGENT_LLM_CONFIG } from "@/llm/constants";
import { getNDK, initNDK } from "@/nostr/ndkClient";
import { PromptBuilder } from "@/prompts";
import { getProjectContext } from "@/services";
import { formatAnyError } from "@/utils/error-formatter";
import { logDebug, logError, logInfo } from "@/utils/logger";
import { ensureProjectInitialized } from "@/utils/projectInitialization";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import chalk from "chalk";
import { v4 as uuidv4 } from "uuid";

interface DebugChatOptions {
    systemPrompt?: boolean;
    message?: string;
    llm?: string | boolean;
}

export async function runDebugChat(
    initialAgentName: string | undefined,
    options: DebugChatOptions
): Promise<void> {
    try {
        const projectPath = process.cwd();

        // Parse LLM options - --llm should specify a preset name from llms.json
        let llmPresetOverride: string | undefined;
        if (typeof options.llm === "string") {
            llmPresetOverride = options.llm;
        }

        logInfo("Starting debug chat mode...");

        // Initialize project context if needed
        await ensureProjectInitialized(projectPath);

        // Create the LLM router
        const llmRouter = await loadLLMRouter(projectPath);

        // Get project context and create signer
        const projectCtx = getProjectContext();
        const project = projectCtx.project;

        // Load agent from registry or create default
        const agentRegistry = new AgentRegistry(projectPath, false);
        await agentRegistry.loadFromProject();

        let agent: Agent;

        if (initialAgentName) {
            const existingAgent = agentRegistry.getAgent(initialAgentName);
            if (!existingAgent) {
                throw new Error(`Agent '${initialAgentName}' not found`);
            }
            // Use the existing agent but potentially override llmConfig if --llm specified
            agent = llmPresetOverride
                ? { ...existingAgent, llmConfig: llmPresetOverride }
                : existingAgent;
        } else {
            // Create default debug agent
            agent = {
                name: "Debug Agent",
                role: "debug-agent",
                pubkey: projectCtx.signer.pubkey,
                signer: projectCtx.signer,
                llmConfig: llmPresetOverride || DEFAULT_AGENT_LLM_CONFIG,
                tools: [],
                instructions: "You are a debug agent for testing purposes.",
                slug: "debug",
            };
        }

        // Create conversation state for AgentExecutor
        const conversationId = uuidv4();
        const _conversationManager = new ConversationManager(projectPath);
        const conversation: Conversation = {
            id: conversationId,
            title: "Debug Chat Session",
            phase: PHASES.CHAT,
            history: [],
            agentStates: new Map(),
            phaseStartedAt: Date.now(),
            metadata: {
                projectPath,
            },
            phaseTransitions: [],
            orchestratorTurns: [],
            executionTime: {
                totalSeconds: 0,
                isActive: false,
                lastUpdated: Date.now(),
            },
        };

        // Initialize NDK for AgentExecutor
        await initNDK();
        const ndk = getNDK();

        // Create agent-aware LLM service that routes based on agent's llmConfig
        const llmService = createAgentAwareLLMService(llmRouter, agent.name);

        // Initialize AgentExecutor
        const agentExecutor = new AgentExecutor(llmService, ndk, _conversationManager);

        // Track messages separately for interactive mode
        const messages: Array<{ role: string; content: string }> = [];

        // Show system prompt if requested
        if (options.systemPrompt) {
            const systemPromptBuilder = new PromptBuilder().add("agent-system-prompt", {
                agent,
                phase: PHASES.CHAT,
                projectTitle: project.tagValue("title") || "Untitled Project",
                projectRepository: project.tagValue("repo") || undefined,
            });

            const systemPrompt = systemPromptBuilder.build();

            console.log(chalk.cyan("\n=== System Prompt ==="));
            console.log(systemPrompt);
            console.log(chalk.cyan("===================\n"));
        }

        // Handle single message mode
        if (options.message) {
            logDebug("Processing single message:", "general", "debug", options.message);

            // Create a mock NDKEvent for the debug session
            const mockEvent = new NDKEvent();
            mockEvent.kind = 9000; // Tenex conversation event kind
            mockEvent.content = options.message;
            mockEvent.pubkey = agent.pubkey;
            mockEvent.created_at = Math.floor(Date.now() / 1000);
            mockEvent.tags = [
                ["conversation", conversationId],
                ["phase", PHASES.CHAT],
            ];

            // Create execution context
            const context: ExecutionContext = {
                agent,
                conversationId: conversation.id,
                phase: PHASES.CHAT,
                projectPath,
                triggeringEvent: mockEvent,
                publisher: new (await import("@/nostr/NostrPublisher")).NostrPublisher({
                    conversationId: conversation.id,
                    agent,
                    triggeringEvent: mockEvent,
                    conversationManager: _conversationManager,
                }),
                conversationManager: _conversationManager,
            };

            // Execute using AgentExecutor without parent tracing context
            try {
                await agentExecutor.execute(context, undefined);
                console.log(chalk.green("\nAgent: Task completed successfully"));
            } catch (error) {
                console.error(
                    chalk.red("\nError:"),
                    error instanceof Error ? error.message : String(error)
                );
            }
            return;
        }

        // Interactive REPL mode
        console.log(chalk.cyan(`\nDebug Chat - Agent: ${agent.name}`));
        console.log(chalk.gray("Type 'exit' or 'quit' to end the conversation"));
        console.log(chalk.gray("Type 'clear' to clear conversation history"));
        console.log(chalk.gray("Type 'history' to view conversation history"));
        console.log(chalk.gray("Type 'prompt' to view system prompt\n"));

        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: chalk.blue("You> "),
        });

        rl.prompt();

        rl.on("line", async (line) => {
            const input = line.trim();

            // Handle special commands
            if (input.toLowerCase() === "exit" || input.toLowerCase() === "quit") {
                console.log(chalk.yellow("\nExiting debug chat..."));
                rl.close();
                return;
            }

            if (input.toLowerCase() === "clear") {
                messages.length = 0;
                conversation.history = [];
                console.log(chalk.yellow("Conversation history cleared.\n"));
                rl.prompt();
                return;
            }

            if (input.toLowerCase() === "history") {
                console.log(chalk.cyan("\n=== Conversation History ==="));
                messages.forEach((msg, idx) => {
                    console.log(chalk.gray(`[${idx}] ${msg.role}:`), msg.content);
                });
                console.log(chalk.cyan("========================\n"));
                rl.prompt();
                return;
            }

            if (input.toLowerCase() === "prompt") {
                const systemPromptBuilder = new PromptBuilder().add("agent-system-prompt", {
                    agent,
                    phase: PHASES.CHAT,
                    projectTitle: project.tagValue("title") || "Untitled Project",
                    projectRepository: project.tagValue("repo") || undefined,
                });

                const systemPrompt = systemPromptBuilder.build();

                console.log(chalk.cyan("\n=== System Prompt ==="));
                console.log(systemPrompt);
                console.log(chalk.cyan("===================\n"));
                rl.prompt();
                return;
            }

            // Skip empty inputs
            if (!input) {
                rl.prompt();
                return;
            }

            try {
                // Show thinking indicator
                process.stdout.write(chalk.gray("Agent is thinking..."));

                // Add user message to tracking
                messages.push({ role: "user", content: input });

                // Create a mock NDKEvent for the user message
                const mockEvent = new NDKEvent();
                mockEvent.kind = 9000; // Tenex conversation event kind
                mockEvent.content = input;
                mockEvent.pubkey = agent.pubkey;
                mockEvent.created_at = Math.floor(Date.now() / 1000);
                mockEvent.tags = [
                    ["conversation", conversationId],
                    ["phase", PHASES.CHAT],
                ];

                // Create execution context
                const context: ExecutionContext = {
                    agent,
                    conversationId: conversation.id,
                    phase: PHASES.CHAT,
                    projectPath,
                    triggeringEvent: mockEvent,
                    publisher: new (await import("@/nostr/NostrPublisher")).NostrPublisher({
                        conversationId: conversation.id,
                        agent,
                        triggeringEvent: mockEvent,
                        conversationManager: _conversationManager,
                    }),
                    conversationManager: _conversationManager,
                };

                // Execute using AgentExecutor without parent tracing context
                try {
                    await agentExecutor.execute(context, undefined);

                    // Clear thinking indicator
                    process.stdout.write(`\r${" ".repeat(20)}\r`);

                    // Add assistant response to tracking
                    messages.push({ role: "assistant", content: "Task completed successfully" });

                    // Display response
                    console.log(chalk.green("Agent: Task completed successfully"));
                } catch (error) {
                    // Clear thinking indicator
                    process.stdout.write(`\r${" ".repeat(20)}\r`);

                    console.error(
                        chalk.red("\nError:"),
                        error instanceof Error ? error.message : String(error)
                    );
                }

                console.log(); // Empty line for readability
            } catch (error) {
                console.error(chalk.red("\nError:"), formatAnyError(error));
            }

            rl.prompt();
        });

        rl.on("close", () => {
            console.log(chalk.yellow("\nDebug chat ended."));
            process.exit(0);
        });
    } catch (err) {
        const errorMessage = formatAnyError(err);
        logError(`Failed to start debug chat: ${errorMessage}`);
        process.exit(1);
    }
}
