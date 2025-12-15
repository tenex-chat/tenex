import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { AgentInstance } from "@/agents/types";
import type { ConversationCoordinator } from "@/conversations";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { createExecutionContext } from "../ExecutionContextFactory";

// Mock git utilities
const mockListWorktrees = mock(() => Promise.resolve([]));

mock.module("@/utils/git/worktree", () => ({
    listWorktrees: mockListWorktrees,
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
                { branch: "main", path: "/test/project/main" },
                { branch: "feature-branch", path: "/test/project/feature-branch" },
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
            expect(context.workingDirectory).toBe("/test/project/feature-branch");
            expect(context.currentBranch).toBe("feature-branch");
            expect(context.projectBasePath).toBe(projectBasePath);
            expect(context.agent).toBe(mockAgent);
            expect(mockListWorktrees).toHaveBeenCalledWith(projectBasePath);
        });

        it("should fall back to default worktree when branch tag has no matching worktree", async () => {
            // Setup: Event has branch tag, but no matching worktree
            const eventWithBranch: NDKEvent = {
                ...mockEvent,
                tags: [["branch", "nonexistent-branch"]],
            };

            mockListWorktrees.mockResolvedValue([
                { branch: "main", path: "/test/project/main" },
            ]);

            // Execute
            const context = await createExecutionContext({
                agent: mockAgent,
                conversationId: "test-conversation",
                projectBasePath,
                triggeringEvent: eventWithBranch,
                conversationCoordinator: mockCoordinator,
            });

            // Assert - should fall back to first worktree (main)
            expect(context.workingDirectory).toBe("/test/project/main");
            expect(context.currentBranch).toBe("main");
        });

        it("should use default worktree when no branch tag", async () => {
            // Setup: Event has no branch tag
            mockListWorktrees.mockResolvedValue([
                { branch: "main", path: "/test/project/main" },
            ]);

            // Execute
            const context = await createExecutionContext({
                agent: mockAgent,
                conversationId: "test-conversation",
                projectBasePath,
                triggeringEvent: mockEvent,
                conversationCoordinator: mockCoordinator,
            });

            // Assert - should use first worktree as default
            expect(context.workingDirectory).toBe("/test/project/main");
            expect(context.currentBranch).toBe("main");
            expect(mockListWorktrees).toHaveBeenCalledWith(projectBasePath);
        });

        it("should pass through optional fields", async () => {
            // Setup
            mockListWorktrees.mockResolvedValue([
                { branch: "main", path: "/test/project/main" },
            ]);
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
            mockListWorktrees.mockResolvedValue([
                { branch: "main", path: "/test/project/main" },
            ]);
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

        it("should construct fallback path when no worktrees exist", async () => {
            // Setup: No worktrees available
            mockListWorktrees.mockResolvedValue([]);

            // Execute
            const context = await createExecutionContext({
                agent: mockAgent,
                conversationId: "test-conversation",
                projectBasePath,
                triggeringEvent: mockEvent,
                conversationCoordinator: mockCoordinator,
            });

            // Assert - should construct path with "main" branch
            expect(context.workingDirectory).toBe("/test/project/main");
            expect(context.currentBranch).toBe("main");
        });
    });
});
