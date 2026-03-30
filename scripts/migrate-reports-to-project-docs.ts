#!/usr/bin/env bun

import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import * as path from "node:path";
import { ConfigService } from "../src/services/ConfigService";

export interface ParsedArgs {
    project: string;
    dryRun: boolean;
    overwrite: boolean;
}

export interface MigrationConfigService {
    getProjectMetadataPath(projectId: string): string;
    getProjectsBase(): string;
    getGlobalPath(): string;
    loadTenexConfig(basePath: string): Promise<{ projectsBase?: string }>;
}

export interface MigrationSummary {
    project: string;
    dryRun: boolean;
    sourceDir: string;
    destinationDir: string;
    copied: string[];
    overwritten: string[];
    conflicted: string[];
    skipped: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
    let project: string | undefined;
    let dryRun = false;
    let overwrite = false;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];

        switch (arg) {
            case "--project":
                project = argv[++i];
                break;
            case "--dry-run":
                dryRun = true;
                break;
            case "--overwrite":
                overwrite = true;
                break;
            default:
                throw new Error(
                    `Unknown argument: ${arg}\nUsage: bun run scripts/migrate-reports-to-project-docs.ts --project <dTag> [--dry-run] [--overwrite]`
                );
        }
    }

    if (!project) {
        throw new Error(
            "Missing required argument: --project <dTag>\nUsage: bun run scripts/migrate-reports-to-project-docs.ts --project <dTag> [--dry-run] [--overwrite]"
        );
    }

    return { project, dryRun, overwrite };
}

async function resolveProjectsBase(configService: MigrationConfigService): Promise<string> {
    try {
        const config = await configService.loadTenexConfig(configService.getGlobalPath());
        if (config.projectsBase) {
            return path.resolve(config.projectsBase);
        }
    } catch {
        // Fall back to the ConfigService default when config.json is absent or unreadable.
    }

    return configService.getProjectsBase();
}

function isMarkdownFilename(filename: string): boolean {
    return filename.toLowerCase().endsWith(".md");
}

export async function migrateReportsToProjectDocs(
    args: ParsedArgs,
    configService: MigrationConfigService = new ConfigService()
): Promise<MigrationSummary> {
    const sourceDir = path.join(configService.getProjectMetadataPath(args.project), "reports");
    const projectsBase = await resolveProjectsBase(configService);
    const projectRoot = path.join(projectsBase, args.project);
    const destinationDir = path.join(projectRoot, "tenex", "docs");

    let sourceStats;
    try {
        sourceStats = await stat(sourceDir);
    } catch (error) {
        throw new Error(`Source reports directory does not exist: ${sourceDir}`, { cause: error });
    }
    if (!sourceStats.isDirectory()) {
        throw new Error(`Source reports path is not a directory: ${sourceDir}`);
    }

    let projectStats;
    try {
        projectStats = await stat(projectRoot);
    } catch (error) {
        throw new Error(`Project root directory does not exist: ${projectRoot}`, { cause: error });
    }
    if (!projectStats.isDirectory()) {
        throw new Error(`Project root path is not a directory: ${projectRoot}`);
    }

    if (!args.dryRun) {
        await mkdir(destinationDir, { recursive: true });
    }

    const summary: MigrationSummary = {
        project: args.project,
        dryRun: args.dryRun,
        sourceDir,
        destinationDir,
        copied: [],
        overwritten: [],
        conflicted: [],
        skipped: [],
    };

    const entries = await readdir(sourceDir, { withFileTypes: true });
    const sortedEntries = [...entries].sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of sortedEntries) {
        if (entry.name === ".metadata") {
            summary.skipped.push(`${entry.name}/`);
            continue;
        }

        if (!entry.isFile()) {
            summary.skipped.push(entry.name + (entry.isDirectory() ? "/" : ""));
            continue;
        }

        if (!isMarkdownFilename(entry.name)) {
            summary.skipped.push(entry.name);
            continue;
        }

        const sourceFile = path.join(sourceDir, entry.name);
        const destinationFile = path.join(destinationDir, entry.name);

        let destinationExists = false;
        try {
            const existing = await stat(destinationFile);
            destinationExists = existing.isFile();
        } catch {
            destinationExists = false;
        }

        if (destinationExists && !args.overwrite) {
            summary.conflicted.push(entry.name);
            continue;
        }

        if (!args.dryRun) {
            await mkdir(path.dirname(destinationFile), { recursive: true });
            await copyFile(sourceFile, destinationFile);
        }

        if (destinationExists) {
            summary.overwritten.push(entry.name);
        } else {
            summary.copied.push(entry.name);
        }
    }

    return summary;
}

export function formatSummary(summary: MigrationSummary): string {
    const lines = [
        `Report migration summary${summary.dryRun ? " (dry run)" : ""}`,
        `Project: ${summary.project}`,
        `Source: ${summary.sourceDir}`,
        `Destination: ${summary.destinationDir}`,
        `Copied: ${summary.copied.length}`,
        `Overwritten: ${summary.overwritten.length}`,
        `Conflicted: ${summary.conflicted.length}`,
        `Skipped: ${summary.skipped.length}`,
    ];

    if (summary.copied.length > 0) {
        lines.push(`Copied files: ${summary.copied.join(", ")}`);
    }
    if (summary.overwritten.length > 0) {
        lines.push(`Overwritten files: ${summary.overwritten.join(", ")}`);
    }
    if (summary.conflicted.length > 0) {
        lines.push(`Conflicted files: ${summary.conflicted.join(", ")}`);
    }
    if (summary.skipped.length > 0) {
        lines.push(`Skipped entries: ${summary.skipped.join(", ")}`);
    }

    return lines.join("\n");
}

async function main(): Promise<void> {
    try {
        const args = parseArgs(process.argv.slice(2));
        const summary = await migrateReportsToProjectDocs(args);
        console.log(formatSummary(summary));
    } catch (error) {
        console.error(
            error instanceof Error ? error.message : `Migration failed: ${String(error)}`
        );
        process.exit(1);
    }
}

if (import.meta.main) {
    await main();
}
