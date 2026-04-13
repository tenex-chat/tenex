import { createFsTools } from "ai-sdk-fs-tools";
import { getAgentHomeDirectory, ensureAgentHomeDirectory } from "@/lib/agent-home";
import { createExpectedError } from "@/tools/utils";
import {
    expandPathFromContext,
    formatUnresolvedPathVariablesError,
} from "@/tools/utils/path-expansion";
import { attachTranscriptArgs } from "@/tools/utils/transcript-args";
import { synthesizeContent, executeReadToolResult } from "./fs-hooks";
import type { AISdkTool, ToolExecutionContext } from "@/tools/types";

const tenexFsToolsCache = new WeakMap<ToolExecutionContext, ReturnType<typeof createFsTools>>();

function wrapToolsWithPathExpansion(
    tools: ReturnType<typeof createFsTools>,
    context: ToolExecutionContext
): ReturnType<typeof createFsTools> {
    const wrappedTools = {} as ReturnType<typeof createFsTools>;

    for (const [toolName, tool] of Object.entries(tools)) {
        wrappedTools[toolName] = {
            ...tool,
            execute: async (input: unknown) => {
                if (
                    typeof input === "object" &&
                    input !== null &&
                    typeof (input as Record<string, unknown>).path === "string"
                ) {
                    const rawPath = (input as Record<string, unknown>).path as string;
                    const { expandedPath, unresolvedVars } = await expandPathFromContext(
                        rawPath,
                        context
                    );

                    if (unresolvedVars.length > 0) {
                        return createExpectedError(
                            formatUnresolvedPathVariablesError(rawPath, unresolvedVars)
                        );
                    }

                    return await tool.execute({
                        ...(input as Record<string, unknown>),
                        path: expandedPath,
                    });
                }

                return await tool.execute(input as never);
            },
        };
    }

    return wrappedTools;
}

export function getOrCreateTenexFsTools(context: ToolExecutionContext): ReturnType<typeof createFsTools> {
    let tools = tenexFsToolsCache.get(context);
    if (!tools) {
        const allowedRoots = [context.projectBasePath, getAgentHomeDirectory(context.agent.pubkey)]
            .filter((p): p is string => typeof p === "string" && p.trim() !== "");

        tools = createFsTools({
            workingDirectory: context.workingDirectory,
            allowedRoots,
            agentsMd: { projectRoot: context.projectBasePath ?? context.workingDirectory, skipRoot: true },
            formatOutsideRootsError: (path, wd) =>
                `Path "${path}" is outside your working directory "${wd}". If this was intentional, retry with allowOutsideWorkingDirectory: true`,
            analyzeContent: ({ content, prompt, source }) => synthesizeContent(content, prompt, source),
            loadToolResult: (toolCallId) =>
                executeReadToolResult(context.conversationId, toolCallId),
        });
        tools = wrapToolsWithPathExpansion(tools, context);

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
        tools = wrapToolsWithPathExpansion(tools, context);
        homeFsToolsCache.set(context, tools);
    }
    return tools;
}
