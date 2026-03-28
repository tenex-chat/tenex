import type { AgentInstance } from "@/agents/types";
import { ConversationStore } from "@/conversations/ConversationStore";
import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import type { AgentRuntimePublisher } from "@/events/runtime/AgentRuntimePublisher";
import type { MCPManager } from "@/services/mcp/MCPManager";
import { listWorktrees, createWorktree } from "@/utils/git/worktree";
import { getCurrentBranchWithFallback, readCurrentBranchFromGitDir } from "@/utils/git/initializeGitRepo";
import { shortenConversationId } from "@/utils/conversation-id";
import { logger } from "@/utils/logger";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ExecutionContext } from "./types";

const tracer = trace.getTracer("tenex.execution-context");

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
    triggeringEnvelope: InboundEnvelope;
    agentPublisher?: AgentRuntimePublisher;
    isDelegationCompletion?: boolean;
    hasPendingDelegations?: boolean;
    debug?: boolean;
    /**
     * MCP manager for this project's MCP tool access.
     * Required for agents to use MCP tools at execution time.
     */
    mcpManager?: MCPManager;
}): Promise<ExecutionContext> {
    return tracer.startActiveSpan("tenex.execution_context.create", async (span) => {
        const branchTag = params.triggeringEnvelope.metadata.branchName;

        span.setAttributes({
            "agent.slug": params.agent.slug,
            "conversation.id": shortenConversationId(params.conversationId),
            "execution.project_base_path": params.projectBasePath,
            "execution.branch_tag_present": !!branchTag,
        });

        if (branchTag) {
            span.setAttribute("execution.branch_tag", branchTag);
        }

        try {
            let workingDirectory: string;
            let currentBranch: string;

            if (branchTag) {
                span.addEvent("execution_context.worktree_lookup_started", {
                    "branch.tag": branchTag,
                });

                const worktrees = await listWorktrees(params.projectBasePath);
                const matchingWorktree = worktrees.find(wt => wt.branch === branchTag);

                if (matchingWorktree) {
                    workingDirectory = matchingWorktree.path;
                    currentBranch = branchTag;

                    span.addEvent("execution_context.worktree_found", {
                        "branch.tag": branchTag,
                        "worktree.path": matchingWorktree.path,
                    });

                    logger.info("Using worktree from branch tag", {
                        branch: branchTag,
                        path: matchingWorktree.path
                    });
                } else {
                    span.addEvent("execution_context.worktree_missing", {
                        "branch.tag": branchTag,
                    });

                    const baseBranch = await getCurrentBranchWithFallback(params.projectBasePath);
                    span.addEvent("execution_context.base_branch_resolved", {
                        "branch.base": baseBranch,
                    });

                    logger.info("Branch tag specified but worktree not found, creating it", {
                        branch: branchTag,
                        baseBranch,
                    });

                    try {
                        workingDirectory = await createWorktree(params.projectBasePath, branchTag, baseBranch);
                        currentBranch = branchTag;

                        span.addEvent("execution_context.worktree_created", {
                            "branch.tag": branchTag,
                            "branch.base": baseBranch,
                            "worktree.path": workingDirectory,
                        });

                        logger.info("Created worktree for delegation", {
                            branch: branchTag,
                            path: workingDirectory,
                            baseBranch,
                        });
                    } catch (error) {
                        logger.error("Failed to create worktree, falling back to project root", {
                            branch: branchTag,
                            error: error instanceof Error ? error.message : String(error),
                        });

                        workingDirectory = params.projectBasePath;
                        currentBranch = baseBranch;

                        span.addEvent("execution_context.worktree_create_failed_fallback", {
                            "branch.tag": branchTag,
                            "branch.base": baseBranch,
                            "error": error instanceof Error ? error.message : String(error),
                        });
                    }
                }
            } else {
                workingDirectory = params.projectBasePath;
                // Read branch from .git/HEAD directly to avoid subprocess spawn.
                // Bun/JSC pre-allocates ~9GB on first child_process.exec(); this avoids that.
                currentBranch = await readCurrentBranchFromGitDir(params.projectBasePath)
                    ?? await getCurrentBranchWithFallback(params.projectBasePath);

                span.addEvent("execution_context.project_root_selected", {
                    "branch.current": currentBranch,
                    "working_directory": workingDirectory,
                });

                logger.info("Using project root as working directory", {
                    path: workingDirectory,
                    branch: currentBranch
                });
            }

            span.setAttributes({
                "execution.working_directory": workingDirectory,
                "execution.current_branch": currentBranch,
            });
            span.setStatus({ code: SpanStatusCode.OK });

            return {
                agent: params.agent,
                conversationId: params.conversationId,
                projectBasePath: params.projectBasePath,
                workingDirectory,
                currentBranch,
                triggeringEnvelope: params.triggeringEnvelope,
                agentPublisher: params.agentPublisher,
                isDelegationCompletion: params.isDelegationCompletion,
                hasPendingDelegations: params.hasPendingDelegations,
                debug: params.debug,
                mcpManager: params.mcpManager,
                getConversation: () => ConversationStore.get(params.conversationId),
            };
        } catch (error) {
            span.recordException(error as Error);
            span.setStatus({
                code: SpanStatusCode.ERROR,
                message: error instanceof Error ? error.message : String(error),
            });
            throw error;
        } finally {
            span.end();
        }
    });
}
