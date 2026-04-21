import { config } from "@/services/ConfigService";
import { Command } from "commander";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

type PublishOutboxRustAction = "inspect" | "maintain";

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
    }
) => Promise<SpawnResult>;

export interface PublishOutboxRustAdapterOptions {
    binaryPath?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    runner?: SpawnRunner;
}

export interface PublishOutboxCommandOptions {
    daemonDir?: string;
    nowMs?: string;
    relayTimeoutMs?: string;
    relayUrl?: string[];
}

export interface PublishOutboxAdapter {
    inspect(options: PublishOutboxCommandOptions): Promise<unknown>;
    repair(options: PublishOutboxCommandOptions): Promise<unknown>;
}

export class PublishOutboxRustCommandError extends Error {
    constructor(
        message: string,
        public readonly exitCode: number,
        public readonly stderr: string
    ) {
        super(message);
        this.name = "PublishOutboxRustCommandError";
    }
}

export class PublishOutboxRustAdapter {
    private readonly binaryPath?: string;
    private readonly cwd: string;
    private readonly env: NodeJS.ProcessEnv;
    private readonly runner: SpawnRunner;

    constructor(options: PublishOutboxRustAdapterOptions = {}) {
        this.binaryPath = options.binaryPath ?? process.env.TENEX_PUBLISH_OUTBOX_BIN;
        this.cwd = options.cwd ?? fileURLToPath(new URL("../../..", import.meta.url));
        this.env = options.env ?? process.env;
        this.runner = options.runner ?? runProcess;
    }

    async inspect(options: PublishOutboxCommandOptions): Promise<unknown> {
        return this.run("inspect", buildRustArgs("inspect", options));
    }

    async repair(options: PublishOutboxCommandOptions): Promise<unknown> {
        return this.run("maintain", buildRustArgs("maintain", options));
    }

    private async run(action: PublishOutboxRustAction, rustArgs: string[]): Promise<unknown> {
        const invocation = this.buildInvocation(rustArgs);
        const result = await this.runner(invocation.command, invocation.args, {
            cwd: this.cwd,
            env: this.env,
        });

        if (result.exitCode !== 0) {
            const message = result.stderr.trim() || `${action} failed with exit code ${result.exitCode}`;
            throw new PublishOutboxRustCommandError(message, result.exitCode, result.stderr);
        }

        try {
            return JSON.parse(result.stdout);
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new PublishOutboxRustCommandError(
                `publish-outbox ${action} returned invalid JSON: ${detail}`,
                1,
                result.stderr
            );
        }
    }

    private buildInvocation(rustArgs: string[]): { command: string; args: string[] } {
        if (this.binaryPath) {
            return {
                command: this.binaryPath,
                args: rustArgs,
            };
        }

        return {
            command: "cargo",
            args: ["run", "-q", "-p", "tenex-daemon", "--bin", "publish-outbox", "--", ...rustArgs],
        };
    }
}

function buildRustArgs(action: PublishOutboxRustAction, options: PublishOutboxCommandOptions): string[] {
    const args = [
        action,
        "--daemon-dir",
        options.daemonDir ?? config.getConfigPath("daemon"),
    ];

    if (options.nowMs) {
        args.push("--now-ms", options.nowMs);
    }
    if (options.relayTimeoutMs) {
        args.push("--relay-timeout-ms", options.relayTimeoutMs);
    }
    for (const relayUrl of options.relayUrl ?? []) {
        args.push("--relay-url", relayUrl);
    }

    return args;
}

function collectOption(value: string, previous: string[] = []): string[] {
    return [...previous, value];
}

function printJson(value: unknown): void {
    console.log(JSON.stringify(value, null, 2));
}

function createActionHandler(
    action: "inspect" | "repair",
    adapter: PublishOutboxAdapter
): (options: PublishOutboxCommandOptions) => Promise<void> {
    return async (options) => {
        const result = action === "inspect"
            ? await adapter.inspect(options)
            : await adapter.repair(options);
        printJson(result);
    };
}

export function createPublishOutboxCommand(
    adapter: PublishOutboxAdapter = new PublishOutboxRustAdapter()
): Command {
    const inspectCommand = new Command("inspect")
        .alias("status")
        .description("Inspect Rust publish-outbox diagnostics without mutating state")
        .option("--daemon-dir <path>", "Daemon state directory; defaults to TENEX daemon dir")
        .option("--now-ms <ms>", "Override inspection timestamp in unix milliseconds")
        .action(createActionHandler("inspect", adapter));

    const repairCommand = new Command("repair")
        .alias("drain")
        .description("Run Rust publish-outbox maintenance: requeue due failures and drain pending events")
        .option("--daemon-dir <path>", "Daemon state directory; defaults to TENEX daemon dir")
        .option("--now-ms <ms>", "Override maintenance timestamp in unix milliseconds")
        .option("--relay-timeout-ms <ms>", "Relay OK response timeout in milliseconds")
        .option("--relay-url <url>", "Relay URL to publish through; can be repeated", collectOption, [])
        .action(createActionHandler("repair", adapter));

    return new Command("publish-outbox")
        .description("Inspect or repair Rust publish-outbox state")
        .addCommand(inspectCommand)
        .addCommand(repairCommand);
}

async function runProcess(
    command: string,
    args: string[],
    options: {
        cwd: string;
        env: NodeJS.ProcessEnv;
    }
): Promise<SpawnResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env,
            stdio: ["ignore", "pipe", "pipe"],
        });

        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];

        child.stdout.on("data", (chunk: Buffer) => {
            stdout.push(chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
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
