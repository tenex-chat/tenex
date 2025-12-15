import type { AgentInstance } from "@/agents/types";
import type { ConversationCoordinator } from "@/conversations";
import type { AgentPublisher } from "@/nostr/AgentPublisher";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { listWorktrees, sanitizeBranchName, WORKTREES_DIR } from "@/utils/git/worktree";
import { getCurrentBranchWithFallback } from "@/utils/git/initializeGitRepo";
import { logger } from "@/utils/logger";
import * as path from "node:path";
import type { ExecutionContext } from "./types";

/**
 * Create an ExecutionContext with environment resolution from event
 *
 * This factory resolves the working directory based on the triggering event's branch tag:
 * - No branch tag: Uses projectBasePath directly (main repo with default branch)
 * - With branch tag: Uses .worktrees/{sanitized_branch}/ directory
 *
 * @param params Context creation parameters
 * @returns Complete ExecutionContext with resolved environment
 */
export async function createExecutionContext(params: {
    agent: AgentInstance;
    conversationId: string;
    /**
     * Project directory (normal git repository root).
     * Example: ~/tenex/{dTag}
     */
    projectBasePath: string;
    triggeringEvent: NDKEvent;
    conversationCoordinator: ConversationCoordinator;
    agentPublisher?: AgentPublisher;
    isDelegationCompletion?: boolean;
    additionalSystemMessage?: string;
    debug?: boolean;
}): Promise<ExecutionContext> {
    // Extract branch tag from event
    const branchTag = params.triggeringEvent.tags.find(t => t[0] === "branch")?.[1];

    // Resolve execution environment
    let workingDirectory: string;
    let currentBranch: string;

    if (branchTag) {
        // Branch specified in event - check if it's in a worktree
        const worktrees = await listWorktrees(params.projectBasePath);
        const matchingWorktree = worktrees.find(wt => wt.branch === branchTag);

        if (matchingWorktree) {
            // Found the worktree
            workingDirectory = matchingWorktree.path;
            currentBranch = branchTag;
            logger.info("Using worktree from branch tag", {
                branch: branchTag,
                path: matchingWorktree.path
            });
        } else {
            // Worktree not found - construct expected path in .worktrees/
            const sanitizedBranch = sanitizeBranchName(branchTag);
            const expectedPath = path.join(params.projectBasePath, WORKTREES_DIR, sanitizedBranch);

            logger.warn("Branch tag specified but worktree not found, using expected path", {
                branch: branchTag,
                expectedPath,
                availableWorktrees: worktrees.map(wt => wt.branch)
            });

            workingDirectory = expectedPath;
            currentBranch = branchTag;
        }
    } else {
        // No branch tag - use project root (default branch)
        workingDirectory = params.projectBasePath;
        currentBranch = await getCurrentBranchWithFallback(params.projectBasePath);
        logger.info("Using project root as working directory", {
            path: workingDirectory,
            branch: currentBranch
        });
    }

    return {
        agent: params.agent,
        conversationId: params.conversationId,
        projectBasePath: params.projectBasePath,
        workingDirectory,
        currentBranch,
        triggeringEvent: params.triggeringEvent,
        conversationCoordinator: params.conversationCoordinator,
        agentPublisher: params.agentPublisher,
        isDelegationCompletion: params.isDelegationCompletion,
        additionalSystemMessage: params.additionalSystemMessage,
        debug: params.debug,
        getConversation: () => params.conversationCoordinator.getConversation(params.conversationId),
    };
}
