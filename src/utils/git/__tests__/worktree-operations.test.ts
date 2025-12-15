import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { getCurrentBranch } from "../initializeGitRepo";
import { listWorktrees, createWorktree, sanitizeBranchName, WORKTREES_DIR } from "../worktree";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

const execAsync = promisify(exec);

describe("sanitizeBranchName", () => {
    test("replaces forward slashes with underscores", () => {
        expect(sanitizeBranchName("feature/whatever")).toBe("feature_whatever");
    });

    test("handles multiple slashes", () => {
        expect(sanitizeBranchName("bugfix/issue/123")).toBe("bugfix_issue_123");
    });

    test("leaves names without slashes unchanged", () => {
        expect(sanitizeBranchName("main")).toBe("main");
        expect(sanitizeBranchName("feature-branch")).toBe("feature-branch");
    });
});

describe("Git Worktree Operations", () => {
    let projectPath: string;

    beforeEach(async () => {
        // Create temporary test directory with normal git repo
        projectPath = path.join(os.tmpdir(), `test-repo-${Date.now()}`);
        await fs.mkdir(projectPath, { recursive: true });

        // Initialize normal git repo
        await execAsync("git init", { cwd: projectPath });

        // Configure git
        await execAsync('git config user.email "test@test.com"', { cwd: projectPath });
        await execAsync('git config user.name "Test"', { cwd: projectPath });

        // Create initial commit
        await fs.writeFile(path.join(projectPath, "README.md"), "# Test");
        await execAsync("git add .", { cwd: projectPath });
        await execAsync('git commit -m "Initial commit"', { cwd: projectPath });
    });

    afterEach(async () => {
        // Clean up test directory
        await fs.rm(projectPath, { recursive: true, force: true });
    });

    test("listWorktrees returns main worktree", async () => {
        const worktrees = await listWorktrees(projectPath);

        expect(worktrees).toHaveLength(1);
        // Default branch could be "main" or "master" depending on git config
        expect(["main", "master"]).toContain(worktrees[0].branch);

        // Resolve real paths for comparison (macOS /var -> /private/var)
        const realProjectPath = await fs.realpath(projectPath);
        const realWorktreePath = await fs.realpath(worktrees[0].path);
        expect(realWorktreePath).toBe(realProjectPath);
    });

    test("getCurrentBranch returns current branch name", async () => {
        const branch = await getCurrentBranch(projectPath);
        // Default branch could be "main" or "master" depending on git config
        expect(["main", "master"]).toContain(branch);
    });

    test("createWorktree creates new worktree in .worktrees directory", async () => {
        const branchName = "feature/test-branch";
        const currentBranch = await getCurrentBranch(projectPath);

        const worktreePath = await createWorktree(projectPath, branchName, currentBranch);

        // Verify worktree was created in .worktrees with sanitized name
        const expectedPath = path.join(projectPath, WORKTREES_DIR, "feature_test-branch");
        expect(worktreePath).toBe(expectedPath);

        const exists = await fs.access(worktreePath).then(() => true).catch(() => false);
        expect(exists).toBe(true);

        // Verify it appears in worktree list
        const worktrees = await listWorktrees(projectPath);
        expect(worktrees.length).toBeGreaterThanOrEqual(2);
        expect(worktrees.some(wt => wt.branch === branchName)).toBe(true);
    });

    test("createWorktree adds .worktrees to gitignore", async () => {
        const branchName = "feature/gitignore-test";
        const currentBranch = await getCurrentBranch(projectPath);

        await createWorktree(projectPath, branchName, currentBranch);

        // Verify .worktrees is in .gitignore
        const gitignorePath = path.join(projectPath, ".gitignore");
        const gitignoreContent = await fs.readFile(gitignorePath, "utf-8");
        expect(gitignoreContent).toContain(".worktrees");
    });

    test("createWorktree handles branch names with slashes", async () => {
        const branchName = "feature/nested/branch/name";
        const currentBranch = await getCurrentBranch(projectPath);

        const worktreePath = await createWorktree(projectPath, branchName, currentBranch);

        // Verify sanitized path
        const expectedPath = path.join(projectPath, WORKTREES_DIR, "feature_nested_branch_name");
        expect(worktreePath).toBe(expectedPath);

        // Verify branch name is preserved in git
        const worktrees = await listWorktrees(projectPath);
        const createdWorktree = worktrees.find(wt => wt.branch === branchName);
        expect(createdWorktree).toBeDefined();
        expect(createdWorktree?.branch).toBe(branchName);
    });
});
