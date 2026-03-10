import {
    createFsWriteTool as createPortableFsWriteTool,
    type FsWriteInput,
} from "ai-sdk-fs-tools";
import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { attachTranscriptArgs } from "@/tools/utils/transcript-args";
import {
    adaptOutsideWorkingDirectoryResult,
    assertAbsolutePath,
    assertWritableOutsideReports,
    createTenexFsToolsOptions,
    withDescription,
} from "./fs-tool-adapter";

/**
 * Create an AI SDK tool for writing files
 */
export function createFsWriteTool(context: ToolExecutionContext): AISdkTool {
    const portableTool = createPortableFsWriteTool(
        createTenexFsToolsOptions(context)
    );
    const executeBase = portableTool.execute.bind(portableTool);
    const toolInstance = portableTool as unknown as AISdkTool<FsWriteInput>;

    Object.defineProperty(toolInstance, "execute", {
        value: async (input: FsWriteInput) => {
            assertAbsolutePath(input.path);
            assertWritableOutsideReports(input.path);

            const result = await executeBase(withDescription(input));
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

    Object.defineProperty(toolInstance, "getHumanReadableContent", {
        value: ({ path, description }: FsWriteInput) => {
            return `Writing ${path} (${description ?? "no description"})`;
        },
        enumerable: false,
        configurable: true,
    });

    attachTranscriptArgs(toolInstance as AISdkTool, [{ key: "path", attribute: "file_path" }]);
    return toolInstance as AISdkTool;
}
