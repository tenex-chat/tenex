import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NDKKind } from "@/nostr/kinds";
import { SkillWhitelistService } from "../SkillWhitelistService";

describe("SkillWhitelistService", () => {
    let testDir: string;
    let originalTenexBaseDir: string | undefined;

    beforeEach(async () => {
        originalTenexBaseDir = process.env.TENEX_BASE_DIR;
        testDir = await fs.mkdtemp(path.join(os.tmpdir(), "tenex-skill-whitelist-"));
        process.env.TENEX_BASE_DIR = testDir;
        SkillWhitelistService.getInstance().shutdown();
    });

    afterEach(async () => {
        SkillWhitelistService.getInstance().shutdown();
        if (originalTenexBaseDir === undefined) {
            delete process.env.TENEX_BASE_DIR;
        } else {
            process.env.TENEX_BASE_DIR = originalTenexBaseDir;
        }
        await fs.rm(testDir, { recursive: true, force: true });
    });

    it("returns an empty whitelist when the Rust snapshot is absent", () => {
        const service = SkillWhitelistService.getInstance();

        expect(service.getWhitelistedSkills()).toEqual([]);
        expect(service.getAllWhitelistedItems()).toEqual([]);
        expect(service.isSkillWhitelisted("a".repeat(64))).toBe(false);
        expect(service.getLastUpdated()).toBeNull();
    });

    it("reads whitelisted skills from the Rust-authored filesystem snapshot", async () => {
        const skillId = "a".repeat(64);
        await writeSnapshot({
            updatedAt: 1710001000900,
            skills: [
                {
                    eventId: skillId,
                    kind: NDKKind.AgentSkill,
                    identifier: "catalog-reader",
                    shortId: "aaaaaa1",
                    name: "Catalog Reader",
                    description: "Reads catalog entries for a project.",
                    whitelistedBy: ["1".repeat(64), "2".repeat(64)],
                    lastObservedAt: 1710001000500,
                },
            ],
        });

        const service = SkillWhitelistService.getInstance();
        const skills = service.getWhitelistedSkills();

        expect(skills).toEqual([
            {
                eventId: skillId,
                kind: NDKKind.AgentSkill,
                identifier: "catalog-reader",
                shortId: "aaaaaa1",
                name: "Catalog Reader",
                description: "Reads catalog entries for a project.",
                whitelistedBy: ["1".repeat(64), "2".repeat(64)],
            },
        ]);
        expect(service.isSkillWhitelisted(skillId)).toBe(true);
        expect(service.getLastUpdated()).toBe(1710001000900);
    });

    it("refreshes the cached snapshot when Rust replaces the file", async () => {
        const firstSkillId = "a".repeat(64);
        const secondSkillId = "b".repeat(64);
        await writeSnapshot({
            updatedAt: 1,
            skills: [createSnapshotSkill(firstSkillId, "first-skill")],
        });

        const service = SkillWhitelistService.getInstance();
        expect(service.getWhitelistedSkills().map((skill) => skill.eventId)).toEqual([
            firstSkillId,
        ]);

        await writeSnapshot({
            updatedAt: 2,
            skills: [createSnapshotSkill(secondSkillId, "second-skill")],
        });
        await fs.utimes(getSnapshotPath(), new Date(3_000), new Date(3_000));

        expect(service.getWhitelistedSkills().map((skill) => skill.eventId)).toEqual([
            secondSkillId,
        ]);
        expect(service.getLastUpdated()).toBe(2);
    });

    it("fails closed when the Rust snapshot schema is unsupported", async () => {
        await fs.mkdir(path.dirname(getSnapshotPath()), { recursive: true });
        await fs.writeFile(
            getSnapshotPath(),
            JSON.stringify({
                schemaVersion: 2,
                writer: "rust-daemon",
                writerVersion: "test-version",
                updatedAt: 1710001000900,
                skills: [createSnapshotSkill("a".repeat(64), "catalog-reader")],
            })
        );

        const service = SkillWhitelistService.getInstance();
        expect(service.getWhitelistedSkills()).toEqual([]);
        expect(service.getLastUpdated()).toBeNull();
    });

    function getSnapshotPath(): string {
        return path.join(testDir, "daemon", "skill-whitelist.json");
    }

    async function writeSnapshot(snapshot: {
        updatedAt: number;
        skills: Array<Record<string, unknown>>;
    }): Promise<void> {
        await fs.mkdir(path.dirname(getSnapshotPath()), { recursive: true });
        await fs.writeFile(
            getSnapshotPath(),
            JSON.stringify({
                schemaVersion: 1,
                writer: "rust-daemon",
                writerVersion: "test-version",
                updatedAt: snapshot.updatedAt,
                skills: snapshot.skills,
            })
        );
    }

    function createSnapshotSkill(eventId: string, identifier: string): Record<string, unknown> {
        return {
            eventId,
            kind: NDKKind.AgentSkill,
            identifier,
            whitelistedBy: ["1".repeat(64)],
            lastObservedAt: 1710001000500,
        };
    }
});
