import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { SkillService } from "@/services/skill/SkillService";
import { SkillWhitelistService } from "@/services/skill";
import { renderAvailableSkillsBlock } from "../skill-reminder-renderers";

describe("skill-reminder-renderers", () => {
    const installedSkills = [
        {
            identifier: "allowed-skill",
            eventId: "a".repeat(64),
            content: "Allowed content",
            installedFiles: [],
            scope: "shared" as const,
        },
        {
            identifier: "blocked-skill",
            eventId: "b".repeat(64),
            content: "Blocked content",
            installedFiles: [],
            scope: "shared" as const,
        },
    ];

    const whitelistItems = [
        {
            eventId: "c".repeat(64),
            identifier: "whitelisted-skill",
            shortId: "whitelisted-short",
            kind: 4202 as const,
            whitelistedBy: ["pubkey"],
        },
    ];

    let skillServiceSpy: ReturnType<typeof spyOn>;
    let installedSkillsSpy: ReturnType<typeof spyOn>;
    let whitelistedSkillsSpy: ReturnType<typeof spyOn>;

    afterEach(() => {
        skillServiceSpy?.mockRestore();
        installedSkillsSpy?.mockRestore();
        whitelistedSkillsSpy?.mockRestore();
        mock.restore();
    });

    it("omits blocked skills from the available-skills block", async () => {
        skillServiceSpy = spyOn(SkillService, "getInstance").mockReturnValue({
            listAvailableSkills: mock(async () => installedSkills),
        } as never);
        installedSkillsSpy = spyOn(SkillWhitelistService.getInstance(), "getInstalledSkills").mockReturnValue(installedSkills as any);
        whitelistedSkillsSpy = spyOn(SkillWhitelistService.getInstance(), "getWhitelistedSkills").mockReturnValue(whitelistItems as any);

        const rendered = await renderAvailableSkillsBlock(
            "agent-pubkey",
            "/tmp/project",
            ["blocked-skill"]
        );

        // Global skills section shows count only, not individual skill names
        expect(rendered).toContain("<global-skills>");
        expect(rendered).toContain("2 global skills available — use `skill_list` to see them all");
        expect(rendered).not.toContain("blocked-skill");
    });
});
