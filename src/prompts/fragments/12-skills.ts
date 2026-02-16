import type { SkillData } from "@/services/skill";
import type { PromptFragment } from "../core/types";

interface SkillsArgs {
    /** Legacy: concatenated skill content (for backward compatibility) */
    skillContent?: string;
    /** Individual skill data with title, content, and files */
    skills?: SkillData[];
}

/**
 * Escape XML attribute value to prevent injection
 */
function escapeAttrValue(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

/**
 * Render a single skill with its title, content, and attached files.
 * Title is escaped to prevent XML injection.
 */
function renderSkill(skill: SkillData): string {
    const parts: string[] = [];

    // Build attributes
    const attrs: string[] = [];
    if (skill.title) {
        attrs.push(`title="${escapeAttrValue(skill.title)}"`);
    }
    if (skill.name) {
        attrs.push(`name="${escapeAttrValue(skill.name)}"`);
    }
    attrs.push(`id="${skill.shortId}"`);

    const attrStr = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";

    parts.push(`<transient-skill${attrStr}>`);
    parts.push(skill.content);

    // List installed files if any
    const successfulFiles = skill.installedFiles.filter((f) => f.success);
    if (successfulFiles.length > 0) {
        parts.push("");
        parts.push("## Installed Files");
        parts.push("The following files have been downloaded for this skill:");
        for (const file of successfulFiles) {
            parts.push(`- \`${file.absolutePath}\``);
        }
    }

    // Note failed files if any
    const failedFiles = skill.installedFiles.filter((f) => !f.success);
    if (failedFiles.length > 0) {
        parts.push("");
        parts.push("## Failed File Downloads");
        for (const file of failedFiles) {
            parts.push(`- ${file.relativePath}: ${file.error}`);
        }
    }

    parts.push("</transient-skill>");

    return parts.join("\n");
}

/**
 * Fragment for injecting skill content into the system prompt.
 * Skills are kind:4202 events referenced via skill tags on the triggering event.
 * Their content is fetched, files are downloaded, and everything is injected
 * to provide transient capabilities/instructions.
 *
 * Unlike nudges, skills do NOT have tool permissions.
 * Skills focus on providing context, instructions, and attached files.
 */
export const skillsFragment: PromptFragment<SkillsArgs> = {
    id: "skills",
    priority: 12, // After nudges (11), before available-agents (15)
    template: ({ skillContent, skills }) => {
        // New rendering path: individual skills with their data
        if (skills && skills.length > 0) {
            const header = `## Loaded Transient Skills

The following skills have been loaded for this conversation. These provide additional context and capabilities:
`;
            const renderedSkills = skills.map((skill) => renderSkill(skill));
            return header + renderedSkills.join("\n\n");
        }

        // Legacy fallback: just skillContent string
        if (!skillContent || skillContent.trim().length === 0) {
            return "";
        }

        return `<transient-skills>
${skillContent}
</transient-skills>`;
    },
    validateArgs: (args: unknown): args is SkillsArgs => {
        if (typeof args !== "object" || args === null) return false;
        const a = args as Record<string, unknown>;
        // Optional: all fields are optional (empty skills is valid)
        // When skills array is provided, validate each element has required shape
        if (a.skills !== undefined) {
            if (!Array.isArray(a.skills)) return false;
            for (const skill of a.skills) {
                if (typeof skill !== "object" || skill === null) return false;
                const s = skill as Record<string, unknown>;
                // content and shortId are required
                if (typeof s.content !== "string") return false;
                if (typeof s.shortId !== "string") return false;
                // title and name are optional
                if (s.title !== undefined && typeof s.title !== "string") return false;
                if (s.name !== undefined && typeof s.name !== "string") return false;
                // installedFiles must be an array
                if (!Array.isArray(s.installedFiles)) return false;
            }
        }
        // skillContent must be string if provided
        if (a.skillContent !== undefined && typeof a.skillContent !== "string") return false;
        return true;
    },
    expectedArgs: "{ skillContent?: string; skills?: SkillData[] }",
};
