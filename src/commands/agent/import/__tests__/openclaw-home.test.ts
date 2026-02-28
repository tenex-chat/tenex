import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHomeDir } from "../openclaw";

describe("createHomeDir", () => {
    let tempBase: string;
    let workspaceDir: string;
    let originalEnv: string | undefined;

    beforeEach(async () => {
        tempBase = await fs.mkdtemp(path.join(os.tmpdir(), "tenex-home-test-"));
        workspaceDir = path.join(tempBase, "openclaw-workspace");
        await fs.mkdir(workspaceDir, { recursive: true });

        // Set TENEX_BASE_DIR so getAgentHomeDirectory resolves under our temp dir
        originalEnv = process.env.TENEX_BASE_DIR;
        process.env.TENEX_BASE_DIR = path.join(tempBase, ".tenex");

        // Create workspace files
        await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# Memory\nSome memory content");
        await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
        await fs.writeFile(path.join(workspaceDir, "memory", "2025-01-15.md"), "Daily log entry");
        await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "# Soul\nBe helpful.");
        await fs.writeFile(path.join(workspaceDir, "notes.txt"), "Some notes");
    });

    afterEach(async () => {
        if (originalEnv !== undefined) {
            process.env.TENEX_BASE_DIR = originalEnv;
        } else {
            delete process.env.TENEX_BASE_DIR;
        }
        await fs.rm(tempBase, { recursive: true, force: true });
    });

    const fakePubkey = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

    describe("correct home directory path", () => {
        it("creates home dir under ~/.tenex/home/<short-pubkey>, not ~/.tenex/agents/<pubkey>", async () => {
            const homeDir = await createHomeDir(fakePubkey, workspaceDir);

            // Should be under home/<short-pubkey>
            const expectedPath = path.join(tempBase, ".tenex", "home", fakePubkey.slice(0, 8));
            expect(homeDir).toBe(expectedPath);

            // The wrong path should NOT exist
            const wrongPath = path.join(tempBase, ".tenex", "agents", fakePubkey);
            const wrongExists = await fs.access(wrongPath).then(() => true).catch(() => false);
            expect(wrongExists).toBe(false);
        });
    });

    describe("default (sync) mode", () => {
        it("creates symlinks for MEMORY.md and memory/", async () => {
            const homeDir = await createHomeDir(fakePubkey, workspaceDir);

            const memoryMdStat = await fs.lstat(path.join(homeDir, "MEMORY.md"));
            expect(memoryMdStat.isSymbolicLink()).toBe(true);

            const memoryMdTarget = await fs.readlink(path.join(homeDir, "MEMORY.md"));
            expect(memoryMdTarget).toBe(path.join(workspaceDir, "MEMORY.md"));

            const memoryDirStat = await fs.lstat(path.join(homeDir, "memory"));
            expect(memoryDirStat.isSymbolicLink()).toBe(true);

            const memoryDirTarget = await fs.readlink(path.join(homeDir, "memory"));
            expect(memoryDirTarget).toBe(path.join(workspaceDir, "memory"));
        });

        it("writes +INDEX.md mentioning sync", async () => {
            const homeDir = await createHomeDir(fakePubkey, workspaceDir);
            const indexContent = await fs.readFile(path.join(homeDir, "+INDEX.md"), "utf-8");
            expect(indexContent).toContain("synced");
            expect(indexContent).toContain(workspaceDir);
        });
    });

    describe("--no-sync (copy) mode", () => {
        it("copies all files from workspace instead of symlinking", async () => {
            const homeDir = await createHomeDir(fakePubkey, workspaceDir, { noSync: true });

            // MEMORY.md should be a regular file, not a symlink
            const memoryMdStat = await fs.lstat(path.join(homeDir, "MEMORY.md"));
            expect(memoryMdStat.isSymbolicLink()).toBe(false);
            expect(memoryMdStat.isFile()).toBe(true);

            const memoryContent = await fs.readFile(path.join(homeDir, "MEMORY.md"), "utf-8");
            expect(memoryContent).toBe("# Memory\nSome memory content");
        });

        it("copies subdirectories recursively", async () => {
            const homeDir = await createHomeDir(fakePubkey, workspaceDir, { noSync: true });

            // memory/ should be a real directory, not a symlink
            const memoryDirStat = await fs.lstat(path.join(homeDir, "memory"));
            expect(memoryDirStat.isSymbolicLink()).toBe(false);
            expect(memoryDirStat.isDirectory()).toBe(true);

            const dailyLog = await fs.readFile(path.join(homeDir, "memory", "2025-01-15.md"), "utf-8");
            expect(dailyLog).toBe("Daily log entry");
        });

        it("copies all workspace files, not just MEMORY.md and memory/", async () => {
            const homeDir = await createHomeDir(fakePubkey, workspaceDir, { noSync: true });

            // SOUL.md and notes.txt should also be copied
            const soulContent = await fs.readFile(path.join(homeDir, "SOUL.md"), "utf-8");
            expect(soulContent).toBe("# Soul\nBe helpful.");

            const notesContent = await fs.readFile(path.join(homeDir, "notes.txt"), "utf-8");
            expect(notesContent).toBe("Some notes");
        });

        it("writes +INDEX.md mentioning copy (not sync)", async () => {
            const homeDir = await createHomeDir(fakePubkey, workspaceDir, { noSync: true });
            const indexContent = await fs.readFile(path.join(homeDir, "+INDEX.md"), "utf-8");
            expect(indexContent).toContain("copied");
            expect(indexContent).not.toContain("synced");
            expect(indexContent).toContain(workspaceDir);
        });
    });
});
