/**
 * WorktreeValidator - Validates worktree cleanup for agent execution
 *
 * This module handles:
 * - Detecting worktrees created by the agent
 * - Prompting for worktree cleanup decisions
 */

import type { AgentInstance } from "@/agents/types";
import { config } from "@/services/ConfigService";
import { getAgentWorktrees, type WorktreeMetadata } from "@/utils/git/worktree";
import * as fs from "node:fs/promises";
import type { ExecutionContext } from "../types";

export interface WorktreeCheckResult {
    created: boolean;
    worktrees: WorktreeMetadata[];
}

/**
 * Check for worktrees created by this agent
 */
export async function checkWorktreeCreation(
    agent: AgentInstance,
    context: ExecutionContext
): Promise<WorktreeCheckResult> {
    const agentWorktrees = await getAgentWorktrees(
        context.projectBasePath,
        config.getConfigPath("projects"),
        agent.pubkey,
        context.conversationId
    );

    const activeWorktrees: WorktreeMetadata[] = [];

    // Check if these worktrees still exist
    for (const worktree of agentWorktrees) {
        try {
            await fs.access(worktree.path);
            // Only consider worktrees that haven't been merged or deleted
            if (!worktree.mergedAt && !worktree.deletedAt) {
                activeWorktrees.push(worktree);
            }
        } catch {
            // Worktree path doesn't exist anymore
        }
    }

    return {
        created: activeWorktrees.length > 0,
        worktrees: activeWorktrees,
    };
}

/**
 * Validate if worktree cleanup was addressed
 * @returns continuation instruction if agent should cleanup worktrees, empty string if addressed
 */
export function validateWorktreeCleanup(
    completionContent: string,
    worktrees: WorktreeMetadata[]
): string {
    // Check if the agent's response mentions any of the worktree branches
    const mentionedBranches = worktrees.filter((wt) =>
        completionContent.toLowerCase().includes(wt.branch.toLowerCase())
    );

    // Check for common cleanup-related keywords
    const cleanupKeywords = [
        "merge",
        "merged",
        "delete",
        "deleted",
        "remove",
        "removed",
        "keep",
        "keeping",
        "retain",
        "leave",
        "worktree",
        "branch",
        "cleanup",
        "clean up",
    ];

    const hasCleanupKeywords = cleanupKeywords.some((keyword) =>
        completionContent.toLowerCase().includes(keyword)
    );

    // If response mentions branches and cleanup keywords, assume it was addressed
    if (mentionedBranches.length > 0 && hasCleanupKeywords) {
        return "";
    }

    // Build the cleanup prompt
    const branchList = worktrees
        .map((wt) => `- Branch "${wt.branch}" (created from ${wt.parentBranch})`)
        .join("\n");

    const cleanupPrompt = `You created the following git worktree${worktrees.length > 1 ? "s" : ""} during this task:
${branchList}

Please specify what should be done with ${worktrees.length > 1 ? "these worktrees" : "this worktree"}:
- MERGE: If the work is complete and should be merged back to the parent branch
- DELETE: If the worktree is no longer needed and can be removed
- KEEP: If the worktree should remain for future work

Use appropriate git commands (git merge, git worktree remove, etc.) to perform the cleanup, or clearly state your decision if you want to keep ${worktrees.length > 1 ? "them" : "it"}.`;

    return cleanupPrompt;
}
