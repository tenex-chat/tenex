import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { getAgentHomeDirectory } from "@/lib/agent-home";
import { AgentEnvironmentService } from "../AgentEnvironmentService";

describe("AgentEnvironmentService", () => {
    const originalTenexBaseDir = process.env.TENEX_BASE_DIR;
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tenex-agent-env-"));
        process.env.TENEX_BASE_DIR = tempDir;
    });

    afterEach(async () => {
        if (originalTenexBaseDir === undefined) {
            process.env.TENEX_BASE_DIR = undefined;
        } else {
            process.env.TENEX_BASE_DIR = originalTenexBaseDir;
        }

        await fs.rm(tempDir, { recursive: true, force: true });
    });

    it("resolves env precedence as base < global < project < agent", async () => {
        const signer = NDKPrivateKeySigner.generate();
        const service = new AgentEnvironmentService({
            loadAgent: async () => ({ nsec: signer.nsec } as any),
        } as any);

        await fs.mkdir(path.join(tempDir, "projects", "proj-1"), { recursive: true });
        await fs.mkdir(getAgentHomeDirectory(signer.pubkey), { recursive: true });
        await fs.writeFile(path.join(tempDir, ".env"), "LEVEL=global\nGLOBAL_ONLY=yes\n", "utf-8");
        await fs.writeFile(
            path.join(tempDir, "projects", "proj-1", ".env"),
            "LEVEL=project\nPROJECT_ONLY=yes\n",
            "utf-8"
        );
        await fs.writeFile(
            path.join(getAgentHomeDirectory(signer.pubkey), ".env"),
            "LEVEL=agent\nAGENT_ONLY=yes\n",
            "utf-8"
        );

        const env = await service.resolveShellEnvironment({
            agentPubkey: signer.pubkey,
            agentNsec: signer.nsec,
            projectDTag: "proj-1",
            baseEnv: {
                LEVEL: "base",
                BASE_ONLY: "yes",
                HOME: "/host/home",
            },
        });

        expect(env.BASE_ONLY).toBe("yes");
        expect(env.GLOBAL_ONLY).toBe("yes");
        expect(env.PROJECT_ONLY).toBe("yes");
        expect(env.AGENT_ONLY).toBe("yes");
        expect(env.LEVEL).toBe("agent");
        expect(env.TENEX_HOST_HOME).toBe("/host/home");
        expect(env.HOME).toBe(getAgentHomeDirectory(signer.pubkey));
    });

    it("bootstraps the agent home env with a normalized bech32 NSEC and preserves existing files", async () => {
        const signer = NDKPrivateKeySigner.generate();
        const service = new AgentEnvironmentService({
            loadAgent: async () => ({ nsec: signer.privateKey } as any),
        } as any);

        const firstResult = await service.ensureAgentHomeEnv({ agentPubkey: signer.pubkey });
        const firstContent = await fs.readFile(firstResult.path, "utf-8");
        const stat = await fs.stat(firstResult.path);

        expect(firstResult.created).toBe(true);
        expect(firstContent).toContain("NSEC=nsec1");
        expect(firstContent).not.toContain(signer.privateKey);
        expect(stat.mode & 0o777).toBe(0o600);

        await fs.writeFile(firstResult.path, "CUSTOM=1\n", "utf-8");
        const secondResult = await service.ensureAgentHomeEnv({ agentPubkey: signer.pubkey });
        const secondContent = await fs.readFile(firstResult.path, "utf-8");

        expect(secondResult.created).toBe(false);
        expect(secondContent).toBe("CUSTOM=1\n");
    });

    it("re-reads env files on every resolve", async () => {
        const signer = NDKPrivateKeySigner.generate();
        const service = new AgentEnvironmentService({
            loadAgent: async () => ({ nsec: signer.nsec } as any),
        } as any);

        await fs.writeFile(path.join(tempDir, ".env"), "VALUE=one\n", "utf-8");

        const firstEnv = await service.resolveShellEnvironment({
            agentPubkey: signer.pubkey,
            agentNsec: signer.nsec,
            baseEnv: { HOME: "/host/home" },
        });
        expect(firstEnv.VALUE).toBe("one");

        await fs.writeFile(path.join(tempDir, ".env"), "VALUE=two\n", "utf-8");

        const secondEnv = await service.resolveShellEnvironment({
            agentPubkey: signer.pubkey,
            agentNsec: signer.nsec,
            baseEnv: { HOME: "/host/home" },
        });
        expect(secondEnv.VALUE).toBe("two");
    });

    it("skips project-scoped env resolution when no project id is available", async () => {
        const signer = NDKPrivateKeySigner.generate();
        const service = new AgentEnvironmentService({
            loadAgent: async () => ({ nsec: signer.nsec } as any),
        } as any);

        await fs.mkdir(path.join(tempDir, "projects", "proj-1"), { recursive: true });
        await fs.writeFile(path.join(tempDir, ".env"), "VALUE=global\n", "utf-8");
        await fs.writeFile(
            path.join(tempDir, "projects", "proj-1", ".env"),
            "VALUE=project\n",
            "utf-8"
        );

        const env = await service.resolveShellEnvironment({
            agentPubkey: signer.pubkey,
            agentNsec: signer.nsec,
            baseEnv: { HOME: "/host/home" },
        });

        expect(env.VALUE).toBe("global");
    });
});
