import type { AgentRegistry } from "@/agents/AgentRegistry";
import type { AgentInstance } from "@/agents/types";
import type { LessonComment } from "@/events/LessonComment";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import type { MCPManager } from "@/services/mcp/MCPManager";
import { SkillWhitelistService, type WhitelistItem } from "@/services/skill";
import type { PromptCompilerRegistryService } from "@/services/prompt-compiler/PromptCompilerRegistryService";
import type { ProjectStatusService } from "@/services/status/ProjectStatusService";
import { shortenEventId } from "@/utils/conversation-id";
import { logger } from "@/utils/logger";
import type { Hexpubkey, NDKProject } from "@nostr-dev-kit/ndk";

/**
 * Resolve the Project Manager for a project.
 *
 * Priority order:
 * 1. Global PM designation via kind 24020 event ["pm"] tag without a-tag (highest priority)
 * 2. Project-scoped PM designation via kind 24020 event ["pm"] tag WITH a-tag (projectOverrides[dTag].isPM)
 * 3. Local PM override for this specific project (pmOverrides) - legacy, for backward compatibility
 * 4. Explicit PM designation in 31933 lowercase `p` tags (tag[2] === "pm")
 * 5. First lowercase `p` project tag
 * 6. First agent in registry (fallback for projects with no agent tags)
 *
 * @param project - The NDKProject event
 * @param agents - Map of agent slug to AgentInstance
 * @param projectDTag - The project's dTag for checking project-scoped PM overrides
 * @returns The resolved PM agent or undefined if no agents exist
 * @throws Error if PM is designated but not loaded in registry
 */
export function resolveProjectManager(
    project: NDKProject,
    agents: Map<string, AgentInstance>,
    projectDTag: string | undefined
): AgentInstance | undefined {
    // Step 1: Check for global PM designation via kind 24020 ["pm"] tag (highest priority)
    // Collect all agents with isPM=true to detect conflicts
    const globalPMAgents: AgentInstance[] = [];
    for (const agent of agents.values()) {
        if (agent.isPM === true) {
            globalPMAgents.push(agent);
        }
    }

    if (globalPMAgents.length > 0) {
        if (globalPMAgents.length > 1) {
            // Warn about multiple global PM agents - this is a configuration issue
            logger.warn("Multiple agents have global PM designation (isPM=true). Using first found.", {
                pmAgents: globalPMAgents.map((a) => ({ slug: a.slug, name: a.name })),
                selectedAgent: globalPMAgents[0].slug,
            });
        }

        logger.info("Found global PM designation via kind 24020 event", {
            agentName: globalPMAgents[0].name,
            agentSlug: globalPMAgents[0].slug,
        });
        return globalPMAgents[0];
    }

    // Step 2: Check for project-scoped PM designation via kind 24020 with a-tag
    if (projectDTag) {
        for (const agent of agents.values()) {
            if (agent.projectOverrides?.[projectDTag]?.isPM === true) {
                logger.info("Found project-scoped PM designation via kind 24020 event", {
                    agentName: agent.name,
                    agentSlug: agent.slug,
                    projectDTag,
                });
                return agent;
            }
        }
    }

    // Step 3: Check for local PM override for this specific project (pmOverrides)
    if (projectDTag) {
        for (const agent of agents.values()) {
            if (agent.pmOverrides?.[projectDTag] === true) {
                logger.info("Found legacy PM override for project", {
                    agentName: agent.name,
                    agentSlug: agent.slug,
                    projectDTag,
                });
                return agent;
            }
        }
    }

    // Step 4: Check for explicit "pm" role in project tags
    const pmAgentTag = project.tags.find(
        (tag: string[]) => tag[0] === "p" && tag[2] === "pm"
    );

    if (pmAgentTag?.[1]) {
        const pmPubkey = pmAgentTag[1];
        logger.debug("Found explicit PM designation in project tags", { pmPubkey });

        for (const agent of agents.values()) {
            if (agent.pubkey === pmPubkey) {
                return agent;
            }
        }

        logger.warn("PM agent designated in project tags not loaded in registry yet, falling through", {
            pmPubkey,
            loadedPubkeys: Array.from(agents.values()).map((a) => a.pubkey),
        });
    }

    // Step 5: Fallback to first agent from project tags
    const firstAgentTag = project.tags.find(
        (tag: string[]) => tag[0] === "p" && tag[1]
    );

    if (firstAgentTag?.[1]) {
        const pmPubkey = firstAgentTag[1];
        logger.debug("No explicit PM found, using first agent from project tags");

        for (const agent of agents.values()) {
            if (agent.pubkey === pmPubkey) {
                return agent;
            }
        }

        logger.warn("First agent from project tags not loaded in registry yet, falling through", {
            pmPubkey,
            loadedPubkeys: Array.from(agents.values()).map((a) => a.pubkey),
        });
    }

    // Step 6: No agent tags in project, use first from registry if any exist
    if (agents.size > 0) {
        const firstAgent = agents.values().next().value;
        if (firstAgent) {
            logger.info(
                "No agent tags in project event, using first agent from registry as PM",
                {
                    agentName: firstAgent.name,
                    agentSlug: firstAgent.slug,
                }
            );
            return firstAgent;
        }
    }

    // No agents at all
    logger.warn(
        "No agents found in project or registry. Project will run without a project manager."
    );
    return undefined;
}

/**
 * ProjectContext provides system-wide access to loaded project and agents
 * Initialized during "tenex project run" by ProjectManager
 */
export class ProjectContext {
    /**
     * Event that represents this project, note that this is SIGNED
     * by the USER, so this.project.pubkey is NOT the project's pubkey but the
     * USER OWNER'S pubkey.
     */
    public project: NDKProject;

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
     * Comments on agent lessons (kind 1111 events per NIP-22)
     * Key: agent pubkey, Value: array of comments (limited to most recent 100 per agent)
     */
    public readonly agentComments: Map<string, LessonComment[]>;

    /**
     * Status publisher for immediately publishing project status updates
     */
    public statusPublisher?: ProjectStatusService;

    /**
     * MCP manager for this project's MCP tool access
     */
    public mcpManager?: MCPManager;

    /**
     * Project-scoped registry for prompt compilers.
     * Attached by ProjectRuntime after startup wiring is complete.
     */
    public promptCompilerRegistry?: PromptCompilerRegistryService;

    /**
     * @deprecated Skill whitelist is now user-scoped, not project-scoped.
     * Use SkillWhitelistService.getInstance() directly instead.
     * Retained as a backward-compatible shim; callers should migrate to the singleton.
     */
    public skillWhitelist: SkillWhitelistService;

    /**
     * Callback invoked when a new agent is added to this project's registry.
     * Used by Daemon to synchronize its routing map (agentPubkeyToProjects).
     *
     * Set via setOnAgentAdded() - typically by the Daemon during runtime startup.
     */
    private onAgentAddedCallback?: (agent: AgentInstance) => void;

    constructor(project: NDKProject, agentRegistry: AgentRegistry) {
        this.project = project;
        this.agentRegistry = agentRegistry;

        const agents = agentRegistry.getAllAgentsMap();
        const projectDTag = project.dTag || project.tagValue("d");

        // Debug logging
        logger.debug("Initializing ProjectContext", {
            projectId: project.id,
            projectTitle: project.tagValue("title"),
            projectDTag,
            agentsCount: agents.size,
            agentSlugs: Array.from(agents.keys()),
            agentDetails: Array.from(agents.entries()).map(([slug, agent]) => ({
                slug,
                name: agent.name,
                eventId: agent.eventId,
            })),
        });

        // Use consolidated PM resolution logic
        const projectManagerAgent = resolveProjectManager(project, agents, projectDTag);

        if (projectManagerAgent) {
            logger.info(`Using "${projectManagerAgent.name}" as Project Manager`);
            this.projectManager = projectManagerAgent;
        }

        this.agentLessons = new Map();
        this.agentComments = new Map();

        // Reference the daemon-scoped skill whitelist singleton
        this.skillWhitelist = SkillWhitelistService.getInstance();
    }

    /**
     * @deprecated Skill whitelist is now initialized at daemon level (user-scoped).
     * This method is a no-op. See Daemon.ts step 6d.
     */
    initializeSkillWhitelist(_additionalPubkeys: string[] = []): void {
        logger.debug("initializeSkillWhitelist is deprecated — skill whitelist is now initialized at daemon level");
    }

    /**
     * @deprecated Use SkillWhitelistService.getInstance().getWhitelistedSkills() directly.
     * Skills are user-scoped, not project-scoped.
     */
    getAvailableSkills(): WhitelistItem[] {
        return this.skillWhitelist.getWhitelistedSkills();
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

    /**
     * Register a callback to be invoked when a new agent is added to this project.
     * Used by the Daemon to keep its routing map (agentPubkeyToProjects) synchronized.
     *
     * @param callback - Function to invoke with the newly added agent
     */
    setOnAgentAdded(callback: (agent: AgentInstance) => void): void {
        this.onAgentAddedCallback = callback;
    }

    /**
     * Notify that a new agent has been added to the registry.
     * This triggers the onAgentAdded callback if one is registered.
     *
     * Called by AgentRegistry.addAgent() when running within this context.
     */
    notifyAgentAdded(agent: AgentInstance): void {
        if (this.promptCompilerRegistry) {
            void this.promptCompilerRegistry.registerAgent(agent).catch((error) => {
                logger.error("ProjectContext: failed to register prompt compiler for new agent", {
                    agentPubkey: agent.pubkey.substring(0, 8),
                    error: error instanceof Error ? error.message : String(error),
                });
            });
        }

        if (this.onAgentAddedCallback) {
            this.onAgentAddedCallback(agent);
        }
    }

    // =====================================================================================
    // LESSON MANAGEMENT
    // =====================================================================================

    /**
     * Add a lesson for an agent, maintaining the 50-lesson limit per agent.
     */
    addLesson(agentPubkey: string, lesson: NDKAgentLesson): void {
        const existingLessons = this.agentLessons.get(agentPubkey) || [];

        // Add the new lesson at the beginning (most recent first)
        const updatedLessons = [lesson, ...existingLessons];

        // Keep only the most recent 50 lessons
        const limitedLessons = updatedLessons.slice(0, 50);

        this.agentLessons.set(agentPubkey, limitedLessons);
        this.syncPromptCompiler(agentPubkey);
    }

    /**
     * Remove a lesson for an agent by event ID.
     * @returns true if the lesson was found and removed, false otherwise
     */
    removeLesson(agentPubkey: string, eventId: string): boolean {
        const lessons = this.agentLessons.get(agentPubkey);
        if (!lessons) {
            return false;
        }

        const index = lessons.findIndex((l) => l.id === eventId);
        if (index === -1) {
            return false;
        }

        const newLessons = [...lessons.slice(0, index), ...lessons.slice(index + 1)];
        this.agentLessons.set(agentPubkey, newLessons);
        this.syncPromptCompiler(agentPubkey);

        logger.debug("ProjectContext: removed lesson from cache", {
            agentPubkey: agentPubkey.substring(0, 8),
            eventId: shortenEventId(eventId),
            remainingLessons: newLessons.length,
        });

        return true;
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

    // =====================================================================================
    // COMMENT MANAGEMENT (kind 1111 NIP-22 comments on lessons)
    // =====================================================================================

    /**
     * Maximum number of comments to store per agent (memory efficiency)
     */
    private static readonly MAX_COMMENTS_PER_AGENT = 100;

    /**
     * Add a comment for an agent, maintaining the 100-comment limit per agent.
     * Comments are de-duplicated by event ID.
     */
    addComment(agentPubkey: string, comment: LessonComment): void {
        const existingComments = this.agentComments.get(agentPubkey) || [];

        // Check for duplicates
        if (existingComments.some((c) => c.id === comment.id)) {
            return;
        }

        // Add the new comment at the beginning (most recent first)
        const updatedComments = [comment, ...existingComments];

        // Keep only the most recent comments
        const limitedComments = updatedComments.slice(0, ProjectContext.MAX_COMMENTS_PER_AGENT);

        this.agentComments.set(agentPubkey, limitedComments);
        this.syncPromptCompiler(agentPubkey);

        logger.debug("ProjectContext: added comment for agent", {
            agentPubkey: agentPubkey.substring(0, 8),
            commentId: shortenEventId(comment.id),
            lessonEventId: shortenEventId(comment.lessonEventId),
            totalComments: limitedComments.length,
        });
    }

    /**
     * Get comments for a specific agent
     */
    getCommentsForAgent(agentPubkey: string): LessonComment[] {
        return this.agentComments.get(agentPubkey) || [];
    }

    /**
     * Get comments for a specific lesson event ID
     */
    getCommentsForLesson(agentPubkey: string, lessonEventId: string): LessonComment[] {
        const comments = this.agentComments.get(agentPubkey) || [];
        return comments.filter((c) => c.lessonEventId === lessonEventId);
    }

    /**
     * Synchronize the runtime-owned prompt compiler for the given agent with the
     * latest lesson/comment snapshot. This is fire-and-forget on purpose: prompt
     * compilation runs in the background and should not block event ingestion.
     */
    syncPromptCompiler(agentPubkey: Hexpubkey): void {
        if (!this.promptCompilerRegistry) {
            return;
        }

        void this.promptCompilerRegistry.syncAgentInputs(
            agentPubkey,
            this.getLessonsForAgent(agentPubkey),
            this.getCommentsForAgent(agentPubkey)
        ).catch((error) => {
            logger.error("ProjectContext: failed to synchronize prompt compiler", {
                agentPubkey: agentPubkey.substring(0, 8),
                error: error instanceof Error ? error.message : String(error),
            });
        });
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
        const projectDTag = newProject.dTag || newProject.tagValue("d");

        // Use consolidated PM resolution logic (same as constructor)
        try {
            const newPM = resolveProjectManager(newProject, agents, projectDTag);
            if (newPM) {
                this.projectManager = newPM;
            }
        } catch (error) {
            logger.error("Failed to resolve project manager in updateProjectData", { error });
            // Keep existing PM if resolution fails
        }

        logger.info("ProjectContext updated with new data", {
            projectId: newProject.id,
            projectTitle: newProject.tagValue("title"),
            totalAgents: agents.size,
            agentSlugs: Array.from(agents.keys()),
            projectManager: this.projectManager?.slug,
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
