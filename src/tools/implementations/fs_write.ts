import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { formatAnyError } from "@/lib/error-formatter";
import { tool } from "ai";
import { z } from "zod";

const writeFileSchema = z.object({
    path: z
        .string()
        .describe("The absolute path to the file to write"),
    content: z.string().describe("The content to write to the file"),
    allowOutsideWorkingDirectory: z
        .boolean()
        .optional()
        .describe("Set to true to write files outside the working directory. Required when path is not within the project."),
});

/**
 * Core implementation of the write_file functionality
 */
async function executeWriteFile(
    path: string,
    content: string,
    workingDirectory: string,
    allowOutsideWorkingDirectory?: boolean,
): Promise<string> {
    if (!path.startsWith("/")) {
        throw new Error(`Path must be absolute, got: ${path}`);
    }

    // Check if path is outside working directory
    const normalizedPath = path.endsWith("/") ? path.slice(0, -1) : path;
    const normalizedWorkingDir = workingDirectory.endsWith("/") ? workingDirectory.slice(0, -1) : workingDirectory;
    const isOutside = !normalizedPath.startsWith(normalizedWorkingDir + "/") && normalizedPath !== normalizedWorkingDir;

    if (isOutside && !allowOutsideWorkingDirectory) {
        return `Path "${path}" is outside your working directory "${workingDirectory}". If this was intentional, retry with allowOutsideWorkingDirectory: true`;
    }

    // Create parent directories if they don't exist
    const parentDir = dirname(path);
    await mkdir(parentDir, { recursive: true });

    // Write the file
    await writeFile(path, content, "utf-8");

    return `Successfully wrote ${content.length} bytes to ${path}`;
}

/**
 * Create an AI SDK tool for writing files
 */
export function createFsWriteTool(context: ToolExecutionContext): AISdkTool {
    const toolInstance = tool({
        description:
            "Write content to a file in the filesystem. Creates parent directories automatically if they don't exist. Overwrites existing files. Path must be absolute. Writing outside the working directory requires allowOutsideWorkingDirectory: true.",

        inputSchema: writeFileSchema,

        execute: async ({ path, content, allowOutsideWorkingDirectory }: { path: string; content: string; allowOutsideWorkingDirectory?: boolean }) => {
            try {
                return await executeWriteFile(path, content, context.workingDirectory, allowOutsideWorkingDirectory);
            } catch (error: unknown) {
                throw new Error(`Failed to write ${path}: ${formatAnyError(error)}`);
            }
        },
    });

    Object.defineProperty(toolInstance, "getHumanReadableContent", {
        value: ({ path }: { path: string }) => {
            return `Writing ${path}`;
        },
        enumerable: false,
        configurable: true,
    });

    return toolInstance as AISdkTool;
}
