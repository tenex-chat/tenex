import { StatusFile } from "@/daemon/StatusFile";
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

function formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ${minutes % 60}m`;
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
}

export const daemonStatusCommand = new Command("status")
    .description("Show the status of the TENEX daemon")
    .action(async () => {
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
            console.log(chalk.gray("○  Daemon is not running"));
            return;
        }

        const uptime = Date.now() - lockInfo.startedAt;
        console.log(
            chalk.green("●  Daemon running") +
            chalk.gray(` — PID: ${lockInfo.pid}, uptime: ${formatDuration(uptime)}`)
        );
        console.log();

        const statusFile = new StatusFile(daemonDir);
        const status = await statusFile.read();

        if (!status) {
            console.log(chalk.gray("   Status details unavailable (daemon is still initializing)"));
            return;
        }

        console.log(`   Known projects:  ${chalk.bold(String(status.knownProjects))}`);
        console.log(`   Active projects: ${chalk.bold(String(status.runtimes.length))}`);

        if (status.runtimes.length > 0) {
            console.log();
            for (const runtime of status.runtimes) {
                if (!runtime.startTime) {
                    throw new Error("[daemon-status] Missing runtime startTime.");
                }

                const startedAgo =
                    `${formatDuration(Date.now() - new Date(runtime.startTime).getTime())} ago`;
                const lastEventAgo = runtime.lastEventTime
                    ? `${formatDuration(Date.now() - new Date(runtime.lastEventTime).getTime())} ago`
                    : "never";

                console.log(`   ${chalk.cyan(runtime.title)}`);
                console.log(chalk.gray(`     agents: ${runtime.agentCount}  events: ${runtime.eventCount}`));
                console.log(chalk.gray(`     started: ${startedAgo}  last event: ${lastEventAgo}`));
            }
        }
    });
