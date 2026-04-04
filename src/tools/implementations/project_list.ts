import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { getDaemon } from "@/daemon";
import { agentStorage } from "@/agents/AgentStorage";
import { logger } from "@/utils/logger";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { PREFIX_LENGTH } from "@/utils/nostr-entity-parser";
import { tool } from "ai";
import { z } from "zod";

const projectListSchema = z.object({});

type ProjectAgent = {
    slug: string;
    pubkey: string;
    role: string;
    isPM?: true;
};

type ProjectInfo = {
    id: string; // The project's dTag (unique identifier)
    title?: string;
    description?: string;
    repository?: string;
    isRunning: boolean;
    agents: ProjectAgent[];
};

type ProjectListOutput = {
    projects: ProjectInfo[];
    summary: {
        totalProjects: number;
        runningProjects: number;
        totalAgents: number;
    };
};

async function executeProjectList(context: ToolExecutionContext): Promise<ProjectListOutput> {
    const daemon = getDaemon();
    const knownProjects = daemon.getKnownProjects();
    const activeRuntimes = daemon.getActiveRuntimes();

    logger.info("📦 Listing all known projects", {
        knownCount: knownProjects.size,
        runningCount: activeRuntimes.size,
        agent: context.agent.name,
    });

    const projects: ProjectInfo[] = [];
    let totalAgents = 0;

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

        const title = project?.tagValue("title") || project?.tagValue("name") || runtimeContext?.project?.tagValue("title") || id;
        const description = project?.content || project?.tagValue("description");
        const repository = project?.tagValue("repo") || project?.tagValue("repository");

        // Get agents from runtime context (authoritative for running projects)
        const agents: ProjectAgent[] = [];
        const pmPubkey = runtimeContext?.projectManager?.pubkey;
        const agentMap = runtimeContext?.agentRegistry.getAllAgentsMap() || new Map();
        for (const agent of agentMap.values()) {
            const isPM = agent.pubkey === pmPubkey;
            agents.push({
                slug: agent.slug,
                pubkey: agent.pubkey.substring(0, PREFIX_LENGTH),
                role: agent.role,
                ...(isPM && { isPM: true }),
            });
        }

        totalAgents += agents.length;

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
        const agents: ProjectAgent[] = [];
        const storedAgents = await agentStorage.getProjectAgents(id);
        for (const storedAgent of storedAgents) {
            const signer = new NDKPrivateKeySigner(storedAgent.nsec);
            const pubkey = (await signer.user()).pubkey;
            agents.push({
                slug: storedAgent.slug,
                pubkey: pubkey.substring(0, PREFIX_LENGTH),
                role: storedAgent.role,
            });
        }

        totalAgents += agents.length;

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
        const agents: ProjectAgent[] = [];
        const storedAgents = await agentStorage.getProjectAgents(dTag);
        for (const storedAgent of storedAgents) {
            const signer = new NDKPrivateKeySigner(storedAgent.nsec);
            const pubkey = (await signer.user()).pubkey;
            agents.push({
                slug: storedAgent.slug,
                pubkey: pubkey.substring(0, PREFIX_LENGTH),
                role: storedAgent.role,
            });
        }

        totalAgents += agents.length;

        projects.push({
            id: dTag,
            title: dTag, // Use dTag as title since we have no Nostr metadata
            isRunning: false,
            agents,
        });
    }

    const runningCount = projects.filter((p) => p.isRunning).length;

    logger.info("✅ Project list complete", {
        totalProjects: projects.length,
        runningProjects: runningCount,
        totalAgents,
        agent: context.agent.name,
    });

    return {
        projects,
        summary: {
            totalProjects: projects.length,
            runningProjects: runningCount,
            totalAgents,
        },
    };
}

export function createProjectListTool(context: ToolExecutionContext): AISdkTool {
    const coreTool = tool({
        description:
            "List ALL known projects with their agents and running status. " +
            "For each project shows: id, title, description, repository, isRunning flag, and all agents. " +
            "For each agent shows: slug, pubkey (shortened), role, and isPM (only if true). " +
            "Includes both running and non-running projects discovered by the daemon.",
        inputSchema: projectListSchema,
        execute: async () => {
            return await executeProjectList(context);
        },
    }) as AISdkTool;

    return coreTool;
}
