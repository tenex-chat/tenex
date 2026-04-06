import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";
import {
    parseSkillDocument,
    parseSkillFrontmatter,
    serializeSkillDocument,
} from "../SkillFrontmatterParser";

describe("SkillFrontmatterParser", () => {
    it("parses skill frontmatter metadata and block scalar values", () => {
        const metadata = parseSkillFrontmatter([
            "name: \"example-skill\" # trailing comment",
            "description: |",
            "  Line one",
            "  Line two",
            "metadata:",
            "  tenex-event-id: \"event-123\"",
        ].join("\n"));

        expect(metadata).toEqual({
            eventId: "event-123",
            name: "example-skill",
            description: "Line one\nLine two",
        });
    });

    it("round-trips serialized skill documents", () => {
        const serialized = serializeSkillDocument("  Body content  \n", {
            eventId: "event-abc",
            name: "round-trip",
            description: "Round trip description",
        });

        const parsed = parseSkillDocument(serialized);

        expect(parsed).toEqual({
            content: "Body content",
            metadata: {
                eventId: "event-abc",
                name: "round-trip",
                description: "Round trip description",
            },
        });
    });

    it("returns trimmed content when frontmatter is missing", () => {
        expect(parseSkillDocument("  plain content  \n")).toEqual({
            content: "plain content",
        });
    });

    it("parses metadata nested block when metadata line has an inline comment", () => {
        const metadata = parseSkillFrontmatter(
            [
                "name: \"my-skill\"",
                "metadata: # source event",
                "  tenex-event-id: abc123",
            ].join("\n")
        );

        expect(metadata).toEqual({
            name: "my-skill",
            eventId: "abc123",
        });
    });

    it("parses block scalar with 4-space indentation correctly", () => {
        const metadata = parseSkillFrontmatter(
            [
                "name: \"my-skill\"",
                "description: |",
                "    line one",
                "    line two",
            ].join("\n")
        );

        expect(metadata).toEqual({
            name: "my-skill",
            description: "line one\nline two",
        });
    });

    it("uses slug-safe names for all built-in skills", async () => {
        const builtInSkillsPath = path.resolve(
            path.dirname(fileURLToPath(import.meta.url)),
            "../../../skills/built-in"
        );
        const entries = await readdir(builtInSkillsPath, { withFileTypes: true });

        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }

            const skillPath = path.join(builtInSkillsPath, entry.name, "SKILL.md");
            const document = await readFile(skillPath, "utf8");
            const parsed = parseSkillDocument(document);

            expect(parsed.metadata?.name).toBe(entry.name);
            expect(parsed.metadata?.name).toMatch(/^[a-z0-9-]+$/);
        }
    });
});
