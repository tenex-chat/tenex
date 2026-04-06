import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentInstance } from "@/agents/types";
import { agentStorage } from "@/agents/AgentStorage";
import { conversationRegistry } from "@/conversations/ConversationRegistry";
import type { Daemon } from "@/daemon/Daemon";
import { getDaemon } from "@/daemon";
import { RALRegistry } from "@/services/ral/RALRegistry";
import { getPubkeyService } from "@/services/PubkeyService";
import { getTransportBindingStore } from "@/services/ingress/TransportBindingStoreService";
import { getIdentityBindingStore } from "@/services/identity";
import { getTelegramChatContextStore } from "@/services/telegram/TelegramChatContextStoreService";
import { parseTelegramChannelId } from "@/utils/telegram-identifiers";
import { config } from "@/services/ConfigService";
import { listWorktrees, loadWorktreeMetadata, type WorktreeMetadata } from "@/utils/git/worktree";
import { getAgentProjectInjectedFiles } from "@/lib/agent-home";
import { shortenPubkey, shortenConversationId } from "@/utils/conversation-id";
import { logger } from "@/utils/logger";
import type { PromptFragment } from "../core/types";
import type { ProjectDTag } from "@/types/project-ids";

// =============================================================================
// Constants
// =============================================================================

const WORKTREE_CONTEXT_CACHE_TTL_MS = 30_000;
const ROOT_AGENTS_MD_CACHE_TTL_MS = 30_000;
const MAX_ROOT_CONTENT_LENGTH_FOR_SYSTEM_PROMPT = 2000;
const MAX_OTHER_PROJECTS = 5;
const MAX_CONVS_PER_PROJECT = 5;
const MAX_SUMMARY_LENGTH = 150;
const ELLIPSIS = "...";

// =============================================================================
// Worktree snapshot cache
// =============================================================================

interface WorktreeSnapshot {
    hasFeatureWorktrees: boolean;
    metadata: Record<string, WorktreeMetadata>;
    worktrees: Array<{ branch: string; path: string }>;
}

interface WorktreeSnapshotCacheEntry {
    expiresAt: number;
    snapshot: WorktreeSnapshot;
}

const worktreeSnapshotCache = new Map<string, WorktreeSnapshotCacheEntry>();

async function getCachedWorktreeSnapshot(projectBasePath: string): Promise<WorktreeSnapshot> {
    const cached = worktreeSnapshotCache.get(projectBasePath);
    if (cached && cached.expiresAt > Date.now()) {
        return {
            hasFeatureWorktrees: cached.snapshot.hasFeatureWorktrees,
            metadata: { ...cached.snapshot.metadata },
            worktrees: cached.snapshot.worktrees.map((worktree) => ({ ...worktree })),
        };
    }

    let worktrees: Array<{ branch: string; path: string }> = [];
    let metadata: Record<string, WorktreeMetadata> = {};
    let hasFeatureWorktrees = false;

    try {
        worktrees = await listWorktrees(projectBasePath);
        metadata = await loadWorktreeMetadata(projectBasePath, config.getConfigPath("projects"));
        hasFeatureWorktrees = worktrees.some((wt) => wt.path.includes("/.worktrees/"));
    } catch (error) {
        logger.warn("Failed to list worktrees", { error });
    }

    const snapshot: WorktreeSnapshot = { hasFeatureWorktrees, metadata, worktrees };
    worktreeSnapshotCache.set(projectBasePath, {
        expiresAt: Date.now() + WORKTREE_CONTEXT_CACHE_TTL_MS,
        snapshot: {
            hasFeatureWorktrees,
            metadata: { ...metadata },
            worktrees: worktrees.map((worktree) => ({ ...worktree })),
        },
    });

    return snapshot;
}

// =============================================================================
// Root AGENTS.md cache
// =============================================================================

interface RootAgentsMdCacheEntry {
    expiresAt: number;
    content?: string;
}

const rootAgentsMdCache = new Map<string, RootAgentsMdCacheEntry>();

async function getCachedRootAgentsMd(
    projectBasePath: string
): Promise<string | undefined> {
    const cached = rootAgentsMdCache.get(projectBasePath);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.content;
    }

    const agentsMdPath = path.join(projectBasePath, "AGENTS.md");

    try {
        const content = await fs.readFile(agentsMdPath, "utf-8");
        rootAgentsMdCache.set(projectBasePath, {
            expiresAt: Date.now() + ROOT_AGENTS_MD_CACHE_TTL_MS,
            content,
        });
        return content;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            rootAgentsMdCache.set(projectBasePath, {
                expiresAt: Date.now() + ROOT_AGENTS_MD_CACHE_TTL_MS,
                content: undefined,
            });
            return undefined;
        }
        throw error;
    }
}

// =============================================================================
// Other projects context
// =============================================================================

interface OtherProjectInfo {
    projectId: ProjectDTag;
    dTag: string;
    title: string;
    activeConversations: ActiveConversationSummary[];
}

interface ActiveConversationSummary {
    conversationId: string;
    title: string;
    agentName: string;
    status: string;
    duration: string;
}

function truncateConversationIdForDisplay(conversationId: string, maxLength = 12): string {
    if (conversationId.length <= maxLength) {
        return conversationId;
    }
    return `${conversationId.substring(0, maxLength)}${ELLIPSIS}`;
}

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

async function loadOtherProjectsContext(
    agentPubkey: string,
    currentProjectId?: ProjectDTag
): Promise<OtherProjectInfo[]> {
    try {
        const agentProjectDTags = await agentStorage.getAgentProjects(agentPubkey);

        if (agentProjectDTags.length === 0) {
            return [];
        }

        let daemon: Daemon;
        try {
            daemon = getDaemon();
        } catch {
            logger.debug("Meta-project context: daemon not available, skipping");
            return [];
        }

        const knownProjects = daemon.getKnownProjects();
        const ralRegistry = RALRegistry.getInstance();
        const pubkeyService = getPubkeyService();

        const dTagToProjectId = new Map<string, { projectId: ProjectDTag; title: string }>();
        for (const [projectId, project] of knownProjects) {
            if (agentProjectDTags.includes(projectId)) {
                const title = project.tagValue("title") || projectId;
                dTagToProjectId.set(projectId, { projectId, title });
            }
        }

        const otherProjectDTags = agentProjectDTags.filter((dTag) => {
            const info = dTagToProjectId.get(dTag);
            return info && info.projectId !== currentProjectId;
        });

        const limitedDTags = otherProjectDTags.slice(0, MAX_OTHER_PROJECTS);
        const results: OtherProjectInfo[] = [];

        for (const dTag of limitedDTags) {
            const projectInfo = dTagToProjectId.get(dTag);
            if (!projectInfo) continue;

            const activeEntries = ralRegistry.getActiveEntriesForProject(projectInfo.projectId);

            const conversationMap = new Map<string, (typeof activeEntries)[0]>();
            for (const entry of activeEntries) {
                const existing = conversationMap.get(entry.conversationId);
                if (
                    !existing ||
                    entry.isStreaming ||
                    (entry.currentTool && !existing.isStreaming) ||
                    entry.lastActivityAt > existing.lastActivityAt
                ) {
                    conversationMap.set(entry.conversationId, entry);
                }
            }

            const activeConversations: ActiveConversationSummary[] = [];
            let convCount = 0;

            for (const [conversationId, entry] of conversationMap) {
                if (convCount >= MAX_CONVS_PER_PROJECT) break;

                let title = `Conversation ${truncateConversationIdForDisplay(conversationId)}`;
                const store = conversationRegistry.get(conversationId);
                if (store) {
                    const metadata = store.getMetadata();
                    if (metadata.title) {
                        title = sanitizeForPrompt(metadata.title, 60);
                    }
                }

                const agentName = pubkeyService.getNameSync(entry.agentPubkey);

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
                    conversationId,
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

// =============================================================================
// Channel binding helpers
// =============================================================================

interface ChannelBindingEntry {
    channelId: string;
    type: "dm" | "group" | "topic";
    description: string;
}

function formatHandle(username: string | undefined): string {
    return username ? ` (@${username})` : "";
}

function formatIdentityLabel(
    displayName: string | undefined,
    username: string | undefined,
    fallback: string
): string {
    const base = displayName ?? username ?? fallback;
    if (!username || base === username) {
        return base;
    }
    return `${base}${formatHandle(username)}`;
}

function describeTelegramChannelBinding(
    projectId: string,
    agentPubkey: string,
    channelId: string
): { type: "dm" | "group" | "topic"; description: string } | undefined {
    const parsed = parseTelegramChannelId(channelId);
    if (!parsed) {
        return undefined;
    }

    // DM: chat ID does not start with "-"
    if (!parsed.chatId.startsWith("-")) {
        const identity = getIdentityBindingStore().getBinding(`telegram:user:${parsed.chatId}`);
        const description = `DM with ${formatIdentityLabel(
            identity?.displayName,
            identity?.username,
            parsed.chatId
        )}`;
        return { type: "dm", description };
    }

    const chatContext = getTelegramChatContextStore().getContext(projectId, agentPubkey, channelId);
    if (!chatContext?.chatTitle && !chatContext?.chatUsername) {
        if (parsed.messageThreadId) {
            return { type: "topic", description: "Telegram topic" };
        }
        return { type: "group", description: "Telegram chat" };
    }

    const title = chatContext.chatTitle
        ? `"${chatContext.chatTitle}"`
        : chatContext.chatUsername
          ? `@${chatContext.chatUsername}`
          : undefined;

    if (!title) {
        if (parsed.messageThreadId) {
            return { type: "topic", description: "Telegram topic" };
        }
        return { type: "group", description: "Telegram chat" };
    }

    if (parsed.messageThreadId) {
        const topicLabel = chatContext.topicTitle
            ? `'${chatContext.topicTitle}' in ${title}`
            : `topic in ${title}`;
        return { type: "topic", description: topicLabel };
    }

    return { type: "group", description: title };
}

function buildChannelBindingEntries(
    agent: AgentInstance,
    projectId: string
): ChannelBindingEntry[] {
    if (!agent.pubkey || !agent.telegram?.botToken) {
        return [];
    }

    const bindings = getTransportBindingStore().listBindingsForAgentProject(
        agent.pubkey,
        projectId,
        "telegram"
    );

    const entries: ChannelBindingEntry[] = [];
    for (const binding of bindings) {
        const info = describeTelegramChannelBinding(projectId, agent.pubkey, binding.channelId);
        if (info) {
            entries.push({
                channelId: binding.channelId,
                type: info.type,
                description: info.description,
            });
        }
    }
    return entries;
}

// =============================================================================
// Fragment interface and implementation
// =============================================================================

export interface ProjectContextArgs {
    agent: AgentInstance;
    projectTitle: string;
    projectId?: ProjectDTag;
    projectOwnerPubkey: string;
    conversationId?: string;
    projectBasePath?: string;
    workingDirectory?: string;
    currentBranch?: string;
    projectDocsPath?: string;
    availableAgents?: AgentInstance[];
}

export const projectContextFragment: PromptFragment<ProjectContextArgs> = {
    id: "project-context",
    priority: 8,
    template: async ({
        agent,
        projectTitle,
        projectId,
        projectOwnerPubkey,
        conversationId,
        projectBasePath,
        workingDirectory,
        currentBranch,
        projectDocsPath,
        availableAgents,
    }) => {
        const parts: string[] = [];

        parts.push("<project-context>");

        // Header: title, ID, owner, conversation
        parts.push(`  Title: "${projectTitle}"`);
        if (projectId) {
            parts.push(`  ID: ${projectId}`);
        }
        parts.push(`  Owner pubkey: "${shortenPubkey(projectOwnerPubkey)}"`);
        if (conversationId) {
            parts.push(`  Conversation ID: ${shortenConversationId(conversationId)}`);
        }

        // <workspace> section
        if (projectBasePath || workingDirectory || currentBranch) {
            parts.push("");
            parts.push("  <workspace>");

            if (projectBasePath) {
                parts.push(`    root: ${projectBasePath}`);
            }
            if (workingDirectory) {
                parts.push(`    cwd: ${workingDirectory}`);
            }
            if (currentBranch) {
                parts.push(`    current-branch: ${currentBranch}`);
            }

            // Worktree list
            if (projectBasePath && currentBranch) {
                const { worktrees } = await getCachedWorktreeSnapshot(projectBasePath);
                const otherWorktrees = worktrees.filter((wt) => wt.branch !== currentBranch);
                if (otherWorktrees.length > 0) {
                    parts.push("    other worktrees:");
                    for (const wt of otherWorktrees) {
                        parts.push(`      ${wt.branch} [Path: ${wt.path}]`);
                    }
                }
            }

            if (projectDocsPath) {
                parts.push(`    project docs: ${projectDocsPath}`);
            }

            parts.push("  </workspace>");
        }

        // <team> section — filter out current agent
        const coworkers = (availableAgents ?? []).filter((a) => a.pubkey !== agent.pubkey);
        if (coworkers.length > 0) {
            parts.push("");
            parts.push("  <team>");
            parts.push("    You are part of a multi-agent team. Stay in your lane, trust your teammates, and defer to their expertise rather than overstepping your own role.");
            for (const coworker of coworkers) {
                const criteria = coworker.useCriteria
                    ? `Use Criteria: ${coworker.useCriteria}`
                    : coworker.description
                      ? `Description: ${coworker.description}`
                      : "";
                parts.push(`    <${coworker.slug}>${criteria}</${coworker.slug}>`);
            }
            parts.push("  </team>");
        }

        // <channels> section
        if (projectId) {
            const channelEntries = buildChannelBindingEntries(agent, projectId);
            if (channelEntries.length > 0) {
                parts.push("");
                parts.push("  <channels>");
                parts.push("    These are alternative communication channels available to you via the send_message tool.");
                for (const entry of channelEntries) {
                    parts.push(
                        `    <telegram type="${entry.type}" id="${entry.channelId}" description="${entry.description}" />`
                    );
                }
                parts.push("  </channels>");
            }
        }

        // <agents.md> section — only include root content
        if (projectBasePath) {
            try {
                const rootContent = await getCachedRootAgentsMd(projectBasePath);
                if (rootContent && rootContent.length < MAX_ROOT_CONTENT_LENGTH_FOR_SYSTEM_PROMPT) {
                    parts.push("");
                    parts.push("  <agents.md>");
                    parts.push(rootContent.trim());
                    parts.push("  </agents.md>");
                }
            } catch (error) {
                logger.debug("Could not read root AGENTS.md:", error);
            }
        }

        // <other-projects> section
        const otherProjects = await loadOtherProjectsContext(agent.pubkey, projectId);
        if (otherProjects.length > 0) {
            parts.push("");
            parts.push("  <other-projects>");
            for (const project of otherProjects) {
                parts.push(`    ${project.title}: (${project.dTag})`);
            }
            parts.push("  </other-projects>");
        }

        // <memorized-project-files> section
        if (projectId && agent.pubkey) {
            const projectInjectedFiles = getAgentProjectInjectedFiles(agent.pubkey, projectId);
            if (projectInjectedFiles.length > 0) {
                parts.push("");
                parts.push("  <memorized-project-files>");
                for (const file of projectInjectedFiles) {
                    const truncatedAttr = file.truncated ? " truncated=\"true\"" : "";
                    parts.push(`    <file name="${file.filename}"${truncatedAttr}>${file.content}</file>`);
                }
                parts.push("  </memorized-project-files>");
            }
        }

        parts.push("</project-context>");

        return parts.join("\n");
    },
};
