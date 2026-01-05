import type { ExecutionContext } from "@/agents/execution/types";
import type { AISdkTool } from "@/tools/types";
import { getDaemon } from "@/daemon";
import { agentStorage } from "@/agents/AgentStorage";
import { logger } from "@/utils/logger";
import { NDKUser, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
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
    const activeRuntimes = daemon.getActiveRuntimes();

    logger.info("📦 Listing all known projects", {
        knownCount: knownProjects.size,
        runningCount: activeRuntimes.size,
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
        const runtime = activeRuntimes.get(projectId);
        const isRunning = !!runtime;

        // Get agents - from running context if available, otherwise from storage
        const agents: ProjectAgent[] = [];

        if (runtime) {
            // Running project - get agents from runtime context
            const runtimeContext = runtime.getContext();
            const pmPubkey = runtimeContext?.projectManager?.pubkey;
            const agentMap = runtimeContext?.agentRegistry.getAllAgentsMap() || new Map();
            for (const agent of agentMap.values()) {
                const isPM = agent.pubkey === pmPubkey;
                agents.push({
                    slug: agent.slug,
                    pubkey: agent.pubkey,
                    role: agent.role,
                    ...(isPM && { isPM: true }),
                });
            }
        } else {
            // Not running - get agents from storage
            const storedAgents = await agentStorage.getProjectAgents(dTag);
            for (const storedAgent of storedAgents) {
                const signer = new NDKPrivateKeySigner(storedAgent.nsec);
                const pubkey = (await signer.user()).pubkey;
                agents.push({
                    slug: storedAgent.slug,
                    pubkey,
                    role: storedAgent.role,
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
            "For each agent shows: slug, pubkey, role, and isPM (only if true). " +
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
