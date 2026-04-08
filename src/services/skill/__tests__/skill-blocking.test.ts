import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { SkillWhitelistService } from "@/services/skill";
import {
    buildExpandedBlockedSet,
    buildSkillAliasMap,
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
        const blockedSet = buildExpandedBlockedSet(undefined, new Map());

        expect(blockedSet.size).toBe(0);
    });

    it("returns an empty set when blocked skills is an empty array", () => {
        const blockedSet = buildExpandedBlockedSet([], new Map());

        expect(blockedSet.size).toBe(0);
    });

    it("includes the raw blocked id when there is no whitelist match", () => {
        const blockedSet = buildExpandedBlockedSet(["local-only-skill"], new Map());

        expect(blockedSet.has("local-only-skill")).toBe(true);
        expect(blockedSet.size).toBe(1);
    });

    it("expands a blocked local identifier to all known aliases", () => {
        const skillMap = buildSkillAliasMap([
            createSkill("local-skill", "a".repeat(64)),
        ]);

        const blockedSet = buildExpandedBlockedSet(["local-skill"], skillMap);

        expect(blockedSet.has("local-skill")).toBe(true);
        expect(blockedSet.has("a".repeat(64))).toBe(true);
    });

    it("expands a blocked event id to all known aliases", () => {
        const skillMap = buildSkillAliasMap([
            createSkill("local-skill", "b".repeat(64)),
        ]);

        const blockedSet = buildExpandedBlockedSet(["b".repeat(64)], skillMap);

        expect(blockedSet.has("local-skill")).toBe(true);
        expect(blockedSet.has("b".repeat(64))).toBe(true);
    });

    it("merges alias groups from installed and whitelisted skills", () => {
        const skillMap = buildSkillAliasMap([
            createSkill("skill-a", "event-1"),
        ]);

        const originalGetWhitelistedSkills = whitelistService.getWhitelistedSkills.bind(
            whitelistService
        );

        try {
            (whitelistService as typeof whitelistService & {
                getWhitelistedSkills: () => never[];
            }).getWhitelistedSkills = () => [
                {
                    eventId: "event-1",
                    identifier: "skill-a",
                    shortId: "short-b",
                    kind: 4202,
                    whitelistedBy: ["pubkey"],
                } as never,
            ];

            const blockedSet = buildExpandedBlockedSet(["skill-a"], skillMap);

            expect(blockedSet.has("skill-a")).toBe(true);
            expect(blockedSet.has("event-1")).toBe(true);
            expect(blockedSet.has("short-b")).toBe(true);
            expect(blockedSet.size).toBe(3);
        } finally {
            (whitelistService as typeof whitelistService & {
                getWhitelistedSkills: () => never[];
            }).getWhitelistedSkills = originalGetWhitelistedSkills;
        }
    });

    it("filters blocked skills and preserves allowed ids", () => {
        const blockedSet = new Set(["blocked"]);
        expect(filterBlockedSkills(["allowed", "blocked", "other"], blockedSet, new Map())).toEqual({
            allowed: ["allowed", "other"],
            blocked: ["blocked"],
        });
    });

    it("detects blocked skills through any alias", () => {
        const skillMap = buildSkillAliasMap([
            createSkill("local-skill", "c".repeat(64)),
        ]);

        const blockedSet = buildExpandedBlockedSet(["local-skill"], skillMap);
        expect(isSkillBlocked("local-skill", blockedSet, skillMap)).toBe(true);
        expect(isSkillBlocked("c".repeat(64), blockedSet, skillMap)).toBe(true);
        expect(isSkillBlocked("other-skill", blockedSet, skillMap)).toBe(false);
    });

    it("returns false for a skill not in the blocked list", () => {
        const blockedSet = buildExpandedBlockedSet(["blocked-skill"], new Map());
        expect(isSkillBlocked("other-skill", blockedSet, new Map())).toBe(false);
    });
});

function createSkill(identifier: string, eventId: string, shortId?: string) {
    return {
        identifier,
        eventId,
        shortId,
        content: "",
        installedFiles: [],
    };
}
