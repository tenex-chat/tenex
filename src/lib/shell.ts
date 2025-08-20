import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * Platform-specific command for finding executables
 */
const getWhichCommand = (): string => {
  return process.platform === "win32" ? "where" : "which";
};

/**
 * Find the full path of a command using the system's which/where command
 * @param command - The command name to find
 * @returns The full path to the command, or null if not found
 * @throws Error if command parameter is invalid
 */
export async function which(command: string): Promise<string | null> {
  // Input validation
  if (!command || typeof command !== "string") {
    throw new Error("Invalid command parameter: must be a non-empty string");
  }

  const sanitizedCommand = command.trim();
  if (!sanitizedCommand) {
    throw new Error("Command cannot be empty or whitespace");
  }

  try {
    const whichCommand = getWhichCommand();
    const { stdout } = await execAsync(`${whichCommand} ${sanitizedCommand}`);

    if (!stdout) {
      return null;
    }

    // Get first result if multiple paths are returned
    const path = stdout.trim().split("\n")[0]?.trim();

    return path || null;
  } catch {
    // Command not found or execution error
    return null;
  }
}
