import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSummary, hasAuditFailures } from "../transport-runtime-audit";

describe("transport-runtime-audit", () => {
    let repoRoot: string;

    beforeEach(async () => {
        repoRoot = await mkdtemp(join(tmpdir(), "tenex-transport-audit-"));
        await mkdir(join(repoRoot, "src"), { recursive: true });
    });

    afterEach(async () => {
        await Bun.$`rm -rf ${repoRoot}`.quiet();
    });

    it("allows the non-runtime report publishing script", async () => {
        const scriptPath = join(repoRoot, "src", "skills", "built-in", "report", "scripts");
        await mkdir(scriptPath, { recursive: true });
        await writeFile(
            join(scriptPath, "publish.js"),
            "await event.publish();\n"
        );

        const summary = buildSummary({ repoRoot });

        expect(summary.directPublishCalls).toEqual([
            {
                file: "src/skills/built-in/report/scripts/publish.js",
                line: 1,
                text: "await event.publish();",
            },
        ]);
        expect(summary.unexpectedDirectPublishCalls).toEqual([]);
        expect(hasAuditFailures(summary)).toBe(false);
    });

    it("fails on direct runtime TypeScript NDK publish calls", async () => {
        const servicePath = join(repoRoot, "src", "services");
        await mkdir(servicePath, { recursive: true });
        await writeFile(
            join(servicePath, "BadPublisher.ts"),
            [
                "export async function publish(event: { publish(): Promise<void> }) {",
                "    await event.publish();",
                "}",
            ].join("\n")
        );

        const summary = buildSummary({ repoRoot });

        expect(summary.unexpectedDirectPublishCalls).toEqual([
            {
                file: "src/services/BadPublisher.ts",
                line: 2,
                text: "await event.publish();",
            },
        ]);
        expect(hasAuditFailures(summary)).toBe(true);
    });

    it("fails on runtime NDKEvent prototype publish references", async () => {
        await writeFile(
            join(repoRoot, "src", "patch-publish.ts"),
            "const directPublish = NDKEvent.prototype.publish;\n"
        );

        const summary = buildSummary({ repoRoot });

        expect(summary.unexpectedDirectPublishCalls).toEqual([
            {
                file: "src/patch-publish.ts",
                line: 1,
                text: "const directPublish = NDKEvent.prototype.publish;",
            },
        ]);
        expect(hasAuditFailures(summary)).toBe(true);
    });

    it("ignores tests and test utilities", async () => {
        const testPath = join(repoRoot, "src", "nostr", "__tests__");
        const testUtilsPath = join(repoRoot, "src", "test-utils");
        await mkdir(testPath, { recursive: true });
        await mkdir(testUtilsPath, { recursive: true });
        await writeFile(join(testPath, "Publisher.test.ts"), "await event.publish();\n");
        await writeFile(join(testUtilsPath, "publisher.ts"), "await event.publish();\n");

        const summary = buildSummary({ repoRoot });

        expect(summary.directPublishCalls).toEqual([]);
        expect(hasAuditFailures(summary)).toBe(false);
    });
});
