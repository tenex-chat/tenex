import { config } from "@/services/ConfigService";
import chalk from "chalk";
import { Command } from "commander";
import * as fs from "node:fs/promises";
import * as path from "node:path";

interface LockInfo {
    pid: number;
    hostname: string;
    startedAt: number;
}

function isProcessRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        const error = err as NodeJS.ErrnoException;
        if (error.code === "ESRCH") return false;
        if (error.code === "EPERM") return true;
        throw err;
    }
}

function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;
        const interval = setInterval(() => {
            if (!isProcessRunning(pid)) {
                clearInterval(interval);
                resolve(true);
            } else if (Date.now() >= deadline) {
                clearInterval(interval);
                resolve(false);
            }
        }, 250);
    });
}

export const daemonStopCommand = new Command("stop")
    .description("Stop the running TENEX daemon")
    .option("--force", "Send SIGKILL if the daemon does not stop gracefully")
    .action(async (options) => {
        const daemonDir = config.getConfigPath("daemon");
        const lockfilePath = path.join(daemonDir, "tenex.lock");

        let lockInfo: LockInfo | null = null;
        try {
            const content = await fs.readFile(lockfilePath, "utf-8");
            lockInfo = JSON.parse(content) as LockInfo;
        } catch {
            // No lockfile
        }

        if (!lockInfo || !isProcessRunning(lockInfo.pid)) {
            console.log(chalk.gray("Daemon is not running"));
            return;
        }

        const { pid } = lockInfo;
        process.stdout.write(chalk.gray(`Stopping daemon (PID: ${pid})...`));

        process.kill(pid, "SIGTERM");

        const exited = await waitForExit(pid, 10_000);

        if (exited) {
            process.stdout.write(chalk.green(" stopped\n"));
            return;
        }

        if (!options.force) {
            process.stdout.write("\n");
            console.error(chalk.red("Daemon did not stop within 10s. Use --force to send SIGKILL."));
            process.exit(1);
        }

        process.stdout.write(chalk.yellow(" forcing...\n"));
        process.kill(pid, "SIGKILL");

        const killedOk = await waitForExit(pid, 5_000);
        if (killedOk) {
            console.log(chalk.green("Daemon killed"));
        } else {
            console.error(chalk.red("Failed to kill daemon"));
            process.exit(1);
        }
    });
