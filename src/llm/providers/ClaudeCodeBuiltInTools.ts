/**
 * Built-in tool definitions for Claude Code.
 * These tools are always available and executed by the Claude Agent SDK.
 */

import type { LanguageModelV2FunctionTool } from "@ai-sdk/provider";
import { zodSchema } from "@ai-sdk/provider-utils";
import { z } from "zod";

/**
 * Defines all built-in Claude Code tools for AI SDK awareness.
 * These tools are provider-executed (handled by Claude Agent SDK).
 */
export function getClaudeCodeBuiltInTools(): LanguageModelV2FunctionTool[] {
    return [
        {
            type: "function" as const,
            name: "Bash",
            description: "Execute bash commands",
            inputSchema: zodSchema(
                z.object({
                    command: z.string().describe("The bash command to execute"),
                    description: z
                        .string()
                        .optional()
                        .describe("Description of what the command does"),
                    timeout: z.number().optional().describe("Timeout in milliseconds"),
                })
            ).jsonSchema,
        },

        {
            type: "function" as const,
            name: "Read",
            description: "Read file contents",
            inputSchema: zodSchema(
                z.object({
                    file_path: z.string().describe("Absolute path to the file to read"),
                    offset: z.number().optional().describe("Line number to start reading from"),
                    limit: z.number().optional().describe("Number of lines to read"),
                })
            ).jsonSchema,
        },

        {
            type: "function" as const,
            name: "Write",
            description: "Write content to a file",
            inputSchema: zodSchema(
                z.object({
                    file_path: z.string().describe("Absolute path to the file to write"),
                    content: z.string().describe("Content to write to the file"),
                })
            ).jsonSchema,
        },

        {
            type: "function" as const,
            name: "Edit",
            description: "Edit file contents by replacing text",
            inputSchema: zodSchema(
                z.object({
                    file_path: z.string().describe("Absolute path to the file to edit"),
                    old_string: z.string().describe("Text to replace"),
                    new_string: z.string().describe("Text to replace it with"),
                    replace_all: z.boolean().optional().describe("Replace all occurrences"),
                })
            ).jsonSchema,
        },

        {
            type: "function" as const,
            name: "Glob",
            description: "Find files matching a pattern",
            inputSchema: zodSchema(
                z.object({
                    pattern: z.string().describe("Glob pattern to match files"),
                    path: z.string().optional().describe("Directory to search in"),
                })
            ).jsonSchema,
        },

        {
            type: "function" as const,
            name: "Grep",
            description: "Search file contents using regex",
            inputSchema: zodSchema(
                z.object({
                    pattern: z.string().describe("Regular expression pattern to search for"),
                    path: z.string().optional().describe("File or directory to search in"),
                    glob: z.string().optional().describe("Glob pattern to filter files"),
                    type: z.string().optional().describe("File type to search"),
                    output_mode: z.enum(["content", "files_with_matches", "count"]).optional(),
                    "-i": z.boolean().optional().describe("Case insensitive search"),
                    "-n": z.boolean().optional().describe("Show line numbers"),
                    "-A": z.number().optional().describe("Lines of context after match"),
                    "-B": z.number().optional().describe("Lines of context before match"),
                    "-C": z.number().optional().describe("Lines of context around match"),
                })
            ).jsonSchema,
        },

        {
            type: "function" as const,
            name: "Task",
            description: "Launch a specialized agent for complex tasks",
            inputSchema: zodSchema(
                z.object({
                    description: z.string().describe("Short description of the task"),
                    prompt: z.string().describe("Detailed task prompt for the agent"),
                    subagent_type: z.string().describe("Type of agent to use"),
                })
            ).jsonSchema,
        },

        {
            type: "function" as const,
            name: "WebFetch",
            description: "Fetch content from a URL",
            inputSchema: zodSchema(
                z.object({
                    url: z.string().describe("URL to fetch content from"),
                    prompt: z.string().describe("What to extract from the content"),
                })
            ).jsonSchema,
        },

        {
            type: "function" as const,
            name: "WebSearch",
            description: "Search the web",
            inputSchema: zodSchema(
                z.object({
                    query: z.string().describe("Search query"),
                    allowed_domains: z.array(z.string()).optional(),
                    blocked_domains: z.array(z.string()).optional(),
                })
            ).jsonSchema,
        },

        {
            type: "function" as const,
            name: "TodoWrite",
            description: "Create and manage a task list",
            inputSchema: zodSchema(
                z.object({
                    todos: z.array(
                        z.object({
                            content: z.string(),
                            status: z.enum(["pending", "in_progress", "completed"]),
                            activeForm: z.string(),
                        })
                    ),
                })
            ).jsonSchema,
        },

        {
            type: "function" as const,
            name: "AskUserQuestion",
            description: "Ask the user questions during execution",
            inputSchema: zodSchema(
                z.object({
                    questions: z.array(
                        z.object({
                            question: z.string(),
                            header: z.string(),
                            options: z.array(
                                z.object({
                                    label: z.string(),
                                    description: z.string(),
                                })
                            ),
                            multiSelect: z.boolean(),
                        })
                    ),
                    answers: z.record(z.string(), z.string()).optional(),
                })
            ).jsonSchema,
        },

        {
            type: "function" as const,
            name: "BashOutput",
            description: "Retrieve output from a background bash shell",
            inputSchema: zodSchema(
                z.object({
                    bash_id: z.string().describe("ID of the background shell"),
                    filter: z.string().optional().describe("Regex to filter output lines"),
                })
            ).jsonSchema,
        },

        {
            type: "function" as const,
            name: "KillShell",
            description: "Kill a running background bash shell",
            inputSchema: zodSchema(
                z.object({
                    shell_id: z.string().describe("ID of the shell to kill"),
                })
            ).jsonSchema,
        },

        {
            type: "function" as const,
            name: "NotebookEdit",
            description: "Edit a Jupyter notebook cell",
            inputSchema: zodSchema(
                z.object({
                    notebook_path: z.string().describe("Path to the notebook"),
                    new_source: z.string().describe("New source for the cell"),
                    cell_id: z.string().optional(),
                    cell_type: z.enum(["code", "markdown"]).optional(),
                    edit_mode: z.enum(["replace", "insert", "delete"]).optional(),
                })
            ).jsonSchema,
        },

        {
            type: "function" as const,
            name: "Skill",
            description: "Execute a skill within the conversation",
            inputSchema: zodSchema(
                z.object({
                    command: z.string().describe("Skill name to invoke"),
                })
            ).jsonSchema,
        },

        {
            type: "function" as const,
            name: "SlashCommand",
            description: "Execute a slash command",
            inputSchema: zodSchema(
                z.object({
                    command: z.string().describe("Slash command with arguments"),
                })
            ).jsonSchema,
        },
    ] as LanguageModelV2FunctionTool[];
}
