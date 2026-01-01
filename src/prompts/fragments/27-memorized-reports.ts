import type { ReportInfo } from "@/services/reports/ReportService";
import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";

/**
 * Memorized reports fragment - injects reports marked with memorize=true
 * into the agent's system prompt for persistent context.
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

        const parts: string[] = [];
        parts.push("## Memorized Knowledge\n");
        parts.push(
            "The following reports have been memorized and represent persistent knowledge for your role:\n"
        );

        for (const report of reports) {
            parts.push(`### ${report.title || report.slug}`);
            if (report.summary) {
                parts.push(`*${report.summary}*\n`);
            }
            if (report.content) {
                parts.push(report.content);
            }
            parts.push(""); // Empty line between reports
        }

        return parts.join("\n");
    },
};

// Register the fragment
fragmentRegistry.register(memorizedReportsFragment);
