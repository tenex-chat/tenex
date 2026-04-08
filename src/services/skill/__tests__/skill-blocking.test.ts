import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { SkillWhitelistService } from "@/services/skill";
import {
    buildExpandedBlockedSet,
    filterBlockedSkills,
    isSkillBlocked,
} from "../skill-blocking";

describe("skill-blocking", () => {
    const whitelistService = SkillWhitelistService.getInstance();

    beforeEach(() => {
        whitelistService.setInstalledSkills([]);
    });

    afterEach(() => {
        mock.restore();
    });

    it("returns an empty set when no blocked skills are configured", () => {
        const blockedSet = buildExpandedBlockedSet(undefined);

        expect(blockedSet.size).toBe(0);
    });

    it("returns an empty set when blocked skills is an empty array", () => {
        const blockedSet = buildExpandedBlockedSet([]);

        expect(blockedSet.size).toBe(0);
    });

    it("includes the raw blocked id when there is no whitelist match", () => {
        const blockedSet = buildExpandedBlockedSet(["local-only-skill"]);

        expect(blockedSet.has("local-only-skill")).toBe(true);
        expect(blockedSet.size).toBe(1);
    });

    it("expands a blocked local identifier to all known aliases", () => {
        whitelistService.setInstalledSkills([
            {
                eventId: "a".repeat(64),
                identifier: "local-skill",
                shortId: "short-skill",
                content: "",
                installedFiles: [],
            } as never,
        ]);

        const blockedSet = buildExpandedBlockedSet(["local-skill"]);

        expect(blockedSet.has("local-skill")).toBe(true);
        expect(blockedSet.has("short-skill")).toBe(true);
        expect(blockedSet.has("a".repeat(64))).toBe(true);
    });

    it("expands a blocked event id to all known aliases", () => {
        whitelistService.setInstalledSkills([
            {
                eventId: "b".repeat(64),
                identifier: "local-skill",
                shortId: "short-skill",
                content: "",
                installedFiles: [],
            } as never,
        ]);

        const blockedSet = buildExpandedBlockedSet(["b".repeat(64)]);

        expect(blockedSet.has("local-skill")).toBe(true);
        expect(blockedSet.has("short-skill")).toBe(true);
        expect(blockedSet.has("b".repeat(64))).toBe(true);
    });

    it("merges alias groups from installed and whitelisted skills", () => {
        whitelistService.setInstalledSkills([
            {
                eventId: "d".repeat(64),
                identifier: "skill-a",
                shortId: "skill-b",
                content: "",
                installedFiles: [],
            } as never,
        ]);

        const originalGetWhitelistedSkills = whitelistService.getWhitelistedSkills.bind(
            whitelistService
        );

        try {
            (whitelistService as typeof whitelistService & {
                getWhitelistedSkills: () => never[];
            }).getWhitelistedSkills = () => [
                {
                    eventId: "e".repeat(64),
                    identifier: "skill-b",
                    shortId: "skill-c",
                    kind: 4202,
                    whitelistedBy: ["pubkey"],
                } as never,
            ];

            const blockedSet = buildExpandedBlockedSet(["skill-a"]);

            expect(blockedSet.has("skill-a")).toBe(true);
            expect(blockedSet.has("skill-b")).toBe(true);
            expect(blockedSet.has("skill-c")).toBe(true);
            expect(blockedSet.has("d".repeat(64))).toBe(true);
            expect(blockedSet.has("e".repeat(64))).toBe(true);
        } finally {
            (whitelistService as typeof whitelistService & {
                getWhitelistedSkills: () => never[];
            }).getWhitelistedSkills = originalGetWhitelistedSkills;
        }
    });

    it("filters blocked skills and preserves allowed ids", () => {
        const blockedSet = new Set(["blocked"]);
        expect(filterBlockedSkills(["allowed", "blocked", "other"], blockedSet)).toEqual([
            "allowed",
            "other",
        ]);
    });

    it("detects blocked skills through any alias", () => {
        whitelistService.setInstalledSkills([
            {
                eventId: "c".repeat(64),
                identifier: "local-skill",
                shortId: "short-skill",
                content: "",
                installedFiles: [],
            } as never,
        ]);

        const blockedSet = buildExpandedBlockedSet(["local-skill"]);
        expect(isSkillBlocked("local-skill", blockedSet)).toBe(true);
        expect(isSkillBlocked("short-skill", blockedSet)).toBe(true);
        expect(isSkillBlocked("c".repeat(64), blockedSet)).toBe(true);
        expect(isSkillBlocked("other-skill", blockedSet)).toBe(false);
    });

    it("returns false for a skill not in the blocked list", () => {
        const blockedSet = buildExpandedBlockedSet(["blocked-skill"]);
        expect(isSkillBlocked("other-skill", blockedSet)).toBe(false);
    });
});
