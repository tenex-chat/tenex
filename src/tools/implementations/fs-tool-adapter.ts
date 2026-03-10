import type {
    AnalyzeContentHook,
    ErrorTextResult,
    FsToolsOptions,
    LoadToolResultHook,
} from "ai-sdk-fs-tools";
import { getAgentHomeDirectory } from "@/lib/agent-home";
import { getLocalReportStore } from "@/services/reports";
import type { ToolExecutionContext } from "@/tools/types";

const DEFAULT_DESCRIPTION = "filesystem operation";

function dedupePaths(paths: Array<string | undefined>): string[] {
    return Array.from(
        new Set(
            paths.filter((path): path is string => typeof path === "string" && path.trim() !== "")
        )
    );
}

export function createTenexFsToolsOptions(
    context: ToolExecutionContext,
    options: {
        agentsMd?: boolean;
        analyzeContent?: AnalyzeContentHook;
        loadToolResult?: LoadToolResultHook;
    } = {}
): FsToolsOptions {
    return {
        workingDirectory: context.workingDirectory,
        allowedRoots: dedupePaths([
            context.projectBasePath,
            getAgentHomeDirectory(context.agent.pubkey),
        ]),
        agentsMd: options.agentsMd
            ? { projectRoot: context.projectBasePath ?? context.workingDirectory }
            : false,
        analyzeContent: options.analyzeContent,
        loadToolResult: options.loadToolResult,
    };
}

export function withDescription<T extends { description?: string }>(
    input: T,
    fallbackDescription: string = DEFAULT_DESCRIPTION
): T & { description: string } {
    const description = input.description?.trim();
    return {
        ...input,
        description: description && description.length > 0
            ? description
            : fallbackDescription,
    };
}

export function isErrorTextResult(value: unknown): value is ErrorTextResult {
    return Boolean(
        value &&
        typeof value === "object" &&
        "type" in value &&
        "text" in value &&
        (value as { type?: unknown }).type === "error-text" &&
        typeof (value as { text?: unknown }).text === "string"
    );
}

export function unwrapErrorTextResult(result: string | ErrorTextResult): string {
    return isErrorTextResult(result) ? result.text : result;
}

export function buildLegacyOutsideWorkingDirectoryMessage(
    path: string,
    workingDirectory: string
): string {
    return `Path "${path}" is outside your working directory "${workingDirectory}". If this was intentional, retry with allowOutsideWorkingDirectory: true`;
}

export function adaptOutsideWorkingDirectoryText(
    result: string,
    path: string,
    workingDirectory: string
): string {
    return result.includes("outside the configured roots")
        ? buildLegacyOutsideWorkingDirectoryMessage(path, workingDirectory)
        : result;
}

export function adaptOutsideWorkingDirectoryResult(
    result: string | ErrorTextResult,
    path: string,
    workingDirectory: string
): string | ErrorTextResult {
    if (
        isErrorTextResult(result) &&
        result.text.includes("outside the configured roots")
    ) {
        return buildLegacyOutsideWorkingDirectoryMessage(path, workingDirectory);
    }

    return result;
}

export function assertAbsolutePath(path: string): void {
    if (!path.startsWith("/")) {
        throw new Error(`Path must be absolute, got: ${path}`);
    }
}

export function formatRelativePathMessage(path: string): string {
    return `Path must be absolute, got: ${path}`;
}

export function buildProtectedReportsWriteMessage(path: string): string {
    return (
        "Cannot write to reports directory directly. " +
        `Path "${path}" is within the protected reports directory. ` +
        "Use the report_write tool instead to create or update reports."
    );
}

export function assertWritableOutsideReports(path: string): void {
    const localReportStore = getLocalReportStore();
    if (localReportStore.isPathInReportsDir(path)) {
        throw new Error(buildProtectedReportsWriteMessage(path));
    }
}

export function createProtectedReportsWriteError(path: string): ErrorTextResult {
    return {
        type: "error-text",
        text: buildProtectedReportsWriteMessage(path),
    };
}

export function isPathInReportsDirSafe(path: string): boolean {
    try {
        return getLocalReportStore().isPathInReportsDir(path);
    } catch {
        return false;
    }
}

const MAX_GREP_OUTPUT_BYTES = 50_000;

function truncateUtf8(text: string, maxBytes: number): string {
    const buffer = Buffer.from(text, "utf8");
    if (buffer.length <= maxBytes) {
        return text;
    }

    return buffer.subarray(0, maxBytes).toString("utf8");
}

export function normalizeGrepFallbackOutput(result: string): string {
    const normalized = result
        .replace(
            /Content output would exceed 50000 bytes \(actual: \d+\)\.\nShowing matching files instead \(\d+ total\):\n\n/,
            "Content output would exceed 50KB limit.\nReturning matching files instead:\n\n"
        )
        .replace(
            /Content output exceeded the command buffer\.\nShowing matching files instead \(\d+ total\):\n\n/,
            "Content output would exceed 50KB limit.\nReturning matching files instead:\n\n"
        );

    return truncateUtf8(normalized, MAX_GREP_OUTPUT_BYTES);
}
