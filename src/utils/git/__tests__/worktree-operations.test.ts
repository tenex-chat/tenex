import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { listWorktrees, createWorktree, getCurrentBranch } from "../initializeGitRepo";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

const execAsync = promisify(exec);

describe("Git Worktree Operations", () => {
    let testRepoPath: string;

    beforeEach(async () => {
        // Create temporary test repo
        testRepoPath = path.join(os.tmpdir(), `test-repo-${Date.now()}`);
        await fs.mkdir(testRepoPath, { recursive: true });

        // Initialize git repo
        await execAsync("git init", { cwd: testRepoPath });
        await execAsync('git config user.email "test@test.com"', { cwd: testRepoPath });
        await execAsync('git config user.name "Test"', { cwd: testRepoPath });

        // Create initial commit
        await fs.writeFile(path.join(testRepoPath, "README.md"), "# Test");
        await execAsync("git add .", { cwd: testRepoPath });
        await execAsync('git commit -m "Initial commit"', { cwd: testRepoPath });
    });

    afterEach(async () => {
        // Clean up test repo
        await fs.rm(testRepoPath, { recursive: true, force: true });
    });

    test("listWorktrees returns main worktree", async () => {
        const worktrees = await listWorktrees(testRepoPath);

        expect(worktrees).toHaveLength(1);
        expect(worktrees[0].branch).toMatch(/main|master/);

        // Resolve real paths for comparison (macOS /var -> /private/var)
        const realTestPath = await fs.realpath(testRepoPath);
        const realWorktreePath = await fs.realpath(worktrees[0].path);
        expect(realWorktreePath).toBe(realTestPath);
    });

    test("getCurrentBranch returns current branch name", async () => {
        const branch = await getCurrentBranch(testRepoPath);
        expect(branch).toMatch(/main|master/);
    });

    test("createWorktree creates new worktree", async () => {
        const branchName = "feature-test";
        const currentBranch = await getCurrentBranch(testRepoPath);

        const worktreePath = await createWorktree(testRepoPath, branchName, currentBranch);

        // Verify worktree was created
        expect(worktreePath).toContain(branchName);
        const exists = await fs.access(worktreePath).then(() => true).catch(() => false);
        expect(exists).toBe(true);

        // Verify it appears in worktree list
        const worktrees = await listWorktrees(testRepoPath);
        expect(worktrees).toHaveLength(2);
        expect(worktrees.some(wt => wt.branch === branchName)).toBe(true);
    });
});
