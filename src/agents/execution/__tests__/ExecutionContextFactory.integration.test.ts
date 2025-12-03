import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { AgentInstance } from "@/agents/types";
import type { ConversationCoordinator } from "@/conversations";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { createExecutionContext } from "../ExecutionContextFactory";
import { getCurrentBranch } from "@/utils/git/initializeGitRepo";
import { createWorktree, listWorktrees } from "@/utils/git/worktree";

const execAsync = promisify(exec);

describe("ExecutionContextFactory Integration", () => {
    let testRepoPath: string;
    let mockAgent: AgentInstance;
    let mockCoordinator: ConversationCoordinator;

    beforeEach(async () => {
        // Create temporary test repo
        testRepoPath = path.join(os.tmpdir(), `test-context-${Date.now()}`);
        await fs.mkdir(testRepoPath, { recursive: true });

        // Initialize git repo
        await execAsync("git init", { cwd: testRepoPath });
        await execAsync('git config user.email "test@test.com"', { cwd: testRepoPath });
        await execAsync('git config user.name "Test"', { cwd: testRepoPath });

        // Create initial commit
        await fs.writeFile(path.join(testRepoPath, "README.md"), "# Test");
        await execAsync("git add .", { cwd: testRepoPath });
        await execAsync('git commit -m "Initial commit"', { cwd: testRepoPath });

        // Setup mock agent and coordinator
        mockAgent = {
            slug: "test-agent",
            name: "Test Agent",
            pubkey: "test-pubkey",
        } as AgentInstance;

        mockCoordinator = {
            getConversation: () => undefined,
        } as unknown as ConversationCoordinator;
    });

    afterEach(async () => {
        // Clean up test repo
        await fs.rm(testRepoPath, { recursive: true, force: true });
    });

    test("creates context with main worktree when no branch tag", async () => {
        // Event with no branch tag
        const event: NDKEvent = {
            tags: [],
            id: "test-event-id",
        } as NDKEvent;

        const context = await createExecutionContext({
            agent: mockAgent,
            conversationId: "test-conversation",
            projectPath: testRepoPath,
            triggeringEvent: event,
            conversationCoordinator: mockCoordinator,
        });

        // Should use main worktree
        const realTestPath = await fs.realpath(testRepoPath);
        const realWorkingDir = await fs.realpath(context.workingDirectory);
        expect(realWorkingDir).toBe(realTestPath);

        const currentBranch = await getCurrentBranch(testRepoPath);
        expect(context.currentBranch).toBe(currentBranch);
    });

    test("creates context with correct worktree when branch tag matches", async () => {
        // Create a worktree for feature branch
        const featureBranch = `feature-test-${Date.now()}`;
        const currentBranch = await getCurrentBranch(testRepoPath);
        const worktreePath = await createWorktree(testRepoPath, featureBranch, currentBranch);

        // Event with branch tag
        const event: NDKEvent = {
            tags: [["branch", featureBranch]],
            id: "test-event-id",
        } as NDKEvent;

        const context = await createExecutionContext({
            agent: mockAgent,
            conversationId: "test-conversation",
            projectPath: testRepoPath,
            triggeringEvent: event,
            conversationCoordinator: mockCoordinator,
        });

        // Should use feature worktree
        const realWorktreePath = await fs.realpath(worktreePath);
        const realWorkingDir = await fs.realpath(context.workingDirectory);
        expect(realWorkingDir).toBe(realWorktreePath);
        expect(context.currentBranch).toBe(featureBranch);
        expect(context.projectPath).toBe(testRepoPath);
    });

    test("falls back to main when branch tag has no matching worktree", async () => {
        // Event with branch tag for non-existent worktree
        const event: NDKEvent = {
            tags: [["branch", "nonexistent-branch"]],
            id: "test-event-id",
        } as NDKEvent;

        const context = await createExecutionContext({
            agent: mockAgent,
            conversationId: "test-conversation",
            projectPath: testRepoPath,
            triggeringEvent: event,
            conversationCoordinator: mockCoordinator,
        });

        // Should fall back to main worktree
        const realTestPath = await fs.realpath(testRepoPath);
        const realWorkingDir = await fs.realpath(context.workingDirectory);
        expect(realWorkingDir).toBe(realTestPath);

        const currentBranch = await getCurrentBranch(testRepoPath);
        expect(context.currentBranch).toBe(currentBranch);
    });

    test("resolves correct worktree when multiple worktrees exist", async () => {
        const currentBranch = await getCurrentBranch(testRepoPath);

        // Create multiple worktrees
        const feature1 = `feature-1-${Date.now()}`;
        const feature2 = `feature-2-${Date.now()}`;
        const feature3 = `feature-3-${Date.now()}`;

        const worktree1Path = await createWorktree(testRepoPath, feature1, currentBranch);
        await createWorktree(testRepoPath, feature2, currentBranch);
        await createWorktree(testRepoPath, feature3, currentBranch);

        // Verify all worktrees exist
        const worktrees = await listWorktrees(testRepoPath);
        expect(worktrees.length).toBe(4); // main + 3 features

        // Event targeting feature1
        const event: NDKEvent = {
            tags: [["branch", feature1]],
            id: "test-event-id",
        } as NDKEvent;

        const context = await createExecutionContext({
            agent: mockAgent,
            conversationId: "test-conversation",
            projectPath: testRepoPath,
            triggeringEvent: event,
            conversationCoordinator: mockCoordinator,
        });

        // Should use feature1 worktree specifically
        const realWorktree1Path = await fs.realpath(worktree1Path);
        const realWorkingDir = await fs.realpath(context.workingDirectory);
        expect(realWorkingDir).toBe(realWorktree1Path);
        expect(context.currentBranch).toBe(feature1);
    });

    test("context can perform operations in correct worktree", async () => {
        const currentBranch = await getCurrentBranch(testRepoPath);
        const featureBranch = `feature-isolated-${Date.now()}`;
        const worktreePath = await createWorktree(testRepoPath, featureBranch, currentBranch);

        // Create a file in the feature worktree
        const testFile = path.join(worktreePath, "feature.txt");
        await fs.writeFile(testFile, "Feature work");

        // Event with branch tag
        const event: NDKEvent = {
            tags: [["branch", featureBranch]],
            id: "test-event-id",
        } as NDKEvent;

        const context = await createExecutionContext({
            agent: mockAgent,
            conversationId: "test-conversation",
            projectPath: testRepoPath,
            triggeringEvent: event,
            conversationCoordinator: mockCoordinator,
        });

        // Verify context points to worktree with the file
        const contextTestFile = path.join(context.workingDirectory, "feature.txt");
        const content = await fs.readFile(contextTestFile, "utf-8");
        expect(content).toBe("Feature work");

        // Verify file doesn't exist in main worktree
        const mainTestFile = path.join(testRepoPath, "feature.txt");
        const mainFileExists = await fs.access(mainTestFile).then(() => true).catch(() => false);
        expect(mainFileExists).toBe(false);
    });

    test("preserves all context fields when using worktree", async () => {
        const currentBranch = await getCurrentBranch(testRepoPath);
        const featureBranch = `feature-props-${Date.now()}`;
        await createWorktree(testRepoPath, featureBranch, currentBranch);

        const mockPublisher = { publish: () => {} };
        const event: NDKEvent = {
            tags: [["branch", featureBranch]],
            id: "test-event-id",
        } as NDKEvent;

        const context = await createExecutionContext({
            agent: mockAgent,
            conversationId: "test-conversation-123",
            projectPath: testRepoPath,
            triggeringEvent: event,
            conversationCoordinator: mockCoordinator,
            agentPublisher: mockPublisher as any,
            isDelegationCompletion: true,
            additionalSystemMessage: "Test message",
            debug: true,
        });

        // Verify all fields are preserved
        expect(context.agent).toBe(mockAgent);
        expect(context.conversationId).toBe("test-conversation-123");
        expect(context.projectPath).toBe(testRepoPath);
        expect(context.triggeringEvent).toBe(event);
        expect(context.agentPublisher).toBe(mockPublisher);
        expect(context.isDelegationCompletion).toBe(true);
        expect(context.additionalSystemMessage).toBe("Test message");
        expect(context.debug).toBe(true);
        expect(context.currentBranch).toBe(featureBranch);
    });
});
