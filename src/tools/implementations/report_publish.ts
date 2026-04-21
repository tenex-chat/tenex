import { tool } from "ai";
import { z } from "zod";
import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { NDKKind } from "@/nostr/kinds";
import { getNDK } from "@/nostr/ndkClient";
import * as fs from "node:fs";
import * as path from "node:path";

interface FileEntry {
    absolutePath: string;
    dTag: string;
    documentTag: string;
}

function assertContained(realFilePath: string, allowedRoot: string): void {
    if (realFilePath !== allowedRoot && !realFilePath.startsWith(allowedRoot + path.sep)) {
        throw new Error(`Access denied: path is outside the project directory`);
    }
}

function collectFiles(inputPath: string, allowedRoot: string): FileEntry[] {
    let realPath: string;
    try {
        realPath = fs.realpathSync(inputPath);
    } catch {
        throw new Error(`path does not exist: ${inputPath}`);
    }

    assertContained(realPath, allowedRoot);

    const stat = fs.statSync(realPath);
    if (!stat.isDirectory()) {
        const filename = path.basename(realPath);
        return [
            {
                absolutePath: realPath,
                dTag: filename,
                documentTag: filename.replace(/\.[^.]+$/, ""),
            },
        ];
    }

    const dirName = path.basename(realPath);
    const files: FileEntry[] = [];

    function walk(current: string, base: string): void {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch (err) {
            throw new Error(`Cannot read directory: ${current}`);
        }
        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            let realEntry: string;
            try {
                realEntry = fs.realpathSync(fullPath);
            } catch {
                continue;
            }
            assertContained(realEntry, allowedRoot);
            if (entry.isDirectory()) {
                walk(fullPath, base);
            } else {
                files.push({
                    absolutePath: realEntry,
                    dTag: `${dirName}/${path.relative(base, realEntry)}`,
                    documentTag: dirName,
                });
            }
        }
    }

    walk(realPath, realPath);
    return files.sort((a, b) => a.dTag.localeCompare(b.dTag));
}

const reportPublishSchema = z.object({
    path: z
        .string()
        .trim()
        .min(1)
        .describe(
            "Absolute or project-relative path to a single markdown file or directory. " +
                "If a directory, all files inside are published recursively."
        ),
});

export function createReportPublishTool(context: ToolExecutionContext): AISdkTool {
    const aiTool = tool({
        description:
            "Publish markdown files as NIP-23 long-form articles (kind 30023) to Nostr, " +
            "signed with this agent's keys. Accepts a single file or a directory (recursive).",

        inputSchema: reportPublishSchema,

        execute: async ({ path: inputPath }) => {
            const projectDTag =
                context.projectContext.project.dTag ||
                context.projectContext.project.tagValue("d");
            const projectPubkey = context.projectContext.project.pubkey;
            const projectATag = projectDTag ? `31933:${projectPubkey}:${projectDTag}` : undefined;

            let allowedRoot: string;
            try {
                allowedRoot = fs.realpathSync(context.projectBasePath);
            } catch {
                return { success: false, error: "Project base path is not accessible", published: [] };
            }

            const resolvedPath = path.isAbsolute(inputPath)
                ? inputPath
                : path.resolve(context.projectBasePath, inputPath);

            let files: FileEntry[];
            try {
                files = collectFiles(resolvedPath, allowedRoot);
            } catch (error) {
                return {
                    success: false,
                    error: error instanceof Error ? error.message : String(error),
                    published: [],
                };
            }

            if (files.length === 0) {
                return { success: false, error: `No files found at ${resolvedPath}`, published: [] };
            }

            const ndk = getNDK();
            const signer = context.agent.signer;

            const published: string[] = [];

            try {
                for (const file of files) {
                    const content = fs.readFileSync(file.absolutePath, "utf-8");

                    const event = new NDKEvent(ndk);
                    event.kind = NDKKind.LongFormArticle;
                    event.content = content;
                    event.tags = [
                        ["d", file.dTag],
                        ["document", file.documentTag],
                    ];

                    if (projectATag) {
                        event.tags.push(["a", projectATag]);
                    }

                    await event.sign(signer);
                    await event.publish();

                    published.push(file.dTag);
                }
            } catch (error) {
                return {
                    success: false,
                    error: error instanceof Error ? error.message : String(error),
                    published,
                };
            }

            const summary =
                published.length === 1
                    ? `Published 1 article: ${published[0]}`
                    : `Published ${published.length} articles`;

            return { success: true, published, summary };
        },
    });

    return aiTool as AISdkTool;
}
