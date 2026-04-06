/**
 * Report Publish Tool
 *
 * Publishes one or more NIP-23 Long-form Article events (kind 30023) to Nostr,
 * signed by the invoking agent's own keys. Supports two input modes:
 *
 * - Single file: publishes one article with d-tag = bare filename
 * - Directory: recursively publishes all files, with d-tag = relative path
 *
 * Each event carries an `a` tag referencing the kind:31933 project the agent belongs to.
 */

import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { getNDK } from "@/nostr/ndkClient";
import { NDKKind } from "@/nostr/kinds";
import { logger } from "@/utils/logger";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { tool } from "ai";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";

const reportPublishSchema = z.object({
    path: z
        .string()
        .describe(
            "Absolute or project-relative path to a markdown file or directory. " +
            "If a file: publishes a single article. " +
            "If a directory: recursively publishes all files within it."
        ),
});

type ReportPublishInput = z.infer<typeof reportPublishSchema>;

interface PublishedArticle {
    file: string;
    eventId: string;
    dTag: string;
    documentTag: string;
}

interface ReportPublishOutput {
    success: boolean;
    published: PublishedArticle[];
    message: string;
}

/**
 * Collect all files recursively from a directory.
 * Returns paths relative to the given base directory.
 */
function collectFiles(dirPath: string): string[] {
    const results: string[] = [];

    function walk(current: string, base: string): void {
        const entries = fs.readdirSync(current, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath, base);
            } else {
                results.push(path.relative(base, fullPath));
            }
        }
    }

    walk(dirPath, dirPath);
    return results.sort();
}

/**
 * Resolve the input path to an absolute path.
 * If the path is relative, resolve it against the project working directory.
 */
function resolveInputPath(inputPath: string, workingDirectory: string): string {
    if (path.isAbsolute(inputPath)) {
        return inputPath;
    }
    return path.resolve(workingDirectory, inputPath);
}

async function executeReportPublish(
    input: ReportPublishInput,
    context: ToolExecutionContext
): Promise<ReportPublishOutput> {
    const resolvedPath = resolveInputPath(input.path, context.workingDirectory);

    if (!fs.existsSync(resolvedPath)) {
        throw new Error(`Path does not exist: ${resolvedPath}`);
    }

    const stat = fs.statSync(resolvedPath);
    const isDirectory = stat.isDirectory();

    // Gather the list of (absoluteFilePath, dTag, documentTag) tuples
    const filesToPublish: Array<{ absolutePath: string; dTag: string; documentTag: string }> = [];

    if (isDirectory) {
        const dirName = path.basename(resolvedPath);
        const relativeFiles = collectFiles(resolvedPath);

        for (const relFile of relativeFiles) {
            filesToPublish.push({
                absolutePath: path.join(resolvedPath, relFile),
                dTag: `${dirName}/${relFile}`,
                documentTag: dirName,
            });
        }
    } else {
        const filename = path.basename(resolvedPath);
        const filenameWithoutExt = filename.replace(/\.[^.]+$/, "");
        filesToPublish.push({
            absolutePath: resolvedPath,
            dTag: filename,
            documentTag: filenameWithoutExt,
        });
    }

    if (filesToPublish.length === 0) {
        throw new Error(`No files found at: ${resolvedPath}`);
    }

    // Resolve project a-tag reference: 31933:<ownerPubkey>:<dTag>
    const project = context.projectContext.project;
    const projectOwnerPubkey = project.pubkey;
    const projectDTag = project.dTag ?? project.tagValue("d") ?? "";
    const aTagValue = `31933:${projectOwnerPubkey}:${projectDTag}`;

    const ndk = getNDK();
    const published: PublishedArticle[] = [];

    for (const fileEntry of filesToPublish) {
        const content = fs.readFileSync(fileEntry.absolutePath, "utf-8");

        const event = new NDKEvent(ndk);
        event.kind = NDKKind.LongFormArticle;
        event.content = content;
        event.tags = [
            ["d", fileEntry.dTag],
            ["document", fileEntry.documentTag],
            ["a", aTagValue],
        ];

        logger.info("[report_publish] Publishing long-form article", {
            agentName: context.agent.name,
            file: fileEntry.absolutePath,
            dTag: fileEntry.dTag,
            documentTag: fileEntry.documentTag,
        });

        await context.agent.sign(event);
        await event.publish();

        published.push({
            file: fileEntry.absolutePath,
            eventId: event.id ?? "",
            dTag: fileEntry.dTag,
            documentTag: fileEntry.documentTag,
        });
    }

    const message =
        published.length === 1
            ? `Published 1 article: ${published[0].dTag}`
            : `Published ${published.length} articles from ${path.basename(resolvedPath)}`;

    return {
        success: true,
        published,
        message,
    };
}

export function createReportPublishTool(context: ToolExecutionContext): AISdkTool {
    const aiTool = tool({
        description:
            "Publish one or more NIP-23 Long-form Articles (kind 30023) to Nostr, signed by this agent. " +
            "Accepts a path to a single markdown file or a directory. " +
            "For a single file, publishes one article with the filename as its identifier. " +
            "For a directory, recursively publishes all files within it, each identified by its relative path.",
        inputSchema: reportPublishSchema,
        execute: async (input: ReportPublishInput) => {
            return await executeReportPublish(input, context);
        },
    });

    return aiTool as AISdkTool;
}
