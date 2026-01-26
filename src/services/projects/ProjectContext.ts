import type { AgentRegistry } from "@/agents/AgentRegistry";
import type { AgentInstance } from "@/agents/types";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import type { MCPManager } from "@/services/mcp/MCPManager";
import type { PairingManager } from "@/services/pairing";
import type { PromptCompilerService } from "@/services/prompt-compiler";
import type { LocalReportStore } from "@/services/reports/LocalReportStore";
import type { ReportInfo } from "@/services/reports/ReportService";
import { articleToReportInfo } from "@/services/reports/articleUtils";
import type { ProjectStatusService } from "@/services/status/ProjectStatusService";
import { logger } from "@/utils/logger";
import type { Hexpubkey, NDKProject, NDKArticle } from "@nostr-dev-kit/ndk";
import { nip19 } from "nostr-tools";

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
     * PairingManager for real-time delegation supervision (optional, initialized when needed)
     */
    public pairingManager?: PairingManager;

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
     * Prompt compilers for agents in this project
     * Key: agent pubkey, Value: PromptCompilerService instance
     * Used to compile lessons + comments into optimized system prompts
     */
    private readonly promptCompilers: Map<Hexpubkey, PromptCompilerService> = new Map();

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
            this.projectManager = projectManagerAgent;
        }

        this.agentLessons = new Map();
        this.reports = new Map();
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
     * Add a lesson for an agent, maintaining the 50-lesson limit per agent.
     * EAGER COMPILATION: Also triggers background recompilation of the agent's prompt.
     */
    addLesson(agentPubkey: string, lesson: NDKAgentLesson): void {
        const existingLessons = this.agentLessons.get(agentPubkey) || [];

        // Add the new lesson at the beginning (most recent first)
        const updatedLessons = [lesson, ...existingLessons];

        // Keep only the most recent 50 lessons
        const limitedLessons = updatedLessons.slice(0, 50);

        this.agentLessons.set(agentPubkey, limitedLessons);

        // EAGER COMPILATION: Trigger recompilation when new lesson arrives
        // This is fire-and-forget - compilation happens in background
        const compiler = this.promptCompilers.get(agentPubkey);
        if (compiler) {
            logger.debug("ProjectContext: triggering recompilation after new lesson", {
                agentPubkey: agentPubkey.substring(0, 8),
                lessonTitle: lesson.title,
            });
            compiler.onLessonArrived();
        }
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
    // PROMPT COMPILER MANAGEMENT
    // =====================================================================================

    /**
     * Set the prompt compiler for an agent
     * @param agentPubkey The agent's public key
     * @param compiler The PromptCompilerService instance
     */
    setPromptCompiler(agentPubkey: Hexpubkey, compiler: PromptCompilerService): void {
        this.promptCompilers.set(agentPubkey, compiler);
    }

    /**
     * Get the prompt compiler for an agent
     * @param agentPubkey The agent's public key
     * @returns The PromptCompilerService instance or undefined if not set
     */
    getPromptCompiler(agentPubkey: Hexpubkey): PromptCompilerService | undefined {
        return this.promptCompilers.get(agentPubkey);
    }

    /**
     * Check if a prompt compiler exists for an agent
     * @param agentPubkey The agent's public key
     * @returns True if a compiler exists for this agent
     */
    hasPromptCompiler(agentPubkey: Hexpubkey): boolean {
        return this.promptCompilers.has(agentPubkey);
    }

    /**
     * Get all prompt compilers
     * @returns Map of agent pubkeys to their PromptCompilerService instances
     */
    getAllPromptCompilers(): Map<Hexpubkey, PromptCompilerService> {
        return new Map(this.promptCompilers);
    }

    /**
     * Stop all prompt compiler subscriptions
     * Called during project shutdown
     */
    stopAllPromptCompilers(): void {
        for (const [pubkey, compiler] of this.promptCompilers) {
            logger.debug("Stopping prompt compiler", { agentPubkey: pubkey.substring(0, 8) });
            compiler.stop();
        }
        this.promptCompilers.clear();
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
        // Extract author pubkey from npub or use as-is
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
     * Extract pubkey from report (handles both npub and hex formats)
     */
    private extractPubkeyFromReport(report: ReportInfo): string | undefined {
        if (!report.author) return undefined;

        // If it's an npub, try to decode it
        if (report.author.startsWith("npub1")) {
            try {
                const decoded = nip19.decode(report.author);
                if (decoded.type === "npub") {
                    return decoded.data as string;
                }
            } catch {
                // Fall through to return as-is
            }
        }

        // Assume it's already a hex pubkey
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
