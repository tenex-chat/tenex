import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { AgentInstance } from "@/agents/types";
import type { ConversationCoordinator } from "@/conversations";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { createExecutionContext } from "../ExecutionContextFactory";

// Mock git utilities
const mockListWorktrees = mock(() => Promise.resolve([]));
const mockGetCurrentBranchWithFallback = mock(() => Promise.resolve("main"));

mock.module("@/utils/git/worktree", () => ({
    listWorktrees: mockListWorktrees,
    sanitizeBranchName: (branch: string) => branch.replace(/\//g, "_"),
    WORKTREES_DIR: ".worktrees",
}));

mock.module("@/utils/git/initializeGitRepo", () => ({
    getCurrentBranchWithFallback: mockGetCurrentBranchWithFallback,
}));

describe("ExecutionContextFactory", () => {
    const mockAgent: AgentInstance = {
        slug: "test-agent",
        name: "Test Agent",
        pubkey: "test-pubkey",
    } as AgentInstance;

    const mockCoordinator = {
        getConversation: mock(() => undefined),
    } as unknown as ConversationCoordinator;

    const mockEvent: NDKEvent = {
        tags: [],
        id: "test-event-id",
    } as NDKEvent;

    const projectBasePath = "/test/project";

    beforeEach(() => {
        mockListWorktrees.mockClear();
        mockGetCurrentBranchWithFallback.mockClear();
        mockGetCurrentBranchWithFallback.mockResolvedValue("main");
        mockCoordinator.getConversation = mock(() => undefined);
    });

    describe("createExecutionContext", () => {
        it("should create context with worktree when branch tag matches", async () => {
            // Setup: Event has branch tag, matching worktree exists
            const eventWithBranch: NDKEvent = {
                ...mockEvent,
                tags: [["branch", "feature-branch"]],
            };

            mockListWorktrees.mockResolvedValue([
                { branch: "main", path: "/test/project" },
                { branch: "feature-branch", path: "/test/project/.worktrees/feature-branch" },
            ]);

            // Execute
            const context = await createExecutionContext({
                agent: mockAgent,
                conversationId: "test-conversation",
                projectBasePath,
                triggeringEvent: eventWithBranch,
                conversationCoordinator: mockCoordinator,
            });

            // Assert
            expect(context.workingDirectory).toBe("/test/project/.worktrees/feature-branch");
            expect(context.currentBranch).toBe("feature-branch");
            expect(context.projectBasePath).toBe(projectBasePath);
            expect(context.agent).toBe(mockAgent);
            expect(mockListWorktrees).toHaveBeenCalledWith(projectBasePath);
        });

        it("should construct expected path when branch tag has no matching worktree", async () => {
            // Setup: Event has branch tag, but no matching worktree
            const eventWithBranch: NDKEvent = {
                ...mockEvent,
                tags: [["branch", "feature/nonexistent"]],
            };

            mockListWorktrees.mockResolvedValue([
                { branch: "main", path: "/test/project" },
            ]);

            // Execute
            const context = await createExecutionContext({
                agent: mockAgent,
                conversationId: "test-conversation",
                projectBasePath,
                triggeringEvent: eventWithBranch,
                conversationCoordinator: mockCoordinator,
            });

            // Assert - should construct expected path in .worktrees with sanitized branch name
            expect(context.workingDirectory).toBe("/test/project/.worktrees/feature_nonexistent");
            expect(context.currentBranch).toBe("feature/nonexistent");
        });

        it("should use project root when no branch tag", async () => {
            // Setup: Event has no branch tag
            mockGetCurrentBranchWithFallback.mockResolvedValue("main");

            // Execute
            const context = await createExecutionContext({
                agent: mockAgent,
                conversationId: "test-conversation",
                projectBasePath,
                triggeringEvent: mockEvent,
                conversationCoordinator: mockCoordinator,
            });

            // Assert - should use projectBasePath directly
            expect(context.workingDirectory).toBe("/test/project");
            expect(context.currentBranch).toBe("main");
            expect(mockGetCurrentBranchWithFallback).toHaveBeenCalledWith(projectBasePath);
        });

        it("should pass through optional fields", async () => {
            // Setup
            mockGetCurrentBranchWithFallback.mockResolvedValue("main");
            const mockPublisher = { publish: mock() };

            // Execute
            const context = await createExecutionContext({
                agent: mockAgent,
                conversationId: "test-conversation",
                projectBasePath,
                triggeringEvent: mockEvent,
                conversationCoordinator: mockCoordinator,
                agentPublisher: mockPublisher as any,
                isDelegationCompletion: true,
                additionalSystemMessage: "Test message",
                debug: true,
            });

            // Assert
            expect(context.agentPublisher).toBe(mockPublisher);
            expect(context.isDelegationCompletion).toBe(true);
            expect(context.additionalSystemMessage).toBe("Test message");
            expect(context.debug).toBe(true);
        });

        it("should create getConversation function", async () => {
            // Setup
            mockGetCurrentBranchWithFallback.mockResolvedValue("main");
            const mockConversation = { id: "test-conversation" };
            mockCoordinator.getConversation = mock(() => mockConversation);

            // Execute
            const context = await createExecutionContext({
                agent: mockAgent,
                conversationId: "test-conversation",
                projectBasePath,
                triggeringEvent: mockEvent,
                conversationCoordinator: mockCoordinator,
            });

            // Assert
            expect(context.getConversation()).toBe(mockConversation);
            expect(mockCoordinator.getConversation).toHaveBeenCalledWith("test-conversation");
        });

        it("should use project root with fallback branch when no branch tag", async () => {
            // Setup: No branch tag
            mockGetCurrentBranchWithFallback.mockResolvedValue("master");

            // Execute
            const context = await createExecutionContext({
                agent: mockAgent,
                conversationId: "test-conversation",
                projectBasePath,
                triggeringEvent: mockEvent,
                conversationCoordinator: mockCoordinator,
            });

            // Assert - should use projectBasePath with detected branch
            expect(context.workingDirectory).toBe("/test/project");
            expect(context.currentBranch).toBe("master");
        });
    });
});
