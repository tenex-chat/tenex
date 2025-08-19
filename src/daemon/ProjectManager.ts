import { exec } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { LLMConfigEditor } from "@/llm/LLMConfigEditor";
import { configService, setProjectContext } from "@/services";
import type { TenexConfig } from "@/services/config/types";
import { initializeToolLogger } from "@/tools/toolLogger";
import { ensureTenexInGitignore, initializeGitRepository } from "@/utils/git";
import { logger } from "@/utils/logger";
import { toKebabCase } from "@/utils/string";
import { fetchAgentDefinition } from "@/utils/agentFetcher";
import { installMCPServerFromEvent } from "@/services/mcp/mcpInstaller";
// createAgent functionality has been moved to AgentRegistry
import type NDK from "@nostr-dev-kit/ndk";
import type { NDKProject } from "@nostr-dev-kit/ndk";
import { NDKMCPTool } from "@/events/NDKMCPTool";
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

            // Load the registry first to get global agents loaded
            await agentRegistry.loadFromProject(project);

            // Fetch and save agent and MCP definitions
            await this.fetchAndSaveCapabilities(projectPath, projectData, ndk, project, agentRegistry);

            // Reload to pick up any new agents that were added
            await agentRegistry.loadFromProject(project);
            const agentMap = agentRegistry.getAllAgentsMap();
            const loadedAgents = new Map();
            for (const [slug, agent] of agentMap.entries()) {
                agent.slug = slug;
                loadedAgents.set(slug, agent);
            }

            // Now set the project context once with all agents loaded
            setProjectContext(project, loadedAgents);

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
            await agentRegistry.loadFromProject(project);

            // Get all agents from registry
            const agentMap = agentRegistry.getAllAgentsMap();
            const loadedAgents = new Map();

            logger.debug("Agent registry loaded", {
                agentMapSize: agentMap.size,
                agentMapKeys: Array.from(agentMap.keys()),
            });

            // Set slug on each agent
            for (const [slug, agent] of agentMap.entries()) {
                agent.slug = slug;
                loadedAgents.set(slug, agent);
            }

            logger.debug("Agents prepared for ProjectContext", {
                loadedAgentsSize: loadedAgents.size,
                loadedAgentsSlugs: Array.from(loadedAgents.keys()),
            });

            // Initialize ProjectContext
            setProjectContext(project, loadedAgents);

            // Initialize ConversationCoordinator with ExecutionQueueManager for CLI commands
            const projectCtx = (await import("@/services")).getProjectContext();
            const ConversationCoordinator = (await import("@/conversations/ConversationCoordinator")).ConversationCoordinator;
            const ExecutionQueueManager = (await import("@/conversations/executionQueue")).ExecutionQueueManager;
            
            const conversationManager = new ConversationCoordinator(projectPath);
            await conversationManager.initialize();
            
            // Create and attach ExecutionQueueManager
            const projectPubkey = projectCtx.pubkey;
            const projectIdentifier = project.tagValue("d") || project.id;
            const queueManager = new ExecutionQueueManager(
                projectPath,
                projectPubkey,
                projectIdentifier
            );
            await queueManager.initialize();
            
            conversationManager.setExecutionQueueManager(queueManager);
            projectCtx.conversationManager = conversationManager;

            // Republish kind:0 events for all agents on project load
            await agentRegistry.republishAllAgentProfiles(project);

            // Initialize tool logger for tracing tool executions
            initializeToolLogger(projectPath);
        } catch (error: unknown) {
            // Only log if it's not a missing project configuration error
            // The MCP server command will handle this specific error with a friendlier message
            if (!error?.message?.includes("Project configuration missing projectNaddr")) {
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
            identifier: project.dTag || "",
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

    private async fetchAndSaveCapabilities(
        projectPath: string,
        project: ProjectData,
        ndk: NDK,
        ndkProject: NDKProject | undefined,
        agentRegistry: unknown
    ): Promise<void> {
        const agentsDir = path.join(projectPath, ".tenex", "agents");
        await fs.mkdir(agentsDir, { recursive: true });

        // Process agent tags
        for (const eventId of project.agentEventIds) {
            try {
                const agent = await fetchAgentDefinition(eventId, ndk);
                if (agent) {
                    // Generate a slug for the agent (kebab-case of the name)
                    const slug = toKebabCase(agent.title);

                    // Use AgentRegistry.ensureAgent to handle all file operations
                    await agentRegistry.ensureAgent(
                        slug,
                        {
                            name: agent.title,
                            role: agent.role,
                            description: agent.description,
                            instructions: agent.instructions,
                            useCriteria: agent.useCriteria,
                            eventId: eventId,
                        },
                        ndkProject
                    );

                    logger.info("Saved agent definition", { eventId, name: agent.title });
                }
            } catch (error) {
                logger.error("Failed to fetch agent definition", { error, eventId });
            }
        }

        // Process MCP tags
        for (const eventId of project.mcpEventIds) {
            try {
                const event = await ndk.fetchEvent(eventId);
                if (event) {
                    const mcpTool = NDKMCPTool.from(event);
                    await installMCPServerFromEvent(projectPath, mcpTool);
                    logger.info("Installed MCP server", { eventId, name: mcpTool.name });
                }
            } catch (error) {
                logger.error("Failed to fetch or install MCP server", { error, eventId });
            }
        }
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
