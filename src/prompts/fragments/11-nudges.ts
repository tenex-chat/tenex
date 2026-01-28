import type { NudgeToolPermissions, NudgeData } from "@/services/nudge";
import { isOnlyToolMode, hasToolPermissions } from "@/services/nudge";
import type { PromptFragment } from "../core/types";

interface NudgesArgs {
    /** Legacy: concatenated nudge content (for backward compatibility) */
    nudgeContent?: string;
    /** Individual nudge data with title and content */
    nudges?: NudgeData[];
    /** Tool permissions extracted from nudge events */
    nudgeToolPermissions?: NudgeToolPermissions;
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
 * Render aggregated tool permissions as a separate header block.
 * These permissions are collected from ALL active nudges and apply globally.
 */
function renderToolPermissionsHeader(permissions: NudgeToolPermissions): string {
    if (!hasToolPermissions(permissions)) {
        return "";
    }

    const lines: string[] = [];

    if (isOnlyToolMode(permissions)) {
        // only-tool mode: restricted to specific tools only
        lines.push(
            `Your available tools are restricted to: ${permissions.onlyTools!.join(", ")}`
        );
    } else {
        // allow/deny mode
        if (permissions.allowTools && permissions.allowTools.length > 0) {
            lines.push(`Additional tools enabled: ${permissions.allowTools.join(", ")}`);
        }
        if (permissions.denyTools && permissions.denyTools.length > 0) {
            lines.push(`Tools disabled: ${permissions.denyTools.join(", ")}`);
        }
    }

    if (lines.length === 0) {
        return "";
    }

    return `<nudge-tool-permissions>
<!-- Aggregated across all active nudges -->
${lines.join("\n")}
</nudge-tool-permissions>`;
}

/**
 * Render a single nudge with its title and content.
 * Title is escaped to prevent XML injection.
 */
function renderNudge(nudge: NudgeData): string {
    const titleAttr = nudge.title ? ` title="${escapeAttrValue(nudge.title)}"` : "";

    return `<nudge${titleAttr}>
${nudge.content}
</nudge>`;
}

/**
 * Fragment for injecting nudge content into the system prompt.
 * Nudges are kind:4201 events referenced via nudge tags on the triggering event.
 * Their content is fetched and injected to provide additional context/instructions.
 *
 * Now supports tool permissions rendering:
 * - For only-tool mode: Shows "This nudge restricts your normal tooling available to: ..."
 * - For allow/deny mode: Shows enabled/disabled tools separately
 */
export const nudgesFragment: PromptFragment<NudgesArgs> = {
    id: "nudges",
    priority: 11, // After referenced-article (10), before available-agents (15)
    template: ({ nudgeContent, nudges, nudgeToolPermissions }) => {
        // New rendering path: individual nudges with their data
        if (nudges && nudges.length > 0) {
            const parts: string[] = [];

            // Render tool permissions as a separate header block (aggregated across ALL nudges)
            if (nudgeToolPermissions) {
                const permissionsHeader = renderToolPermissionsHeader(nudgeToolPermissions);
                if (permissionsHeader) {
                    parts.push(permissionsHeader);
                }
            }

            // Render each nudge individually (without embedding permissions in each)
            const renderedNudges = nudges.map((nudge) => renderNudge(nudge));
            parts.push(...renderedNudges);

            return parts.join("\n\n");
        }

        // Legacy fallback: just nudgeContent string
        if (!nudgeContent || nudgeContent.trim().length === 0) {
            return "";
        }

        return `<nudges>
${nudgeContent}
</nudges>`;
    },
    validateArgs: (args: unknown): args is NudgesArgs => {
        if (typeof args !== "object" || args === null) return false;
        const a = args as Record<string, unknown>;
        // Optional: all fields are optional (empty nudge is valid)
        // When nudges array is provided, validate each element has required shape
        if (a.nudges !== undefined) {
            if (!Array.isArray(a.nudges)) return false;
            for (const nudge of a.nudges) {
                if (typeof nudge !== "object" || nudge === null) return false;
                const n = nudge as Record<string, unknown>;
                // content is required, title is optional
                if (typeof n.content !== "string") return false;
                if (n.title !== undefined && typeof n.title !== "string") return false;
            }
        }
        // nudgeContent must be string if provided
        if (a.nudgeContent !== undefined && typeof a.nudgeContent !== "string") return false;
        return true;
    },
    expectedArgs: "{ nudgeContent?: string; nudges?: NudgeData[]; nudgeToolPermissions?: NudgeToolPermissions }",
};
