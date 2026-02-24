import type { AgentRegistry } from "@/agents/AgentRegistry";
import type { AgentInstance } from "@/agents/types";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import type { MCPManager } from "@/services/mcp/MCPManager";
import { NudgeWhitelistService, type WhitelistItem } from "@/services/nudge";
import type { LessonComment } from "@/services/prompt-compiler";
import type { LocalReportStore } from "@/services/reports/LocalReportStore";
import type { ReportInfo } from "@/services/reports/ReportService";
import { articleToReportInfo } from "@/services/reports/articleUtils";
import type { ProjectStatusService } from "@/services/status/ProjectStatusService";
import { logger } from "@/utils/logger";
import type { Hexpubkey, NDKProject, NDKArticle } from "@nostr-dev-kit/ndk";

/**
 * Resolve the Project Manager for a project.
 *
 * Priority order:
 * 1. Global PM designation via kind 24020 event ["pm"] tag without a-tag (highest priority)
 * 2. Project-scoped PM designation via kind 24020 event ["pm"] tag WITH a-tag (projectOverrides[dTag].isPM)
 * 3. Local PM override for this specific project (pmOverrides) - legacy, for backward compatibility
 * 4. Explicit PM designation in 31933 project tags (role="pm")
 * 5. First agent from project tags
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
        (tag: string[]) => tag[0] === "agent" && tag[2] === "pm"
    );

    if (pmAgentTag?.[1]) {
        const pmEventId = pmAgentTag[1];
        logger.debug("Found explicit PM designation in project tags", { pmEventId });

        for (const agent of agents.values()) {
            if (agent.eventId === pmEventId) {
                return agent;
            }
        }

        throw new Error(
            `Project Manager agent not found. PM agent (eventId: ${pmEventId}) not loaded in registry.`
        );
    }

    // Step 5: Fallback to first agent from project tags
    const firstAgentTag = project.tags.find(
        (tag: string[]) => tag[0] === "agent" && tag[1]
    );

    if (firstAgentTag?.[1]) {
        const pmEventId = firstAgentTag[1];
        logger.debug("No explicit PM found, using first agent from project tags");

        for (const agent of agents.values()) {
            if (agent.eventId === pmEventId) {
                return agent;
            }
        }

        throw new Error(
            `Project Manager agent not found. First agent (eventId: ${pmEventId}) not loaded in registry.`
        );
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
     * Reports cache for this project
     * Key: compound key "author:slug", Value: ReportInfo object
     * Using compound key allows efficient lookup by both slug and author
     */
    public readonly reports: Map<string, ReportInfo>;

    /**
     * Maximum number of reports to cache per project (memory efficiency)
     */
    private static readonly MAX_REPORTS_CACHE_SIZE = 200;

    /**
     * Status publisher for immediately publishing project status updates
     */
    public statusPublisher?: ProjectStatusService;

    /**
     * MCP manager for this project's MCP tool access
     */
    public mcpManager?: MCPManager;

    /**
     * Local report store for this project's report storage.
     * Each project has its own store to ensure isolation.
     */
    public localReportStore?: LocalReportStore;

    /**
     * @deprecated Nudge whitelist is now user-scoped, not project-scoped.
     * Use NudgeSkillWhitelistService.getInstance() directly instead.
     * Kept temporarily for backward compatibility during transition.
     */
    public nudgeWhitelist: NudgeWhitelistService;

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
        this.reports = new Map();

        // Initialize nudge whitelist service (lazy init on first use)
        this.nudgeWhitelist = NudgeWhitelistService.getInstance();
    }

    /**
     * @deprecated Nudge whitelist is now initialized at daemon level (user-scoped).
     * This method is a no-op. See Daemon.ts step 6d.
     */
    initializeNudgeWhitelist(_additionalPubkeys: string[] = []): void {
        logger.debug("initializeNudgeWhitelist is deprecated — nudge whitelist is now initialized at daemon level");
    }

    /**
     * @deprecated Use NudgeSkillWhitelistService.getInstance().getWhitelistedNudges() directly.
     * Nudges are user-scoped, not project-scoped.
     */
    getAvailableNudges(): WhitelistItem[] {
        return this.nudgeWhitelist.getWhitelistedNudges();
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

        logger.debug("ProjectContext: removed lesson from cache", {
            agentPubkey: agentPubkey.substring(0, 8),
            eventId: eventId.substring(0, 8),
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

        logger.debug("ProjectContext: added comment for agent", {
            agentPubkey: agentPubkey.substring(0, 8),
            commentId: comment.id.substring(0, 8),
            lessonEventId: comment.lessonEventId.substring(0, 8),
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

    // =====================================================================================
    // REPORT MANAGEMENT
    // =====================================================================================

    /**
     * Generate a compound key for report storage
     */
    private static reportKey(authorPubkey: string, slug: string): string {
        return `${authorPubkey}:${slug}`;
    }

    /**
     * Add or update a report in the cache
     * @param report The report info to add/update
     */
    addReport(report: ReportInfo): void {
        // Get author hex pubkey from report
        const authorPubkey = this.extractPubkeyFromReport(report);
        if (!authorPubkey) {
            logger.warn("Cannot add report without author pubkey", { slug: report.slug });
            return;
        }

        const key = ProjectContext.reportKey(authorPubkey, report.slug);

        // Check if this is a deleted report
        if (report.isDeleted) {
            // Remove from cache instead of adding
            this.reports.delete(key);
            logger.debug("📰 Removed deleted report from cache", {
                slug: report.slug,
                author: authorPubkey.substring(0, 8),
            });
            return;
        }

        // Add/update the report
        this.reports.set(key, report);

        // Enforce cache size limit (LRU-style: oldest entries first based on Map insertion order)
        if (this.reports.size > ProjectContext.MAX_REPORTS_CACHE_SIZE) {
            const oldestKey = this.reports.keys().next().value;
            if (oldestKey) {
                this.reports.delete(oldestKey);
                logger.debug("📰 Evicted oldest report from cache due to size limit");
            }
        }

        logger.debug("📰 Added/updated report in cache", {
            slug: report.slug,
            author: authorPubkey.substring(0, 8),
            cacheSize: this.reports.size,
        });
    }

    /**
     * Add a report directly from an NDKArticle event
     * Converts the article to ReportInfo and adds to cache
     */
    addReportFromArticle(article: NDKArticle): void {
        const report = articleToReportInfo(article);
        this.addReport(report);
    }

    /**
     * Get a report by slug for a specific agent
     */
    getReport(agentPubkey: string, slug: string): ReportInfo | undefined {
        const key = ProjectContext.reportKey(agentPubkey, slug);
        return this.reports.get(key);
    }

    /**
     * Get a report by slug (searches all authors)
     * Returns the first match found
     */
    getReportBySlug(slug: string): ReportInfo | undefined {
        for (const report of this.reports.values()) {
            if (report.slug === slug) {
                return report;
            }
        }
        return undefined;
    }

    /**
     * Get all reports from the cache
     */
    getAllReports(): ReportInfo[] {
        return Array.from(this.reports.values());
    }

    /**
     * Get reports for a specific agent by pubkey
     */
    getReportsForAgent(agentPubkey: string): ReportInfo[] {
        const reports: ReportInfo[] = [];
        const prefix = `${agentPubkey}:`;
        for (const [key, report] of this.reports) {
            if (key.startsWith(prefix)) {
                reports.push(report);
            }
        }
        return reports;
    }

    /**
     * Get all memorized reports (reports tagged with memorize=true)
     */
    getMemorizedReports(): ReportInfo[] {
        return Array.from(this.reports.values()).filter((report) => report.isMemorized);
    }

    /**
     * Get memorized reports for a specific agent
     */
    getMemorizedReportsForAgent(agentPubkey: string): ReportInfo[] {
        return this.getReportsForAgent(agentPubkey).filter((report) => report.isMemorized);
    }

    /**
     * Get all team-memorized reports (reports tagged with memorize_team=true).
     * These reports are injected into ALL agents' system prompts.
     */
    getTeamMemorizedReports(): ReportInfo[] {
        return Array.from(this.reports.values()).filter((report) => report.isMemorizedTeam);
    }

    /**
     * Get reports by hashtag
     */
    getReportsByHashtag(hashtag: string): ReportInfo[] {
        return Array.from(this.reports.values()).filter(
            (report) => report.hashtags?.includes(hashtag)
        );
    }

    /**
     * Get report cache statistics
     */
    getReportCacheStats(): { total: number; memorized: number; byAuthor: Record<string, number> } {
        const byAuthor: Record<string, number> = {};
        let memorized = 0;

        for (const report of this.reports.values()) {
            const author = this.extractPubkeyFromReport(report) || "unknown";
            byAuthor[author.substring(0, 8)] = (byAuthor[author.substring(0, 8)] || 0) + 1;
            if (report.isMemorized) memorized++;
        }

        return {
            total: this.reports.size,
            memorized,
            byAuthor,
        };
    }

    /**
     * Clear all reports from cache
     */
    clearReports(): void {
        this.reports.clear();
    }

    /**
     * Extract pubkey from report. Author is stored as hex pubkey.
     */
    private extractPubkeyFromReport(report: ReportInfo): string | undefined {
        return report.author;
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
