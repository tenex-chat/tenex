import type { AgentInstance } from "@/agents/types";
import type { ConversationCoordinator } from "@/conversations";
import type { AgentPublisher } from "@/nostr/AgentPublisher";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { listWorktrees } from "@/utils/git/worktree";
import { logger } from "@/utils/logger";
import * as path from "node:path";
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
    /**
     * Base project directory containing .bare/ and all worktrees.
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
        // Branch specified in event - find matching worktree
        const worktrees = await listWorktrees(params.projectBasePath);
        const matchingWorktree = worktrees.find(wt => wt.branch === branchTag);

        if (matchingWorktree) {
            workingDirectory = matchingWorktree.path;
            currentBranch = branchTag;
            logger.info("Using worktree from branch tag", {
                branch: branchTag,
                path: matchingWorktree.path
            });
        } else {
            // Worktree not found - fall back to default worktree
            logger.warn("Branch tag specified but worktree not found, using default", {
                branch: branchTag,
                availableWorktrees: worktrees.map(wt => wt.branch)
            });
            // Find the default worktree (first one, typically master/main)
            const defaultWorktree = worktrees[0];
            if (defaultWorktree) {
                workingDirectory = defaultWorktree.path;
                currentBranch = defaultWorktree.branch;
            } else {
                // No worktrees at all - construct path for main branch
                workingDirectory = path.join(params.projectBasePath, "main");
                currentBranch = "main";
            }
        }
    } else {
        // No branch tag - use default worktree
        const worktrees = await listWorktrees(params.projectBasePath);
        const defaultWorktree = worktrees[0];
        if (defaultWorktree) {
            workingDirectory = defaultWorktree.path;
            currentBranch = defaultWorktree.branch;
        } else {
            // No worktrees at all - construct path for main branch
            workingDirectory = path.join(params.projectBasePath, "main");
            currentBranch = "main";
        }
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
