import { type ChildProcess, spawn } from "node:child_process";
import * as path from "node:path";
import { logger } from "@/utils/logger";

export interface IProcessManager {
    spawnProjectRun(projectPath: string, projectId?: string): Promise<void>;
    isProjectRunning(projectId: string): Promise<boolean>;
    stopProject(projectId: string): Promise<void>;
    stopAll(): Promise<void>;
}

interface ProcessInfo {
    process: ChildProcess;
    projectPath: string;
    startedAt: Date;
}

export class ProcessManager implements IProcessManager {
    private processes: Map<string, ProcessInfo> = new Map();

    async spawnProjectRun(projectPath: string, projectId?: string): Promise<void> {
        const id = projectId || path.basename(projectPath);

        // Check if already running
        if (this.processes.has(id)) {
            return;
        }

        // Get the CLI binary path
        const cliBinPath = path.join(__dirname, "..", "tenex.ts");

        // Spawn the process
        const child = spawn("bun", ["run", cliBinPath, "project", "run"], {
            cwd: projectPath,
            stdio: "inherit", // Let output pass through directly
            detached: false,
        });

        // Handle process exit
        child.on("exit", (code, signal) => {
            logger.info("Project process exited", {
                projectId: id,
                code,
                signal,
            });
            this.processes.delete(id);
        });

        // Handle errors
        child.on("error", (error) => {
            logger.error("Project process error", {
                projectId: id,
                error,
            });
            this.processes.delete(id);
        });

        // Store process info
        this.processes.set(id, {
            process: child,
            projectPath,
            startedAt: new Date(),
        });
    }

    async isProjectRunning(projectId: string): Promise<boolean> {
        const processInfo = this.processes.get(projectId);
        if (!processInfo) {
            return false;
        }

        // Check if process is still alive
        try {
            if (processInfo.process.pid) {
                process.kill(processInfo.process.pid, 0);
                return true;
            }
        } catch {
            // Process doesn't exist
            this.processes.delete(projectId);
            return false;
        }

        return false;
    }

    async stopProject(projectId: string): Promise<void> {
        const processInfo = this.processes.get(projectId);
        if (!processInfo) {
            logger.warn("Project not running", { projectId });
            return;
        }

        // Try graceful shutdown first
        if (processInfo.process.pid) {
            process.kill(processInfo.process.pid, "SIGTERM");

            // Wait for process to exit
            await new Promise<void>((resolve) => {
                const timeout = setTimeout(() => {
                    // Force kill if not exited
                    if (processInfo.process.pid) {
                        logger.warn("Force killing project", { projectId });
                        process.kill(processInfo.process.pid, "SIGKILL");
                    }
                    resolve();
                }, 5000);

                processInfo.process.once("exit", () => {
                    clearTimeout(timeout);
                    resolve();
                });
            });
        }

        this.processes.delete(projectId);
    }

    async stopAll(): Promise<void> {
        const stopPromises = Array.from(this.processes.keys()).map((projectId) =>
            this.stopProject(projectId)
        );

        await Promise.all(stopPromises);
    }

    getRunningProjects(): Array<{ id: string; path: string; startedAt: Date }> {
        return Array.from(this.processes.entries()).map(([id, info]) => ({
            id,
            path: info.projectPath,
            startedAt: info.startedAt,
        }));
    }
}
