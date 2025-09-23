import { AgentRegistry } from "@/agents/AgentRegistry";
import { DEFAULT_AGENT_LLM_CONFIG } from "@/llm/constants";
import { configService } from "@/services/ConfigService";
import { formatConfigScope, resolveConfigScope } from "@/utils/cli-config-scope";
import { logger } from "@/utils/logger";
import { isValidSlug } from "@/utils/validation";
import { confirm, input } from "@inquirer/prompts";
import { Command } from "commander";
import { initNDK, getTenexAnnouncementService, shutdownNDK } from "@/nostr/ndkClient";

interface AddOptions {
  project?: boolean;
  global?: boolean;
}

export const agentAddCommand = new Command("add")
  .description("Add a local agent")
  .option("--project", "Add to project configuration (default if in project)")
  .option("--global", "Add to global configuration")
  .action(async (options: AddOptions) => {
    try {
      // Determine where to save
      const projectPath = process.cwd();
      const scope = await resolveConfigScope(options, projectPath);

      if (scope.error) {
        throw new Error(scope.error);
      }

      const useProject = scope.isProject;

      // Interactive wizard
      const name = await input({
        message: "Agent name:",
        validate: (value) => {
          if (!value.trim()) return "Name is required";
          if (!isValidSlug(value)) {
            return "Name must contain only alphanumeric characters, hyphens, and underscores";
          }
          return true;
        },
      });

      const role = await input({
        message: "Agent role:",
        validate: (value) => (value.trim() ? true : "Role is required"),
      });

      const prompt = await input({
        message: "Agent prompt/instructions:",
        validate: (value) => (value.trim() ? true : "Prompt is required"),
      });

      const description = await input({
        message: "Agent description (optional):",
        default: "",
      });

      // Determine the base path for the registry
      const basePath = useProject
        ? configService.getProjectPath(projectPath)
        : configService.getGlobalPath();

      // Load existing registry
      const registryPath = useProject
        ? projectPath
        : configService.getGlobalPath().replace("/.tenex", "");
      const registry = new AgentRegistry(registryPath, !useProject);
      await registry.loadFromProject();

      // Check if agent already exists
      const existingAgent = registry.getAgentByName(name);
      if (existingAgent) {
        throw new Error(`Agent with name "${name}" already exists`);
      }

      // If creating a project agent, check if it would shadow a global one
      if (useProject) {
        try {
          const globalPath = configService.getGlobalPath().replace("/.tenex", "");
          const globalRegistry = new AgentRegistry(globalPath, true);
          await globalRegistry.loadFromProject();
          const globalAgent = globalRegistry.getAgent(name) || globalRegistry.getAgentByName(name);

          if (globalAgent) {
            const confirmed = await confirm({
              message: `A global agent named "${name}" already exists. Do you want to create a project-specific version that will override it?`,
              default: false,
            });

            if (!confirmed) {
              logger.info("Agent creation cancelled");
              process.exit(0);
            }
          }
        } catch (error) {
          // If we can't load global agents, continue anyway
          logger.debug("Could not check for global agents", { error });
        }
      }

      // Create agent config
      const agentConfig = {
        name,
        role,
        instructions: prompt,
        llmConfig: DEFAULT_AGENT_LLM_CONFIG,
        ...(description && { description }),
      };

      // Use AgentRegistry to ensure agent (this handles all file operations and Nostr publishing)
      const agent = await registry.ensureAgent(name, agentConfig);

      // Add agent to TENEX announcement service
      // Initialize NDK to get the announcement service
      await initNDK();
      const announcementService = getTenexAnnouncementService();
      if (announcementService) {
        try {
          // Use 'g' tag for agents (as specified in the plan)
          const agentTag = ['g', agent.pubkey];
          const changed = announcementService.addTag(agentTag);
          
          if (changed) {
            await announcementService.publish();
            logger.debug(`Published agent announcement for ${agent.pubkey}`);
          }
        } catch (error) {
          logger.error("Failed to publish agent announcement", error);
          // Don't fail the agent creation if announcement fails
        }
      }
      await shutdownNDK();

      const location = formatConfigScope(scope);
      logger.info(`✅ Local agent "${name}" created successfully in ${location}`);
      logger.info(`   Name: ${name}`);
      logger.info(`   Pubkey: ${agent.pubkey}`);
      logger.info(`   Stored in: ${basePath}/agents/`);
    } catch (error) {
      if (error instanceof Error) {
        logger.error("Failed to create agent:", error.message);
      } else {
        logger.error("Failed to create agent:", error);
      }
      process.exit(1);
    }
  });
