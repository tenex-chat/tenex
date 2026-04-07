import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { NDKKind } from "@/nostr/kinds";
import { SkillWhitelistService, type WhitelistItem } from "@/services/skill";
import {
    buildExpandedBlockedSet,
    filterBlockedSkills,
    isSkillBlocked,
} from "../skill-blocking";

function createWhitelistItem(overrides: Partial<WhitelistItem>): WhitelistItem {
    return {
        eventId: overrides.eventId ?? "event-a",
        identifier: overrides.identifier,
        shortId: overrides.shortId,
        kind: NDKKind.AgentSkill,
        name: overrides.name,
        description: overrides.description,
        whitelistedBy: overrides.whitelistedBy ?? ["pubkey"],
    };
}

describe("skill-blocking", () => {
    const whitelistService = SkillWhitelistService.getInstance();

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
        spyOn(whitelistService, "getWhitelistedSkills").mockReturnValue([]);

        const blockedSet = buildExpandedBlockedSet(["local-only-skill"]);

        expect(blockedSet.has("local-only-skill")).toBe(true);
        expect(blockedSet.size).toBe(1);
    });

    it("expands a blocked local identifier to all known aliases", () => {
        spyOn(whitelistService, "getWhitelistedSkills").mockReturnValue([
            createWhitelistItem({
                eventId: "a".repeat(64),
                identifier: "local-skill",
                shortId: "short-skill",
            }),
        ]);

        const blockedSet = buildExpandedBlockedSet(["local-skill"]);

        expect(blockedSet.has("local-skill")).toBe(true);
        expect(blockedSet.has("short-skill")).toBe(true);
        expect(blockedSet.has("a".repeat(64))).toBe(true);
    });

    it("expands a blocked event id to all known aliases", () => {
        spyOn(whitelistService, "getWhitelistedSkills").mockReturnValue([
            createWhitelistItem({
                eventId: "b".repeat(64),
                identifier: "local-skill",
                shortId: "short-skill",
            }),
        ]);

        const blockedSet = buildExpandedBlockedSet(["b".repeat(64)]);

        expect(blockedSet.has("local-skill")).toBe(true);
        expect(blockedSet.has("short-skill")).toBe(true);
        expect(blockedSet.has("b".repeat(64))).toBe(true);
    });

    it("filters blocked skills and preserves allowed ids", () => {
        spyOn(whitelistService, "getWhitelistedSkills").mockReturnValue([]);

        expect(filterBlockedSkills(["allowed", "blocked", "other"], ["blocked"])).toEqual({
            allowed: ["allowed", "other"],
            blocked: ["blocked"],
        });
    });

    it("returns all as allowed when blockedSkillIds is undefined", () => {
        expect(filterBlockedSkills(["allowed", "blocked"], undefined)).toEqual({
            allowed: ["allowed", "blocked"],
            blocked: [],
        });
    });

    it("detects blocked skills through any alias", () => {
        spyOn(whitelistService, "getWhitelistedSkills").mockReturnValue([
            createWhitelistItem({
                eventId: "c".repeat(64),
                identifier: "local-skill",
                shortId: "short-skill",
            }),
        ]);

        expect(isSkillBlocked("local-skill", ["local-skill"])).toBe(true);
        expect(isSkillBlocked("short-skill", ["local-skill"])).toBe(true);
        expect(isSkillBlocked("c".repeat(64), ["local-skill"])).toBe(true);
        expect(isSkillBlocked("other-skill", ["local-skill"])).toBe(false);
    });

    it("returns false for a skill not in the blocked list", () => {
        spyOn(whitelistService, "getWhitelistedSkills").mockReturnValue([]);

        expect(isSkillBlocked("other-skill", ["blocked-skill"])).toBe(false);
    });
});
