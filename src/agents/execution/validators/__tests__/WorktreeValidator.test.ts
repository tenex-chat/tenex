import { describe, expect, it, mock, beforeEach } from "bun:test";
import { NDKEvent } from "@nostr-dev-kit/ndk";

// Mock fs
const mockAccess = mock(async () => {});
mock.module("node:fs/promises", () => ({
    access: mockAccess,
}));

// Mock ConfigService
mock.module("@/services/ConfigService", () => ({
    config: {
        getConfigPath: mock(() => "/mock/config/path"),
    },
}));

// Mock worktree utils
const mockGetAgentWorktrees = mock(async () => []);
mock.module("@/utils/git/worktree", () => ({
    getAgentWorktrees: mockGetAgentWorktrees,
}));

import {
    checkWorktreeCreation,
    validateWorktreeCleanup,
} from "../WorktreeValidator";
import type { AgentInstance } from "@/agents/types";
import type { ExecutionContext } from "../../types";
import type { WorktreeMetadata } from "@/utils/git/worktree";

describe("WorktreeValidator", () => {
    beforeEach(() => {
        mockGetAgentWorktrees.mockClear();
        mockAccess.mockClear();
    });

    describe("checkWorktreeCreation", () => {
        it("should return no worktrees when agent has none", async () => {
            mockGetAgentWorktrees.mockResolvedValue([]);

            const agent = {
                slug: "test-agent",
                pubkey: "agent-pubkey",
            } as AgentInstance;

            const context = {
                projectBasePath: "/project",
                conversationId: "conv-123",
            } as unknown as ExecutionContext;

            const result = await checkWorktreeCreation(agent, context);

            expect(result.created).toBe(false);
            expect(result.worktrees).toEqual([]);
        });

        it("should return active worktrees that exist on disk", async () => {
            const worktrees: WorktreeMetadata[] = [
                {
                    path: "/project/.worktrees/feature-1",
                    branch: "feature-1",
                    parentBranch: "main",
                    agentPubkey: "agent-pubkey",
                    conversationId: "conv-123",
                    createdAt: Date.now(),
                },
            ];

            mockGetAgentWorktrees.mockResolvedValue(worktrees);
            mockAccess.mockResolvedValue(undefined); // Path exists

            const agent = {
                slug: "test-agent",
                pubkey: "agent-pubkey",
            } as AgentInstance;

            const context = {
                projectBasePath: "/project",
                conversationId: "conv-123",
            } as unknown as ExecutionContext;

            const result = await checkWorktreeCreation(agent, context);

            expect(result.created).toBe(true);
            expect(result.worktrees).toHaveLength(1);
            expect(result.worktrees[0].branch).toBe("feature-1");
        });

        it("should filter out worktrees that no longer exist on disk", async () => {
            const worktrees: WorktreeMetadata[] = [
                {
                    path: "/project/.worktrees/deleted-feature",
                    branch: "deleted-feature",
                    parentBranch: "main",
                    agentPubkey: "agent-pubkey",
                    conversationId: "conv-123",
                    createdAt: Date.now(),
                },
            ];

            mockGetAgentWorktrees.mockResolvedValue(worktrees);
            mockAccess.mockRejectedValue(new Error("ENOENT")); // Path doesn't exist

            const agent = {
                slug: "test-agent",
                pubkey: "agent-pubkey",
            } as AgentInstance;

            const context = {
                projectBasePath: "/project",
                conversationId: "conv-123",
            } as unknown as ExecutionContext;

            const result = await checkWorktreeCreation(agent, context);

            expect(result.created).toBe(false);
            expect(result.worktrees).toEqual([]);
        });

        it("should filter out already merged worktrees", async () => {
            const worktrees: WorktreeMetadata[] = [
                {
                    path: "/project/.worktrees/merged-feature",
                    branch: "merged-feature",
                    parentBranch: "main",
                    agentPubkey: "agent-pubkey",
                    conversationId: "conv-123",
                    createdAt: Date.now(),
                    mergedAt: Date.now(), // Already merged
                },
            ];

            mockGetAgentWorktrees.mockResolvedValue(worktrees);
            mockAccess.mockResolvedValue(undefined);

            const agent = {
                slug: "test-agent",
                pubkey: "agent-pubkey",
            } as AgentInstance;

            const context = {
                projectBasePath: "/project",
                conversationId: "conv-123",
            } as unknown as ExecutionContext;

            const result = await checkWorktreeCreation(agent, context);

            expect(result.created).toBe(false);
            expect(result.worktrees).toEqual([]);
        });

        it("should filter out deleted worktrees", async () => {
            const worktrees: WorktreeMetadata[] = [
                {
                    path: "/project/.worktrees/deleted-feature",
                    branch: "deleted-feature",
                    parentBranch: "main",
                    agentPubkey: "agent-pubkey",
                    conversationId: "conv-123",
                    createdAt: Date.now(),
                    deletedAt: Date.now(), // Already deleted
                },
            ];

            mockGetAgentWorktrees.mockResolvedValue(worktrees);
            mockAccess.mockResolvedValue(undefined);

            const agent = {
                slug: "test-agent",
                pubkey: "agent-pubkey",
            } as AgentInstance;

            const context = {
                projectBasePath: "/project",
                conversationId: "conv-123",
            } as unknown as ExecutionContext;

            const result = await checkWorktreeCreation(agent, context);

            expect(result.created).toBe(false);
            expect(result.worktrees).toEqual([]);
        });
    });

    describe("validateWorktreeCleanup", () => {
        it("should return empty string when response mentions branch and cleanup keywords", () => {
            const worktrees: WorktreeMetadata[] = [
                {
                    path: "/project/.worktrees/feature-1",
                    branch: "feature-1",
                    parentBranch: "main",
                    agentPubkey: "agent-pubkey",
                    conversationId: "conv-123",
                    createdAt: Date.now(),
                },
            ];

            const completionContent =
                "I have merged the feature-1 branch back to main.";

            const result = validateWorktreeCleanup(completionContent, worktrees);

            expect(result).toBe("");
        });

        it("should return cleanup prompt when branch not mentioned", () => {
            const worktrees: WorktreeMetadata[] = [
                {
                    path: "/project/.worktrees/feature-1",
                    branch: "feature-1",
                    parentBranch: "main",
                    agentPubkey: "agent-pubkey",
                    conversationId: "conv-123",
                    createdAt: Date.now(),
                },
            ];

            const completionContent = "I have completed the task.";

            const result = validateWorktreeCleanup(completionContent, worktrees);

            expect(result).toContain("feature-1");
            expect(result).toContain("MERGE");
            expect(result).toContain("DELETE");
            expect(result).toContain("KEEP");
        });

        it("should return cleanup prompt when cleanup keywords not present", () => {
            const worktrees: WorktreeMetadata[] = [
                {
                    path: "/project/.worktrees/feature-1",
                    branch: "feature-1",
                    parentBranch: "main",
                    agentPubkey: "agent-pubkey",
                    conversationId: "conv-123",
                    createdAt: Date.now(),
                },
            ];

            // Mentions branch but no cleanup action
            const completionContent = "I worked on feature-1 and it's looking good.";

            const result = validateWorktreeCleanup(completionContent, worktrees);

            expect(result).toContain("MERGE");
            expect(result).toContain("DELETE");
            expect(result).toContain("KEEP");
        });

        it("should recognize various cleanup keywords", () => {
            const worktrees: WorktreeMetadata[] = [
                {
                    path: "/project/.worktrees/test-branch",
                    branch: "test-branch",
                    parentBranch: "main",
                    agentPubkey: "agent-pubkey",
                    conversationId: "conv-123",
                    createdAt: Date.now(),
                },
            ];

            const testCases = [
                "I deleted the test-branch worktree",
                "Keeping test-branch for future work",
                "Removed test-branch after merging",
                "The test-branch cleanup is complete",
            ];

            for (const content of testCases) {
                const result = validateWorktreeCleanup(content, worktrees);
                expect(result).toBe("");
            }
        });

        it("should handle multiple worktrees", () => {
            const worktrees: WorktreeMetadata[] = [
                {
                    path: "/project/.worktrees/feature-1",
                    branch: "feature-1",
                    parentBranch: "main",
                    agentPubkey: "agent-pubkey",
                    conversationId: "conv-123",
                    createdAt: Date.now(),
                },
                {
                    path: "/project/.worktrees/feature-2",
                    branch: "feature-2",
                    parentBranch: "main",
                    agentPubkey: "agent-pubkey",
                    conversationId: "conv-123",
                    createdAt: Date.now(),
                },
            ];

            const completionContent = "Task done.";

            const result = validateWorktreeCleanup(completionContent, worktrees);

            expect(result).toContain("feature-1");
            expect(result).toContain("feature-2");
            expect(result).toContain("these worktrees");
        });

        it("should use singular form for single worktree", () => {
            const worktrees: WorktreeMetadata[] = [
                {
                    path: "/project/.worktrees/feature-1",
                    branch: "feature-1",
                    parentBranch: "main",
                    agentPubkey: "agent-pubkey",
                    conversationId: "conv-123",
                    createdAt: Date.now(),
                },
            ];

            const completionContent = "Task done.";

            const result = validateWorktreeCleanup(completionContent, worktrees);

            expect(result).toContain("this worktree");
            expect(result).not.toContain("these worktrees");
        });
    });
});
