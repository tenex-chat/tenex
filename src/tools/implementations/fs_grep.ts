import { createFsGrepTool as createPortableFsGrepTool, type FsGrepInput } from "ai-sdk-fs-tools";
import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import {
    adaptOutsideWorkingDirectoryText,
    createTenexFsToolsOptions,
    formatRelativePathMessage,
    normalizeGrepFallbackOutput,
    unwrapErrorTextResult,
    withDescription,
} from "./fs-tool-adapter";

export function createFsGrepTool(context: ToolExecutionContext): AISdkTool {
    const portableTool = createPortableFsGrepTool(
        createTenexFsToolsOptions(context)
    );
    const executeBase = portableTool.execute.bind(portableTool);
    const toolInstance = portableTool as unknown as AISdkTool<FsGrepInput>;

    Object.defineProperty(toolInstance, "execute", {
        value: async (input: FsGrepInput) => {
            if (input.path && !input.path.startsWith("/")) {
                return formatRelativePathMessage(input.path);
            }

            const result = unwrapErrorTextResult(await executeBase(withDescription(input)));
            const normalizedResult = input.path
                ? adaptOutsideWorkingDirectoryText(result, input.path, context.workingDirectory)
                : result;
            return normalizeGrepFallbackOutput(normalizedResult);
        },
        enumerable: true,
        configurable: true,
        writable: true,
    });

    Object.defineProperty(toolInstance, "getHumanReadableContent", {
        value: ({ pattern, path, description }: FsGrepInput) => {
            const location = path ? ` in ${path}` : "";
            return `Searching for "${pattern}"${location} (${description ?? "no description"})`;
        },
        enumerable: false,
        configurable: true,
    });

    return toolInstance as AISdkTool;
}
