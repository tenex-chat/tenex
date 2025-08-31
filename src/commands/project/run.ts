import * as path from "node:path";
import { ProjectDisplay } from "@/commands/run/ProjectDisplay";
import { SubscriptionManager } from "@/commands/run/SubscriptionManager";
import { EventHandler } from "@/event-handler";
import { getLLMServiceFromConfig } from "@/llm/service";
import { shutdownNDK } from "@/nostr/ndkClient";
import { getProjectContext } from "@/services";
import { mcpService } from "@/services/mcp/MCPService";
import { StatusPublisher } from "@/services/status";
import { handleCliError } from "@/utils/cli-error";
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import { setupGracefulShutdown } from "@/utils/process";
import { ensureProjectInitialized } from "@/utils/projectInitialization";
import { Command } from "commander";

export const projectRunCommand = new Command("run")
  .description("Run the TENEX agent orchestration system for the current project")
  .option("-p, --path <path>", "Project path", process.cwd())
  .action(async (options) => {
    try {
      const projectPath = path.resolve(options.path);

      // Initialize project context (includes NDK setup)
      await ensureProjectInitialized(projectPath);

      // Display project information
      const projectDisplay = new ProjectDisplay();
      await projectDisplay.displayProjectInfo(projectPath);

      // Start the project listener
      await runProjectListener(projectPath);
    } catch (err) {
      // Don't double-log project configuration errors
      // as they're already handled in ensureProjectInitialized
      const error = err as Error;
      if (!error?.message?.includes("Project configuration missing projectNaddr")) {
        handleCliError(error, "Failed to start project");
      }
    }
  });

async function runProjectListener(projectPath: string): Promise<void> {
  try {
    const projectCtx = getProjectContext();
    const project = projectCtx.project;
    const titleTag = project.tagValue("title") || "Untitled Project";
    const dTag = project.tagValue("d") || "";
    logger.info(`Starting listener for project: ${titleTag} (${dTag})`);

    // Load LLM service from config
    const llmService = await getLLMServiceFromConfig();

    // Initialize MCP service
    await mcpService.initialize(projectPath);

    // Initialize event handler
    const eventHandler = new EventHandler(projectPath, llmService);
    await eventHandler.initialize();

    // Initialize subscription manager
    const subscriptionManager = new SubscriptionManager(eventHandler, projectPath);
    await subscriptionManager.start();

    // Start status publisher with ConversationCoordinator from event handler
    const conversationCoordinator = eventHandler.getConversationCoordinator();
    const statusPublisher = new StatusPublisher(conversationCoordinator);
    await statusPublisher.startPublishing(projectPath);

    // Set up graceful shutdown
    setupGracefulShutdown(async () => {
      // Stop subscriptions first
      await subscriptionManager.stop();

      // Stop status publisher
      statusPublisher.stopPublishing();

      // Clean up event handler subscriptions
      await eventHandler.cleanup();

      // Shutdown MCP service
      await mcpService.shutdown();

      // Shutdown NDK singleton
      await shutdownNDK();

      logger.info("Project shutdown complete");
    });

    // Keep the process running
    await new Promise(() => {
      // This promise never resolves, keeping the listener active
    });
  } catch (err) {
    const errorMessage = formatAnyError(err);
    logger.error(`Failed to run project listener: ${errorMessage}`);
    throw err;
  }
}
