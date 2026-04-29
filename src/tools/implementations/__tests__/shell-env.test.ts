import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { getAgentHomeDirectory } from "@/lib/agent-home";
import { createMockAgent, createMockExecutionEnvironment } from "@/test-utils";
import { createShellTool } from "../shell";

describe("shellTool env resolution", () => {
    let tempDir: string;
    let projectDir: string;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tenex-shell-env-"));
        projectDir = path.join(tempDir, "project");
        await fs.mkdir(projectDir, { recursive: true });
    });

    afterEach(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    function createToolEnv(
        signer: NDKPrivateKeySigner,
        projectId: string | undefined,
        projectBasePath: string,
        overrides: NodeJS.ProcessEnv = {}
    ): NodeJS.ProcessEnv {
        return {
            ...process.env,
            HOME: process.env.HOME ?? os.homedir(),
            AGENT_HOME: getAgentHomeDirectory(signer.pubkey, tempDir),
            NSEC: (signer as unknown as { nsec: string }).nsec,
            PUBKEY: signer.pubkey,
            PROJECT_BASE: projectBasePath,
            PROJECT_ID: projectId,
            TENEX_BASE_DIR: tempDir,
            ...overrides,
        };
    }

    function createShellContext(projectId?: string, envOverrides: NodeJS.ProcessEnv = {}) {
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
                projectId: projectId ?? undefined,
                tenexBasePath: tempDir,
                resolveToolEnvironment: () =>
                    createToolEnv(signer, projectId, projectDir, envOverrides),
                getConversation: projectId
                    ? () => ({ getProjectId: () => projectId } as any)
                    : () => undefined,
            }),
        };
    }

    it("provides NSEC and AGENT_HOME without overwriting HOME", async () => {
        const { signer, context } = createShellContext();
        const shellTool = createShellTool(context);

        const result = await shellTool.execute({
            command: "printf '%s\\n%s\\n%s' \"$HOME\" \"$AGENT_HOME\" \"$NSEC\"",
            description: "Inspect shell environment",
        });

        expect(typeof result).toBe("string");
        const output = (result as string).trimEnd().split("\n");
        const agentHome = getAgentHomeDirectory(signer.pubkey, tempDir);

        // HOME should NOT be the agent home - tools like gh rely on user's real home
        expect(output[0]).not.toBe(agentHome);
        expect(output[0].length).toBeGreaterThan(0);
        // AGENT_HOME provides access to agent home for scripts that need it
        expect(output[1]).toBe(agentHome);
        expect(output[2].startsWith("nsec1")).toBe(true);
    });

    it("passes the resolved env to the spawned process", async () => {
        const { context } = createShellContext("proj-1", { VALUE: "agent" });
        const shellTool = createShellTool(context);

        const result = await shellTool.execute({
            command: "printf '%s' \"$VALUE\"",
            description: "Check env precedence",
        });

        expect(result).toBe("agent");
    });

    it("expands project path variables in cwd before spawning the shell", async () => {
        const signer = NDKPrivateKeySigner.generate();
        const agent = createMockAgent({
            pubkey: signer.pubkey,
            signer,
        });
        const projectWorkingDir = path.join(tempDir, "project-workdir");
        const projectBasePath = path.join(tempDir, "project-base");
        await fs.mkdir(projectWorkingDir, { recursive: true });
        await fs.mkdir(projectBasePath, { recursive: true });

        const shellTool = createShellTool(
            createMockExecutionEnvironment({
                agent,
                workingDirectory: projectWorkingDir,
                projectBasePath,
                projectId: "proj-1",
                tenexBasePath: tempDir,
                resolveToolEnvironment: () =>
                    createToolEnv(signer, "proj-1", projectBasePath),
                getConversation: () => ({ getProjectId: () => "proj-1" } as any),
            })
        );

        const result = await shellTool.execute({
            command: "pwd",
            description: "Verify cwd expansion",
            cwd: "$PROJECT_BASE",
        });

        expect(typeof result).toBe("string");
        expect((result as string).trim()).toBe(await fs.realpath(projectBasePath));
    });

    it("expands arbitrary env vars from project env files in cwd", async () => {
        const { context } = createShellContext("proj-1", { CUSTOM_CWD: "env-dir" });
        const shellTool = createShellTool(context);
        const envDir = path.join(projectDir, "env-dir");

        await fs.mkdir(envDir, { recursive: true });

        const result = await shellTool.execute({
            command: "pwd",
            description: "Verify arbitrary cwd env expansion",
            cwd: "$CUSTOM_CWD",
        });

        expect(typeof result).toBe("string");
        expect((result as string).trim()).toBe(await fs.realpath(envDir));
    });

    it("returns a shell error before execution when env resolution fails", async () => {
        const { context } = createShellContext("proj-1");
        context.resolveToolEnvironment = () => {
            throw new Error(`Invalid .env file at ${path.join(tempDir, "projects", "proj-1", ".env")}:1: Invalid line`);
        };
        const shellTool = createShellTool(context);

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
        const { context } = createShellContext("proj-1", { VALUE: "background" });
        const shellTool = createShellTool(context);

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
