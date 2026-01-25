import type { ReportInfo } from "@/services/reports/ReportService";
import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";

/**
 * Memorized reports fragment - injects reports marked with memorize=true or memorize_team=true
 * into the agent's system prompt for persistent context.
 *
 * - memorize=true: Report is only injected into the authoring agent's system prompt
 * - memorize_team=true: Report is injected into ALL agents' system prompts in the project
 */
interface MemorizedReportsArgs {
    reports: ReportInfo[];
}

export const memorizedReportsFragment: PromptFragment<MemorizedReportsArgs> = {
    id: "memorized-reports",
    priority: 27, // After RAG instructions, before worktree context
    template: ({ reports }) => {
        if (!reports || reports.length === 0) {
            return ""; // No memorized reports
        }

        // Separate team-wide reports from agent-specific reports
        const teamReports = reports.filter((r) => r.isMemorizedTeam);
        const agentReports = reports.filter((r) => !r.isMemorizedTeam);

        const parts: string[] = [];
        parts.push("## Memorized Knowledge\n");

        // Add team-wide reports first (if any)
        if (teamReports.length > 0) {
            parts.push("### Team-Wide Knowledge\n");
            parts.push("*The following knowledge is shared across ALL agents in this project:*\n");

            for (const report of teamReports) {
                parts.push(`#### ${report.title || report.slug}`);
                if (report.summary) {
                    parts.push(`*${report.summary}*\n`);
                }
                if (report.content) {
                    parts.push(report.content);
                }
                parts.push(""); // Empty line between reports
            }
        }

        // Add agent-specific reports (if any)
        if (agentReports.length > 0) {
            if (teamReports.length > 0) {
                parts.push("### Agent-Specific Knowledge\n");
                parts.push("*The following knowledge is specific to your role:*\n");
            } else {
                parts.push(
                    "The following reports have been memorized and represent persistent knowledge for your role:\n"
                );
            }

            for (const report of agentReports) {
                const heading = teamReports.length > 0 ? "####" : "###";
                parts.push(`${heading} ${report.title || report.slug}`);
                if (report.summary) {
                    parts.push(`*${report.summary}*\n`);
                }
                if (report.content) {
                    parts.push(report.content);
                }
                parts.push(""); // Empty line between reports
            }
        }

        return parts.join("\n");
    },
};

// Register the fragment
fragmentRegistry.register(memorizedReportsFragment);
