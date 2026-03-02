import type { AISdkTool, ToolTranscriptArgSpec } from "@/tools/types";

export function attachTranscriptArgs<TInput = unknown, TOutput = unknown>(
    tool: AISdkTool<TInput, TOutput>,
    args: ToolTranscriptArgSpec[]
): AISdkTool<TInput, TOutput> {
    Object.defineProperty(tool, "transcriptArgsToInclude", {
        value: args,
        enumerable: false,
        configurable: true,
    });
    return tool;
}
