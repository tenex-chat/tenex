import {
    createFsEditTool as createPortableFsEditTool,
    type FsEditInput,
} from "ai-sdk-fs-tools";
import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import {
    adaptOutsideWorkingDirectoryResult,
    assertAbsolutePath,
    createProtectedReportsWriteError,
    createTenexFsToolsOptions,
    isPathInReportsDirSafe,
    withDescription,
} from "./fs-tool-adapter";

/**
 * Create an AI SDK tool for editing files
 */
export function createFsEditTool(context: ToolExecutionContext): AISdkTool {
    const portableTool = createPortableFsEditTool(
        createTenexFsToolsOptions(context)
    );
    const executeBase = portableTool.execute.bind(portableTool);
    const toolInstance = portableTool as unknown as AISdkTool<FsEditInput>;

    Object.defineProperty(toolInstance, "execute", {
        value: async (input: FsEditInput) => {
            assertAbsolutePath(input.path);

            if (isPathInReportsDirSafe(input.path)) {
                return createProtectedReportsWriteError(input.path);
            }

            const result = await executeBase(withDescription(input));
            if (
                typeof result === "object" &&
                result &&
                "type" in result &&
                result.type === "error-text" &&
                "text" in result &&
                typeof result.text === "string" &&
                result.text.includes("old_string was not found")
            ) {
                return {
                    type: "error-text" as const,
                    text: `old_string not found in ${input.path}. Make sure you're using the exact string from the file.`,
                };
            }
            return adaptOutsideWorkingDirectoryResult(
                result,
                input.path,
                context.workingDirectory
            );
        },
        enumerable: true,
        configurable: true,
        writable: true,
    });

    return toolInstance as AISdkTool;
}
