import { getTenexBasePath } from "@/constants";
import { Command } from "commander";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface SpawnResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

export type SpawnRunner = (
    command: string,
    args: string[],
    options: {
        cwd: string;
        env: NodeJS.ProcessEnv;
        stdio: "pipe" | "inherit";
    }
) => Promise<SpawnResult>;

export interface DetachedProcess {
    pid?: number;
}

export type DetachedRunner = (
    command: string,
    args: string[],
    options: {
        cwd: string;
        env: NodeJS.ProcessEnv;
    }
) => Promise<DetachedProcess>;

export interface ProcessController {
    signal(pid: number, signal: NodeJS.Signals): void;
    isRunning(pid: number): boolean;
    waitForExit(pid: number, timeoutMs: number): Promise<boolean>;
}

export interface DaemonRustAdapterOptions {
    daemonBinaryPath?: string;
    daemonControlBinaryPath?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    runner?: SpawnRunner;
    detachedRunner?: DetachedRunner;
    processController?: ProcessController;
}

export interface DaemonCommandOptions {
    daemonDir?: string;
    tenexBaseDir?: string;
    foreground?: boolean;
    force?: boolean;
}

export interface DaemonAdapter {
    start(options: DaemonCommandOptions): Promise<DetachedProcess | null>;
    status(options: DaemonCommandOptions): Promise<unknown>;
    stop(options: DaemonCommandOptions): Promise<DaemonStopOutcome>;
}

export interface DaemonStopOutcome {
    status: "not_running" | "stopped" | "killed";
    pid?: number;
}

interface DaemonLockOwner {
    pid: number;
    hostname?: string;
    startedAt?: number;
}

interface DaemonLockState {
    kind: string;
    owner?: DaemonLockOwner;
}

interface DaemonStartPlan {
    kind: string;
    reason?: {
        kind?: string;
        owner?: DaemonLockOwner;
    };
}

interface DaemonStopPlan {
    kind: string;
    lock_state?: DaemonLockState;
    reason?: string;
}

export class DaemonRustCommandError extends Error {
    constructor(
        message: string,
        public readonly exitCode: number,
        public readonly stderr: string
    ) {
        super(message);
        this.name = "DaemonRustCommandError";
    }
}

export class DaemonRustAdapter implements DaemonAdapter {
    private readonly daemonBinaryPath?: string;
    private readonly daemonControlBinaryPath?: string;
    private readonly cwd: string;
    private readonly env: NodeJS.ProcessEnv;
    private readonly runner: SpawnRunner;
    private readonly detachedRunner: DetachedRunner;
    private readonly processController: ProcessController;

    constructor(options: DaemonRustAdapterOptions = {}) {
        this.daemonBinaryPath = options.daemonBinaryPath ?? process.env.TENEX_DAEMON_BIN;
        this.daemonControlBinaryPath = options.daemonControlBinaryPath ?? process.env.TENEX_DAEMON_CONTROL_BIN;
        this.cwd = options.cwd ?? fileURLToPath(new URL("../..", import.meta.url));
        this.env = options.env ?? process.env;
        this.runner = options.runner ?? runProcess;
        this.detachedRunner = options.detachedRunner ?? runDetachedProcess;
        this.processController = options.processController ?? defaultProcessController;
    }

    async start(options: DaemonCommandOptions): Promise<DetachedProcess | null> {
        if (options.foreground) {
            await this.runDaemonForeground(options);
            return null;
        }

        const plan = await this.startPlan(options);
        if (plan.kind !== "allowed") {
            throw new DaemonRustCommandError(formatStartRefusal(plan), 1, "");
        }

        const invocation = this.buildDaemonInvocation(buildDaemonArgs(options));
        return this.detachedRunner(invocation.command, invocation.args, {
            cwd: this.cwd,
            env: this.env,
        });
    }

    async status(options: DaemonCommandOptions): Promise<unknown> {
        return this.runControl("status", buildControlArgs("status", options));
    }

    async stop(options: DaemonCommandOptions): Promise<DaemonStopOutcome> {
        const plan = await this.stopPlan(options);
        if (plan.kind !== "allowed") {
            return { status: "not_running" };
        }

        const pid = plan.lock_state?.owner?.pid;
        if (!pid) {
            throw new DaemonRustCommandError("daemon stop-plan did not include a daemon PID", 1, "");
        }

        this.processController.signal(pid, "SIGTERM");
        const stopped = await this.processController.waitForExit(pid, 10_000);
        if (stopped) {
            return { status: "stopped", pid };
        }

        if (!options.force) {
            throw new DaemonRustCommandError(
                "Daemon did not stop within 10s. Use --force to send SIGKILL.",
                1,
                ""
            );
        }

        this.processController.signal(pid, "SIGKILL");
        const killed = await this.processController.waitForExit(pid, 5_000);
        if (!killed) {
            throw new DaemonRustCommandError("Failed to kill daemon", 1, "");
        }

        return { status: "killed", pid };
    }

    private async runDaemonForeground(options: DaemonCommandOptions): Promise<void> {
        const invocation = this.buildDaemonInvocation(buildDaemonArgs(options));
        const result = await this.runner(invocation.command, invocation.args, {
            cwd: this.cwd,
            env: this.env,
            stdio: "inherit",
        });

        if (result.exitCode !== 0) {
            const message = result.stderr.trim() || `daemon failed with exit code ${result.exitCode}`;
            throw new DaemonRustCommandError(message, result.exitCode, result.stderr);
        }
    }

    private async startPlan(options: DaemonCommandOptions): Promise<DaemonStartPlan> {
        return this.runControl("start-plan", buildControlArgs("start-plan", options)) as Promise<DaemonStartPlan>;
    }

    private async stopPlan(options: DaemonCommandOptions): Promise<DaemonStopPlan> {
        return this.runControl("stop-plan", buildControlArgs("stop-plan", options)) as Promise<DaemonStopPlan>;
    }

    private async runControl(action: string, rustArgs: string[]): Promise<unknown> {
        const invocation = this.buildDaemonControlInvocation(rustArgs);
        const result = await this.runner(invocation.command, invocation.args, {
            cwd: this.cwd,
            env: this.env,
            stdio: "pipe",
        });

        if (result.exitCode !== 0) {
            const message = result.stderr.trim() || `daemon-control ${action} failed with exit code ${result.exitCode}`;
            throw new DaemonRustCommandError(message, result.exitCode, result.stderr);
        }

        try {
            return JSON.parse(result.stdout);
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new DaemonRustCommandError(
                `daemon-control ${action} returned invalid JSON: ${detail}`,
                1,
                result.stderr
            );
        }
    }

    private buildDaemonInvocation(rustArgs: string[]): { command: string; args: string[] } {
        if (this.daemonBinaryPath) {
            return {
                command: this.daemonBinaryPath,
                args: rustArgs,
            };
        }

        return {
            command: "cargo",
            args: ["run", "-q", "-p", "tenex-daemon", "--bin", "daemon", "--", ...rustArgs],
        };
    }

    private buildDaemonControlInvocation(rustArgs: string[]): { command: string; args: string[] } {
        if (this.daemonControlBinaryPath) {
            return {
                command: this.daemonControlBinaryPath,
                args: rustArgs,
            };
        }

        return {
            command: "cargo",
            args: ["run", "-q", "-p", "tenex-daemon", "--bin", "daemon-control", "--", ...rustArgs],
        };
    }
}

function buildDaemonArgs(options: DaemonCommandOptions): string[] {
    const args: string[] = [];
    if (options.daemonDir) {
        args.push("--daemon-dir", options.daemonDir);
        if (options.tenexBaseDir) {
            args.push("--tenex-base-dir", options.tenexBaseDir);
        }
        return args;
    }

    args.push("--tenex-base-dir", options.tenexBaseDir ?? getTenexBasePath());
    return args;
}

function buildControlArgs(action: "status" | "start-plan" | "stop-plan", options: DaemonCommandOptions): string[] {
    return [
        action,
        "--daemon-dir",
        resolveDaemonDir(options),
    ];
}

function resolveDaemonDir(options: DaemonCommandOptions): string {
    return options.daemonDir ?? join(options.tenexBaseDir ?? getTenexBasePath(), "daemon");
}

function formatStartRefusal(plan: DaemonStartPlan): string {
    const owner = plan.reason?.owner;
    if (owner) {
        return `Daemon is already running (PID: ${owner.pid})`;
    }

    return "Daemon start refused by daemon-control";
}

function printJson(value: unknown): void {
    console.log(JSON.stringify(value, null, 2));
}

function createStartHandler(adapter: DaemonAdapter): (options: DaemonCommandOptions) => Promise<void> {
    return async (options) => {
        const processInfo = await adapter.start(options);
        if (processInfo) {
            console.log(`Rust daemon started${processInfo.pid ? ` (PID: ${processInfo.pid})` : ""}`);
        }
    };
}

function createStatusHandler(adapter: DaemonAdapter): (options: DaemonCommandOptions) => Promise<void> {
    return async (options) => {
        printJson(await adapter.status(options));
    };
}

function createStopHandler(adapter: DaemonAdapter): (options: DaemonCommandOptions) => Promise<void> {
    return async (options) => {
        const outcome = await adapter.stop(options);
        if (outcome.status === "not_running") {
            console.log("Daemon is not running");
            return;
        }

        if (outcome.status === "killed") {
            console.log(`Daemon killed${outcome.pid ? ` (PID: ${outcome.pid})` : ""}`);
            return;
        }

        console.log(`Daemon stopped${outcome.pid ? ` (PID: ${outcome.pid})` : ""}`);
    };
}

export function createDaemonCommand(adapter: DaemonAdapter = new DaemonRustAdapter()): Command {
    const statusCommand = new Command("status")
        .description("Show Rust daemon status")
        .option("--daemon-dir <path>", "Daemon state directory; defaults to TENEX daemon dir")
        .option("--tenex-base-dir <path>", "TENEX base directory; used to derive the daemon dir")
        .action(createStatusHandler(adapter));

    const stopCommand = new Command("stop")
        .description("Stop the running Rust daemon")
        .option("--force", "Send SIGKILL if the daemon does not stop gracefully")
        .option("--daemon-dir <path>", "Daemon state directory; defaults to TENEX daemon dir")
        .option("--tenex-base-dir <path>", "TENEX base directory; used to derive the daemon dir")
        .action(createStopHandler(adapter));

    return new Command("daemon")
        .description("Start and control the Rust TENEX daemon")
        .enablePositionalOptions()
        .option("--foreground", "Run the Rust daemon in the foreground")
        .option("--daemon-dir <path>", "Daemon state directory; defaults to TENEX daemon dir")
        .option("--tenex-base-dir <path>", "TENEX base directory; defaults to TENEX_BASE_DIR or ~/.tenex")
        .action(createStartHandler(adapter))
        .addCommand(statusCommand)
        .addCommand(stopCommand);
}

async function runProcess(
    command: string,
    args: string[],
    options: {
        cwd: string;
        env: NodeJS.ProcessEnv;
        stdio: "pipe" | "inherit";
    }
): Promise<SpawnResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env,
            stdio: options.stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
        });

        if (options.stdio === "inherit") {
            child.on("error", reject);
            child.on("close", (code) => {
                resolve({
                    stdout: "",
                    stderr: "",
                    exitCode: code ?? 1,
                });
            });
            return;
        }

        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];

        child.stdout?.on("data", (chunk: Buffer) => {
            stdout.push(chunk);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
            stderr.push(chunk);
        });
        child.on("error", reject);
        child.on("close", (code) => {
            resolve({
                stdout: Buffer.concat(stdout).toString("utf8"),
                stderr: Buffer.concat(stderr).toString("utf8"),
                exitCode: code ?? 1,
            });
        });
    });
}

async function runDetachedProcess(
    command: string,
    args: string[],
    options: {
        cwd: string;
        env: NodeJS.ProcessEnv;
    }
): Promise<DetachedProcess> {
    const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        detached: true,
        stdio: "ignore",
    });
    child.unref();
    return { pid: child.pid };
}

const defaultProcessController: ProcessController = {
    signal(pid: number, signal: NodeJS.Signals): void {
        process.kill(pid, signal);
    },

    isRunning(pid: number): boolean {
        try {
            process.kill(pid, 0);
            return true;
        } catch (err) {
            const error = err as NodeJS.ErrnoException;
            if (error.code === "ESRCH") return false;
            if (error.code === "EPERM") return true;
            throw err;
        }
    },

    async waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (!this.isRunning(pid)) {
                return true;
            }
            await new Promise((resolve) => {
                setTimeout(resolve, 250);
            });
        }
        return !this.isRunning(pid);
    },
};

export const daemonCommand = createDaemonCommand();
