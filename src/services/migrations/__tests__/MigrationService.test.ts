import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { agentStorage } from "@/agents/AgentStorage";
import { fileExists } from "@/lib/fs";
import { config } from "@/services/ConfigService";
import { getLegacySchedulesPath, getProjectSchedulesPath } from "@/services/scheduling";
import { migrationService } from "../MigrationService";

describe("MigrationService", () => {
    const originalTenexBaseDir = process.env.TENEX_BASE_DIR;
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tenex-migration-test-"));
        process.env.TENEX_BASE_DIR = tempDir;
        config.dispose();
        config.clearCache();
    });

    afterEach(async () => {
        mock.restore();
        config.dispose();
        config.clearCache();

        if (originalTenexBaseDir === undefined) {
            process.env.TENEX_BASE_DIR = undefined;
        } else {
            process.env.TENEX_BASE_DIR = originalTenexBaseDir;
        }

        await fs.rm(tempDir, { recursive: true, force: true });
    });

    it("migrates legacy schedules into per-project schedules.json files and writes version 1", async () => {
        const projectAddress = `31933:${"a".repeat(64)}:project-1`;

        await fs.writeFile(path.join(tempDir, "config.json"), JSON.stringify({}, null, 2));
        await fs.writeFile(
            getLegacySchedulesPath(),
            JSON.stringify(
                [
                    {
                        id: "task-1",
                        title: "Morning report",
                        schedule: "0 9 * * *",
                        prompt: "Generate the morning report",
                        fromPubkey: "user-pubkey",
                        toPubkey: "agent-pubkey-1",
                        projectId: projectAddress,
                        type: "cron",
                        createdAt: "2026-04-01T08:00:00.000Z",
                    },
                ],
                null,
                2
            )
        );

        spyOn(agentStorage, "initialize").mockResolvedValue(undefined);
        spyOn(agentStorage, "loadAgent").mockImplementation(async (pubkey: string) => {
            if (pubkey === "agent-pubkey-1") {
                return { slug: "architect" } as any;
            }
            return null;
        });
        spyOn(agentStorage, "getAgentProjects").mockImplementation(async (pubkey: string) => {
            if (pubkey === "agent-pubkey-1") {
                return ["project-1"];
            }
            return [];
        });

        const summary = await migrationService.migrate();

        expect(summary.currentVersion).toBe("unknown");
        expect(summary.finalVersion).toBe(1);
        expect(summary.applied).toHaveLength(1);
        expect(summary.applied[0].result.migratedCount).toBe(1);
        expect(summary.applied[0].result.skippedCount).toBe(0);

        const savedConfig = JSON.parse(
            await fs.readFile(path.join(tempDir, "config.json"), "utf-8")
        );
        expect(savedConfig.version).toBe(1);

        const migratedTasks = JSON.parse(
            await fs.readFile(getProjectSchedulesPath("project-1"), "utf-8")
        );
        expect(migratedTasks).toHaveLength(1);
        expect(migratedTasks[0].targetAgentSlug).toBe("architect");
        expect(migratedTasks[0].projectId).toBe("project-1");
        expect(migratedTasks[0].projectRef).toBe(projectAddress);

        expect(await fileExists(getLegacySchedulesPath())).toBe(false);
    });

    it("retains the legacy file when a target pubkey cannot be resolved to a project agent slug", async () => {
        await fs.writeFile(path.join(tempDir, "config.json"), JSON.stringify({}, null, 2));
        await fs.writeFile(
            getLegacySchedulesPath(),
            JSON.stringify(
                [
                    {
                        id: "task-1",
                        schedule: "0 9 * * *",
                        prompt: "Generate the morning report",
                        fromPubkey: "user-pubkey",
                        toPubkey: "missing-agent",
                        projectId: `31933:${"b".repeat(64)}:project-2`,
                    },
                ],
                null,
                2
            )
        );

        spyOn(agentStorage, "initialize").mockResolvedValue(undefined);
        spyOn(agentStorage, "loadAgent").mockResolvedValue(null);
        spyOn(agentStorage, "getAgentProjects").mockResolvedValue([]);

        const summary = await migrationService.migrate();

        expect(summary.finalVersion).toBe(1);
        expect(summary.applied).toHaveLength(1);
        expect(summary.applied[0].result.migratedCount).toBe(0);
        expect(summary.applied[0].result.skippedCount).toBe(1);
        expect(summary.applied[0].result.warnings.some((warning) =>
            warning.includes("Legacy schedule file retained")
        )).toBe(true);

        expect(await fileExists(getLegacySchedulesPath())).toBe(true);
        expect(await fileExists(getProjectSchedulesPath("project-2"))).toBe(false);
    });

    it("no-ops when the config migration version is already current", async () => {
        await fs.writeFile(path.join(tempDir, "config.json"), JSON.stringify({ version: 1 }, null, 2));

        const summary = await migrationService.migrate();

        expect(summary.currentVersion).toBe(1);
        expect(summary.finalVersion).toBe(1);
        expect(summary.applied).toHaveLength(0);
    });
});
