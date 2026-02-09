import { readFile, writeFile } from "node:fs/promises";
import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { isPathWithinDirectory, isWithinAgentHome } from "@/lib/agent-home";
import { formatAnyError } from "@/lib/error-formatter";
import {
    createExpectedError,
    type ExpectedErrorResult,
    getFsErrorDescription,
    isExpectedFsError,
} from "@/tools/utils";
import { tool } from "ai";
import { z } from "zod";

const editSchema = z.object({
    path: z
        .string()
        .describe("The absolute path to the file to edit"),
    old_string: z.string().describe("The exact text to replace"),
    new_string: z.string().describe("The text to replace it with (must be different from old_string)"),
    replace_all: z
        .boolean()
        .optional()
        .default(false)
        .describe("Replace all occurrences of old_string (default false)"),
    allowOutsideWorkingDirectory: z
        .boolean()
        .optional()
        .describe("Set to true to edit files outside the working directory. Required when path is not within the project."),
});

/**
 * Core implementation of the edit functionality
 */
async function executeEdit(
    path: string,
    oldString: string,
    newString: string,
    replaceAll: boolean,
    workingDirectory: string,
    agentPubkey: string,
    allowOutsideWorkingDirectory?: boolean,
): Promise<string | ExpectedErrorResult> {
    if (!path.startsWith("/")) {
        throw new Error(`Path must be absolute, got: ${path}`);
    }

    // Check if path is within working directory (using secure path normalization)
    const isWithinWorkDir = isPathWithinDirectory(path, workingDirectory);

    // Always allow access to agent's home directory without requiring allowOutsideWorkingDirectory
    const isInAgentHome = isWithinAgentHome(path, agentPubkey);

    if (!isWithinWorkDir && !isInAgentHome && !allowOutsideWorkingDirectory) {
        return `Path "${path}" is outside your working directory "${workingDirectory}". If this was intentional, retry with allowOutsideWorkingDirectory: true`;
    }

    // Read the file
    const content = await readFile(path, "utf-8");

    // Check if old_string exists - return as expected error since this is user input validation
    if (!content.includes(oldString)) {
        return createExpectedError(
            `old_string not found in ${path}. Make sure you're using the exact string from the file.`
        );
    }

    let newContent: string;
    let replacementCount: number;

    if (replaceAll) {
        // Replace all occurrences
        const regex = new RegExp(oldString.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
        newContent = content.replace(regex, newString);
        replacementCount = (content.match(regex) || []).length;
    } else {
        // Check for uniqueness
        const firstIndex = content.indexOf(oldString);
        const lastIndex = content.lastIndexOf(oldString);

        // Multiple matches - return as expected error since this is user input validation
        if (firstIndex !== lastIndex) {
            return createExpectedError(
                `old_string appears multiple times in ${path}. Either provide a larger string with more surrounding context to make it unique or use replace_all to change every instance.`
            );
        }

        // Replace single occurrence
        newContent = content.replace(oldString, newString);
        replacementCount = 1;
    }

    // Write the file
    await writeFile(path, newContent, "utf-8");

    return `Successfully replaced ${replacementCount} occurrence(s) in ${path}`;
}

/**
 * Create an AI SDK tool for editing files
 */
export function createFsEditTool(context: ToolExecutionContext): AISdkTool {
    const toolInstance = tool({
        description:
            "Performs exact string replacements in files. The edit will FAIL if old_string is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use replace_all to change every instance of old_string. Path must be absolute. Editing outside the working directory requires allowOutsideWorkingDirectory: true.",

        inputSchema: editSchema,

        execute: async ({
            path,
            old_string,
            new_string,
            replace_all = false,
            allowOutsideWorkingDirectory,
        }: {
            path: string;
            old_string: string;
            new_string: string;
            replace_all?: boolean;
            allowOutsideWorkingDirectory?: boolean;
        }) => {
            try {
                // Validate input - same strings is an expected user error
                if (old_string === new_string) {
                    return createExpectedError("old_string and new_string must be different");
                }

                const result = await executeEdit(path, old_string, new_string, replace_all, context.workingDirectory, context.agent.pubkey, allowOutsideWorkingDirectory);
                // executeEdit may return an ExpectedErrorResult for validation errors
                return result;
            } catch (error: unknown) {
                // Expected errors (file not found, permission denied, etc.) return error-text
                // This ensures the error is properly communicated to the LLM without stream failures
                if (isExpectedFsError(error)) {
                    const code = (error as NodeJS.ErrnoException).code;
                    const description = getFsErrorDescription(code);
                    return createExpectedError(`${description}: ${path}`);
                }

                // Unexpected errors still throw (they'll be caught by the SDK)
                throw new Error(`Failed to edit ${path}: ${formatAnyError(error)}`, { cause: error });
            }
        },
    });

    Object.defineProperty(toolInstance, "getHumanReadableContent", {
        value: ({ path }: { path: string }) => {
            return `Editing ${path}`;
        },
        enumerable: false,
        configurable: true,
    });

    return toolInstance as AISdkTool;
}
