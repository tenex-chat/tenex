import { readFile, writeFile } from "node:fs/promises";
import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { formatAnyError } from "@/lib/error-formatter";
import { tool } from "ai";
import { z } from "zod";
import { resolveAndValidatePath } from "../utils";

const editSchema = z.object({
    path: z
        .string()
        .describe("The file path to edit (absolute or relative to project root)"),
    old_string: z.string().describe("The exact text to replace"),
    new_string: z.string().describe("The text to replace it with (must be different from old_string)"),
    replace_all: z
        .boolean()
        .optional()
        .default(false)
        .describe("Replace all occurrences of old_string (default false)"),
});

/**
 * Core implementation of the edit functionality
 */
async function executeEdit(
    path: string,
    oldString: string,
    newString: string,
    replaceAll: boolean,
    context: ToolExecutionContext
): Promise<string> {
    // Resolve path and ensure it's within project
    const fullPath = resolveAndValidatePath(path, context.workingDirectory);

    // Read the file
    const content = await readFile(fullPath, "utf-8");

    // Check if old_string exists
    if (!content.includes(oldString)) {
        throw new Error(
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

        if (firstIndex !== lastIndex) {
            throw new Error(
                `old_string appears multiple times in ${path}. Either provide a larger string with more surrounding context to make it unique or use replace_all to change every instance.`
            );
        }

        // Replace single occurrence
        newContent = content.replace(oldString, newString);
        replacementCount = 1;
    }

    // Write the file
    await writeFile(fullPath, newContent, "utf-8");

    return `Successfully replaced ${replacementCount} occurrence(s) in ${path}`;
}

/**
 * Create an AI SDK tool for editing files
 */
export function createFsEditTool(context: ToolExecutionContext): AISdkTool {
    const toolInstance = tool({
        description:
            "Performs exact string replacements in files. The edit will FAIL if old_string is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use replace_all to change every instance of old_string. Use replace_all for replacing and renaming strings across the file. This is useful for surgical edits without full file rewrites. Safe and sandboxed to project directory.",

        inputSchema: editSchema,

        execute: async ({
            path,
            old_string,
            new_string,
            replace_all = false,
        }: {
            path: string;
            old_string: string;
            new_string: string;
            replace_all?: boolean;
        }) => {
            try {
                if (old_string === new_string) {
                    throw new Error("old_string and new_string must be different");
                }

                return await executeEdit(path, old_string, new_string, replace_all, context);
            } catch (error: unknown) {
                throw new Error(`Failed to edit ${path}: ${formatAnyError(error)}`);
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
