import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentInstance } from "@/agents/types";
import type { ProjectAgentRuntimeInfo } from "@/services/projects/ProjectContext";
import { config } from "@/services/ConfigService";
import { listWorktrees, loadWorktreeMetadata, type WorktreeMetadata } from "@/utils/git/worktree";
import { shortenPubkey, shortenConversationId } from "@/utils/conversation-id";
import { logger } from "@/utils/logger";
import type { PromptFragment } from "../core/types";
import type { ProjectDTag } from "@/types/project-ids";
import type { TeamContext, TeamInfo } from "./types";
import type { ChannelBindingEntry } from "@/prompts/utils/projectChannelBindings";

// =============================================================================
// Constants
// =============================================================================

const WORKTREE_CONTEXT_CACHE_TTL_MS = 30_000;
const ROOT_AGENTS_MD_CACHE_TTL_MS = 30_000;
const MAX_ROOT_CONTENT_LENGTH_FOR_SYSTEM_PROMPT = 2000;
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
    agentRuntimeInfo?: ProjectAgentRuntimeInfo[];
    teamContext?: TeamContext;
    channelBindingEntries?: ChannelBindingEntry[];
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
        agentRuntimeInfo,
        teamContext,
        channelBindingEntries,
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
            const relativePath = (p: string): string => {
                if (!projectBasePath) return p;
                const rel = path.relative(projectBasePath, p);
                if (rel === "") return "$PROJECT_BASE";
                const isOutside = rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
                if (!isOutside) {
                    return `$PROJECT_BASE/${rel}`;
                }
                return p;
            };

            parts.push("");
            parts.push("  <workspace>");

            if (projectBasePath) {
                parts.push("    root: $PROJECT_BASE");
            }
            if (workingDirectory) {
                parts.push(`    cwd: ${relativePath(workingDirectory)}`);
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
                        parts.push(`      ${wt.branch} [Path: ${relativePath(wt.path)}]`);
                    }
                }
            }

            if (projectDocsPath) {
                parts.push(`    project docs: ${relativePath(projectDocsPath)}`);
            }

            parts.push("  </workspace>");
        }

        // <team> section
        const runtimeInfoByPubkey = new Map(
            (agentRuntimeInfo ?? []).map((info) => [info.pubkey, info])
        );
        const renderRuntimeLabel = (info?: ProjectAgentRuntimeInfo): string => {
            if (!info || info.runtimeStatus === "local-online") {
                return "local";
            }
            if (info.runtimeStatus === "remote-online") {
                const backend = info.backendPubkey ? shortenPubkey(info.backendPubkey) : "unknown";
                return `remote backend ${backend}`;
            }
            return "offline";
        };
        const renderAgentBullet = (a: AgentInstance): string => {
            const detail = a.useCriteria ?? a.description ?? "";
            const runtimeLabel = runtimeInfoByPubkey.has(a.pubkey)
                ? ` [${renderRuntimeLabel(runtimeInfoByPubkey.get(a.pubkey))}]`
                : "";
            return detail
                ? `      * ${a.slug}${runtimeLabel} - ${detail}`
                : `      * ${a.slug}${runtimeLabel}`;
        };
        const renderRuntimeAgentBullet = (info: ProjectAgentRuntimeInfo): string => {
            const detail = info.useCriteria ?? info.description ?? "";
            const runtimeLabel = renderRuntimeLabel(info);
            return detail
                ? `      * ${info.slug} [${runtimeLabel}] - ${detail}`
                : `      * ${info.slug} [${runtimeLabel}]`;
        };

        const renderTeamBullet = (t: TeamInfo): string =>
            `      * Team ${t.name} — ${t.description} [${t.members.length} agents]`;

        const hasTeamContext =
            teamContext &&
            (teamContext.memberTeams.length > 0 ||
                teamContext.activeTeam !== undefined ||
                teamContext.otherTeams.length > 0);

        if (hasTeamContext) {
            const { memberTeams, activeTeam, otherTeams, teammates, unaffiliated } = teamContext;

            parts.push("");
            parts.push("  <team>");

            // <active-team> — the team context this agent is executing in
            if (activeTeam) {
                parts.push("    <active-team>");
                parts.push(`      You are working in team "${activeTeam.name}" — ${activeTeam.description}`);
                parts.push("      Delegate within your team first. Only reach outside when a specific expert is a clearly better fit.");
                parts.push("");
                parts.push("      Teammates:");
                for (const t of teammates) {
                    parts.push(renderAgentBullet(t));
                }
                parts.push("    </active-team>");
            }

            // <my-teams> — other teams the agent belongs to (excluding active)
            const myTeams = activeTeam
                ? memberTeams.filter((t) => t.name !== activeTeam.name)
                : memberTeams;
            if (myTeams.length > 0) {
                parts.push("");
                parts.push("    <my-teams>");
                parts.push(activeTeam
                    ? "      You are also a member of:"
                    : "      You are a member of:");
                for (const team of myTeams) {
                    parts.push(`      * ${team.name} — ${team.description}`);
                }
                parts.push("    </my-teams>");
            }

            // <also-available> — non-member teams + unaffiliated agents
            const alsoAvailableItems: string[] = [];
            for (const team of otherTeams) {
                alsoAvailableItems.push(renderTeamBullet(team));
            }
            for (const a of unaffiliated) {
                alsoAvailableItems.push(renderAgentBullet(a));
            }

            if (alsoAvailableItems.length > 0) {
                parts.push("");
                parts.push("    <also-available>");
                parts.push("      Other teams and agents in this project:");
                for (const item of alsoAvailableItems) {
                    parts.push(item);
                }
                parts.push("      Run team_roster for full roster with use criteria and agent pubkeys.");
                parts.push("    </also-available>");
            }

            const nonLocalAgents = (agentRuntimeInfo ?? []).filter(
                (info) =>
                    info.pubkey !== agent.pubkey &&
                    info.runtimeStatus !== "local-online"
            );
            if (nonLocalAgents.length > 0) {
                parts.push("");
                parts.push("    <agent-runtime>");
                parts.push("      Assigned agents not running in this backend:");
                for (const nonLocalAgent of nonLocalAgents) {
                    parts.push(renderRuntimeAgentBullet(nonLocalAgent));
                }
                parts.push("    </agent-runtime>");
            }

            parts.push("  </team>");
        } else {
            // No teams defined — flat coworker list
            const coworkers = agentRuntimeInfo
                ? agentRuntimeInfo.filter((a) => a.pubkey !== agent.pubkey)
                : (availableAgents ?? []).filter((a) => a.pubkey !== agent.pubkey);
            if (coworkers.length > 0) {
                parts.push("");
                parts.push("  <team>");
                parts.push("    You are part of a multi-agent team. Stay in your lane, trust your teammates, and defer to their expertise rather than overstepping your own role.");
                for (const coworker of coworkers) {
                    parts.push("runtimeStatus" in coworker
                        ? renderRuntimeAgentBullet(coworker)
                        : renderAgentBullet(coworker));
                }
                parts.push("  </team>");
            }
        }

        // <channels> section
        const channelEntries = channelBindingEntries ?? [];
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

        parts.push("</project-context>");

        return parts.join("\n");
    },
};
