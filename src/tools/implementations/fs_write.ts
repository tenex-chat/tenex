import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { isPathWithinDirectory, isWithinAgentHome } from "@/lib/agent-home";
import { formatAnyError } from "@/lib/error-formatter";
import { getLocalReportStore } from "@/services/reports";
import {
    createExpectedError,
    getFsErrorDescription,
    isExpectedFsError,
} from "@/tools/utils";
import { tool } from "ai";
import { z } from "zod";

const writeFileSchema = z.object({
    path: z
        .string()
        .describe("The absolute path to the file to write"),
    content: z.string().describe("The content to write to the file"),
    description: z
        .string()
        .min(1, "Description is required and cannot be empty")
        .describe(
            "REQUIRED: A clear, concise description of why you're writing this file (5-10 words). Helps provide human-readable context for the operation."
        ),
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
    agentPubkey: string,
    allowOutsideWorkingDirectory?: boolean,
): Promise<string> {
    if (!path.startsWith("/")) {
        throw new Error(`Path must be absolute, got: ${path}`);
    }

    // Block writes to the reports directory - agents must use report_write instead
    const localReportStore = getLocalReportStore();
    if (localReportStore.isPathInReportsDir(path)) {
        throw new Error(
            "Cannot write to reports directory directly. " +
            `Path "${path}" is within the protected reports directory. ` +
            "Use the report_write tool instead to create or update reports."
        );
    }

    // Check if path is within working directory (using secure path normalization)
    const isWithinWorkDir = isPathWithinDirectory(path, workingDirectory);

    // Always allow access to agent's home directory without requiring allowOutsideWorkingDirectory
    const isInAgentHome = isWithinAgentHome(path, agentPubkey);

    if (!isWithinWorkDir && !isInAgentHome && !allowOutsideWorkingDirectory) {
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

        execute: async ({ path, content, description: _description, allowOutsideWorkingDirectory }: { path: string; content: string; description: string; allowOutsideWorkingDirectory?: boolean }) => {
            try {
                return await executeWriteFile(path, content, context.workingDirectory, context.agent.pubkey, allowOutsideWorkingDirectory);
            } catch (error: unknown) {
                // Expected errors (permission denied, etc.) return error-text
                // This ensures the error is properly communicated to the LLM without stream failures
                if (isExpectedFsError(error)) {
                    const code = (error as NodeJS.ErrnoException).code;
                    const description = getFsErrorDescription(code);
                    return createExpectedError(`${description}: ${path}`);
                }

                // Unexpected errors still throw (they'll be caught by the SDK)
                throw new Error(`Failed to write ${path}: ${formatAnyError(error)}`, { cause: error });
            }
        },
    });

    Object.defineProperty(toolInstance, "getHumanReadableContent", {
        value: ({ path, description }: { path: string; description: string }) => {
            return `Writing ${path} (${description})`;
        },
        enumerable: false,
        configurable: true,
    });

    return toolInstance as AISdkTool;
}
