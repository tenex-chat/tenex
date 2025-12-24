import type { AgentInstance } from "@/agents/types";
import { isAlphaMode } from "@/commands/daemon";
import type { ConversationCoordinator } from "@/conversations";
import type { AgentPublisher } from "@/nostr/AgentPublisher";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { listWorktrees, createWorktree } from "@/utils/git/worktree";
import { getCurrentBranchWithFallback } from "@/utils/git/initializeGitRepo";
import { logger } from "@/utils/logger";
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
            // Worktree not found - create it now
            const baseBranch = await getCurrentBranchWithFallback(params.projectBasePath);

            logger.info("Branch tag specified but worktree not found, creating it", {
                branch: branchTag,
                baseBranch,
            });

            try {
                workingDirectory = await createWorktree(params.projectBasePath, branchTag, baseBranch);
                currentBranch = branchTag;

                logger.info("Created worktree for delegation", {
                    branch: branchTag,
                    path: workingDirectory,
                    baseBranch,
                });
            } catch (error) {
                // If worktree creation fails, fall back to project root with a warning
                logger.error("Failed to create worktree, falling back to project root", {
                    branch: branchTag,
                    error: error instanceof Error ? error.message : String(error),
                });
                workingDirectory = params.projectBasePath;
                currentBranch = baseBranch;
            }
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
        alphaMode: isAlphaMode(),
        getConversation: () => params.conversationCoordinator.getConversation(params.conversationId),
    };
}
