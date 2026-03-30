import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
    formatSummary,
    migrateReportsToProjectDocs,
    parseArgs,
    type MigrationConfigService,
} from "../migrate-reports-to-project-docs";

describe("migrate-reports-to-project-docs", () => {
    let tempDir: string;
    let sourceReportsDir: string;
    let projectRoot: string;
    let configService: MigrationConfigService;

    beforeEach(async () => {
        tempDir = await mkdtemp(path.join(tmpdir(), "tenex-migrate-reports-"));
        sourceReportsDir = path.join(tempDir, ".tenex", "projects", "acme-app", "reports");
        projectRoot = path.join(tempDir, "workspace", "acme-app");

        await mkdir(sourceReportsDir, { recursive: true });
        await mkdir(projectRoot, { recursive: true });

        configService = {
            getProjectMetadataPath: (projectId) =>
                path.join(tempDir, ".tenex", "projects", projectId),
            getProjectsBase: () => path.join(tempDir, "workspace"),
            getGlobalPath: () => path.join(tempDir, ".tenex"),
            loadTenexConfig: async () => ({
                projectsBase: path.join(tempDir, "workspace"),
            }),
        };
    });

    afterEach(async () => {
        await Bun.$`rm -rf ${tempDir}`.quiet();
    });

    it("requires --project", () => {
        expect(() => parseArgs([])).toThrow("Missing required argument");
    });

    it("parses dry-run and overwrite flags", () => {
        expect(parseArgs(["--project", "acme-app", "--dry-run", "--overwrite"])).toEqual({
            project: "acme-app",
            dryRun: true,
            overwrite: true,
        });
    });

    it("copies markdown reports into tenex/docs", async () => {
        await writeFile(path.join(sourceReportsDir, "alpha.md"), "# alpha");
        await writeFile(path.join(sourceReportsDir, "beta.md"), "# beta");

        const summary = await migrateReportsToProjectDocs(
            { project: "acme-app", dryRun: false, overwrite: false },
            configService
        );

        expect(summary.copied).toEqual(["alpha.md", "beta.md"]);
        expect(await readFile(path.join(projectRoot, "tenex", "docs", "alpha.md"), "utf-8")).toBe(
            "# alpha"
        );
        expect(await readFile(path.join(projectRoot, "tenex", "docs", "beta.md"), "utf-8")).toBe(
            "# beta"
        );
    });

    it("skips non-markdown files and .metadata", async () => {
        await writeFile(path.join(sourceReportsDir, "alpha.md"), "# alpha");
        await writeFile(path.join(sourceReportsDir, "notes.txt"), "ignore");
        await mkdir(path.join(sourceReportsDir, ".metadata"), { recursive: true });

        const summary = await migrateReportsToProjectDocs(
            { project: "acme-app", dryRun: false, overwrite: false },
            configService
        );

        expect(summary.copied).toEqual(["alpha.md"]);
        expect(summary.skipped).toEqual([".metadata/", "notes.txt"]);
    });

    it("reports conflicts without overwriting by default", async () => {
        const destinationDir = path.join(projectRoot, "tenex", "docs");
        await mkdir(destinationDir, { recursive: true });
        await writeFile(path.join(sourceReportsDir, "alpha.md"), "# source");
        await writeFile(path.join(destinationDir, "alpha.md"), "# destination");

        const summary = await migrateReportsToProjectDocs(
            { project: "acme-app", dryRun: false, overwrite: false },
            configService
        );

        expect(summary.conflicted).toEqual(["alpha.md"]);
        expect(summary.copied).toEqual([]);
        expect(await readFile(path.join(destinationDir, "alpha.md"), "utf-8")).toBe("# destination");
    });

    it("overwrites existing files when requested", async () => {
        const destinationDir = path.join(projectRoot, "tenex", "docs");
        await mkdir(destinationDir, { recursive: true });
        await writeFile(path.join(sourceReportsDir, "alpha.md"), "# source");
        await writeFile(path.join(destinationDir, "alpha.md"), "# destination");

        const summary = await migrateReportsToProjectDocs(
            { project: "acme-app", dryRun: false, overwrite: true },
            configService
        );

        expect(summary.overwritten).toEqual(["alpha.md"]);
        expect(await readFile(path.join(destinationDir, "alpha.md"), "utf-8")).toBe("# source");
    });

    it("does not write files during dry run", async () => {
        await writeFile(path.join(sourceReportsDir, "alpha.md"), "# alpha");

        const summary = await migrateReportsToProjectDocs(
            { project: "acme-app", dryRun: true, overwrite: false },
            configService
        );

        expect(summary.copied).toEqual(["alpha.md"]);
        expect(
            await Bun.file(path.join(projectRoot, "tenex", "docs", "alpha.md")).exists()
        ).toBe(false);
    });

    it("formats a clear summary", () => {
        const text = formatSummary({
            project: "acme-app",
            dryRun: true,
            sourceDir: "/src",
            destinationDir: "/dst",
            copied: ["alpha.md"],
            overwritten: [],
            conflicted: ["beta.md"],
            skipped: ["notes.txt"],
        });

        expect(text).toContain("Report migration summary (dry run)");
        expect(text).toContain("Copied: 1");
        expect(text).toContain("Conflicted files: beta.md");
        expect(text).toContain("Skipped entries: notes.txt");
    });
});
