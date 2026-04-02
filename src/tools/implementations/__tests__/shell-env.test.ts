import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { getAgentHomeDirectory } from "@/lib/agent-home";
import { createMockAgent, createMockExecutionEnvironment } from "@/test-utils";
import { createShellTool } from "../shell";

describe("shellTool env resolution", () => {
    const originalTenexBaseDir = process.env.TENEX_BASE_DIR;
    let tempDir: string;
    let projectDir: string;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tenex-shell-env-"));
        projectDir = path.join(tempDir, "project");
        await fs.mkdir(projectDir, { recursive: true });
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

    function createShellContext(projectId?: string) {
        const signer = NDKPrivateKeySigner.generate();
        const agent = createMockAgent({
            pubkey: signer.pubkey,
            signer,
        });

        return {
            signer,
            agent,
            context: createMockExecutionEnvironment({
                agent,
                workingDirectory: projectDir,
                projectBasePath: projectDir,
                getConversation: projectId
                    ? () => ({ getProjectId: () => projectId } as any)
                    : () => undefined,
            }),
        };
    }

    it("bootstraps NSEC and provides AGENT_HOME without overwriting HOME", async () => {
        const { signer, context } = createShellContext();
        const shellTool = createShellTool(context);

        const result = await shellTool.execute({
            command: "printf '%s\\n%s\\n%s' \"$HOME\" \"$AGENT_HOME\" \"$NSEC\"",
            description: "Inspect shell environment",
        });

        expect(typeof result).toBe("string");
        const output = (result as string).trimEnd().split("\n");
        const agentHome = getAgentHomeDirectory(signer.pubkey);

        // HOME should NOT be the agent home - tools like gh rely on user's real home
        expect(output[0]).not.toBe(agentHome);
        expect(output[0].length).toBeGreaterThan(0);
        // AGENT_HOME provides access to agent home for scripts that need it
        expect(output[1]).toBe(agentHome);
        expect(output[2].startsWith("nsec1")).toBe(true);

        const bootstrappedEnv = await fs.readFile(path.join(agentHome, ".env"), "utf-8");
        expect(bootstrappedEnv).toContain("NSEC=nsec1");
    });

    it("applies env precedence as global < project < agent", async () => {
        const { signer, context } = createShellContext("proj-1");
        const shellTool = createShellTool(context);

        await fs.mkdir(path.join(tempDir, "projects", "proj-1"), { recursive: true });
        await fs.mkdir(getAgentHomeDirectory(signer.pubkey), { recursive: true });
        await fs.writeFile(path.join(tempDir, ".env"), "VALUE=global\n", "utf-8");
        await fs.writeFile(
            path.join(tempDir, "projects", "proj-1", ".env"),
            "VALUE=project\n",
            "utf-8"
        );
        await fs.writeFile(
            path.join(getAgentHomeDirectory(signer.pubkey), ".env"),
            "VALUE=agent\n",
            "utf-8"
        );

        const result = await shellTool.execute({
            command: "printf '%s' \"$VALUE\"",
            description: "Check env precedence",
        });

        expect(result).toBe("agent");
    });

    it("returns a shell error before execution when an env file has invalid syntax", async () => {
        const { context } = createShellContext("proj-1");
        const shellTool = createShellTool(context);

        await fs.mkdir(path.join(tempDir, "projects", "proj-1"), { recursive: true });
        await fs.writeFile(
            path.join(tempDir, "projects", "proj-1", ".env"),
            "NOT VALID\n",
            "utf-8"
        );

        const result = await shellTool.execute({
            command: "printf 'should-not-run'",
            description: "Hit invalid env syntax",
        });

        expect(result).toMatchObject({
            type: "shell-error",
            exitCode: null,
            stdout: "",
            stderr: "",
        });
        expect((result as { error: string }).error).toContain(
            path.join(tempDir, "projects", "proj-1", ".env")
        );
        expect((result as { error: string }).error).toContain(":1");
    });

    it("uses the resolved env for background tasks too", async () => {
        const { context } = createShellContext("proj-1");
        const shellTool = createShellTool(context);

        await fs.writeFile(path.join(tempDir, ".env"), "VALUE=background\n", "utf-8");

        const result = await shellTool.execute({
            command: "printf '%s' \"$VALUE\"",
            description: "Background env check",
            run_in_background: true,
        });

        expect(result).toMatchObject({
            type: "background-task",
        });

        const outputFile = (result as { outputFile: string }).outputFile;
        let output = "";
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
            try {
                output = await fs.readFile(outputFile, "utf-8");
                if (output.length > 0) {
                    break;
                }
            } catch {
                // Wait for the task to create output.
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }

        expect(output).toContain("background");
    });
});
