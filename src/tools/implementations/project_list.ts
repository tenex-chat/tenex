import type { ExecutionContext } from "@/agents/execution/types";
import type { AISdkTool } from "@/tools/types";
import { getDaemon } from "@/daemon";
import { getProjectContextManager } from "@/daemon/ProjectContextManager";
import { agentStorage } from "@/agents/AgentStorage";
import { logger } from "@/utils/logger";
import { NDKUser, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { tool } from "ai";
import { z } from "zod";

const projectListSchema = z.object({});

type ProjectAgent = {
    slug: string;
    name: string;
    pubkey: string;
    npub: string;
    role: string;
    isPM: boolean;
};

type ProjectInfo = {
    id: string; // Format: "31933:pubkey:dTag"
    naddr: string; // NIP-19 naddr encoding
    title?: string;
    description?: string;
    repository?: string;
    dTag: string;
    ownerPubkey: string;
    ownerNpub: string;
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

async function executeProjectList(context: ExecutionContext): Promise<ProjectListOutput> {
    const daemon = getDaemon();
    const knownProjects = daemon.getKnownProjects();
    const contextManager = getProjectContextManager();
    const runningContexts = contextManager.getAllContexts();

    logger.info("📦 Listing all known projects", {
        knownCount: knownProjects.size,
        runningCount: runningContexts.size,
        agent: context.agent.name,
    });

    const projects: ProjectInfo[] = [];
    let totalAgents = 0;

    for (const [projectId, project] of knownProjects) {
        const dTag = project.tagValue("d");
        if (!dTag) {
            logger.warn("⚠️ Project missing d tag, skipping", { projectId });
            continue;
        }

        const title = project.tagValue("title") || project.tagValue("name");
        const description = project.tagValue("description");
        const repository = project.tagValue("repository");
        const ownerPubkey = project.pubkey;
        const ownerUser = new NDKUser({ pubkey: ownerPubkey });
        const naddr = project.encode();

        // Check if this project is running
        const runningContext = runningContexts.get(projectId);
        const isRunning = !!runningContext;

        // Get agents - from running context if available, otherwise from storage
        const agents: ProjectAgent[] = [];

        if (runningContext) {
            // Running project - get agents from context
            const pmPubkey = runningContext.projectManager?.pubkey;
            for (const agent of runningContext.agents.values()) {
                const user = new NDKUser({ pubkey: agent.pubkey });
                agents.push({
                    slug: agent.slug,
                    name: agent.name,
                    pubkey: agent.pubkey,
                    npub: user.npub,
                    role: agent.role,
                    isPM: agent.pubkey === pmPubkey,
                });
            }
        } else {
            // Not running - get agents from storage
            const storedAgents = await agentStorage.getProjectAgents(dTag);
            for (const storedAgent of storedAgents) {
                const signer = new NDKPrivateKeySigner(storedAgent.nsec);
                const pubkey = (await signer.user()).pubkey;
                const user = new NDKUser({ pubkey });
                agents.push({
                    slug: storedAgent.slug,
                    name: storedAgent.name,
                    pubkey,
                    npub: user.npub,
                    role: storedAgent.role,
                    isPM: false, // Can't determine PM for non-running projects
                });
            }
        }

        totalAgents += agents.length;

        projects.push({
            id: projectId,
            naddr,
            title,
            description,
            repository,
            dTag,
            ownerPubkey,
            ownerNpub: ownerUser.npub,
            isRunning,
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

export function createProjectListTool(context: ExecutionContext): AISdkTool {
    const coreTool = tool({
        description:
            "List ALL known projects with their agents and running status. " +
            "For each project shows: id, naddr, title, description, repository, owner info, isRunning flag, and all agents. " +
            "For each agent shows: slug, name, pubkey, npub, role, and whether they're the project manager. " +
            "Includes both running and non-running projects discovered by the daemon.",
        inputSchema: projectListSchema,
        execute: async () => {
            return await executeProjectList(context);
        },
    }) as AISdkTool;

    coreTool.getHumanReadableContent = () => {
        return "Listing all known projects and their agents";
    };

    return coreTool;
}
