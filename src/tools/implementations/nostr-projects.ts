import { tool } from 'ai';
import { NDKProjectStatus } from "@/events/NDKProjectStatus";
import { getNDK } from "@/nostr";
import { getProjectContext } from "@/services/ProjectContext";
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import { NDKArticle, NDKUser } from "@nostr-dev-kit/ndk";
import { z } from "zod";
import type { ExecutionContext } from "@/agents/execution/types";

// Define schema that gracefully handles no arguments, empty strings, or optional pubkey
// This handles cases where LLMs send "", {}, or {pubkey: "..."}
const nostrProjectsSchema = z
  .object({
    pubkey: z
      .string()
      .optional()
      .describe(
        "Public key to fetch projects for. Defaults to project owner's pubkey if available"
      ),
  })
  .partial(); // Make all properties optional, effectively allowing empty object

type NostrProjectsInput = z.infer<typeof nostrProjectsSchema>;
type NostrProjectsOutput = {
  projects: Array<{
    id: string;
    title?: string;
    description?: string;
    repository?: string;
    image?: string;
    online: boolean;
    agents?: Record<string, string>;
    date?: number;
    specs: Array<{
      title?: string;
      summary?: string;
      id: string;
      date?: number;
    }>;
  }>;
  summary: {
    totalProjects: number;
    onlineProjects: number;
    offlineProjects: number;
    totalSpecDocuments: number;
  };
};

// Core implementation - extracted from existing execute function
async function executeNostrProjects(input: NostrProjectsInput, context: ExecutionContext): Promise<NostrProjectsOutput> {
  const ndk = getNDK();
  if (!ndk) {
    throw new Error("NDK instance not available");
  }

  // Determine which pubkey to use
  let targetPubkey = input.pubkey;

  if (!targetPubkey) {
    // Try to get project owner's pubkey from context
    const projectCtx = getProjectContext();
    if (projectCtx?.project?.pubkey) {
      targetPubkey = projectCtx.project.pubkey;
      logger.info("🔍 Using project owner's pubkey from context", {
        pubkey: targetPubkey,
        agent: context.agent.name,
      });
    } else {
      throw new Error("No pubkey provided and no project context available");
    }
  }

  logger.info("🔍 Fetching projects for pubkey", {
    pubkey: targetPubkey,
    agent: context.agent.name,
    phase: context.phase,
  });

  // Publish status message about what we're doing
  try {
    const conversation = context.conversationCoordinator.getConversation(context.conversationId);
    
    if (conversation?.history?.[0]) {
      // Format the pubkey as npub for the status message
      const user = new NDKUser({ pubkey: targetPubkey });
      await context.agentPublisher.conversation(
        { type: "conversation", content: `🔍 Getting nostr:${user.npub}'s projects` },
        {
          triggeringEvent: context.triggeringEvent,
          rootEvent: conversation.history[0],
          conversationId: context.conversationId,
        }
      );
    }
  } catch (error) {
    // Don't fail the tool if we can't publish the status
    logger.warn("Failed to publish nostr_projects status:", error);
  }

  // Calculate 1 minute ago timestamp for online status check
  const oneMinuteAgo = Math.floor(Date.now() / 1000) - 60;

  // Fetch both kinds of events in parallel
  const [projectEvents, statusEvents] = await Promise.all([
    // Fetch 31933 events (NDKProject)
    ndk.fetchEvents({
      kinds: [31933],
      authors: [targetPubkey],
    }),
    // Fetch 24010 events (project status - online agents)
    // Only get status events from the last minute to determine if online
    ndk.fetchEvents({
      kinds: [NDKProjectStatus.kind],
      "#p": [targetPubkey],
      since: oneMinuteAgo,
    }),
  ]);

  // Build a map of online agents by project (keyed by project tagId)
  const onlineAgentsByProject = new Map<string, Record<string, string>>();

  // Process status events to find online agents
  Array.from(statusEvents).forEach((event) => {
    // Convert to NDKProjectStatus for type safety
    const statusEvent = NDKProjectStatus.from(event);

    // Get the project reference
    const projectTagId = statusEvent.projectReference;
    if (projectTagId) {
      // Get agents from the status event
      const agents = statusEvent.agents;
      const agentsMap: Record<string, string> = {};

      agents.forEach(({ pubkey, slug }) => {
        // Convert pubkey to npub format
        const agentUser = new NDKUser({ pubkey });
        agentsMap[slug] = agentUser.npub;
      });

      // Store agents for this specific project using its tagId as the key
      if (Object.keys(agentsMap).length > 0) {
        onlineAgentsByProject.set(projectTagId, agentsMap);
      }
    }
  });

  // Once we have the list of projects, fetch spec documents that tag them
  interface SpecArticle {
    title: string | undefined;
    summary: string | undefined;
    id: string;
    date: number | undefined;
    _projectRefs: string[];
  }
  let specArticles: SpecArticle[] = [];
  if (projectEvents.size > 0) {
    // Create array of project tag IDs for fetching articles
    const projectTagIds = Array.from(projectEvents).map((projectEvent) => {
      return projectEvent.tagId();
    });

    logger.info("📄 Fetching spec documents for projects", {
      projectCount: projectTagIds.length,
      agent: context.agent.name,
    });

    // Fetch NDKArticles (kind 30023) that tag these projects
    const articleEvents = await ndk.fetchEvents(
      {
        kinds: [30023],
        "#a": projectTagIds,
      },
      { subId: "spec-articles" }
    );

    // Process articles
    specArticles = Array.from(articleEvents).map((event) => {
      const article = NDKArticle.from(event);

      // Get project references from the article's tags (for internal filtering only)
      const projectRefs = event.tags
        .filter((tag) => tag[0] === "a" && projectTagIds.includes(tag[1]))
        .map((tag) => tag[1]);

      // Get summary or first 300 bytes of content
      let summary = article.summary;
      if (!summary && article.content) {
        summary = article.content.substring(0, 300);
        if (article.content.length > 300) {
          summary += "...";
        }
      }

      return {
        title: article.title,
        summary: summary,
        id: `nostr:${article.encode()}`,
        date: article.created_at,
        _projectRefs: projectRefs, // Keep for internal filtering but prefix with underscore
      };
    });

    logger.info("✅ Spec documents fetched", {
      articleCount: specArticles.length,
      agent: context.agent.name,
    });
  }

  // Process project events (31933)
  const projects = Array.from(projectEvents).map((projectEvent) => {
    const title = projectEvent.tagValue("title") || projectEvent.tagValue("name");
    const description = projectEvent.tagValue("description");
    const repository = projectEvent.tagValue("repository");
    const image = projectEvent.tagValue("image");

    // Get the project's tagId for matching with status events and articles
    const projectTagId = projectEvent.tagId();

    // Check if this project has online agents using its tagId
    const isOnline = onlineAgentsByProject.has(projectTagId);
    const onlineAgents = isOnline ? onlineAgentsByProject.get(projectTagId) : undefined;

    // Get the encoded project ID with nostr: prefix
    const projectId = `nostr:${projectEvent.encode()}`;

    // Find spec articles for this project
    const projectSpecs = specArticles
      .filter((article) => article._projectRefs.includes(projectTagId))
      .map(({ _projectRefs, ...article }) => article); // Remove internal _projectRefs field

    return {
      id: projectId,
      title,
      description,
      repository,
      image,
      online: isOnline,
      agents: onlineAgents,
      date: projectEvent.created_at,
      specs: projectSpecs,
    };
  });

  // Sort projects by creation time (newest first)
  projects.sort((a, b) => (b.date || 0) - (a.date || 0));

  const result: NostrProjectsOutput = {
    projects,
    summary: {
      totalProjects: projects.length,
      onlineProjects: projects.filter((p) => p.online).length,
      offlineProjects: projects.filter((p) => !p.online).length,
      totalSpecDocuments: specArticles.length,
    },
  };

  logger.info("✅ Projects fetched successfully", {
    pubkey: targetPubkey,
    projectCount: projects.length,
    onlineCount: result.summary.onlineProjects,
    specDocumentCount: specArticles.length,
    agent: context.agent.name,
  });

  return result;
}

// AI SDK tool factory
export function createNostrProjectsTool(context: ExecutionContext) {
  return tool({
    description: "Fetch Nostr projects for a pubkey, including online status and spec documents",
    parameters: nostrProjectsSchema,
    execute: async (input: NostrProjectsInput) => {
      return await executeNostrProjects(input, context);
    },
  });
}

