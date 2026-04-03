import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import type { AgentInstance } from "@/agents/types";
import { createExecutionContext } from "../ExecutionContextFactory";
import { ConversationStore } from "@/conversations/ConversationStore";
import { createMockInboundEnvelope } from "@/test-utils/mock-factories";
import * as worktreeModule from "@/utils/git/worktree";
import * as initializeGitRepoModule from "@/utils/git/initializeGitRepo";

type ConversationCoordinator = {
    getConversation: (conversationId: string) => unknown;
};

describe("ExecutionContextFactory", () => {
    const mockAgent: AgentInstance = {
        slug: "test-agent",
        name: "Test Agent",
        pubkey: "test-pubkey",
    } as AgentInstance;

    const mockCoordinator = {
        getConversation: mock(() => undefined),
    } as unknown as ConversationCoordinator;

    const mockEvent = createMockInboundEnvelope({
        message: {
            id: "test-event-id",
            transport: "nostr",
            nativeId: "test-event-id",
        },
    });

    const projectBasePath = "/test/project";

    // Store original functions for restoration
    const originalListWorktrees = worktreeModule.listWorktrees;
    const originalCreateWorktree = worktreeModule.createWorktree;
    const originalGetCurrentBranch = initializeGitRepoModule.getCurrentBranchWithFallback;

    // Spies that will be set up in beforeEach
    let listWorktreesSpy: ReturnType<typeof spyOn>;
    let createWorktreeSpy: ReturnType<typeof spyOn>;
    let getCurrentBranchSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        // Set up spies instead of mock.module
        listWorktreesSpy = spyOn(worktreeModule, "listWorktrees").mockResolvedValue([]);
        createWorktreeSpy = spyOn(worktreeModule, "createWorktree").mockImplementation(
            (projectPath: string, branch: string) =>
                Promise.resolve(`${projectPath}/.worktrees/${branch.replace(/\//g, "_")}`)
        );
        getCurrentBranchSpy = spyOn(initializeGitRepoModule, "getCurrentBranchWithFallback").mockResolvedValue("main");
        mockCoordinator.getConversation = mock(() => undefined);
    });

    afterEach(() => {
        // Restore original functions to prevent pollution of other tests
        listWorktreesSpy.mockRestore();
        createWorktreeSpy.mockRestore();
        getCurrentBranchSpy.mockRestore();
    });

    describe("createExecutionContext", () => {
        it("should create context with worktree when branch tag matches", async () => {
            // Setup: Event has branch tag, matching worktree exists
            const eventWithBranch = createMockInboundEnvelope({
                ...mockEvent,
                metadata: {
                    ...mockEvent.metadata,
                    branchName: "feature-branch",
                },
            });

            listWorktreesSpy.mockResolvedValue([
                { branch: "main", path: "/test/project" },
                { branch: "feature-branch", path: "/test/project/.worktrees/feature-branch" },
            ]);

            // Execute
            const context = await createExecutionContext({
                agent: mockAgent,
                conversationId: "test-conversation",
                projectBasePath,
                triggeringEnvelope: eventWithBranch,
            });

            // Assert
            expect(context.workingDirectory).toBe("/test/project/.worktrees/feature-branch");
            expect(context.currentBranch).toBe("feature-branch");
            expect(context.projectBasePath).toBe(projectBasePath);
            expect(context.agent).toBe(mockAgent);
            expect(listWorktreesSpy).toHaveBeenCalledWith(projectBasePath);
        });

        it("should create worktree when branch tag has no matching worktree", async () => {
            // Setup: Event has branch tag, but no matching worktree
            const eventWithBranch = createMockInboundEnvelope({
                ...mockEvent,
                metadata: {
                    ...mockEvent.metadata,
                    branchName: "feature/nonexistent",
                },
            });

            listWorktreesSpy.mockResolvedValue([
                { branch: "main", path: "/test/project" },
            ]);

            // Execute
            const context = await createExecutionContext({
                agent: mockAgent,
                conversationId: "test-conversation",
                projectBasePath,
                triggeringEnvelope: eventWithBranch,
            });

            // Assert - should create worktree and use the returned path
            expect(createWorktreeSpy).toHaveBeenCalledWith(projectBasePath, "feature/nonexistent", "main");
            expect(context.workingDirectory).toBe("/test/project/.worktrees/feature_nonexistent");
            expect(context.currentBranch).toBe("feature/nonexistent");
        });

        it("should use project root when no branch tag", async () => {
            // Setup: Event has no branch tag
            getCurrentBranchSpy.mockResolvedValue("main");

            // Execute
            const context = await createExecutionContext({
                agent: mockAgent,
                conversationId: "test-conversation",
                projectBasePath,
                triggeringEnvelope: mockEvent,
            });

            // Assert - should use projectBasePath directly
            expect(context.workingDirectory).toBe("/test/project");
            expect(context.currentBranch).toBe("main");
            expect(getCurrentBranchSpy).toHaveBeenCalledWith(projectBasePath);
        });

        it("should pass through optional fields", async () => {
            // Setup
            getCurrentBranchSpy.mockResolvedValue("main");
            const mockPublisher = { publish: mock() };

            // Execute
            const context = await createExecutionContext({
                agent: mockAgent,
                conversationId: "test-conversation",
                projectBasePath,
                triggeringEnvelope: mockEvent,
                agentPublisher: mockPublisher as any,
                isDelegationCompletion: true,
                debug: true,
            });

            // Assert
            expect(context.agentPublisher).toBe(mockPublisher);
            expect(context.isDelegationCompletion).toBe(true);
            expect(context.debug).toBe(true);
        });

        it("should create getConversation function", async () => {
            // Setup
            getCurrentBranchSpy.mockResolvedValue("main");
            const mockConversation = { id: "test-conversation" };
            const originalGetOrLoad = ConversationStore.getOrLoad;
            ConversationStore.getOrLoad = mock(() => mockConversation) as typeof ConversationStore.getOrLoad;

            try {
                // Execute
                const context = await createExecutionContext({
                    agent: mockAgent,
                    conversationId: "test-conversation",
                    projectBasePath,
                    triggeringEnvelope: mockEvent,
                });

                // Assert
                expect(context.getConversation()).toBe(mockConversation);
                expect(ConversationStore.getOrLoad).toHaveBeenCalledWith("test-conversation");
            } finally {
                // Restore
                ConversationStore.getOrLoad = originalGetOrLoad;
            }
        });

        it("should use project root with fallback branch when no branch tag", async () => {
            // Setup: No branch tag
            getCurrentBranchSpy.mockResolvedValue("master");

            // Execute
            const context = await createExecutionContext({
                agent: mockAgent,
                conversationId: "test-conversation",
                projectBasePath,
                triggeringEnvelope: mockEvent,
            });

            // Assert - should use projectBasePath with detected branch
            expect(context.workingDirectory).toBe("/test/project");
            expect(context.currentBranch).toBe("master");
        });
    });
});
