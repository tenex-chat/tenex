import { describe, expect, it } from "bun:test";
import type { SkillData } from "@/services/skill";
import { skillsFragment } from "../12-skills";

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

        it("should wrap skillContent in transient-skills tags", () => {
            const result = skillsFragment.template({
                skillContent: "Do something special",
            });
            expect(result).toContain("<transient-skills>");
            expect(result).toContain("Do something special");
            expect(result).toContain("</transient-skills>");
        });
    });

    describe("new mode (skills array)", () => {
        it("should render single skill without title or name", () => {
            const skills: SkillData[] = [
                {
                    content: "This is the skill content",
                    shortId: "abc123def456",
                    installedFiles: [],
                },
            ];

            const result = skillsFragment.template({ skills });

            expect(result).toContain("<transient-skill");
            expect(result).toContain('id="abc123def456"');
            expect(result).toContain("This is the skill content");
            expect(result).toContain("</transient-skill>");
            expect(result).not.toContain("title=");
            expect(result).not.toContain("name=");
        });

        it("should render single skill with title", () => {
            const skills: SkillData[] = [
                {
                    content: "This is the skill content",
                    title: "My Skill",
                    shortId: "abc123def456",
                    installedFiles: [],
                },
            ];

            const result = skillsFragment.template({ skills });

            expect(result).toContain('title="My Skill"');
            expect(result).toContain("This is the skill content");
            expect(result).toContain("</transient-skill>");
        });

        it("should render single skill with name", () => {
            const skills: SkillData[] = [
                {
                    content: "This is the skill content",
                    name: "code-review",
                    shortId: "abc123def456",
                    installedFiles: [],
                },
            ];

            const result = skillsFragment.template({ skills });

            expect(result).toContain('name="code-review"');
            expect(result).toContain("This is the skill content");
        });

        it("should render single skill with both title and name", () => {
            const skills: SkillData[] = [
                {
                    content: "This is the skill content",
                    title: "Code Review Skill",
                    name: "code-review",
                    shortId: "abc123def456",
                    installedFiles: [],
                },
            ];

            const result = skillsFragment.template({ skills });

            expect(result).toContain('title="Code Review Skill"');
            expect(result).toContain('name="code-review"');
            expect(result).toContain('id="abc123def456"');
        });

        it("should render multiple skills", () => {
            const skills: SkillData[] = [
                {
                    content: "First skill content",
                    title: "First",
                    shortId: "first1234567",
                    installedFiles: [],
                },
                {
                    content: "Second skill content",
                    title: "Second",
                    shortId: "second123456",
                    installedFiles: [],
                },
            ];

            const result = skillsFragment.template({ skills });

            expect(result).toContain('title="First"');
            expect(result).toContain("First skill content");
            expect(result).toContain('title="Second"');
            expect(result).toContain("Second skill content");
        });

        it("should include header explaining loaded transient skills", () => {
            const skills: SkillData[] = [
                {
                    content: "Skill content",
                    shortId: "abc123def456",
                    installedFiles: [],
                },
            ];

            const result = skillsFragment.template({ skills });

            expect(result).toContain("## Loaded Transient Skills");
            expect(result).toContain("additional context and capabilities");
        });
    });

    describe("installed files rendering", () => {
        it("should show successfully installed files", () => {
            const skills: SkillData[] = [
                {
                    content: "Skill with files",
                    shortId: "abc123def456",
                    installedFiles: [
                        {
                            eventId: "event1",
                            relativePath: "scripts/helper.py",
                            absolutePath: "/home/.tenex/skills/abc123def456/scripts/helper.py",
                            success: true,
                        },
                        {
                            eventId: "event2",
                            relativePath: "data/config.json",
                            absolutePath: "/home/.tenex/skills/abc123def456/data/config.json",
                            success: true,
                        },
                    ],
                },
            ];

            const result = skillsFragment.template({ skills });

            expect(result).toContain("## Installed Files");
            expect(result).toContain("`/home/.tenex/skills/abc123def456/scripts/helper.py`");
            expect(result).toContain("`/home/.tenex/skills/abc123def456/data/config.json`");
        });

        it("should show failed file downloads separately", () => {
            const skills: SkillData[] = [
                {
                    content: "Skill with failed files",
                    shortId: "abc123def456",
                    installedFiles: [
                        {
                            eventId: "event1",
                            relativePath: "scripts/helper.py",
                            absolutePath: "/home/.tenex/skills/abc123def456/scripts/helper.py",
                            success: true,
                        },
                        {
                            eventId: "event2",
                            relativePath: "data/missing.json",
                            absolutePath: "/home/.tenex/skills/abc123def456/data/missing.json",
                            success: false,
                            error: "Download timed out",
                        },
                    ],
                },
            ];

            const result = skillsFragment.template({ skills });

            expect(result).toContain("## Installed Files");
            expect(result).toContain("## Failed File Downloads");
            expect(result).toContain("data/missing.json: Download timed out");
        });

        it("should not show files sections when no files", () => {
            const skills: SkillData[] = [
                {
                    content: "Skill without files",
                    shortId: "abc123def456",
                    installedFiles: [],
                },
            ];

            const result = skillsFragment.template({ skills });

            expect(result).not.toContain("## Installed Files");
            expect(result).not.toContain("## Failed File Downloads");
        });
    });

    describe("title escaping", () => {
        it("should escape quotes in title attribute", () => {
            const skills: SkillData[] = [
                {
                    content: "Test content",
                    title: 'Title with "quotes"',
                    shortId: "abc123def456",
                    installedFiles: [],
                },
            ];

            const result = skillsFragment.template({ skills });

            expect(result).toContain('title="Title with &quot;quotes&quot;"');
            expect(result).not.toContain('title="Title with "quotes""');
        });

        it("should escape angle brackets in title attribute", () => {
            const skills: SkillData[] = [
                {
                    content: "Test content",
                    title: "Title with <tags>",
                    shortId: "abc123def456",
                    installedFiles: [],
                },
            ];

            const result = skillsFragment.template({ skills });

            expect(result).toContain('title="Title with &lt;tags&gt;"');
        });

        it("should escape ampersands in title attribute", () => {
            const skills: SkillData[] = [
                {
                    content: "Test content",
                    title: "Title & more",
                    shortId: "abc123def456",
                    installedFiles: [],
                },
            ];

            const result = skillsFragment.template({ skills });

            expect(result).toContain('title="Title &amp; more"');
        });

        it("should escape special chars in name attribute", () => {
            const skills: SkillData[] = [
                {
                    content: "Test content",
                    name: 'name-with-"quotes"',
                    shortId: "abc123def456",
                    installedFiles: [],
                },
            ];

            const result = skillsFragment.template({ skills });

            expect(result).toContain('name="name-with-&quot;quotes&quot;"');
        });
    });

    describe("validation", () => {
        it("should validate skillContent as string", () => {
            expect(skillsFragment.validateArgs({ skillContent: "test" })).toBe(true);
        });

        it("should validate skills array", () => {
            expect(skillsFragment.validateArgs({ skills: [] })).toBe(true);
            expect(skillsFragment.validateArgs({
                skills: [{
                    content: "test",
                    shortId: "abc123def456",
                    installedFiles: [],
                }],
            })).toBe(true);
        });

        it("should validate skill with optional title and name", () => {
            expect(skillsFragment.validateArgs({
                skills: [{
                    content: "test",
                    title: "My Title",
                    name: "my-skill",
                    shortId: "abc123def456",
                    installedFiles: [],
                }],
            })).toBe(true);
        });

        it("should validate combined args", () => {
            expect(skillsFragment.validateArgs({
                skillContent: "test",
                skills: [{
                    content: "test",
                    shortId: "abc123def456",
                    installedFiles: [],
                }],
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
                    shortId: "abc123def456",
                    installedFiles: [],
                }],
            })).toBe(false);
        });

        it("should reject skill without shortId field", () => {
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
                    content: "test",
                    shortId: "abc123def456",
                }],
            })).toBe(false);
        });

        it("should reject skill with non-string content", () => {
            expect(skillsFragment.validateArgs({
                skills: [{
                    content: 123,
                    shortId: "abc123def456",
                    installedFiles: [],
                }],
            })).toBe(false);
        });

        it("should reject skill with non-string title", () => {
            expect(skillsFragment.validateArgs({
                skills: [{
                    content: "test",
                    title: 123,
                    shortId: "abc123def456",
                    installedFiles: [],
                }],
            })).toBe(false);
        });

        it("should reject skill with non-string name", () => {
            expect(skillsFragment.validateArgs({
                skills: [{
                    content: "test",
                    name: 123,
                    shortId: "abc123def456",
                    installedFiles: [],
                }],
            })).toBe(false);
        });
    });
});
