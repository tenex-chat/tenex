import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import type { ExecutionContext } from "@/agents/execution/types";
import { listWorktrees, getCurrentBranch } from "@/utils/git/initializeGitRepo";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

const execAsync = promisify(exec);

// Mock ConfigService for metadata tests
const MockConfigService = class {
    getProjectsBase() {
        return path.join(os.tmpdir(), "tenex-test-projects");
    }
    getConfigPath(subdir?: string) {
        return path.join(os.tmpdir(), "tenex-test-config", subdir || "");
    }
    getGlobalPath() {
        return path.join(os.tmpdir(), "tenex-test-config");
    }
    getConfig() {
        return {};
    }
};

mock.module("@/services/ConfigService", () => ({
    ConfigService: MockConfigService,
    config: new MockConfigService()
}));

describe("delegate_phase worktree creation", () => {
    let testRepoPath: string;
    let mockContext: ExecutionContext;

    beforeEach(async () => {
        // Setup similar to worktree-operations.test.ts
        testRepoPath = path.join(os.tmpdir(), `test-delegate-${Date.now()}`);
        await fs.mkdir(testRepoPath, { recursive: true });

        // Initialize git repo
        await execAsync("git init", { cwd: testRepoPath });
        await execAsync('git config user.email "test@test.com"', { cwd: testRepoPath });
        await execAsync('git config user.name "Test"', { cwd: testRepoPath });
        await fs.writeFile(path.join(testRepoPath, "README.md"), "# Test");
        await execAsync("git add .", { cwd: testRepoPath });
        await execAsync('git commit -m "Initial"', { cwd: testRepoPath });

        const currentBranch = await getCurrentBranch(testRepoPath);

        // Mock context
        mockContext = {
            projectPath: testRepoPath,
            workingDirectory: testRepoPath,
            currentBranch,
            agent: {
                pubkey: "test-pubkey",
                phases: {
                    "test-phase": "Test phase instructions"
                }
            },
            conversationId: "test-conversation",
        } as any;
    });

    afterEach(async () => {
        await fs.rm(testRepoPath, { recursive: true, force: true });
    });

    test("creates worktree when branch parameter provided", async () => {
        const branchName = `feature-test-${Date.now()}`;

        // This test verifies worktree creation logic without full delegation
        // We're testing the worktree creation part, not the full delegation flow
        const { createWorktree } = await import("@/utils/git/initializeGitRepo");

        const worktreePath = await createWorktree(
            mockContext.projectPath,
            branchName,
            mockContext.currentBranch
        );

        expect(worktreePath).toContain(branchName);

        const worktrees = await listWorktrees(mockContext.projectPath);
        expect(worktrees.some(wt => wt.branch === branchName)).toBe(true);
    });

    test("tracks worktree metadata when created", async () => {
        const branchName = `feature-meta-${Date.now()}`;
        const { createWorktree } = await import("@/utils/git/initializeGitRepo");
        const { trackWorktreeCreation, loadWorktreeMetadata } =
            await import("@/utils/git/worktree");

        const worktreePath = await createWorktree(
            mockContext.projectPath,
            branchName,
            mockContext.currentBranch
        );

        await trackWorktreeCreation(mockContext.projectPath, {
            path: worktreePath,
            branch: branchName,
            createdBy: mockContext.agent.pubkey,
            conversationId: mockContext.conversationId,
            parentBranch: mockContext.currentBranch,
        });

        const metadata = await loadWorktreeMetadata(mockContext.projectPath);
        expect(metadata[branchName]).toBeDefined();
        expect(metadata[branchName].createdBy).toBe(mockContext.agent.pubkey);
        expect(metadata[branchName].conversationId).toBe(mockContext.conversationId);
    });
});
