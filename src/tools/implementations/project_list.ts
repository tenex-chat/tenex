import type { ExecutionContext } from "@/agents/execution/types";
import type { AISdkTool } from "@/tools/types";
import { getProjectContext } from "@/services/ProjectContext";
import { logger } from "@/utils/logger";
import { NDKUser } from "@nostr-dev-kit/ndk";
import { tool } from "ai";
import { z } from "zod";

// No parameters needed - this tool only shows the current instance's project
const projectListSchema = z.object({});

type ProjectListOutput = {
    project: {
        id: string;
        title?: string;
        description?: string;
        repository?: string;
        image?: string;
        ownerPubkey: string;
        ownerNpub: string;
    };
    agents: Array<{
        slug: string;
        name: string;
        npub: string;
        isProjectManager: boolean;
    }>;
    summary: {
        totalAgents: number;
    };
};

function executeProjectList(context: ExecutionContext): ProjectListOutput {
    const projectCtx = getProjectContext();
    const project = projectCtx.project;

    // Get project info from the local context
    const title = project.tagValue("title") || project.tagValue("name");
    const description = project.tagValue("description");
    const repository = project.tagValue("repository");
    const image = project.tagValue("image");
    const projectId = `nostr:${project.encode()}`;

    // Get owner info
    const ownerPubkey = project.pubkey;
    const ownerUser = new NDKUser({ pubkey: ownerPubkey });

    // Get agents from the local registry
    const agents = Array.from(projectCtx.agents.values()).map((agent) => {
        const user = new NDKUser({ pubkey: agent.pubkey });
        return {
            slug: agent.slug,
            name: agent.name,
            npub: user.npub,
            isProjectManager: agent.pubkey === projectCtx.projectManager?.pubkey,
        };
    });

    const result: ProjectListOutput = {
        project: {
            id: projectId,
            title,
            description,
            repository,
            image,
            ownerPubkey,
            ownerNpub: ownerUser.npub,
        },
        agents,
        summary: {
            totalAgents: agents.length,
        },
    };

    logger.info("✅ Project list retrieved from local context", {
        projectTitle: title,
        agentCount: agents.length,
        agent: context.agent.name,
    });

    return result;
}

export function createProjectListTool(context: ExecutionContext): AISdkTool {
    const coreTool = tool({
        description:
            "Get information about the current project and its agents. Use this to see what agents are available in this project.",
        inputSchema: projectListSchema,
        execute: async () => {
            return executeProjectList(context);
        },
    }) as AISdkTool;

    coreTool.getHumanReadableContent = () => {
        return "Getting project information";
    };

    return coreTool;
}
