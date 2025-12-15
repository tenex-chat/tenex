import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { getCurrentBranch } from "../initializeGitRepo";
import { listWorktrees, createWorktree } from "../worktree";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

const execAsync = promisify(exec);

describe("Git Worktree Operations", () => {
    let testBaseDir: string;
    let bareRepoPath: string;
    let mainWorktreePath: string;

    beforeEach(async () => {
        // Create temporary test directory using bare repo pattern
        testBaseDir = path.join(os.tmpdir(), `test-repo-${Date.now()}`);
        bareRepoPath = path.join(testBaseDir, ".bare");
        mainWorktreePath = path.join(testBaseDir, "main");

        await fs.mkdir(bareRepoPath, { recursive: true });

        // Initialize bare repo
        await execAsync("git init --bare", { cwd: bareRepoPath });

        // Create main worktree
        await execAsync(`git worktree add "${mainWorktreePath}" -b main`, { cwd: bareRepoPath });

        // Configure git in the worktree
        await execAsync('git config user.email "test@test.com"', { cwd: mainWorktreePath });
        await execAsync('git config user.name "Test"', { cwd: mainWorktreePath });

        // Create initial commit
        await fs.writeFile(path.join(mainWorktreePath, "README.md"), "# Test");
        await execAsync("git add .", { cwd: mainWorktreePath });
        await execAsync('git commit -m "Initial commit"', { cwd: mainWorktreePath });
    });

    afterEach(async () => {
        // Clean up test directory
        await fs.rm(testBaseDir, { recursive: true, force: true });
    });

    test("listWorktrees returns main worktree", async () => {
        const worktrees = await listWorktrees(mainWorktreePath);

        expect(worktrees).toHaveLength(1);
        expect(worktrees[0].branch).toBe("main");

        // Resolve real paths for comparison (macOS /var -> /private/var)
        const realMainPath = await fs.realpath(mainWorktreePath);
        const realWorktreePath = await fs.realpath(worktrees[0].path);
        expect(realWorktreePath).toBe(realMainPath);
    });

    test("getCurrentBranch returns current branch name", async () => {
        const branch = await getCurrentBranch(mainWorktreePath);
        expect(branch).toBe("main");
    });

    test("createWorktree creates new worktree", async () => {
        const branchName = `feature-test-${Date.now()}`;
        const currentBranch = await getCurrentBranch(mainWorktreePath);

        const worktreePath = await createWorktree(mainWorktreePath, branchName, currentBranch);

        // Verify worktree was created
        expect(worktreePath).toContain(branchName);
        const exists = await fs.access(worktreePath).then(() => true).catch(() => false);
        expect(exists).toBe(true);

        // Verify it appears in worktree list
        const worktrees = await listWorktrees(mainWorktreePath);
        expect(worktrees).toHaveLength(2);
        expect(worktrees.some(wt => wt.branch === branchName)).toBe(true);
    });

    test("listWorktrees works with bare repo path", async () => {
        const worktrees = await listWorktrees(bareRepoPath);

        expect(worktrees).toHaveLength(1);
        expect(worktrees[0].branch).toBe("main");
    });
});
