import { createFsGlobTool as createPortableFsGlobTool, type FsGlobInput } from "ai-sdk-fs-tools";
import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import {
    adaptOutsideWorkingDirectoryText,
    createTenexFsToolsOptions,
    formatRelativePathMessage,
    unwrapErrorTextResult,
    withDescription,
} from "./fs-tool-adapter";

export function createFsGlobTool(context: ToolExecutionContext): AISdkTool {
    const portableTool = createPortableFsGlobTool(
        createTenexFsToolsOptions(context)
    );
    const executeBase = portableTool.execute.bind(portableTool);
    const toolInstance = portableTool as unknown as AISdkTool<FsGlobInput>;

    Object.defineProperty(toolInstance, "execute", {
        value: async (input: FsGlobInput) => {
            if (input.path && !input.path.startsWith("/")) {
                return formatRelativePathMessage(input.path);
            }

            const result = unwrapErrorTextResult(await executeBase(withDescription(input)));
            return input.path
                ? adaptOutsideWorkingDirectoryText(result, input.path, context.workingDirectory)
                : result;
        },
        enumerable: true,
        configurable: true,
        writable: true,
    });

    return toolInstance as AISdkTool;
}
