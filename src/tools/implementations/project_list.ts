import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { getDaemon } from "@/daemon";
import { agentStorage } from "@/agents/AgentStorage";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const projectListSchema = z.object({
    search: z
        .string()
        .optional()
        .describe(
            "Optional fuzzy search string. When provided, only projects whose id, title, description, or repository contain this string (case-insensitive) are returned."
        ),
});

type ProjectListInput = z.infer<typeof projectListSchema>;

type AgentRoleMap = Record<string, string>;

type ProjectInfo = {
    id: string; // The project's dTag (unique identifier)
    title?: string;
    description?: string;
    repository?: string;
    isRunning: boolean;
    agents: AgentRoleMap;
};

type ProjectListOutput = {
    projects: ProjectInfo[];
    summary: {
        totalProjects: number;
        runningProjects: number;
        totalAgents: number;
    };
};

function formatAgentKey(slug: string, isPM = false): string {
    return isPM ? `${slug} (PM)` : slug;
}

function addAgentRole(agents: AgentRoleMap, slug: string, role: string, isPM = false): void {
    agents[formatAgentKey(slug, isPM)] = role;
}

function matchesProjectSearch(project: ProjectInfo, query: string): boolean {
    return [project.id, project.title, project.description, project.repository].some((value) =>
        (value ?? "").toLowerCase().includes(query)
    );
}

async function executeProjectList(
    context: ToolExecutionContext,
    { search }: ProjectListInput
): Promise<ProjectListOutput> {
    const daemon = getDaemon();
    const knownProjects = daemon.getKnownProjects();
    const activeRuntimes = daemon.getActiveRuntimes();

    logger.info("📦 Listing all known projects", {
        knownCount: knownProjects.size,
        runningCount: activeRuntimes.size,
        agent: context.agent.name,
    });

    const projects: ProjectInfo[] = [];

    // Track which projects we've processed (by d-tag)
    const processedDTags = new Set<string>();

    // First, process all RUNNING projects from activeRuntimes (source of truth for running state)
    // This handles the case where a project is running but not in knownProjects
    // (e.g., kind:31933 event hasn't arrived yet from subscription)
    for (const [projectId, runtime] of activeRuntimes) {
        // projectId format is "31933:pubkey:id" or just the d-tag
        const id = projectId.includes(":") ? projectId.split(":")[2] : projectId;
        if (!id) {
            logger.warn("⚠️ Running project missing id, skipping", { projectId });
            continue;
        }

        processedDTags.add(id);

        // Try to get project metadata from knownProjects, fall back to runtime
        const project = knownProjects.get(projectId);
        const runtimeContext = runtime.getContext();

        const title =
            project?.tagValue("title") ||
            project?.tagValue("name") ||
            runtimeContext?.project?.tagValue("title") ||
            id;
        const description = project?.content || project?.tagValue("description");
        const repository = project?.tagValue("repo") || project?.tagValue("repository");

        // Get agents from runtime context (authoritative for running projects)
        const agents = Object.create(null) as AgentRoleMap;
        const pmPubkey = runtimeContext?.projectManager?.pubkey;
        const agentMap = runtimeContext?.agentRegistry.getAllAgentsMap() || new Map();
        for (const agent of agentMap.values()) {
            const isPM = agent.pubkey === pmPubkey;
            addAgentRole(agents, agent.slug, agent.role, isPM);
        }

        projects.push({
            id,
            title,
            description,
            repository,
            isRunning: true,
            agents,
        });
    }

    // Then, process NON-RUNNING projects from knownProjects (discovered via Nostr)
    for (const [projectId, project] of knownProjects) {
        // projectId format is "31933:pubkey:id" or just the d-tag
        const id = projectId.includes(":") ? projectId.split(":")[2] : projectId;
        if (!id) {
            logger.warn("⚠️ Project missing id, skipping", { projectId });
            continue;
        }

        // Skip if already processed as a running project
        if (processedDTags.has(id)) {
            continue;
        }

        processedDTags.add(id);

        const title = project.tagValue("title") || project.tagValue("name");
        const description = project.content || project.tagValue("description");
        const repository = project.tagValue("repo") || project.tagValue("repository");

        // Not running - get agents from storage
        const agents = Object.create(null) as AgentRoleMap;
        const storedAgents = await agentStorage.getProjectAgents(id);
        for (const storedAgent of storedAgents) {
            addAgentRole(agents, storedAgent.slug, storedAgent.role);
        }

        projects.push({
            id,
            title,
            description,
            repository,
            isRunning: false,
            agents,
        });
    }

    // Finally, process OFFLINE projects from AgentStorage (local storage, not discovered via Nostr)
    // This catches projects that exist locally but haven't been discovered via Nostr subscriptions
    const storedProjectDTags = await agentStorage.getAllProjectDTags();
    for (const dTag of storedProjectDTags) {
        // Skip if already processed (either running or discovered via Nostr)
        if (processedDTags.has(dTag)) {
            continue;
        }

        processedDTags.add(dTag);

        // Get agents from storage - this is the only metadata we have for offline projects
        const agents = Object.create(null) as AgentRoleMap;
        const storedAgents = await agentStorage.getProjectAgents(dTag);
        for (const storedAgent of storedAgents) {
            addAgentRole(agents, storedAgent.slug, storedAgent.role);
        }

        projects.push({
            id: dTag,
            title: dTag, // Use dTag as title since we have no Nostr metadata
            isRunning: false,
            agents,
        });
    }

    const normalizedSearch = search?.trim().toLowerCase();

    const returnedProjects = normalizedSearch
        ? projects.filter((project) => matchesProjectSearch(project, normalizedSearch))
        : projects;

    const totalAgents = returnedProjects.reduce(
        (sum, project) => sum + Object.keys(project.agents).length,
        0
    );

    const runningCount = returnedProjects.filter((p) => p.isRunning).length;

    logger.info("✅ Project list complete", {
        collectedProjects: projects.length,
        returnedProjects: returnedProjects.length,
        search: normalizedSearch,
        agent: context.agent.name,
    });

    return {
        projects: returnedProjects,
        summary: {
            totalProjects: returnedProjects.length,
            runningProjects: runningCount,
            totalAgents,
        },
    };
}

export function createProjectListTool(context: ToolExecutionContext): AISdkTool {
    const coreTool = tool({
        description:
            "List known projects with their agents and running status. Optionally filter by search text. " +
            'Agent keys ending with " (PM)" indicate the project manager; use the slug without the suffix when calling delegate_crossproject.',
        inputSchema: projectListSchema,
        execute: async (input) => {
            return await executeProjectList(context, input);
        },
    }) as AISdkTool;

    return coreTool;
}
