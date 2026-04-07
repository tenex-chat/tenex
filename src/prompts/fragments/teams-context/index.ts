import type { TeamInfo } from "../types";

export interface TeamsContextRenderOptions {
    teams: TeamInfo[];
    activeTeam?: string;
}

function isActiveTeam(team: TeamInfo, activeTeam?: string): boolean {
    if (!activeTeam) {
        return false;
    }

    return team.name.toLowerCase() === activeTeam.toLowerCase();
}

export function render(options: TeamsContextRenderOptions): string {
    const { teams, activeTeam } = options;

    if (teams.length === 0 && !activeTeam) {
        return "";
    }

    const lines: string[] = ["<teams-context>"];

    if (teams.length > 0) {
        lines.push(`  You belong to teams: ${teams.map((team) => team.name).join(", ")}`);
        lines.push("  Team members:");

        for (const team of teams) {
            const teamLabel = isActiveTeam(team, activeTeam) ? `${team.name} (active)` : team.name;
            lines.push(`    ${teamLabel}: lead=${team.teamLead}, members=${team.members.join(", ")}`);
        }
    }

    if (activeTeam && !teams.some((team) => isActiveTeam(team, activeTeam))) {
        lines.push(`  Active team: ${activeTeam}`);
    }

    lines.push("</teams-context>");
    return lines.join("\n");
}

export function buildTeamContext(options: TeamsContextRenderOptions): string {
    return render(options);
}
