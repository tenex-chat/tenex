import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import {
    createPublishOutboxCommand,
    PublishOutboxRustAdapter,
    PublishOutboxRustCommandError,
    type SpawnRunner,
} from "@/commands/doctor/publish-outbox";

describe("doctor publish-outbox command", () => {
    let logSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        logSpy = spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
        logSpy.mockRestore();
    });

    it("exposes inspect/status and repair/drain subcommands", () => {
        const command = createPublishOutboxCommand({
            inspect: async () => ({}),
            repair: async () => ({}),
        });

        expect(command.name()).toBe("publish-outbox");
        expect(command.commands.map((subcommand) => subcommand.name()).sort()).toEqual([
            "inspect",
            "repair",
        ]);
        expect(command.commands.find((subcommand) => subcommand.name() === "inspect")?.aliases())
            .toContain("status");
        expect(command.commands.find((subcommand) => subcommand.name() === "repair")?.aliases())
            .toContain("drain");
    });

    it("dispatches inspect to the Rust binary with daemon dir and timestamp", async () => {
        const calls: Array<{ command: string; args: string[] }> = [];
        const runner: SpawnRunner = mock(async (command, args) => {
            calls.push({ command, args });
            return {
                stdout: JSON.stringify({ schemaVersion: 1, pendingCount: 0 }),
                stderr: "",
                exitCode: 0,
            };
        });
        const adapter = new PublishOutboxRustAdapter({
            binaryPath: "/tmp/publish-outbox",
            cwd: "/repo",
            env: {},
            runner,
        });
        const command = createPublishOutboxCommand(adapter);

        await command.parseAsync([
            "inspect",
            "--daemon-dir",
            "/tmp/daemon",
            "--now-ms",
            "1710001000000",
        ], { from: "user" });

        expect(calls).toEqual([{
            command: "/tmp/publish-outbox",
            args: [
                "inspect",
                "--daemon-dir",
                "/tmp/daemon",
                "--now-ms",
                "1710001000000",
            ],
        }]);
        expect(logSpy).toHaveBeenCalledWith(JSON.stringify({
            schemaVersion: 1,
            pendingCount: 0,
        }, null, 2));
    });

    it("maps repair to Rust maintain and forwards relay options", async () => {
        const calls: Array<{ command: string; args: string[] }> = [];
        const runner: SpawnRunner = mock(async (command, args) => {
            calls.push({ command, args });
            return {
                stdout: JSON.stringify({ diagnosticsBefore: {}, requeued: [], drained: [] }),
                stderr: "",
                exitCode: 0,
            };
        });
        const adapter = new PublishOutboxRustAdapter({
            binaryPath: "/tmp/publish-outbox",
            cwd: "/repo",
            env: {},
            runner,
        });
        const command = createPublishOutboxCommand(adapter);

        await command.parseAsync([
            "repair",
            "--daemon-dir",
            "/tmp/daemon",
            "--now-ms",
            "1710001000000",
            "--relay-timeout-ms",
            "5000",
            "--relay-url",
            "wss://relay-one.test",
            "--relay-url",
            "wss://relay-two.test",
        ], { from: "user" });

        expect(calls[0]?.args).toEqual([
            "maintain",
            "--daemon-dir",
            "/tmp/daemon",
            "--now-ms",
            "1710001000000",
            "--relay-timeout-ms",
            "5000",
            "--relay-url",
            "wss://relay-one.test",
            "--relay-url",
            "wss://relay-two.test",
        ]);
    });

    it("uses TENEX daemon dir by default", async () => {
        const previousBaseDir = process.env.TENEX_BASE_DIR;
        process.env.TENEX_BASE_DIR = "/tmp/tenex-base";
        const calls: Array<{ args: string[] }> = [];
        const runner: SpawnRunner = mock(async (_command, args) => {
            calls.push({ args });
            return {
                stdout: JSON.stringify({ schemaVersion: 1 }),
                stderr: "",
                exitCode: 0,
            };
        });
        const adapter = new PublishOutboxRustAdapter({
            binaryPath: "/tmp/publish-outbox",
            cwd: "/repo",
            env: {},
            runner,
        });
        const command = createPublishOutboxCommand(adapter);

        try {
            await command.parseAsync(["inspect"], { from: "user" });
        } finally {
            if (previousBaseDir === undefined) {
                delete process.env.TENEX_BASE_DIR;
            } else {
                process.env.TENEX_BASE_DIR = previousBaseDir;
            }
        }

        expect(calls[0]?.args).toEqual([
            "inspect",
            "--daemon-dir",
            "/tmp/tenex-base/daemon",
        ]);
    });

    it("surfaces Rust non-zero exits with the original exit code", async () => {
        const runner: SpawnRunner = mock(async () => ({
            stdout: "",
            stderr: "invalid usage",
            exitCode: 2,
        }));
        const adapter = new PublishOutboxRustAdapter({
            binaryPath: "/tmp/publish-outbox",
            cwd: "/repo",
            env: {},
            runner,
        });
        const command = createPublishOutboxCommand(adapter);

        await expect(command.parseAsync([
            "inspect",
            "--daemon-dir",
            "/tmp/daemon",
        ], { from: "user" })).rejects.toMatchObject({
            name: "PublishOutboxRustCommandError",
            exitCode: 2,
            stderr: "invalid usage",
        } satisfies Partial<PublishOutboxRustCommandError>);
    });

    it("treats invalid Rust stdout JSON as an adapter failure", async () => {
        const runner: SpawnRunner = mock(async () => ({
            stdout: "not json",
            stderr: "",
            exitCode: 0,
        }));
        const adapter = new PublishOutboxRustAdapter({
            binaryPath: "/tmp/publish-outbox",
            cwd: "/repo",
            env: {},
            runner,
        });
        const command = createPublishOutboxCommand(adapter);

        await expect(command.parseAsync([
            "inspect",
            "--daemon-dir",
            "/tmp/daemon",
        ], { from: "user" })).rejects.toThrow("returned invalid JSON");
    });
});
