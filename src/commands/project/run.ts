import * as path from "node:path";
import { ProjectDisplay } from "@/commands/run/ProjectDisplay";
import { SubscriptionManager } from "@/commands/run/SubscriptionManager";
import { EventHandler } from "@/event-handler";
// LLMLogger will be accessed from ProjectContext
import { shutdownNDK, getNDK } from "@/nostr/ndkClient";
import { getProjectContext, dynamicToolService } from "@/services";
import { mcpService } from "@/services/mcp/MCPManager";
import { SchedulerService } from "@/services/SchedulerService";
import { RagSubscriptionService } from "@/services/rag/RagSubscriptionService";
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

      // Initialize MCP service BEFORE displaying agents so MCP tools are available
      await mcpService.initialize(projectPath);

      // Initialize scheduler service
      const schedulerService = SchedulerService.getInstance();
      await schedulerService.initialize(getNDK(), projectPath);
      
      // Initialize RAG subscription service
      const ragSubscriptionService = RagSubscriptionService.getInstance();
      await ragSubscriptionService.initialize();
      
      // Initialize dynamic tool service
      await dynamicToolService.initialize();

      // Refresh agent tools now that MCP is initialized
      // Update the agents directly in ProjectContext since AgentRegistry isn't exposed
      const projectCtx = getProjectContext();
      try {
        const allMcpTools = mcpService.getCachedTools();
        const mcpToolNames = Object.keys(allMcpTools);
        
        if (mcpToolNames.length > 0) {
          
          for (const [_, agent] of projectCtx.agents) {
            // Skip agents that have MCP disabled
            if (agent.mcp === false) continue;
            
            // Add MCP tools that aren't already in the agent's tool list
            const newMcpTools = mcpToolNames.filter(t => !agent.tools.includes(t));
            if (newMcpTools.length > 0) {
              agent.tools = [...agent.tools, ...newMcpTools];
              logger.debug(`Added ${newMcpTools.length} MCP tools to agent "${agent.name}"`);
            }
          }
          
          logger.info(`Updated agents with ${mcpToolNames.length} MCP tools`);
        }
      } catch (error) {
        logger.debug("Could not refresh agent tools with MCP", error);
      }

      // Display project information (now with MCP tools and scheduler available)
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

    // MCP service already initialized before displaying agents

    // Initialize event handler
    const eventHandler = new EventHandler(projectPath);
    await eventHandler.initialize();

    // Initialize subscription manager
    const subscriptionManager = new SubscriptionManager(eventHandler, projectPath);
    await subscriptionManager.start();

    // Start status publisher
    const statusPublisher = new StatusPublisher();
    await statusPublisher.startPublishing(projectPath);

    // Start operations status publisher
    const { OperationsStatusPublisher } = await import("@/services");
    const { llmOpsRegistry } = await import("@/services/LLMOperationsRegistry");
    const operationsStatusPublisher = new OperationsStatusPublisher(llmOpsRegistry);
    operationsStatusPublisher.start();

    // Set up graceful shutdown
    setupGracefulShutdown(async () => {
      // Stop subscriptions first
      await subscriptionManager.stop();

      // Stop status publishers
      statusPublisher.stopPublishing();
      operationsStatusPublisher.stop();

      // Clean up event handler subscriptions
      await eventHandler.cleanup();

      // Shutdown scheduler service
      SchedulerService.getInstance().shutdown();
      
      // Note: RagSubscriptionService doesn't have a shutdown method yet
      // It would be good to add one to properly clean up listeners
      
      // Shutdown dynamic tool service
      dynamicToolService.shutdown();

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
