import { describe, expect, it } from "bun:test";
import type { NudgeToolPermissions, NudgeData } from "@/services/nudge";
import { nudgesFragment } from "../11-nudges";

describe("nudgesFragment", () => {
    describe("legacy mode (nudgeContent only)", () => {
        it("should return empty string when nudgeContent is empty", () => {
            const result = nudgesFragment.template({ nudgeContent: "" });
            expect(result).toBe("");
        });

        it("should return empty string when nudgeContent is whitespace", () => {
            const result = nudgesFragment.template({ nudgeContent: "   \n  " });
            expect(result).toBe("");
        });

        it("should wrap nudgeContent in nudges tags", () => {
            const result = nudgesFragment.template({
                nudgeContent: "Do something special",
            });
            expect(result).toContain("<nudges>");
            expect(result).toContain("Do something special");
            expect(result).toContain("</nudges>");
        });
    });

    describe("new mode (nudges array)", () => {
        it("should render single nudge with id", () => {
            const nudges: NudgeData[] = [
                { id: "abc123456789", content: "This is the nudge content" },
            ];

            const result = nudgesFragment.template({ nudges });

            expect(result).toContain('<nudge id="abc123456789">');
            expect(result).toContain("This is the nudge content");
            expect(result).toContain("</nudge>");
            expect(result).not.toContain("title=");
        });

        it("should render single nudge with id and title", () => {
            const nudges: NudgeData[] = [
                { id: "abc123456789", content: "This is the nudge content", title: "My Nudge" },
            ];

            const result = nudgesFragment.template({ nudges });

            expect(result).toContain('<nudge id="abc123456789" title="My Nudge">');
            expect(result).toContain("This is the nudge content");
            expect(result).toContain("</nudge>");
        });

        it("should wrap nudges in <nudges> container", () => {
            const nudges: NudgeData[] = [
                { id: "abc123456789", content: "Nudge content" },
            ];

            const result = nudgesFragment.template({ nudges });

            expect(result).toContain("<nudges>");
            expect(result).toContain("</nudges>");
        });

        it("should render multiple nudges inside container", () => {
            const nudges: NudgeData[] = [
                { id: "aaa111111111", content: "First nudge content", title: "First" },
                { id: "bbb222222222", content: "Second nudge content", title: "Second" },
            ];

            const result = nudgesFragment.template({ nudges });

            expect(result).toContain('<nudge id="aaa111111111" title="First">');
            expect(result).toContain("First nudge content");
            expect(result).toContain('<nudge id="bbb222222222" title="Second">');
            expect(result).toContain("Second nudge content");
            expect(result).toContain("<nudges>");
            expect(result).toContain("</nudges>");
        });
    });

    describe("attribute escaping", () => {
        it("should escape quotes in title attribute", () => {
            const nudges: NudgeData[] = [
                { id: "abc123456789", content: "Test content", title: 'Title with "quotes"' },
            ];

            const result = nudgesFragment.template({ nudges });

            expect(result).toContain('title="Title with &quot;quotes&quot;"');
            expect(result).not.toContain('title="Title with "quotes""');
        });

        it("should escape angle brackets in title attribute", () => {
            const nudges: NudgeData[] = [
                { id: "abc123456789", content: "Test content", title: "Title with <tags>" },
            ];

            const result = nudgesFragment.template({ nudges });

            expect(result).toContain("title=\"Title with &lt;tags&gt;\"");
        });

        it("should escape ampersands in title attribute", () => {
            const nudges: NudgeData[] = [
                { id: "abc123456789", content: "Test content", title: "Title & more" },
            ];

            const result = nudgesFragment.template({ nudges });

            expect(result).toContain('title="Title &amp; more"');
        });

        it("should escape id attribute values", () => {
            const nudges: NudgeData[] = [
                { id: 'id"with<special>&chars', content: "Test content" },
            ];

            const result = nudgesFragment.template({ nudges });

            expect(result).toContain('id="id&quot;with&lt;special&gt;&amp;chars"');
        });
    });

    describe("tool permissions rendering (aggregated header)", () => {
        describe("only-tool mode", () => {
            it("should show restricted tools in separate header block", () => {
                const nudges: NudgeData[] = [
                    { id: "abc123456789", content: "Do something", title: "Test Nudge" },
                ];
                const nudgeToolPermissions: NudgeToolPermissions = {
                    onlyTools: ["fs_read", "fs_write"],
                };

                const result = nudgesFragment.template({ nudges, nudgeToolPermissions });

                expect(result).toContain("<nudge-tool-permissions>");
                expect(result).toContain("Your available tools are restricted to: fs_read, fs_write");
                expect(result).toContain("</nudge-tool-permissions>");
                expect(result).toContain("<!-- Aggregated across all active nudges -->");
            });
        });

        describe("allow/deny mode", () => {
            it("should show enabled tools in header", () => {
                const nudges: NudgeData[] = [
                    { id: "abc123456789", content: "Do something" },
                ];
                const nudgeToolPermissions: NudgeToolPermissions = {
                    allowTools: ["shell", "delegate"],
                };

                const result = nudgesFragment.template({ nudges, nudgeToolPermissions });

                expect(result).toContain("<nudge-tool-permissions>");
                expect(result).toContain("Additional tools enabled: shell, delegate");
                expect(result).toContain("</nudge-tool-permissions>");
            });

            it("should show disabled tools in header", () => {
                const nudges: NudgeData[] = [
                    { id: "abc123456789", content: "Do something" },
                ];
                const nudgeToolPermissions: NudgeToolPermissions = {
                    denyTools: ["fs_write", "shell"],
                };

                const result = nudgesFragment.template({ nudges, nudgeToolPermissions });

                expect(result).toContain("<nudge-tool-permissions>");
                expect(result).toContain("Tools disabled: fs_write, shell");
                expect(result).toContain("</nudge-tool-permissions>");
            });

            it("should show both enabled and disabled tools in header", () => {
                const nudges: NudgeData[] = [
                    { id: "abc123456789", content: "Do something" },
                ];
                const nudgeToolPermissions: NudgeToolPermissions = {
                    allowTools: ["delegate"],
                    denyTools: ["shell"],
                };

                const result = nudgesFragment.template({ nudges, nudgeToolPermissions });

                expect(result).toContain("<nudge-tool-permissions>");
                expect(result).toContain("Additional tools enabled: delegate");
                expect(result).toContain("Tools disabled: shell");
                expect(result).toContain("</nudge-tool-permissions>");
            });
        });

        describe("no tool permissions", () => {
            it("should not render permissions header when no permissions", () => {
                const nudges: NudgeData[] = [
                    { id: "abc123456789", content: "Do something" },
                ];

                const result = nudgesFragment.template({ nudges });

                expect(result).not.toContain("<nudge-tool-permissions>");
                expect(result).not.toContain("</nudge-tool-permissions>");
            });

            it("should not render permissions header when permissions are empty", () => {
                const nudges: NudgeData[] = [
                    { id: "abc123456789", content: "Do something" },
                ];
                const nudgeToolPermissions: NudgeToolPermissions = {};

                const result = nudgesFragment.template({ nudges, nudgeToolPermissions });

                expect(result).not.toContain("<nudge-tool-permissions>");
                expect(result).not.toContain("</nudge-tool-permissions>");
            });
        });

        describe("multiple nudges with permissions", () => {
            it("should render permissions BEFORE nudges as a header block", () => {
                const nudges: NudgeData[] = [
                    { id: "aaa111111111", content: "First nudge", title: "First" },
                    { id: "bbb222222222", content: "Second nudge", title: "Second" },
                ];
                const nudgeToolPermissions: NudgeToolPermissions = {
                    onlyTools: ["fs_read"],
                };

                const result = nudgesFragment.template({ nudges, nudgeToolPermissions });

                // Count occurrences of permissions header
                const permMatches = result.match(/<nudge-tool-permissions>/g) || [];
                expect(permMatches.length).toBe(1); // Only one permissions block

                // Verify it appears BEFORE all nudges
                const permIndex = result.indexOf("<nudge-tool-permissions>");
                const firstNudgeIndex = result.indexOf('<nudge id="aaa111111111"');
                const secondNudgeIndex = result.indexOf('<nudge id="bbb222222222"');

                expect(permIndex).toBeLessThan(firstNudgeIndex);
                expect(permIndex).toBeLessThan(secondNudgeIndex);
            });

            it("should not embed permissions inside individual nudges", () => {
                const nudges: NudgeData[] = [
                    { id: "aaa111111111", content: "First nudge", title: "First" },
                    { id: "bbb222222222", content: "Second nudge", title: "Second" },
                ];
                const nudgeToolPermissions: NudgeToolPermissions = {
                    allowTools: ["shell"],
                };

                const result = nudgesFragment.template({ nudges, nudgeToolPermissions });

                // Get the content of just the first nudge
                const firstNudgeStart = result.indexOf('<nudge id="aaa111111111"');
                const firstNudgeEnd = result.indexOf('</nudge>', firstNudgeStart) + '</nudge>'.length;
                const firstNudgeContent = result.substring(firstNudgeStart, firstNudgeEnd);

                // No tools info inside the nudge tag itself
                expect(firstNudgeContent).not.toContain("Additional tools enabled");
                expect(firstNudgeContent).not.toContain("<nudge-tool-permissions>");
            });
        });
    });

    describe("validation", () => {
        it("should validate nudgeContent as string", () => {
            expect(nudgesFragment.validateArgs({ nudgeContent: "test" })).toBe(true);
        });

        it("should validate nudges array with id", () => {
            expect(nudgesFragment.validateArgs({ nudges: [] })).toBe(true);
            expect(nudgesFragment.validateArgs({ nudges: [{ id: "abc123456789", content: "test" }] })).toBe(true);
        });

        it("should validate nudge with optional title", () => {
            expect(nudgesFragment.validateArgs({
                nudges: [{ id: "abc123456789", content: "test", title: "My Title" }],
            })).toBe(true);
        });

        it("should validate combined args", () => {
            expect(nudgesFragment.validateArgs({
                nudgeContent: "test",
                nudges: [{ id: "abc123456789", content: "test" }],
                nudgeToolPermissions: { onlyTools: ["fs_read"] },
            })).toBe(true);
        });

        it("should accept empty object (all fields optional)", () => {
            expect(nudgesFragment.validateArgs({})).toBe(true);
        });

        it("should reject null and undefined", () => {
            expect(nudgesFragment.validateArgs(null)).toBe(false);
            expect(nudgesFragment.validateArgs(undefined)).toBe(false);
        });

        it("should reject invalid nudgeContent type", () => {
            expect(nudgesFragment.validateArgs({ nudgeContent: 123 })).toBe(false);
        });

        it("should reject nudges that is not an array", () => {
            expect(nudgesFragment.validateArgs({ nudges: "not an array" })).toBe(false);
            expect(nudgesFragment.validateArgs({ nudges: {} })).toBe(false);
        });

        it("should reject nudge without id field", () => {
            expect(nudgesFragment.validateArgs({
                nudges: [{ content: "test" }],
            })).toBe(false);
        });

        it("should reject nudge without content field", () => {
            expect(nudgesFragment.validateArgs({
                nudges: [{ id: "abc123456789", title: "no content" }],
            })).toBe(false);
        });

        it("should reject nudge with non-string content", () => {
            expect(nudgesFragment.validateArgs({
                nudges: [{ id: "abc123456789", content: 123 }],
            })).toBe(false);
        });

        it("should reject nudge with non-string title", () => {
            expect(nudgesFragment.validateArgs({
                nudges: [{ id: "abc123456789", content: "test", title: 123 }],
            })).toBe(false);
        });

        it("should reject nudge with non-string id", () => {
            expect(nudgesFragment.validateArgs({
                nudges: [{ id: 123, content: "test" }],
            })).toBe(false);
        });
    });
});
