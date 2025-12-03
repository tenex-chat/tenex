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

    const projectPath = "/test/project";

    beforeEach(() => {
        mockListWorktrees.mockClear();
        mockGetCurrentBranchWithFallback.mockClear();
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
                { branch: "feature-branch", path: "/test/project-feature-branch" },
            ]);

            // Execute
            const context = await createExecutionContext({
                agent: mockAgent,
                conversationId: "test-conversation",
                projectPath,
                triggeringEvent: eventWithBranch,
                conversationCoordinator: mockCoordinator,
            });

            // Assert
            expect(context.workingDirectory).toBe("/test/project-feature-branch");
            expect(context.currentBranch).toBe("feature-branch");
            expect(context.projectPath).toBe(projectPath);
            expect(context.agent).toBe(mockAgent);
            expect(mockListWorktrees).toHaveBeenCalledWith(projectPath);
        });

        it("should fall back to main when branch tag has no matching worktree", async () => {
            // Setup: Event has branch tag, but no matching worktree
            const eventWithBranch: NDKEvent = {
                ...mockEvent,
                tags: [["branch", "nonexistent-branch"]],
            };

            mockListWorktrees.mockResolvedValue([
                { branch: "main", path: "/test/project" },
            ]);

            mockGetCurrentBranchWithFallback.mockResolvedValue("main");

            // Execute
            const context = await createExecutionContext({
                agent: mockAgent,
                conversationId: "test-conversation",
                projectPath,
                triggeringEvent: eventWithBranch,
                conversationCoordinator: mockCoordinator,
            });

            // Assert
            expect(context.workingDirectory).toBe(projectPath);
            expect(context.currentBranch).toBe("main");
            expect(mockGetCurrentBranchWithFallback).toHaveBeenCalledWith(projectPath);
        });

        it("should use main worktree when no branch tag", async () => {
            // Setup: Event has no branch tag
            mockGetCurrentBranchWithFallback.mockResolvedValue("main");

            // Execute
            const context = await createExecutionContext({
                agent: mockAgent,
                conversationId: "test-conversation",
                projectPath,
                triggeringEvent: mockEvent,
                conversationCoordinator: mockCoordinator,
            });

            // Assert
            expect(context.workingDirectory).toBe(projectPath);
            expect(context.currentBranch).toBe("main");
            expect(mockGetCurrentBranchWithFallback).toHaveBeenCalledWith(projectPath);
            expect(mockListWorktrees).not.toHaveBeenCalled();
        });

        it("should pass through optional fields", async () => {
            // Setup
            mockGetCurrentBranchWithFallback.mockResolvedValue("main");
            const mockPublisher = { publish: mock() };

            // Execute
            const context = await createExecutionContext({
                agent: mockAgent,
                conversationId: "test-conversation",
                projectPath,
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
                projectPath,
                triggeringEvent: mockEvent,
                conversationCoordinator: mockCoordinator,
            });

            // Assert
            expect(context.getConversation()).toBe(mockConversation);
            expect(mockCoordinator.getConversation).toHaveBeenCalledWith("test-conversation");
        });

        it("should handle getCurrentBranchWithFallback returning fallback branch", async () => {
            // Setup: getCurrentBranchWithFallback returns fallback
            mockGetCurrentBranchWithFallback.mockResolvedValue("master");

            // Execute
            const context = await createExecutionContext({
                agent: mockAgent,
                conversationId: "test-conversation",
                projectPath,
                triggeringEvent: mockEvent,
                conversationCoordinator: mockCoordinator,
            });

            // Assert
            expect(context.currentBranch).toBe("master");
        });
    });
});
