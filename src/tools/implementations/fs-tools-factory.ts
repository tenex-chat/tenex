import { createFsTools } from "ai-sdk-fs-tools";
import { homedir } from "node:os";
import { getAgentHomeDirectory, ensureAgentHomeDirectory } from "@/lib/agent-home";
import { attachTranscriptArgs } from "@/tools/utils/transcript-args";
import { synthesizeContent, executeReadToolResult } from "./fs-hooks";
import type { AISdkTool, ToolExecutionContext } from "@/tools/types";

function buildPathVars(context: ToolExecutionContext): Record<string, string> {
    const vars: Record<string, string> = {
        '$USER_HOME': homedir(),
        '$AGENT_HOME': getAgentHomeDirectory(context.agent.pubkey),
    };
    if (context.projectBasePath) {
        vars['$PROJECT_BASE'] = context.projectBasePath;
    }
    return vars;
}

function expandPathVars(input: Record<string, unknown>, pathVars: Record<string, string>): void {
    if (typeof input.path === 'string') {
        for (const [varName, varValue] of Object.entries(pathVars)) {
            input.path = (input.path as string).replaceAll(varName, varValue);
        }
    }
}

const tenexFsToolsCache = new WeakMap<ToolExecutionContext, ReturnType<typeof createFsTools>>();

export function getOrCreateTenexFsTools(context: ToolExecutionContext): ReturnType<typeof createFsTools> {
    let tools = tenexFsToolsCache.get(context);
    if (!tools) {
        const allowedRoots = [context.projectBasePath, getAgentHomeDirectory(context.agent.pubkey)]
            .filter((p): p is string => typeof p === "string" && p.trim() !== "");

        const pathVars = buildPathVars(context);

        const envVarNote = "Path variables ($PROJECT_BASE, $AGENT_HOME, $USER_HOME) are expanded automatically.";

        tools = createFsTools({
            workingDirectory: context.workingDirectory,
            allowedRoots,
            beforeExecute: (_toolName, input) => expandPathVars(input, pathVars),
            agentsMd: { projectRoot: context.projectBasePath ?? context.workingDirectory, skipRoot: true },
            descriptions: {
                read: `Read a file, directory, or caller-defined tool result. File reads include line numbers, default to 250 lines, and truncate lines over 2000 characters. Paths must be absolute. ${envVarNote} Reading outside the configured roots requires allowOutsideWorkingDirectory: true.`,
                write: `Write content to a file. Creates parent directories automatically and overwrites existing files. ${envVarNote}`,
                edit: `Perform exact string replacements in a file. When replace_all is false, old_string must match exactly once. ${envVarNote}`,
                glob: `Fast glob-based file search. Returns matching file paths relative to workingDirectory in glob traversal order. ${envVarNote}`,
                grep: `Search file contents with ripgrep, with grep as a fallback. Supports content, file-list, and count modes. ${envVarNote}`,
            },
            formatOutsideRootsError: (path, wd) =>
                `Path "${path}" is outside your working directory "${wd}". If this was intentional, retry with allowOutsideWorkingDirectory: true`,
            analyzeContent: ({ content, prompt, source }) => synthesizeContent(content, prompt, source),
            loadToolResult: (toolCallId) =>
                executeReadToolResult(context.conversationId, toolCallId),
        });

        attachTranscriptArgs(tools.fs_read as AISdkTool, [{ key: "path", attribute: "file_path" }]);
        attachTranscriptArgs(tools.fs_write as AISdkTool, [{ key: "path", attribute: "file_path" }]);

        tenexFsToolsCache.set(context, tools);
    }
    return tools;
}

const homeFsToolsCache = new WeakMap<ToolExecutionContext, ReturnType<typeof createFsTools>>();

export function getOrCreateHomeFsTools(context: ToolExecutionContext): ReturnType<typeof createFsTools> {
    let tools = homeFsToolsCache.get(context);
    if (!tools) {
        const homeDir = getAgentHomeDirectory(context.agent.pubkey);
        ensureAgentHomeDirectory(context.agent.pubkey);
        tools = createFsTools({
            workingDirectory: homeDir,
            namePrefix: "home_fs",
            strictContainment: true,
            agentsMd: false,
            descriptions: {
                read: "Read a file or directory listing from your home directory. Returns contents with line numbers. Use offset/limit to paginate large files.",
                write: "Write content to a file in your home directory. Creates parent directories automatically. Overwrites existing files.",
                edit: "Edit a file in your home directory by replacing a specific string with a new string.",
                glob: "Find files by glob pattern within your home directory.",
                grep: "Search for patterns in files within your home directory. Uses ripgrep. Supports regex patterns.",
            },
            formatOutsideRootsError: (path) =>
                `Path "${path}" is outside your home directory. You can only access files within your home directory.`,
        });
        homeFsToolsCache.set(context, tools);
    }
    return tools;
}
