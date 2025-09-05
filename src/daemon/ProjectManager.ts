import { exec } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { NDKMCPTool } from "@/events/NDKMCPTool";
import { LLMConfigEditor } from "@/llm/LLMConfigEditor";
import { configService, setProjectContext } from "@/services";
import type { TenexConfig } from "@/services/config/types";
import { installMCPServerFromEvent } from "@/services/mcp/mcpInstaller";
import { LLMLogger } from "@/logging/LLMLogger";
import { ensureTenexInGitignore, initializeGitRepository } from "@/utils/git";
import { logger } from "@/utils/logger";
// createAgent functionality has been moved to AgentRegistry
import type NDK from "@nostr-dev-kit/ndk";
import type { NDKProject } from "@nostr-dev-kit/ndk";
import chalk from "chalk";

const execAsync = promisify(exec);

export interface ProjectData {
  identifier: string;
  pubkey: string;
  naddr: string;
  title: string;
  description?: string;
  repoUrl?: string;
  hashtags: string[];
  agentEventIds: string[];
  mcpEventIds: string[];
  createdAt?: number;
  updatedAt?: number;
}

export interface IProjectManager {
  initializeProject(projectPath: string, naddr: string, ndk: NDK): Promise<ProjectData>;
  loadProject(projectPath: string): Promise<ProjectData>;
  ensureProjectExists(identifier: string, naddr: string, ndk: NDK): Promise<string>;
  loadAndInitializeProjectContext(projectPath: string, ndk: NDK): Promise<void>;
}

export class ProjectManager implements IProjectManager {
  private projectsPath: string;

  constructor(projectsPath?: string) {
    this.projectsPath = projectsPath || path.join(process.cwd(), "projects");
  }
  async initializeProject(projectPath: string, naddr: string, ndk: NDK): Promise<ProjectData> {
    try {
      // Fetch project from Nostr
      const project = await this.fetchProject(naddr, ndk);
      const projectData = this.projectToProjectData(project);

      // Clone repository if provided, otherwise create directory and init git
      if (projectData.repoUrl) {
        await this.cloneRepository(projectData.repoUrl, projectPath);
      } else {
        // Create project directory and initialize git
        await fs.mkdir(projectPath, { recursive: true });
        await initializeGitRepository(projectPath);
        logger.info("Created new project directory and initialized git repository", {
          projectPath,
        });
      }

      // Ensure .tenex is in .gitignore
      await ensureTenexInGitignore(projectPath);

      // Create project structure (without nsec in config)
      await this.createProjectStructure(projectPath, projectData);

      // Initialize agent registry
      const AgentRegistry = (await import("@/agents/AgentRegistry")).AgentRegistry;
      const agentRegistry = new AgentRegistry(projectPath, false);

      // First, fetch and install agents from Nostr (source of truth)
      logger.info(`Installing ${projectData.agentEventIds.length} agents from Nostr events`);
      const { installAgentFromEvent } = await import("@/utils/agentInstaller");
      
      for (const eventId of projectData.agentEventIds) {
        try {
          logger.debug(`Installing agent from event: ${eventId}`);
          await installAgentFromEvent(eventId, projectPath, project, undefined, ndk);
        } catch (error) {
          logger.error(`Failed to install agent ${eventId} from Nostr`, { error });
        }
      }

      // Install MCP servers
      for (const eventId of projectData.mcpEventIds) {
        try {
          const event = await ndk.fetchEvent(eventId);
          if (event) {
            const mcpTool = NDKMCPTool.from(event);
            await installMCPServerFromEvent(projectPath, mcpTool);
            logger.info("Installed MCP server", { eventId, name: mcpTool.name });
          }
        } catch (error) {
          logger.error(`Failed to fetch or install MCP server ${eventId}`, { error });
        }
      }

      // Now load from local files (which were just created/updated)
      await agentRegistry.loadFromProject();

      // Create and initialize LLM logger
      const llmLogger = new LLMLogger();
      llmLogger.initialize(projectPath);

      // Now set the project context with the agent registry
      await setProjectContext(project, agentRegistry, llmLogger);

      // Republish kind:0 events for all agents
      await agentRegistry.republishAllAgentProfiles(project);

      // Check if LLM configuration is needed
      await this.checkAndRunLLMConfigWizard(projectPath);

      return projectData;
    } catch (error) {
      logger.error("Failed to initialize project", { error });
      throw error;
    }
  }

  async loadProject(projectPath: string): Promise<ProjectData> {
    try {
      const { config } = await configService.loadConfig(projectPath);

      if (!config.projectNaddr) {
        throw new Error("Project configuration missing projectNaddr");
      }

      // For now, return a simplified version without decoding naddr
      // The identifier and pubkey will be filled when the project is fetched from Nostr
      return {
        identifier: config.projectNaddr, // Use naddr as identifier temporarily
        pubkey: "", // Will be filled when fetched from Nostr
        naddr: config.projectNaddr,
        title: "Untitled Project", // This should come from NDKProject
        description: config.description,
        repoUrl: config.repoUrl || undefined,
        hashtags: [], // This should come from NDKProject
        agentEventIds: [],
        mcpEventIds: [],
        createdAt: undefined, // This should come from NDKProject
        updatedAt: undefined, // This should come from NDKProject
      };
    } catch (error) {
      logger.error("Failed to load project", { error, projectPath });
      throw new Error(`Failed to load project from ${projectPath}`);
    }
  }

  async ensureProjectExists(identifier: string, naddr: string, ndk: NDK): Promise<string> {
    const projectPath = path.join(this.projectsPath, identifier);

    // Check if project already exists
    if (await this.projectExists(projectPath)) {
      return projectPath;
    }

    // Initialize the project
    await this.initializeProject(projectPath, naddr, ndk);

    return projectPath;
  }

  async loadAndInitializeProjectContext(projectPath: string, ndk: NDK): Promise<void> {
    try {
      // Load project configuration
      const { config } = await configService.loadConfig(projectPath);

      if (!config.projectNaddr) {
        throw new Error("Project configuration missing projectNaddr");
      }

      // Fetch project from Nostr
      const project = await this.fetchProject(config.projectNaddr, ndk);
      logger.debug("Fetched project from Nostr", {
        projectId: project.id,
        projectTitle: project.tagValue("title"),
        projectNaddr: config.projectNaddr,
      });

      // Load agents using AgentRegistry
      const AgentRegistry = (await import("@/agents/AgentRegistry")).AgentRegistry;
      const agentRegistry = new AgentRegistry(projectPath, false);
      
      // First, fetch and install agents from Nostr (source of truth)
      const agentEventIds = project.tags
        .filter((t) => t[0] === "agent" && t[1])
        .map((t) => t[1])
        .filter(Boolean) as string[];
      
      logger.info(`Installing ${agentEventIds.length} agents from Nostr events`);
      const { installAgentFromEvent } = await import("@/utils/agentInstaller");
      
      for (const eventId of agentEventIds) {
        try {
          logger.debug(`Installing agent from event: ${eventId}`);
          await installAgentFromEvent(eventId, projectPath, project, undefined, ndk);
        } catch (error) {
          logger.error(`Failed to install agent ${eventId} from Nostr`, { error });
        }
      }
      
      // Now load from local files (which were just created/updated)
      await agentRegistry.loadFromProject();

      // Create and initialize LLM logger
      const llmLogger = new LLMLogger();
      llmLogger.initialize(projectPath);

      // Initialize ProjectContext with the agent registry
      await setProjectContext(project, agentRegistry, llmLogger);

      // Initialize ConversationCoordinator for CLI commands
      const projectCtx = (await import("@/services")).getProjectContext();
      const ConversationCoordinator = (await import("@/conversations"))
        .ConversationCoordinator;

      const conversationCoordinator = new ConversationCoordinator(projectPath);
      await conversationCoordinator.initialize();
      
      projectCtx.conversationCoordinator = conversationCoordinator;

      // Republish kind:0 events for all agents on project load
      await agentRegistry.republishAllAgentProfiles(project);

      // LLM logger is now initialized and passed to ProjectContext above
    } catch (error: unknown) {
      // Only log if it's not a missing project configuration error
      // The MCP server command will handle this specific error with a friendlier message
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (!errorMessage.includes("Project configuration missing projectNaddr")) {
        logger.error("Failed to initialize ProjectContext", { error, projectPath });
      }
      throw error;
    }
  }

  private async fetchProject(naddr: string, ndk: NDK): Promise<NDKProject> {
    const event = await ndk.fetchEvent(naddr);
    if (!event) {
      throw new Error(`Project event not found: ${naddr}`);
    }
    return event as NDKProject;
  }

  private projectToProjectData(project: NDKProject): ProjectData {
    if (!project.dTag) {
      throw new Error("Project missing required d tag identifier");
    }
    
    const repoTag = project.tagValue("repo");
    const titleTag = project.tagValue("title");
    const hashtagTags = project.tags
      .filter((t) => t[0] === "t")
      .map((t) => t[1])
      .filter(Boolean) as string[];

    const agentTags = project.tags
      .filter((t) => t[0] === "agent")
      .map((t) => t[1])
      .filter(Boolean) as string[];

    const mcpTags = project.tags
      .filter((t) => t[0] === "mcp")
      .map((t) => t[1])
      .filter(Boolean) as string[];

    return {
      identifier: project.dTag,
      pubkey: project.pubkey,
      naddr: project.encode(),
      title: titleTag || "Untitled Project",
      description: project.description,
      repoUrl: repoTag,
      hashtags: hashtagTags,
      agentEventIds: agentTags,
      mcpEventIds: mcpTags,
      createdAt: project.created_at,
      updatedAt: project.created_at,
    };
  }

  private async cloneRepository(repoUrl: string, projectPath: string): Promise<void> {
    try {
      await fs.mkdir(path.dirname(projectPath), { recursive: true });
      const { stdout, stderr } = await execAsync(`git clone "${repoUrl}" "${projectPath}"`);
      if (stderr) {
        logger.warn("Git clone warning", { stderr });
      }
      logger.info("Cloned repository", { repoUrl, projectPath, stdout });
    } catch (error) {
      logger.error("Failed to clone repository", { error, repoUrl });
      throw error;
    }
  }

  private async createProjectStructure(
    projectPath: string,
    projectData: ProjectData
  ): Promise<void> {
    const tenexPath = path.join(projectPath, ".tenex");
    await fs.mkdir(tenexPath, { recursive: true });

    // Create project config (without nsec - it's now in agents.json)
    const projectConfig: TenexConfig = {
      description: projectData.description,
      repoUrl: projectData.repoUrl || undefined,
      projectNaddr: projectData.naddr,
    };

    await configService.saveProjectConfig(projectPath, projectConfig);

    logger.info("Created project structure with config", { projectPath });
  }


  private async projectExists(projectPath: string): Promise<boolean> {
    try {
      await fs.access(projectPath);
      const tenexPath = path.join(projectPath, ".tenex");
      await fs.access(tenexPath);

      // Also verify that config.json exists and has projectNaddr
      const { config } = await configService.loadConfig(projectPath);
      if (!config.projectNaddr) {
        logger.warn("Project directory exists but config is incomplete (missing projectNaddr)", {
          projectPath,
        });
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  private async checkAndRunLLMConfigWizard(projectPath: string): Promise<void> {
    try {
      const { llms: llmsConfig } = await configService.loadConfig(projectPath);

      // Check if there are any LLM configurations
      const hasLLMConfig =
        llmsConfig?.configurations && Object.keys(llmsConfig.configurations).length > 0;

      if (!hasLLMConfig) {
        logger.info(
          chalk.yellow(
            "\n⚠️  No LLM configurations found. Let's set up your LLMs for this project.\n"
          )
        );

        const llmEditor = new LLMConfigEditor(projectPath, false);
        await llmEditor.runOnboardingFlow();
      }
    } catch (error) {
      logger.warn("Failed to check LLM configuration", { error });
      // Don't throw - LLM configuration is not critical for project initialization
    }
  }
}
