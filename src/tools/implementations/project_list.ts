import type { ExecutionContext } from "@/agents/execution/types";
import type { AISdkTool } from "@/tools/types";
import { agentStorage } from "@/agents/AgentStorage";
import { config } from "@/services/ConfigService";
import { getNDK } from "@/nostr/ndkClient";
import { logger } from "@/utils/logger";
import { NDKUser, NDKProject, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { tool } from "ai";
import { z } from "zod";

// No parameters needed - this tool lists all projects the user has access to
const projectListSchema = z.object({});

type ProjectAgent = {
    slug: string;
    name: string;
    pubkey: string;
    npub: string;
    role: string;
};

type ProjectInfo = {
    id: string; // Format: "nostr:naddr1..."
    naddr: string; // NIP-19 naddr encoding
    title?: string;
    description?: string;
    repository?: string;
    image?: string;
    dTag: string;
    ownerPubkey: string;
    ownerNpub: string;
    agents: ProjectAgent[];
};

type ProjectListOutput = {
    projects: ProjectInfo[];
    summary: {
        totalProjects: number;
        totalAgents: number;
    };
};

async function executeProjectList(context: ExecutionContext): Promise<ProjectListOutput> {
    const ndk = getNDK();
    const { config: loadedConfig } = await config.loadConfig();
    const whitelistedPubkeys = loadedConfig.whitelistedPubkeys || [];

    logger.info("🔍 Fetching all projects from Nostr", {
        whitelistedPubkeys: whitelistedPubkeys.length,
        agent: context.agent.name,
    });

    // Fetch all project events (kind 31933) from whitelisted pubkeys
    const projectEvents = await ndk.fetchEvents({
        kinds: [31933],
        authors: whitelistedPubkeys,
    });

    logger.info(`📦 Found ${projectEvents.size} project events`, {
        agent: context.agent.name,
    });

    const projects: ProjectInfo[] = [];
    let totalAgents = 0;

    // Process each project event
    for (const event of projectEvents) {
        const project = new NDKProject(ndk, event.rawEvent());

        // Extract project metadata
        const dTag = project.tags.find((t) => t[0] === "d")?.[1];
        if (!dTag) {
            logger.warn("⚠️ Project event missing d tag, skipping", {
                eventId: event.id,
            });
            continue;
        }

        const title = project.tagValue("title") || project.tagValue("name");
        const description = project.tagValue("description");
        const repository = project.tagValue("repository");
        const image = project.tagValue("image");
        const ownerPubkey = project.pubkey;
        const ownerUser = new NDKUser({ pubkey: ownerPubkey });
        const naddr = project.encode();

        // Get agents for this project from local storage
        const storedAgents = await agentStorage.getProjectAgents(dTag);
        const agents: ProjectAgent[] = storedAgents.map((agent) => {
            const user = new NDKUser({ pubkey: new NDKPrivateKeySigner(agent.nsec).pubkey });
            return {
                slug: agent.slug,
                name: agent.name,
                pubkey: user.pubkey,
                npub: user.npub,
                role: agent.role,
            };
        });

        totalAgents += agents.length;

        projects.push({
            id: `nostr:${naddr}`,
            naddr,
            title,
            description,
            repository,
            image,
            dTag,
            ownerPubkey,
            ownerNpub: ownerUser.npub,
            agents,
        });
    }

    logger.info("✅ Project list retrieved successfully", {
        totalProjects: projects.length,
        totalAgents,
        agent: context.agent.name,
    });

    return {
        projects,
        summary: {
            totalProjects: projects.length,
            totalAgents,
        },
    };
}

export function createProjectListTool(context: ExecutionContext): AISdkTool {
    const coreTool = tool({
        description:
            "List ALL projects the user has access to (including offline/inactive projects) with their agents. " +
            "For each project, shows: naddr (NIP-19 address), title, description, repository, owner info, and all associated agents. " +
            "For each agent, includes: slug, name, pubkey, npub, and role. " +
            "Use this to discover all available projects and their agents.",
        inputSchema: projectListSchema,
        execute: async () => {
            return await executeProjectList(context);
        },
    }) as AISdkTool;

    coreTool.getHumanReadableContent = () => {
        return "Listing all projects and their agents";
    };

    return coreTool;
}
