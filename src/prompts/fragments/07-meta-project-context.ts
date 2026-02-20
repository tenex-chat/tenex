import type { AgentInstance } from "@/agents/types";
import { agentStorage } from "@/agents/AgentStorage";
import { conversationRegistry } from "@/conversations/ConversationRegistry";
import { getDaemon } from "@/daemon";
import { RALRegistry } from "@/services/ral/RALRegistry";
import { getPubkeyService } from "@/services/PubkeyService";
import { logger } from "@/utils/logger";
import type { PromptFragment } from "../core/types";

/**
 * Meta-project context fragment - provides agents with awareness of
 * their membership in OTHER projects and what's happening there.
 *
 * This enables cross-project awareness for agents that belong to multiple projects.
 */

interface MetaProjectContextArgs {
    agent: AgentInstance;
    currentProjectId?: string;
}

interface OtherProjectInfo {
    projectId: string;  // Full project ID: "31933:pubkey:dTag"
    dTag: string;       // Just the d-tag (human readable identifier)
    title: string;
    activeConversations: ActiveConversationSummary[];
}

interface ActiveConversationSummary {
    title: string;
    agentName: string;
    status: string;      // "streaming", "running <tool>", "active"
    duration: string;    // "5m", "1h 30m"
}

const MAX_OTHER_PROJECTS = 5;
const MAX_CONVS_PER_PROJECT = 5;
const MAX_SUMMARY_LENGTH = 150;
const ELLIPSIS = "...";

/**
 * Sanitize text for safe inclusion in system prompt.
 */
function sanitizeForPrompt(text: string, maxLength: number = MAX_SUMMARY_LENGTH): string {
    let sanitized = text
        .replace(/[\r\n]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    if (sanitized.length > maxLength) {
        sanitized = sanitized.substring(0, maxLength - ELLIPSIS.length) + ELLIPSIS;
    }

    return sanitized;
}

/**
 * Format duration since a timestamp into a human-readable string.
 */
function formatDuration(startTimestampMs: number): string {
    const now = Date.now();
    const durationMs = now - startTimestampMs;
    const seconds = Math.floor(durationMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
        const remainingMinutes = minutes % 60;
        return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
    }
    if (minutes > 0) {
        return `${minutes}m`;
    }
    return `${seconds}s`;
}

/**
 * Load other projects this agent belongs to and their active conversations.
 */
async function loadOtherProjectsContext(
    agentPubkey: string,
    currentProjectId?: string
): Promise<OtherProjectInfo[]> {
    try {
        // Get all project dTags where this agent is a member
        const agentProjectDTags = await agentStorage.getAgentProjects(agentPubkey);
        
        if (agentProjectDTags.length === 0) {
            return [];
        }

        // Get daemon for known projects info
        let daemon;
        try {
            daemon = getDaemon();
        } catch {
            // Daemon might not be available (e.g., in MCP-only mode or tests)
            logger.debug("Meta-project context: daemon not available, skipping");
            return [];
        }

        const knownProjects = daemon.getKnownProjects();
        const ralRegistry = RALRegistry.getInstance();
        const pubkeyService = getPubkeyService();

        // Build map of dTag -> full project info
        const dTagToProjectId = new Map<string, { projectId: string; title: string }>();
        for (const [projectId, project] of knownProjects) {
            // projectId format: "31933:pubkey:dTag"
            const parts = projectId.split(":");
            const dTag = parts[2];
            if (dTag && agentProjectDTags.includes(dTag)) {
                const title = project.tagValue("title") || dTag;
                dTagToProjectId.set(dTag, { projectId, title });
            }
        }

        // Filter out current project and limit
        const otherProjectDTags = agentProjectDTags.filter(dTag => {
            const info = dTagToProjectId.get(dTag);
            return info && info.projectId !== currentProjectId;
        });

        const limitedDTags = otherProjectDTags.slice(0, MAX_OTHER_PROJECTS);
        const results: OtherProjectInfo[] = [];

        for (const dTag of limitedDTags) {
            const projectInfo = dTagToProjectId.get(dTag);
            if (!projectInfo) continue;

            // Get active conversations for this project
            const activeEntries = ralRegistry.getActiveEntriesForProject(projectInfo.projectId);
            
            // Deduplicate by conversation and take most interesting entry
            const conversationMap = new Map<string, typeof activeEntries[0]>();
            for (const entry of activeEntries) {
                const existing = conversationMap.get(entry.conversationId);
                if (!existing || 
                    entry.isStreaming || 
                    (entry.currentTool && !existing.isStreaming) ||
                    entry.lastActivityAt > existing.lastActivityAt) {
                    conversationMap.set(entry.conversationId, entry);
                }
            }

            // Build conversation summaries
            const activeConversations: ActiveConversationSummary[] = [];
            let convCount = 0;

            for (const [conversationId, entry] of conversationMap) {
                if (convCount >= MAX_CONVS_PER_PROJECT) break;

                // Get conversation title
                let title = `Conversation ${conversationId.substring(0, 8)}...`;
                const store = conversationRegistry.get(conversationId);
                if (store) {
                    const metadata = store.getMetadata();
                    if (metadata.title) {
                        title = sanitizeForPrompt(metadata.title, 60);
                    }
                }

                // Get agent name
                const agentName = pubkeyService.getNameSync(entry.agentPubkey);

                // Build status
                let status: string;
                if (entry.isStreaming) {
                    status = "streaming";
                } else if (entry.currentTool) {
                    status = `running ${entry.currentTool}`;
                } else {
                    status = "active";
                }

                const duration = formatDuration(entry.createdAt);

                activeConversations.push({
                    title,
                    agentName,
                    status,
                    duration,
                });

                convCount++;
            }

            results.push({
                projectId: projectInfo.projectId,
                dTag,
                title: projectInfo.title,
                activeConversations,
            });
        }

        return results;
    } catch (error) {
        logger.debug("Failed to load meta-project context", { error });
        return [];
    }
}

export const metaProjectContextFragment: PromptFragment<MetaProjectContextArgs> = {
    id: "meta-project-context",
    priority: 7, // Between delegation-chain (5) and active-conversations (8)
    template: async ({ agent, currentProjectId }) => {
        const otherProjects = await loadOtherProjectsContext(agent.pubkey, currentProjectId);

        if (otherProjects.length === 0) {
            return ""; // No other projects to show
        }

        const projectSections = otherProjects.map(project => {
            const convLines = project.activeConversations.length > 0
                ? project.activeConversations.map(conv => 
                    `  - "${conv.title}" - ${conv.agentName} (${conv.status}, ${conv.duration})`
                ).join("\n")
                : "  - No active conversations";

            return `### Project: ${project.title}
- ID: ${project.dTag}
- Active conversations:
${convLines}`;
        });

        return `## Cross-Project Context

You are also a member of these other projects:

${projectSections.join("\n\n")}

---`;
    },
};
