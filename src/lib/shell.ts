import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * Find the full path of a command using the system's which/where command
 */
export async function which(command: string): Promise<string | null> {
    try {
        const isWindows = process.platform === "win32";
        const whichCommand = isWindows ? "where" : "which";

        const { stdout } = await execAsync(`${whichCommand} ${command}`);
        const path = stdout.trim().split("\n")[0]; // Get first result if multiple

        return path || null;
    } catch {
        return null;
    }
}
