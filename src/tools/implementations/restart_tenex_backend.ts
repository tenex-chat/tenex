import { spawn, type ChildProcess } from "node:child_process";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ExecutionContext } from "@/agents/execution/types";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const execAsync = promisify(exec);

/**
 * Configuration for backend restart operations
 */
export const BackendRestartConfig = {
    /** Command to start the backend */
    START_COMMAND: "bun" as const,
    START_ARGS: ["run", "src/index.ts", "daemon"] as string[],

    /** Pattern to match backend processes */
    PROCESS_MATCH_PATTERN: "bun run src/index.ts daemon" as const,

    /** Log file path for backend output */
    LOG_FILE_PATH: "/tmp/tenex-backend.log" as const,

    /** Maximum time to wait for process termination in milliseconds */
    TERMINATION_TIMEOUT_MS: 5000 as const,

    /** Polling interval for checking process termination in milliseconds */
    TERMINATION_POLL_INTERVAL_MS: 100 as const,
};

const restartTenexBackendSchema = z.object({});

type RestartTenexBackendInput = z.infer<typeof restartTenexBackendSchema>;

export interface RestartTenexBackendOutput {
    success: boolean;
    message: string;
    processId?: number;
    killedProcesses?: number[];
}

/**
 * Process information returned by findProcessesByCommand
 */
export interface ProcessInfo {
    pid: number;
    command: string;
}

/**
 * Find all process IDs for processes matching the given command pattern.
 * Uses pgrep on Unix-like systems for reliable process matching.
 *
 * @param commandPattern - Pattern to match against process command lines
 * @param execFunction - Optional exec function for dependency injection (for testing)
 * @returns Array of process information objects
 */
export async function findProcessesByCommand(
    commandPattern: string,
    execFunction: typeof execAsync = execAsync
): Promise<ProcessInfo[]> {
    try {
        // Use pgrep for more reliable process matching
        // -f flag matches against the full command line
        // -l flag includes the process name in output
        const { stdout } = await execFunction(`pgrep -fl "${commandPattern}"`);

        if (!stdout.trim()) {
            return [];
        }

        const lines = stdout.trim().split("\n");
        const processes: ProcessInfo[] = [];

        for (const line of lines) {
            // pgrep -fl output format: "PID command"
            const match = line.match(/^(\d+)\s+(.+)$/);
            if (match) {
                const [, pidStr, command] = match;
                const pid = parseInt(pidStr, 10);
                if (!isNaN(pid)) {
                    processes.push({ pid, command });
                }
            }
        }

        return processes;
    } catch (error) {
        // pgrep returns exit code 1 when no processes are found
        // This is not an error condition
        if (error instanceof Error && "code" in error && error.code === 1) {
            return [];
        }
        throw error;
    }
}

/**
 * Check if a process with the given PID is still running
 *
 * @param pid - Process ID to check
 * @returns True if the process is running, false otherwise
 */
export async function isProcessRunning(pid: number): Promise<boolean> {
    try {
        // Sending signal 0 to a process checks if it exists without actually sending a signal
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/**
 * Wait for a process to terminate, with timeout and polling
 *
 * @param pid - Process ID to wait for
 * @param timeoutMs - Maximum time to wait in milliseconds
 * @param pollIntervalMs - Interval between checks in milliseconds
 * @returns True if process terminated, false if timeout occurred
 */
export async function waitForProcessTermination(
    pid: number,
    timeoutMs: number = BackendRestartConfig.TERMINATION_TIMEOUT_MS,
    pollIntervalMs: number = BackendRestartConfig.TERMINATION_POLL_INTERVAL_MS
): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
        const running = await isProcessRunning(pid);
        if (!running) {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    return false;
}

/**
 * Gracefully terminate a list of processes by their PIDs
 * First sends SIGTERM, then waits for termination with timeout
 *
 * @param pids - Array of process IDs to terminate
 * @returns Array of PIDs that were successfully terminated
 */
export async function terminateProcesses(pids: number[]): Promise<number[]> {
    if (pids.length === 0) {
        return [];
    }

    const terminated: number[] = [];

    for (const pid of pids) {
        try {
            logger.info(`Sending SIGTERM to process ${pid}`);
            process.kill(pid, "SIGTERM");

            // Wait for the process to terminate gracefully
            const didTerminate = await waitForProcessTermination(pid);

            if (didTerminate) {
                logger.info(`Process ${pid} terminated gracefully`);
                terminated.push(pid);
            } else {
                logger.warn(`Process ${pid} did not terminate within timeout, sending SIGKILL`);
                try {
                    process.kill(pid, "SIGKILL");
                    // Wait briefly and check if process was killed
                    await new Promise((resolve) => setTimeout(resolve, 100));
                    const stillRunning = await isProcessRunning(pid);
                    if (!stillRunning) {
                        terminated.push(pid);
                    }
                } catch (killError) {
                    // Process may have already terminated, check status
                    const stillRunning = await isProcessRunning(pid);
                    if (!stillRunning) {
                        terminated.push(pid);
                    } else {
                        logger.error(`Failed to kill process ${pid}`, { error: killError });
                    }
                }
            }
        } catch (error) {
            // Process may have already terminated
            const running = await isProcessRunning(pid);
            if (!running) {
                logger.info(`Process ${pid} already terminated`);
                terminated.push(pid);
            } else {
                logger.error(`Failed to terminate process ${pid}`, { error });
            }
        }
    }

    return terminated;
}

/**
 * Spawn a new detached background process
 *
 * @param command - Command to execute
 * @param args - Command arguments
 * @param cwd - Working directory
 * @param logFilePath - Path to redirect stdout/stderr
 * @returns Spawned process object
 * @throws Error if spawning fails
 */
export async function spawnBackgroundProcess(
    command: string,
    args: string[],
    cwd: string,
    logFilePath: string
): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
        try {
            const child = spawn(command, args, {
                cwd,
                detached: true,
                stdio: ["ignore", "pipe", "pipe"],
                env: {
                    ...process.env,
                    PATH: process.env.PATH,
                    HOME: process.env.HOME,
                },
            });

            // Redirect output to log file
            const fs = require("node:fs");
            const logStream = fs.createWriteStream(logFilePath, { flags: "a" });

            if (child.stdout) {
                child.stdout.pipe(logStream);
            }
            if (child.stderr) {
                child.stderr.pipe(logStream);
            }

            // Detach the process so it continues running after parent exits
            child.unref();

            // Handle spawn errors
            child.on("error", (error) => {
                reject(new Error(`Failed to spawn process: ${error.message}`));
            });

            // Wait a moment to ensure the process started successfully
            setTimeout(() => {
                if (child.pid) {
                    resolve(child);
                } else {
                    reject(new Error("Process spawned but PID is undefined"));
                }
            }, 100);
        } catch (error) {
            reject(error);
        }
    });
}

/**
 * Core implementation of TENEX backend restart
 * Orchestrates the process of finding, stopping, and starting the backend
 */
async function executeRestartTenexBackend(
    _input: RestartTenexBackendInput,
    context: ExecutionContext
): Promise<RestartTenexBackendOutput> {
    const workingDir = context.workingDirectory;

    logger.info("Restarting TENEX backend", {
        cwd: workingDir,
        agent: context.agent.name,
    });

    try {
        // Step 1: Find running backend processes
        logger.info("Finding running TENEX backend processes...");
        const processes = await findProcessesByCommand(BackendRestartConfig.PROCESS_MATCH_PATTERN);
        const pids = processes.map((p) => p.pid);

        let killMessage = "";
        let killedPids: number[] = [];

        if (pids.length > 0) {
            logger.info(`Found ${pids.length} running process(es)`, { pids });

            // Step 2: Terminate existing processes
            killedPids = await terminateProcesses(pids);

            if (killedPids.length > 0) {
                killMessage = `Terminated ${killedPids.length} process(es): ${killedPids.join(", ")}`;
            } else {
                killMessage = "Failed to terminate running processes";
                logger.warn(killMessage);
            }
        } else {
            killMessage = "No running TENEX backend process found";
            logger.info(killMessage);
        }

        // Step 3: Start new backend process
        logger.info("Starting new TENEX backend process...");
        const child = await spawnBackgroundProcess(
            BackendRestartConfig.START_COMMAND,
            BackendRestartConfig.START_ARGS,
            workingDir,
            BackendRestartConfig.LOG_FILE_PATH
        );

        const newPid = child.pid!;

        logger.info("TENEX backend restarted successfully", {
            newPid,
            killedProcesses: killedPids,
        });

        return {
            success: true,
            message: `${killMessage}\nStarted new TENEX backend process with PID ${newPid}.\nLogs available at: ${BackendRestartConfig.LOG_FILE_PATH}`,
            processId: newPid,
            killedProcesses: killedPids,
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error("Failed to restart TENEX backend", {
            error: errorMessage,
            agent: context.agent.name,
        });

        return {
            success: false,
            message: `Failed to restart TENEX backend: ${errorMessage}`,
        };
    }
}

/**
 * Create an AI SDK tool for restarting the TENEX backend
 */
export function createRestartTenexBackendTool(context: ExecutionContext): AISdkTool {
    const aiTool = tool({
        description: `Restart the TENEX backend process.

This tool will:
1. Find and gracefully stop any currently running TENEX backend processes
2. Start a new TENEX backend process in the background
3. Log output to ${BackendRestartConfig.LOG_FILE_PATH}

The tool uses robust process management:
- Uses pgrep for reliable process detection
- Sends SIGTERM for graceful shutdown
- Falls back to SIGKILL if processes don't terminate
- Spawns new process using child_process.spawn for reliability
- Detaches the new process so it continues after tool completion

Use this tool to quickly apply bug fixes during alpha testing.`,

        inputSchema: restartTenexBackendSchema,

        execute: async (input: RestartTenexBackendInput) => {
            return await executeRestartTenexBackend(input, context);
        },
    });

    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: (_input: RestartTenexBackendInput) => {
            return "Restarting TENEX backend";
        },
        enumerable: false,
        configurable: true,
    });

    return aiTool as AISdkTool;
}
