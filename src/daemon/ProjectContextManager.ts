import type { AgentRegistry } from "@/agents/AgentRegistry";
import type { LLMLogger } from "@/logging/LLMLogger";
import { ProjectContext } from "@/services/ProjectContext";
import { logger } from "@/utils/logger";
import type { Hexpubkey } from "@nostr-dev-kit/ndk";
import type { NDKProject } from "@nostr-dev-kit/ndk";

/**
 * ProjectContextManager is a REGISTRY for project contexts.
 *
 * Responsibilities:
 * - Store/retrieve contexts by project ID
 * - Track agent-to-project mappings
 * - Provide lookup functions
 *
 * NOT responsible for:
 * - Setting "active" context (use projectContextStore.run())
 * - Global state management
 */
export class ProjectContextManager {
    /**
     * Map of project ID to ProjectContext
     * Key format: "31933:authorPubkey:dTag"
     */
    private contexts = new Map<string, ProjectContext>();

    /**
     * Track which agents belong to which projects for routing
     * Key: agent pubkey, Value: Set of project IDs
     */
    private agentToProjects = new Map<Hexpubkey, Set<string>>();

    /**
     * Get or create a ProjectContext for a project
     */
    async loadProject(
        project: NDKProject,
        agentRegistry: AgentRegistry,
        llmLogger: LLMLogger
    ): Promise<ProjectContext> {
        const projectId = this.getProjectId(project);

        let context = this.contexts.get(projectId);
        if (!context) {
            logger.info(`Creating new ProjectContext for project ${projectId}`, {
                title: project.tagValue("title"),
                authorPubkey: project.pubkey,
            });

            context = new ProjectContext(project, agentRegistry, llmLogger);
            this.contexts.set(projectId, context);

            // Update agent-to-project mappings
            this.updateAgentMappings(projectId, context);
        } else {
            logger.debug(`Using existing ProjectContext for project ${projectId}`);
        }

        return context;
    }

    /**
     * Update an existing project's data
     */
    async updateProject(project: NDKProject): Promise<ProjectContext | null> {
        const projectId = this.getProjectId(project);
        const context = this.contexts.get(projectId);

        if (!context) {
            logger.warn(`Cannot update project ${projectId} - not loaded`);
            return null;
        }

        // Clear old agent mappings before update
        this.clearAgentMappings(projectId, context);

        // Update the project data
        await context.updateProjectData(project);

        // Re-build agent mappings with new data
        this.updateAgentMappings(projectId, context);

        logger.info(`Updated project ${projectId}`, {
            title: project.tagValue("title"),
            agentsCount: context.agents.size,
        });

        return context;
    }

    /**
     * Get a specific project context
     */
    getContext(projectId: string): ProjectContext | undefined {
        return this.contexts.get(projectId);
    }

    /**
     * Get all loaded contexts
     */
    getAllContexts(): Map<string, ProjectContext> {
        return new Map(this.contexts);
    }

    /**
     * Find which project(s) an agent belongs to
     */
    findProjectsForAgent(agentPubkey: Hexpubkey): string[] {
        const projectIds = this.agentToProjects.get(agentPubkey);
        return projectIds ? Array.from(projectIds) : [];
    }

    /**
     * Find the first project that contains a specific agent
     * Used for routing events that only have p-tags
     */
    findFirstProjectForAgent(agentPubkey: Hexpubkey): string | null {
        const projects = this.findProjectsForAgent(agentPubkey);
        return projects.length > 0 ? projects[0] : null;
    }

    /**
     * Check if a project is loaded
     */
    hasProject(projectId: string): boolean {
        return this.contexts.has(projectId);
    }

    /**
     * Remove a project context (for cleanup)
     */
    removeProject(projectId: string): boolean {
        const context = this.contexts.get(projectId);
        if (!context) {
            return false;
        }

        // Clear agent mappings
        this.clearAgentMappings(projectId, context);

        // Remove the context
        this.contexts.delete(projectId);

        logger.info(`Removed project context ${projectId}`);
        return true;
    }

    /**
     * Get all known project IDs
     */
    getProjectIds(): string[] {
        return Array.from(this.contexts.keys());
    }

    /**
     * Get all agent pubkeys across all projects
     */
    getAllAgentPubkeys(): Hexpubkey[] {
        return Array.from(this.agentToProjects.keys());
    }

    /**
     * Build the project ID from an NDKProject event
     * Format: "31933:authorPubkey:dTag"
     */
    private getProjectId(project: NDKProject): string {
        const dTag = project.tagValue("d");
        if (!dTag) {
            throw new Error("Project missing required d tag");
        }
        return `31933:${project.pubkey}:${dTag}`;
    }

    /**
     * Update agent-to-project mappings for a project
     */
    private updateAgentMappings(projectId: string, context: ProjectContext): void {
        const agents = context.agentRegistry.getAllAgentsMap();

        for (const agent of agents.values()) {
            let projectSet = this.agentToProjects.get(agent.pubkey);
            if (!projectSet) {
                projectSet = new Set<string>();
                this.agentToProjects.set(agent.pubkey, projectSet);
            }
            projectSet.add(projectId);
        }

        logger.debug(`Updated agent mappings for project ${projectId}`, {
            agentCount: agents.size,
            agentPubkeys: Array.from(agents.values()).map((a) => a.pubkey.slice(0, 8)),
        });
    }

    /**
     * Clear agent mappings for a project
     */
    private clearAgentMappings(projectId: string, context: ProjectContext): void {
        const agents = context.agentRegistry.getAllAgentsMap();

        for (const agent of agents.values()) {
            const projectSet = this.agentToProjects.get(agent.pubkey);
            if (projectSet) {
                projectSet.delete(projectId);
                if (projectSet.size === 0) {
                    this.agentToProjects.delete(agent.pubkey);
                }
            }
        }
    }

    /**
     * Get statistics about loaded projects
     */
    getStats(): {
        totalProjects: number;
        totalAgents: number;
        projectDetails: Array<{
            id: string;
            title: string;
            agentCount: number;
        }>;
    } {
        const projectDetails = Array.from(this.contexts.entries()).map(([id, ctx]) => ({
            id,
            title: ctx.project.tagValue("title") || "Untitled",
            agentCount: ctx.agents.size,
        }));

        return {
            totalProjects: this.contexts.size,
            totalAgents: this.agentToProjects.size,
            projectDetails,
        };
    }
}

// Global singleton instance
let managerInstance: ProjectContextManager | undefined;

/**
 * Get or create the global ProjectContextManager instance
 */
export function getProjectContextManager(): ProjectContextManager {
    if (!managerInstance) {
        managerInstance = new ProjectContextManager();
    }
    return managerInstance;
}

/**
 * Reset the manager (mainly for testing)
 */
export function resetProjectContextManager(): void {
    managerInstance = undefined;
}
