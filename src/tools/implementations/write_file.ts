import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { formatAnyError } from "@/lib/error-formatter";
import { tool } from "ai";
import { z } from "zod";
import { resolveAndValidatePath } from "../utils";

const writeFileSchema = z.object({
    path: z
        .string()
        .describe("The file path to write (absolute or relative to project root)"),
    content: z.string().describe("The content to write to the file"),
});

/**
 * Core implementation of the write_file functionality
 */
async function executeWriteFile(
    path: string,
    content: string,
    context: ToolExecutionContext
): Promise<string> {
    // Resolve path and ensure it's within project
    const fullPath = resolveAndValidatePath(path, context.workingDirectory);

    // Create parent directories if they don't exist
    const parentDir = dirname(fullPath);
    await mkdir(parentDir, { recursive: true });

    // Write the file
    await writeFile(fullPath, content, "utf-8");

    return `Successfully wrote ${content.length} bytes to ${path}`;
}

/**
 * Create an AI SDK tool for writing files
 */
export function createWriteFileTool(context: ToolExecutionContext): AISdkTool {
    const toolInstance = tool({
        description:
            "Write content to a file in the filesystem. Creates parent directories automatically if they don't exist. Overwrites existing files. Paths are relative to project root unless absolute. Safe and sandboxed to project directory.",

        inputSchema: writeFileSchema,

        execute: async ({ path, content }: { path: string; content: string }) => {
            try {
                return await executeWriteFile(path, content, context);
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
