import type { AgentRegistry } from "@/agents/AgentRegistry";
import type { AgentInstance } from "@/agents/types";
import type { ConversationCoordinator } from "@/conversations";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import type { LLMLogger } from "@/logging/LLMLogger";
import { logger } from "@/utils/logger";
import type { Hexpubkey, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { type NDKProject } from "@nostr-dev-kit/ndk";

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

  /**
   * Agent registry - single source of truth for all agents
   */
  public readonly agentRegistry: AgentRegistry;

  /**
   * Getter for agents map to maintain compatibility
   */
  get agents(): Map<string, AgentInstance> {
    return this.agentRegistry.getAllAgentsMap();
  }

  /**
   * Lessons learned by agents in this project
   * Key: agent pubkey, Value: array of lessons (limited to most recent 50 per agent)
   */
  public readonly agentLessons: Map<string, NDKAgentLesson[]>;

  /**
   * Conversation manager for the project (optional, initialized when needed)
   */
  public conversationCoordinator?: ConversationCoordinator;

  /**
   * LLM Logger instance for this project
   */
  public readonly llmLogger: LLMLogger;

  constructor(project: NDKProject, agentRegistry: AgentRegistry, llmLogger: LLMLogger) {
    this.project = project;
    this.agentRegistry = agentRegistry;
    this.llmLogger = llmLogger;

    const agents = agentRegistry.getAllAgentsMap();
    
    // Debug logging
    logger.debug("Initializing ProjectContext", {
      projectId: project.id,
      projectTitle: project.tagValue("title"),
      agentsCount: agents.size,
      agentSlugs: Array.from(agents.keys()),
      agentDetails: Array.from(agents.entries()).map(([slug, agent]) => ({
        slug,
        name: agent.name,
        eventId: agent.eventId,
      })),
    });

    // Find the project manager agent - look for "pm" role suffix first
    const pmAgentTag = project.tags.find((tag: string[]) => 
      tag[0] === "agent" && tag[2] === "pm"
    );
    
    let pmEventId: string;
    if (pmAgentTag && pmAgentTag[1]) {
      pmEventId = pmAgentTag[1];
      logger.info("Found explicit PM designation in project tags");
    } else {
      // Fallback: use first agent (for projects without explicit PM)
      const firstAgentTag = project.tags.find((tag: string[]) => tag[0] === "agent" && tag[1]);
      if (!firstAgentTag) {
        throw new Error(
          "No agents found in project event. Project must have at least one agent tag."
        );
      }
      pmEventId = firstAgentTag[1];
      logger.info("No explicit PM found, using first agent as PM (legacy behavior)");
    }

    let projectManagerAgent: AgentInstance | undefined;
    
    // Find the agent with matching eventId
    for (const agent of agents.values()) {
      if (agent.eventId === pmEventId) {
        projectManagerAgent = agent;
        break;
      }
    }

    if (!projectManagerAgent) {
      throw new Error(
        `Project Manager agent not found. PM agent (eventId: ${pmEventId}) not loaded in registry.`
      );
    }

    logger.info(`Using "${projectManagerAgent.name}" as Project Manager`);

    // Hardwire to project manager's signer and pubkey
    this.signer = projectManagerAgent.signer;
    this.pubkey = projectManagerAgent.pubkey;
    this.projectManager = projectManagerAgent;
    this.agentLessons = new Map();
    
    // Tell AgentRegistry who the PM is so it can assign delegate tools correctly
    // Note: This is synchronous now, file saving happens later
    this.agentRegistry.setPMPubkey(projectManagerAgent.pubkey);
  }

  // =====================================================================================
  // AGENT ACCESS HELPERS
  // =====================================================================================

  getAgent(slug: string): AgentInstance | undefined {
    return this.agentRegistry.getAgent(slug);
  }

  getAgentByPubkey(pubkey: Hexpubkey): AgentInstance | undefined {
    return this.agentRegistry.getAgentByPubkey(pubkey);
  }

  getProjectManager(): AgentInstance {
    return this.projectManager;
  }

  getProjectAgent(): AgentInstance {
    // Returns the project manager agent
    return this.projectManager;
  }

  getAgentSlugs(): string[] {
    return Array.from(this.agentRegistry.getAllAgentsMap().keys());
  }

  hasAgent(slug: string): boolean {
    return this.agentRegistry.getAgent(slug) !== undefined;
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
  async updateProjectData(newProject: NDKProject): Promise<void> {
    this.project = newProject;
    
    // Reload agents from project
    await this.agentRegistry.loadFromProject();
    
    const agents = this.agentRegistry.getAllAgentsMap();

    // Update project manager reference - look for "pm" role first
    const pmAgentTag = newProject.tags.find((tag: string[]) => 
      tag[0] === "agent" && tag[2] === "pm"
    );
    
    let pmEventId: string;
    if (pmAgentTag && pmAgentTag[1]) {
      pmEventId = pmAgentTag[1];
    } else {
      // Fallback to first agent
      const firstAgentTag = newProject.tags.find((tag: string[]) => tag[0] === "agent" && tag[1]);
      if (firstAgentTag) {
        pmEventId = firstAgentTag[1];
      } else {
        logger.error("No agents found in updated project");
        return;
      }
    }
    
    for (const agent of agents.values()) {
      if (agent.eventId === pmEventId) {
        this.projectManager = agent;
        break;
      }
    }
    
    // Tell AgentRegistry who the PM is after reload
    if (this.projectManager) {
      this.agentRegistry.setPMPubkey(this.projectManager.pubkey);
      await this.agentRegistry.persistPMStatus();
    }

    logger.info("ProjectContext updated with new data", {
      projectId: newProject.id,
      projectTitle: newProject.tagValue("title"),
      totalAgents: agents.size,
      agentSlugs: Array.from(agents.keys()),
    });
  }
}

// Module-level variable for global access
let projectContext: ProjectContext | undefined;

/**
 * Initialize the project context. Should be called once during project startup.
 */
export async function setProjectContext(project: NDKProject, agentRegistry: AgentRegistry, llmLogger: LLMLogger): Promise<void> {
  projectContext = new ProjectContext(project, agentRegistry, llmLogger);
  // Persist the PM status to disk
  await agentRegistry.persistPMStatus();
  // Note: publishProjectStatus() should be called explicitly after context is set
  // to avoid duplicate events during initialization
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
