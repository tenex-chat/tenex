import { describe, expect, it } from "bun:test";
import type { SkillData } from "@/services/skill";
import { skillsFragment } from "../12-skills";

function createSkill(overrides: Partial<SkillData> = {}): SkillData {
    return {
        identifier: "poster-kit",
        content: "This is the skill content",
        installedFiles: [],
        ...overrides,
    };
}

describe("skillsFragment", () => {
    describe("legacy mode (skillContent only)", () => {
        it("should return empty string when skillContent is empty", () => {
            const result = skillsFragment.template({ skillContent: "" });
            expect(result).toBe("");
        });

        it("should return empty string when skillContent is whitespace", () => {
            const result = skillsFragment.template({ skillContent: "   \n  " });
            expect(result).toBe("");
        });

        it("should wrap skillContent in loaded-skills tags", () => {
            const result = skillsFragment.template({
                skillContent: "Do something special",
            });
            expect(result).toContain("<loaded-skills>");
            expect(result).toContain("Do something special");
            expect(result).toContain("</loaded-skills>");
        });
    });

    describe("new mode (skills array)", () => {
        it("should render single skill without name", () => {
            const result = skillsFragment.template({
                skills: [createSkill()],
            });

            expect(result).toContain("<loaded-skill");
            expect(result).toContain('id="poster-kit"');
            expect(result).toContain("This is the skill content");
            expect(result).toContain("</loaded-skill>");
            expect(result).not.toContain("name=");
        });

        it("should render single skill with name", () => {
            const result = skillsFragment.template({
                skills: [createSkill({ name: "code-review" })],
            });

            expect(result).toContain('name="code-review"');
            expect(result).toContain("This is the skill content");
        });

        it("should render single skill with a human-readable name", () => {
            const result = skillsFragment.template({
                skills: [
                    createSkill({
                        name: "Code Review Skill",
                    }),
                ],
            });

            expect(result).toContain('name="Code Review Skill"');
            expect(result).toContain('id="poster-kit"');
        });

        it("should render multiple skills", () => {
            const result = skillsFragment.template({
                skills: [
                    createSkill({
                        identifier: "first-skill",
                        content: "First skill content",
                        name: "First",
                    }),
                    createSkill({
                        identifier: "second-skill",
                        content: "Second skill content",
                        name: "Second",
                    }),
                ],
            });

            expect(result).toContain('name="First"');
            expect(result).toContain("First skill content");
            expect(result).toContain('name="Second"');
            expect(result).toContain("Second skill content");
        });

        it("should include header explaining loaded skills", () => {
            const result = skillsFragment.template({
                skills: [createSkill({ content: "Skill content" })],
            });

            expect(result).toContain("## Loaded Skills");
            expect(result).toContain("additional context and capabilities");
        });
    });

    describe("installed files rendering", () => {
        it("should show successfully installed files", () => {
            const result = skillsFragment.template({
                skills: [
                    createSkill({
                        installedFiles: [
                            {
                                eventId: "event1",
                                relativePath: "scripts/helper.py",
                                absolutePath: "/home/.tenex/skills/poster-kit/scripts/helper.py",
                                success: true,
                            },
                            {
                                eventId: "event2",
                                relativePath: "data/config.json",
                                absolutePath: "/home/.tenex/skills/poster-kit/data/config.json",
                                success: true,
                            },
                        ],
                    }),
                ],
            });

            expect(result).toContain("## Installed Files");
            expect(result).toContain("`/home/.tenex/skills/poster-kit/scripts/helper.py`");
            expect(result).toContain("`/home/.tenex/skills/poster-kit/data/config.json`");
        });

        it("should show failed file downloads separately", () => {
            const result = skillsFragment.template({
                skills: [
                    createSkill({
                        content: "Skill with failed files",
                        installedFiles: [
                            {
                                eventId: "event1",
                                relativePath: "scripts/helper.py",
                                absolutePath: "/home/.tenex/skills/poster-kit/scripts/helper.py",
                                success: true,
                            },
                            {
                                eventId: "event2",
                                relativePath: "data/missing.json",
                                absolutePath: "/home/.tenex/skills/poster-kit/data/missing.json",
                                success: false,
                                error: "Download timed out",
                            },
                        ],
                    }),
                ],
            });

            expect(result).toContain("## Installed Files");
            expect(result).toContain("## Failed File Downloads");
            expect(result).toContain("data/missing.json: Download timed out");
        });

        it("should not show files sections when no files", () => {
            const result = skillsFragment.template({
                skills: [createSkill({ content: "Skill without files" })],
            });

            expect(result).not.toContain("## Installed Files");
            expect(result).not.toContain("## Failed File Downloads");
        });
    });

    describe("name escaping", () => {
        it("should escape quotes in name attribute", () => {
            const result = skillsFragment.template({
                skills: [createSkill({ content: "Test content", name: 'name-with-"quotes"' })],
            });

            expect(result).toContain('name="name-with-&quot;quotes&quot;"');
            expect(result).not.toContain('name="name-with-"quotes""');
        });

        it("should escape angle brackets in name attribute", () => {
            const result = skillsFragment.template({
                skills: [createSkill({ content: "Test content", name: "Name with <tags>" })],
            });

            expect(result).toContain('name="Name with &lt;tags&gt;"');
        });

        it("should escape ampersands in name attribute", () => {
            const result = skillsFragment.template({
                skills: [createSkill({ content: "Test content", name: "Name & more" })],
            });

            expect(result).toContain('name="Name &amp; more"');
        });
    });

    describe("validation", () => {
        it("should validate skillContent as string", () => {
            expect(skillsFragment.validateArgs({ skillContent: "test" })).toBe(true);
        });

        it("should validate skills array", () => {
            expect(skillsFragment.validateArgs({ skills: [] })).toBe(true);
            expect(skillsFragment.validateArgs({
                skills: [createSkill({ content: "test" })],
            })).toBe(true);
        });

        it("should validate skill with optional name", () => {
            expect(skillsFragment.validateArgs({
                skills: [
                    createSkill({
                        content: "test",
                        name: "my-skill",
                    }),
                ],
            })).toBe(true);
        });

        it("should validate combined args", () => {
            expect(skillsFragment.validateArgs({
                skillContent: "test",
                skills: [createSkill({ content: "test" })],
            })).toBe(true);
        });

        it("should accept empty object (all fields optional)", () => {
            expect(skillsFragment.validateArgs({})).toBe(true);
        });

        it("should reject null and undefined", () => {
            expect(skillsFragment.validateArgs(null)).toBe(false);
            expect(skillsFragment.validateArgs(undefined)).toBe(false);
        });

        it("should reject invalid skillContent type", () => {
            expect(skillsFragment.validateArgs({ skillContent: 123 })).toBe(false);
        });

        it("should reject skills that is not an array", () => {
            expect(skillsFragment.validateArgs({ skills: "not an array" })).toBe(false);
            expect(skillsFragment.validateArgs({ skills: {} })).toBe(false);
        });

        it("should reject skill without content field", () => {
            expect(skillsFragment.validateArgs({
                skills: [{
                    identifier: "poster-kit",
                    installedFiles: [],
                }],
            })).toBe(false);
        });

        it("should reject skill without identifier field", () => {
            expect(skillsFragment.validateArgs({
                skills: [{
                    content: "test",
                    installedFiles: [],
                }],
            })).toBe(false);
        });

        it("should reject skill without installedFiles array", () => {
            expect(skillsFragment.validateArgs({
                skills: [{
                    identifier: "poster-kit",
                    content: "test",
                }],
            })).toBe(false);
        });

        it("should reject skill with non-string content", () => {
            expect(skillsFragment.validateArgs({
                skills: [{
                    identifier: "poster-kit",
                    content: 123,
                    installedFiles: [],
                }],
            })).toBe(false);
        });

        it("should reject skill with non-string identifier", () => {
            expect(skillsFragment.validateArgs({
                skills: [{
                    identifier: 123,
                    content: "test",
                    installedFiles: [],
                }],
            })).toBe(false);
        });

        it("should reject skill with non-string name", () => {
            expect(skillsFragment.validateArgs({
                skills: [{
                    identifier: "poster-kit",
                    content: "test",
                    name: 123,
                    installedFiles: [],
                }],
            })).toBe(false);
        });
    });
});
