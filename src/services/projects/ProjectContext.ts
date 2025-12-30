import type { AgentRegistry } from "@/agents/AgentRegistry";
import type { AgentInstance } from "@/agents/types";
import type { ConversationCoordinator } from "@/conversations";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import type { PairingManager } from "@/services/pairing";
import type { ProjectStatusService } from "@/services/status/ProjectStatusService";
import { logger } from "@/utils/logger";
import type { Hexpubkey, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import type { NDKProject } from "@nostr-dev-kit/ndk";

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
    public readonly signer?: NDKPrivateKeySigner;

    /**
     * Pubkey of the project (PM's pubkey)
     */
    public readonly pubkey?: Hexpubkey;

    /**
     * The project manager agent for this project
     */
    public projectManager?: AgentInstance;

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
     * PairingManager for real-time delegation supervision (optional, initialized when needed)
     */
    public pairingManager?: PairingManager;

    /**
     * Status publisher for immediately publishing project status updates
     */
    public statusPublisher?: ProjectStatusService;

    constructor(project: NDKProject, agentRegistry: AgentRegistry) {
        this.project = project;
        this.agentRegistry = agentRegistry;

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
        const pmAgentTag = project.tags.find(
            (tag: string[]) => tag[0] === "agent" && tag[2] === "pm"
        );

        let projectManagerAgent: AgentInstance | undefined;

        if (pmAgentTag?.[1]) {
            const pmEventId = pmAgentTag[1];
            logger.info("Found explicit PM designation in project tags");

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
        } else {
            // Fallback: use first agent from tags or from registry
            const firstAgentTag = project.tags.find(
                (tag: string[]) => tag[0] === "agent" && tag[1]
            );

            if (firstAgentTag) {
                const pmEventId = firstAgentTag[1];
                logger.info("No explicit PM found, using first agent from project tags as PM");

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
            } else if (agents.size > 0) {
                // No agent tags in project, but agents exist in registry (e.g., global agents)
                projectManagerAgent = agents.values().next().value;

                if (!projectManagerAgent) {
                    throw new Error("Failed to get first agent from registry");
                }

                logger.info(
                    "No agent tags in project event, using first agent from registry as PM",
                    {
                        agentName: projectManagerAgent.name,
                        agentSlug: projectManagerAgent.slug,
                    }
                );
            } else {
                // No agents at all - this is allowed, project might work without agents
                logger.warn(
                    "No agents found in project or registry. Project will run without a project manager."
                );
            }
        }

        if (projectManagerAgent) {
            logger.info(`Using "${projectManagerAgent.name}" as Project Manager`);
        }

        // Hardwire to project manager's signer and pubkey (if available)
        if (projectManagerAgent) {
            this.signer = projectManagerAgent.signer;
            this.pubkey = projectManagerAgent.pubkey;
            this.projectManager = projectManagerAgent;
        }

        this.agentLessons = new Map();
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
        if (!this.projectManager) {
            throw new Error("Project manager not initialized");
        }
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
        await this.agentRegistry.loadFromProject(newProject);

        const agents = this.agentRegistry.getAllAgentsMap();

        // Update project manager reference - look for "pm" role first
        const pmAgentTag = newProject.tags.find(
            (tag: string[]) => tag[0] === "agent" && tag[2] === "pm"
        );

        let pmEventId: string;
        if (pmAgentTag?.[1]) {
            pmEventId = pmAgentTag[1];
        } else {
            // Fallback to first agent
            const firstAgentTag = newProject.tags.find(
                (tag: string[]) => tag[0] === "agent" && tag[1]
            );
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

        logger.info("ProjectContext updated with new data", {
            projectId: newProject.id,
            projectTitle: newProject.tagValue("title"),
            totalAgents: agents.size,
            agentSlugs: Array.from(agents.keys()),
        });
    }
}

import { projectContextStore } from "./ProjectContextStore";

/**
 * Get the current project context from AsyncLocalStorage.
 * This is the ONLY way to access project context - it must be set via
 * projectContextStore.run(context, async () => {...})
 *
 * @throws Error if no context is available (not inside a .run() call)
 */
export function getProjectContext(): ProjectContext {
    return projectContextStore.getContextOrThrow();
}

/**
 * Check if project context is initialized in current async context
 */
export function isProjectContextInitialized(): boolean {
    return projectContextStore.hasContext();
}
