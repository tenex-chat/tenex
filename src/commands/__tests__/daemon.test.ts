import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import {
    createDaemonCommand,
    DaemonRustAdapter,
    type DetachedRunner,
    type ProcessController,
    type SpawnRunner,
} from "@/commands/daemon";

describe("daemon command", () => {
    let logSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        logSpy = spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
        logSpy.mockRestore();
    });

    it("exposes status and stop subcommands", () => {
        const command = createDaemonCommand({
            start: async () => null,
            status: async () => ({}),
            stop: async () => ({ status: "not_running" }),
        });

        expect(command.name()).toBe("daemon");
        expect(command.commands.map((subcommand) => subcommand.name()).sort()).toEqual([
            "status",
            "stop",
        ]);
    });

    it("starts the Rust daemon in the background after Rust start-plan allows it", async () => {
        const calls: Array<{ command: string; args: string[]; stdio?: string }> = [];
        const detachedCalls: Array<{ command: string; args: string[] }> = [];
        const runner: SpawnRunner = mock(async (command, args, options) => {
            calls.push({ command, args, stdio: options.stdio });
            return {
                stdout: JSON.stringify({ kind: "allowed", lock_state: { kind: "missing" } }),
                stderr: "",
                exitCode: 0,
            };
        });
        const detachedRunner: DetachedRunner = mock(async (command, args) => {
            detachedCalls.push({ command, args });
            return { pid: 12345 };
        });
        const adapter = new DaemonRustAdapter({
            daemonBinaryPath: "/tmp/daemon",
            daemonControlBinaryPath: "/tmp/daemon-control",
            cwd: "/repo",
            env: {},
            runner,
            detachedRunner,
        });
        const command = createDaemonCommand(adapter);

        await command.parseAsync(["--tenex-base-dir", "/tmp/tenex-base"], { from: "user" });

        expect(calls).toEqual([{
            command: "/tmp/daemon-control",
            args: ["start-plan", "--daemon-dir", "/tmp/tenex-base/daemon"],
            stdio: "pipe",
        }]);
        expect(detachedCalls).toEqual([{
            command: "/tmp/daemon",
            args: ["--tenex-base-dir", "/tmp/tenex-base"],
        }]);
        expect(logSpy).toHaveBeenCalledWith("Rust daemon started (PID: 12345)");
    });

    it("runs the Rust daemon binary directly for foreground mode", async () => {
        const calls: Array<{ command: string; args: string[]; stdio?: string }> = [];
        const detachedRunner: DetachedRunner = mock(async () => {
            throw new Error("foreground must not use detached runner");
        });
        const runner: SpawnRunner = mock(async (command, args, options) => {
            calls.push({ command, args, stdio: options.stdio });
            return {
                stdout: "",
                stderr: "",
                exitCode: 0,
            };
        });
        const adapter = new DaemonRustAdapter({
            daemonBinaryPath: "/tmp/daemon",
            daemonControlBinaryPath: "/tmp/daemon-control",
            cwd: "/repo",
            env: {},
            runner,
            detachedRunner,
        });
        const command = createDaemonCommand(adapter);

        await command.parseAsync([
            "--foreground",
            "--daemon-dir",
            "/tmp/daemon-dir",
            "--tenex-base-dir",
            "/tmp/tenex-base",
        ], { from: "user" });

        expect(calls).toEqual([{
            command: "/tmp/daemon",
            args: [
                "--daemon-dir",
                "/tmp/daemon-dir",
                "--tenex-base-dir",
                "/tmp/tenex-base",
            ],
            stdio: "inherit",
        }]);
    });

    it("delegates status to daemon-control and prints its JSON", async () => {
        const calls: Array<{ command: string; args: string[] }> = [];
        const runner: SpawnRunner = mock(async (command, args) => {
            calls.push({ command, args });
            return {
                stdout: JSON.stringify({
                    statusSnapshot: { presence: "missing_lock" },
                    lockState: { kind: "missing" },
                }),
                stderr: "",
                exitCode: 0,
            };
        });
        const adapter = new DaemonRustAdapter({
            daemonControlBinaryPath: "/tmp/daemon-control",
            cwd: "/repo",
            env: {},
            runner,
        });
        const command = createDaemonCommand(adapter);

        await command.parseAsync(["status", "--daemon-dir", "/tmp/daemon"], { from: "user" });

        expect(calls).toEqual([{
            command: "/tmp/daemon-control",
            args: ["status", "--daemon-dir", "/tmp/daemon"],
        }]);
        expect(logSpy).toHaveBeenCalledWith(JSON.stringify({
            statusSnapshot: { presence: "missing_lock" },
            lockState: { kind: "missing" },
        }, null, 2));
    });

    it("uses Rust stop-plan before sending SIGTERM to the daemon process", async () => {
        const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
        const waits: Array<{ pid: number; timeoutMs: number }> = [];
        const runner: SpawnRunner = mock(async () => ({
            stdout: JSON.stringify({
                kind: "allowed",
                lock_state: {
                    kind: "busy",
                    owner: { pid: 4242, hostname: "tenex-host", startedAt: 1710000000000 },
                },
                status_snapshot: { presence: "running" },
            }),
            stderr: "",
            exitCode: 0,
        }));
        const processController: ProcessController = {
            signal(pid, signal) {
                signals.push({ pid, signal });
            },
            isRunning: () => true,
            waitForExit: mock(async (pid, timeoutMs) => {
                waits.push({ pid, timeoutMs });
                return true;
            }),
        };
        const adapter = new DaemonRustAdapter({
            daemonControlBinaryPath: "/tmp/daemon-control",
            cwd: "/repo",
            env: {},
            runner,
            processController,
        });
        const command = createDaemonCommand(adapter);

        await command.parseAsync(["stop", "--daemon-dir", "/tmp/daemon"], { from: "user" });

        expect(signals).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
        expect(waits).toEqual([{ pid: 4242, timeoutMs: 10_000 }]);
        expect(logSpy).toHaveBeenCalledWith("Daemon stopped (PID: 4242)");
    });

    it("sends SIGKILL when forced stop does not exit after SIGTERM", async () => {
        const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
        const waitResults = [false, true];
        const runner: SpawnRunner = mock(async () => ({
            stdout: JSON.stringify({
                kind: "allowed",
                lock_state: {
                    kind: "busy",
                    owner: { pid: 4242, hostname: "tenex-host", startedAt: 1710000000000 },
                },
                status_snapshot: { presence: "running" },
            }),
            stderr: "",
            exitCode: 0,
        }));
        const processController: ProcessController = {
            signal(pid, signal) {
                signals.push({ pid, signal });
            },
            isRunning: () => true,
            waitForExit: mock(async () => waitResults.shift() ?? true),
        };
        const adapter = new DaemonRustAdapter({
            daemonControlBinaryPath: "/tmp/daemon-control",
            cwd: "/repo",
            env: {},
            runner,
            processController,
        });
        const command = createDaemonCommand(adapter);

        await command.parseAsync(["stop", "--force", "--daemon-dir", "/tmp/daemon"], { from: "user" });

        expect(signals).toEqual([
            { pid: 4242, signal: "SIGTERM" },
            { pid: 4242, signal: "SIGKILL" },
        ]);
        expect(logSpy).toHaveBeenCalledWith("Daemon killed (PID: 4242)");
    });

    it("does not signal a daemon when Rust stop-plan refuses the stop", async () => {
        const runner: SpawnRunner = mock(async () => ({
            stdout: JSON.stringify({
                kind: "refused",
                reason: "missing_lock",
                lock_state: { kind: "missing" },
                status_snapshot: { presence: "missing_lock" },
            }),
            stderr: "",
            exitCode: 0,
        }));
        const processController: ProcessController = {
            signal: mock(() => {}),
            isRunning: () => false,
            waitForExit: mock(async () => true),
        };
        const adapter = new DaemonRustAdapter({
            daemonControlBinaryPath: "/tmp/daemon-control",
            cwd: "/repo",
            env: {},
            runner,
            processController,
        });
        const command = createDaemonCommand(adapter);

        await command.parseAsync(["stop", "--daemon-dir", "/tmp/daemon"], { from: "user" });

        expect(processController.signal).not.toHaveBeenCalled();
        expect(logSpy).toHaveBeenCalledWith("Daemon is not running");
    });
});
