import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { findOpenClawStateDir, readOpenClawAgents } from "../openclaw-reader";

describe("findOpenClawStateDir", () => {
    let tempDir: string;
    let originalEnv: string | undefined;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-"));
        originalEnv = process.env.OPENCLAW_STATE_DIR;
        delete process.env.OPENCLAW_STATE_DIR;
    });

    afterEach(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
        if (originalEnv !== undefined) {
            process.env.OPENCLAW_STATE_DIR = originalEnv;
        } else {
            delete process.env.OPENCLAW_STATE_DIR;
        }
    });

    it("returns null when no installation found", async () => {
        const result = await findOpenClawStateDir([tempDir + "/nonexistent"]);
        expect(result).toBeNull();
    });

    it("detects via OPENCLAW_STATE_DIR env var", async () => {
        const configPath = path.join(tempDir, "openclaw.json");
        await fs.writeFile(configPath, JSON.stringify({ agents: {} }));
        process.env.OPENCLAW_STATE_DIR = tempDir;
        const result = await findOpenClawStateDir([]);
        expect(result).toBe(tempDir);
    });

    it("detects via candidate path with openclaw.json", async () => {
        const configPath = path.join(tempDir, "openclaw.json");
        await fs.writeFile(configPath, JSON.stringify({ agents: {} }));
        const result = await findOpenClawStateDir([tempDir]);
        expect(result).toBe(tempDir);
    });
});

describe("readOpenClawAgents", () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agents-test-"));
    });

    afterEach(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    it("reads default main agent when no agents.list configured", async () => {
        const workspaceDir = path.join(tempDir, "workspace");
        await fs.mkdir(workspaceDir, { recursive: true });
        await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "# Soul\nBe helpful.");
        await fs.writeFile(path.join(workspaceDir, "IDENTITY.md"), "# Identity\n- **Name:** Clippy");
        await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "# Agents\nBe safe.");
        await fs.writeFile(path.join(workspaceDir, "USER.md"), "# User\n- **Name:** Bob");

        const config = {
            agents: {
                defaults: {
                    model: { primary: "anthropic/claude-sonnet-4-6" },
                    workspace: workspaceDir,
                },
            },
        };
        await fs.writeFile(path.join(tempDir, "openclaw.json"), JSON.stringify(config));

        const agents = await readOpenClawAgents(tempDir);
        expect(agents).toHaveLength(1);
        expect(agents[0].id).toBe("main");
        expect(agents[0].modelPrimary).toBe("anthropic/claude-sonnet-4-6");
        expect(agents[0].workspaceFiles.soul).toContain("Be helpful.");
        expect(agents[0].workspaceFiles.identity).toContain("Clippy");
        expect(agents[0].workspaceFiles.agents).toContain("Be safe.");
        expect(agents[0].workspaceFiles.user).toContain("Bob");
        expect(agents[0].workspacePath).toBe(workspaceDir);
    });

    it("reads multiple agents from agents.list", async () => {
        const ws1 = path.join(tempDir, "workspace-a");
        const ws2 = path.join(tempDir, "workspace-b");
        await fs.mkdir(ws1, { recursive: true });
        await fs.mkdir(ws2, { recursive: true });
        await fs.writeFile(path.join(ws1, "SOUL.md"), "Agent A soul");
        await fs.writeFile(path.join(ws2, "SOUL.md"), "Agent B soul");

        const config = {
            agents: {
                list: [
                    { id: "agent-a", workspace: ws1, model: { primary: "anthropic/claude-opus-4-6" } },
                    { id: "agent-b", workspace: ws2 },
                ],
                defaults: {
                    model: { primary: "anthropic/claude-sonnet-4-6" },
                    workspace: ws1,
                },
            },
        };
        await fs.writeFile(path.join(tempDir, "openclaw.json"), JSON.stringify(config));

        const agents = await readOpenClawAgents(tempDir);
        expect(agents).toHaveLength(2);
        expect(agents[0].id).toBe("agent-a");
        expect(agents[0].modelPrimary).toBe("anthropic/claude-opus-4-6");
        expect(agents[1].id).toBe("agent-b");
        expect(agents[1].modelPrimary).toBe("anthropic/claude-sonnet-4-6"); // falls back to defaults
    });

    it("handles missing workspace files gracefully", async () => {
        const workspaceDir = path.join(tempDir, "workspace");
        await fs.mkdir(workspaceDir, { recursive: true });
        // Only SOUL.md exists, IDENTITY.md and AGENTS.md are missing

        await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "Soul content");

        const config = {
            agents: {
                defaults: { model: { primary: "anthropic/claude-sonnet-4-6" }, workspace: workspaceDir },
            },
        };
        await fs.writeFile(path.join(tempDir, "openclaw.json"), JSON.stringify(config));

        const agents = await readOpenClawAgents(tempDir);
        expect(agents[0].workspaceFiles.soul).toBe("Soul content");
        expect(agents[0].workspaceFiles.identity).toBeNull();
        expect(agents[0].workspaceFiles.agents).toBeNull();
        expect(agents[0].workspaceFiles.user).toBeNull();
    });
});
