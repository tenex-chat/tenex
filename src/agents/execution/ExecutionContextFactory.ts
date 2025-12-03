import type { AgentInstance } from "@/agents/types";
import type { ConversationCoordinator } from "@/conversations";
import type { AgentPublisher } from "@/nostr/AgentPublisher";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { getCurrentBranchWithFallback, listWorktrees } from "@/utils/git/initializeGitRepo";
import { logger } from "@/utils/logger";
import type { ExecutionContext } from "./types";

/**
 * Create an ExecutionContext with environment resolution from event
 *
 * This factory encapsulates the logic of deriving workingDirectory and currentBranch
 * from the triggering event's branch tag and git worktrees. Callers don't need to
 * know about worktree resolution - they just pass the event and get a complete context.
 *
 * @param params Context creation parameters
 * @returns Complete ExecutionContext with resolved environment
 */
export async function createExecutionContext(params: {
    agent: AgentInstance;
    conversationId: string;
    projectPath: string;
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
        // Branch specified in event - find matching worktree
        const worktrees = await listWorktrees(params.projectPath);
        const matchingWorktree = worktrees.find(wt => wt.branch === branchTag);

        if (matchingWorktree) {
            workingDirectory = matchingWorktree.path;
            currentBranch = branchTag;
            logger.info("Using worktree from branch tag", {
                branch: branchTag,
                path: matchingWorktree.path
            });
        } else {
            // Worktree not found - fall back to main
            logger.warn("Branch tag specified but worktree not found, using main", {
                branch: branchTag,
                availableWorktrees: worktrees.map(wt => wt.branch)
            });
            workingDirectory = params.projectPath;
            currentBranch = await getCurrentBranchWithFallback(params.projectPath);
        }
    } else {
        // No branch tag - use main worktree
        workingDirectory = params.projectPath;
        currentBranch = await getCurrentBranchWithFallback(params.projectPath);
    }

    return {
        agent: params.agent,
        conversationId: params.conversationId,
        projectPath: params.projectPath,
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
