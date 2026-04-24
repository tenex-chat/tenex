import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { AgentInstance } from "@/agents/types";
import { createExecutionContext } from "../ExecutionContextFactory";
import { getCurrentBranch } from "@/utils/git/initializeGitRepo";
import { createWorktree, listWorktrees, WORKTREES_DIR, sanitizeBranchName } from "@/utils/git/worktree";
import { createMockInboundEnvelope } from "@/test-utils/mock-factories";

const execAsync = promisify(exec);

type ConversationCoordinator = {
    getConversation: (conversationId: string) => unknown;
};

describe("ExecutionContextFactory Integration", () => {
    let testRepoPath: string;
    let mockAgent: AgentInstance;
    let mockCoordinator: ConversationCoordinator;
    const projectContext = {
        project: {
            dTag: "test-project",
            tagValue: (tag: string) => (tag === "d" ? "test-project" : undefined),
        },
    } as any;

    beforeEach(async () => {
        // Create temporary test repo (normal git repo, not bare)
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

    const createEnvelope = (branchName?: string) =>
        createMockInboundEnvelope({
            message: {
                id: "test-event-id",
                transport: "nostr",
                nativeId: "test-event-id",
            },
            metadata: {
                branchName,
            },
        });

    test("uses project root when no branch tag", async () => {
        const event = createEnvelope();

        const context = await createExecutionContext({
            agent: mockAgent,
            conversationId: "test-conversation",
            projectContext,
            projectBasePath: testRepoPath,
            triggeringEnvelope: event,
        });

        // Should use project root directly
        const realTestPath = await fs.realpath(testRepoPath);
        const realWorkingDir = await fs.realpath(context.workingDirectory);
        expect(realWorkingDir).toBe(realTestPath);

        const currentBranch = await getCurrentBranch(testRepoPath);
        expect(context.currentBranch).toBe(currentBranch);
    });

    test("creates context with correct worktree when branch tag matches", async () => {
        // Create a worktree for feature branch (will go in .worktrees/)
        const featureBranch = "feature/test-branch";
        const currentBranch = await getCurrentBranch(testRepoPath);
        const worktreePath = await createWorktree(testRepoPath, featureBranch, currentBranch);

        const event = createEnvelope(featureBranch);

        const context = await createExecutionContext({
            agent: mockAgent,
            conversationId: "test-conversation",
            projectContext,
            projectBasePath: testRepoPath,
            triggeringEnvelope: event,
        });

        // Should use feature worktree in .worktrees/
        const realWorktreePath = await fs.realpath(worktreePath);
        const realWorkingDir = await fs.realpath(context.workingDirectory);
        expect(realWorkingDir).toBe(realWorktreePath);
        expect(context.currentBranch).toBe(featureBranch);
        expect(context.projectBasePath).toBe(testRepoPath);
    });

    test("constructs expected path when branch tag has no matching worktree", async () => {
        const nonexistentBranch = "feature/nonexistent";
        const event = createEnvelope(nonexistentBranch);

        const context = await createExecutionContext({
            agent: mockAgent,
            conversationId: "test-conversation",
            projectContext,
            projectBasePath: testRepoPath,
            triggeringEnvelope: event,
        });

        // Should construct expected path in .worktrees/ with sanitized name
        const expectedPath = path.join(testRepoPath, WORKTREES_DIR, sanitizeBranchName(nonexistentBranch));
        expect(context.workingDirectory).toBe(expectedPath);
        expect(context.currentBranch).toBe(nonexistentBranch);
    });

    test("resolves correct worktree when multiple worktrees exist", async () => {
        const currentBranch = await getCurrentBranch(testRepoPath);

        // Create multiple worktrees in .worktrees/
        const feature1 = "feature/one";
        const feature2 = "feature/two";
        const feature3 = "feature/three";

        const worktree1Path = await createWorktree(testRepoPath, feature1, currentBranch);
        await createWorktree(testRepoPath, feature2, currentBranch);
        await createWorktree(testRepoPath, feature3, currentBranch);

        // Verify all worktrees exist
        const worktrees = await listWorktrees(testRepoPath);
        expect(worktrees.length).toBe(4); // main + 3 features

        const event = createEnvelope(feature1);

        const context = await createExecutionContext({
            agent: mockAgent,
            conversationId: "test-conversation",
            projectContext,
            projectBasePath: testRepoPath,
            triggeringEnvelope: event,
        });

        // Should use feature1 worktree specifically
        const realWorktree1Path = await fs.realpath(worktree1Path);
        const realWorkingDir = await fs.realpath(context.workingDirectory);
        expect(realWorkingDir).toBe(realWorktree1Path);
        expect(context.currentBranch).toBe(feature1);
    });

    test("context can perform operations in correct worktree", async () => {
        const currentBranch = await getCurrentBranch(testRepoPath);
        const featureBranch = "feature/isolated-test";
        const worktreePath = await createWorktree(testRepoPath, featureBranch, currentBranch);

        // Create a file in the feature worktree
        const testFile = path.join(worktreePath, "feature.txt");
        await fs.writeFile(testFile, "Feature work");

        const event = createEnvelope(featureBranch);

        const context = await createExecutionContext({
            agent: mockAgent,
            conversationId: "test-conversation",
            projectContext,
            projectBasePath: testRepoPath,
            triggeringEnvelope: event,
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
        const featureBranch = "feature/props-test";
        await createWorktree(testRepoPath, featureBranch, currentBranch);

        const mockPublisher = { publish: () => {} };
        const event = createEnvelope(featureBranch);

        const context = await createExecutionContext({
            agent: mockAgent,
            conversationId: "test-conversation-123",
            projectContext,
            projectBasePath: testRepoPath,
            triggeringEnvelope: event,
            agentPublisher: mockPublisher as any,
            isDelegationCompletion: true,
            debug: true,
        });

        // Verify all fields are preserved
        expect(context.agent).toBe(mockAgent);
        expect(context.conversationId).toBe("test-conversation-123");
        expect(context.projectBasePath).toBe(testRepoPath);
        expect(context.triggeringEnvelope).toBe(event);
        expect(context.agentPublisher).toBe(mockPublisher);
        expect(context.isDelegationCompletion).toBe(true);
        expect(context.debug).toBe(true);
        expect(context.currentBranch).toBe(featureBranch);
    });
});
