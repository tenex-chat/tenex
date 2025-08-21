import type { AgentInstance } from "@/agents/types";
import type { ConversationCoordinator } from "@/conversations/ConversationCoordinator";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { NDKProjectStatus } from "@/events/NDKProjectStatus";
import { getNDK } from "@/nostr";
import { logger } from "@/utils/logger";
import type { Hexpubkey, NDKPrivateKeySigner, NDKProject } from "@nostr-dev-kit/ndk";

/**
 * ProjectContext provides system-wide access to loaded project and agents
 * Initialized during "tenex project run" by ProjectManager
 */
export class ProjectContext {
  /**
   * Event that represents this project, note that this is SIGNED
   * by the USER, so this.project.pubkey is NOT the project's pubkey but the
   * USER OWNER'S pubkey.
   *
   * - projectCtx.pubkey = The project agent's pubkey (the bot/system)
   * - projectCtx.project.pubkey = The user's pubkey (who created the project)
   */
  public project: NDKProject;

  /**
   * Signer the project uses (hardwired to project manager's signer)
   */
  public readonly signer: NDKPrivateKeySigner;

  /**
   * Pubkey of the project (PM's pubkey)
   */
  public readonly pubkey: Hexpubkey;

  /**
   * The project manager agent for this project
   */
  public projectManager: AgentInstance;

  public agents: Map<string, AgentInstance>;

  /**
   * Lessons learned by agents in this project
   * Key: agent pubkey, Value: array of lessons (limited to most recent 50 per agent)
   */
  public readonly agentLessons: Map<string, NDKAgentLesson[]>;

  /**
   * Conversation manager for the project (optional, initialized when needed)
   */
  public conversationCoordinator?: ConversationCoordinator;

  constructor(project: NDKProject, agents: Map<string, AgentInstance>) {
    this.project = project;

    // Debug logging
    logger.debug("Initializing ProjectContext", {
      projectId: project.id,
      projectTitle: project.tagValue("title"),
      agentsCount: agents.size,
      agentSlugs: Array.from(agents.keys()),
      agentDetails: Array.from(agents.entries()).map(([slug, agent]) => ({
        slug,
        name: agent.name,
        isBuiltIn: agent.isBuiltIn,
      })),
    });

    // Find the project manager agent
    const projectManagerAgent = agents.get("project-manager");

    if (!projectManagerAgent) {
      throw new Error(
        "Project Manager agent not found. Ensure AgentRegistry.loadFromProject() is called before initializing ProjectContext."
      );
    }

    // Hardwire to project manager's signer and pubkey
    this.signer = projectManagerAgent.signer;
    this.pubkey = projectManagerAgent.pubkey;
    this.projectManager = projectManagerAgent;
    this.agents = new Map(agents);
    this.agentLessons = new Map();
  }

  // =====================================================================================
  // AGENT ACCESS HELPERS
  // =====================================================================================

  getAgent(slug: string): AgentInstance | undefined {
    return this.agents.get(slug);
  }

  getAgentByPubkey(pubkey: Hexpubkey): AgentInstance | undefined {
    // Find the agent dynamically
    for (const agent of this.agents.values()) {
      if (agent.pubkey === pubkey) {
        return agent;
      }
    }

    return undefined;
  }

  getProjectAgent(): AgentInstance {
    // Returns the project manager agent
    return this.projectManager;
  }

  getAgentSlugs(): string[] {
    return Array.from(this.agents.keys());
  }

  hasAgent(slug: string): boolean {
    return this.agents.has(slug);
  }

  // =====================================================================================
  // LESSON MANAGEMENT
  // =====================================================================================

  /**
   * Add a lesson for an agent, maintaining the 50-lesson limit per agent
   */
  addLesson(agentPubkey: string, lesson: NDKAgentLesson): void {
    const existingLessons = this.agentLessons.get(agentPubkey) || [];

    // Add the new lesson at the beginning (most recent first)
    const updatedLessons = [lesson, ...existingLessons];

    // Keep only the most recent 50 lessons
    const limitedLessons = updatedLessons.slice(0, 50);

    this.agentLessons.set(agentPubkey, limitedLessons);
  }

  /**
   * Get lessons for a specific agent
   */
  getLessonsForAgent(agentPubkey: string): NDKAgentLesson[] {
    return this.agentLessons.get(agentPubkey) || [];
  }

  /**
   * Get all lessons across all agents
   */
  getAllLessons(): NDKAgentLesson[] {
    return Array.from(this.agentLessons.values()).flat();
  }

  /**
   * Safely update project data without creating a new instance.
   * This ensures all parts of the system work with consistent state.
   */
  async updateProjectData(newProject: NDKProject, newAgents: Map<string, AgentInstance>): Promise<void> {
    this.project = newProject;
    this.agents = new Map(newAgents);

    // Update project manager reference if it exists in new agents
    const newProjectManager = newAgents.get("project-manager");
    if (newProjectManager) {
      this.projectManager = newProjectManager;
    }

    logger.info("ProjectContext updated with new data", {
      projectId: newProject.id,
      projectTitle: newProject.tagValue("title"),
      totalAgents: newAgents.size,
      agentSlugs: Array.from(newAgents.keys()),
    });

    // Publish 24010 event to notify about the project status update
    await this.publishProjectStatus();
  }

  /**
   * Publish a 24010 event with the current project status
   */
  public async publishProjectStatus(): Promise<void> {
    try {
      const ndk = getNDK();
      const status = new NDKProjectStatus(ndk);
      
      // Set the project reference (format: kind:pubkey:dTag)
      const projectReference = `${this.project.kind}:${this.project.pubkey}:${this.project.dTag}`;
      status.projectReference = projectReference;
      
      // Add all active agents
      for (const [slug, agent] of this.agents) {
        status.addAgent(agent.pubkey, slug);
      }
      
      // Group agents by model
      const modelToAgents = new Map<string, string[]>();
      for (const [slug, agent] of this.agents) {
        if (agent.llmConfig) {
          const modelSlug = agent.llmConfig;
          if (!modelToAgents.has(modelSlug)) {
            modelToAgents.set(modelSlug, []);
          }
          modelToAgents.get(modelSlug)?.push(slug);
        }
      }
      
      // Add model configurations
      for (const [modelSlug, agentSlugs] of modelToAgents) {
        status.addModel(modelSlug, agentSlugs);
      }
      
      // Import the registry to get all available tools
      const { getAllTools } = await import("@/tools/registry");
      const allTools = getAllTools();
      
      // Create a map of all tools with their assigned agents
      const toolToAgents = new Map<string, string[]>();
      
      // First, add all registered tools (even if unassigned)
      for (const tool of allTools) {
        toolToAgents.set(tool.name, []);
      }
      
      // Then populate with agent assignments
      for (const [slug, agent] of this.agents) {
        if (agent.tools && agent.tools.length > 0) {
          for (const tool of agent.tools) {
            const toolName = typeof tool === 'string' ? tool : tool.name;
            const agentList = toolToAgents.get(toolName);
            if (agentList) {
              agentList.push(slug);
            }
          }
        }
      }
      
      // Add all tool configurations (including unassigned ones)
      for (const [toolName, agentSlugs] of toolToAgents) {
        status.addTool(toolName, agentSlugs);
      }
      
      // Set status content
      status.status = `Project ${this.project.tagValue("title")} updated with ${this.agents.size} agents`;
      
      // Sign and publish the event
      await status.sign(this.signer);
      await status.publish();
      
      logger.info("Published project status update (24010)", {
        projectId: this.project.id,
        projectTitle: this.project.tagValue("title"),
        agentCount: this.agents.size,
        modelCount: modelToAgents.size,
        toolCount: toolToAgents.size,
      });
    } catch (error) {
      logger.error("Failed to publish project status update", { error });
    }
  }
}

// Module-level variable for global access
let projectContext: ProjectContext | undefined;

/**
 * Initialize the project context. Should be called once during project startup.
 */
export async function setProjectContext(project: NDKProject, agents: Map<string, AgentInstance>): Promise<void> {
  projectContext = new ProjectContext(project, agents);
  // Publish initial 24010 status event
  await projectContext.publishProjectStatus();
}

/**
 * Get the initialized project context
 * @throws Error if not initialized
 */
export function getProjectContext(): ProjectContext {
  if (!projectContext) {
    throw new Error(
      "ProjectContext not initialized. Please call setProjectContext() first or ensure the project has been properly initialized."
    );
  }
  return projectContext;
}

/**
 * Check if project context is initialized
 */
export function isProjectContextInitialized(): boolean {
  return projectContext !== undefined;
}
