import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { createFsTools } from "ai-sdk-fs-tools";
import { getAgentHomeDirectory } from "@/lib/agent-home";
import { attachTranscriptArgs } from "@/tools/utils/transcript-args";
import { synthesizeContent, executeReadToolResult } from "@/tools/implementations/fs-hooks";

export function createTools(context: ToolExecutionContext): Record<string, AISdkTool> {
    const allowedRoots = [context.projectBasePath, getAgentHomeDirectory(context.agent.pubkey)]
        .filter((p): p is string => typeof p === "string" && p.trim() !== "");

    const tools = createFsTools({
        workingDirectory: context.workingDirectory,
        allowedRoots,
        agentsMd: { projectRoot: context.projectBasePath ?? context.workingDirectory, skipRoot: true },
        formatOutsideRootsError: (path, wd) =>
            `Path "${path}" is outside your working directory "${wd}". If this was intentional, retry with allowOutsideWorkingDirectory: true`,
        analyzeContent: ({ content, prompt, source }) => synthesizeContent(content, prompt, source),
        loadToolResult: (toolCallId) =>
            executeReadToolResult(context.conversationId, toolCallId),
    });

    attachTranscriptArgs(tools.fs_read as AISdkTool, [{ key: "path", attribute: "file_path" }]);
    attachTranscriptArgs(tools.fs_write as AISdkTool, [{ key: "path", attribute: "file_path" }]);

    return {
        fs_read: tools.fs_read as AISdkTool,
        fs_write: tools.fs_write as AISdkTool,
        fs_edit: tools.fs_edit as AISdkTool,
        fs_glob: tools.fs_glob as AISdkTool,
        fs_grep: tools.fs_grep as AISdkTool,
    };
}
