import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { createMockAgent, createMockExecutionEnvironment } from "@/test-utils";
import { getOrCreateTenexFsTools } from "../fs-tools-factory";

describe("TENEX fs tools path expansion", () => {
    let tempDir: string;
    let projectDir: string;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tenex-fs-tools-"));
        projectDir = path.join(tempDir, "project");
        await fs.mkdir(projectDir, { recursive: true });
    });

    afterEach(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    function createContext(projectId = "proj-1") {
        const signer = NDKPrivateKeySigner.generate();
        const agent = createMockAgent({
            pubkey: signer.pubkey,
            signer,
        });

        return createMockExecutionEnvironment({
            agent,
            workingDirectory: projectDir,
            projectBasePath: projectDir,
            projectId,
            tenexBasePath: tempDir,
            resolveToolEnvironment: () => ({
                ...process.env,
                DOC_SUBDIR: "docs",
                PROJECT_BASE: projectDir,
                PROJECT_ID: projectId,
                TENEX_BASE_DIR: tempDir,
            }),
            getConversation: () => ({ getProjectId: () => projectId } as any),
        });
    }

    it("expands arbitrary env vars from project env files in fs tool paths", async () => {
        const context = createContext();
        const tools = getOrCreateTenexFsTools(context);

        await fs.mkdir(path.join(projectDir, "docs"), { recursive: true });
        await fs.writeFile(path.join(projectDir, "docs", "note.txt"), "env-expanded", "utf-8");

        const result = await tools.fs_read.execute({
            path: `${projectDir}/$DOC_SUBDIR/note.txt`,
            description: "Read file using env-expanded path",
        });

        expect(typeof result).toBe("string");
        expect(result).toContain("env-expanded");
    });

    it("returns error-text when a path references an unresolved env var", async () => {
        const context = createContext();
        const tools = getOrCreateTenexFsTools(context);

        const result = await tools.fs_read.execute({
            path: `${projectDir}/$MISSING_SEGMENT/note.txt`,
            description: "Read file with unresolved env var",
        });

        expect(result).toEqual({
            type: "error-text",
            text: expect.stringContaining("unresolved environment variable"),
        });
    });
});
