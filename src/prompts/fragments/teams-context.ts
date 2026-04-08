/**
 * Teams Context Fragment
 *
 * A lightweight summary of team membership and active team scope.
 * This is rendered separately from the main project-context fragment
 * to provide a quick overview of team structure.
 */

import type { TeamInfo } from "./types";

export interface TeamsContextArgs {
    /** Teams the current agent belongs to */
    teams: TeamInfo[];
    /** The currently active team name (from [team] tag on triggering event) */
    activeTeam?: string;
}

/**
 * Renders a simple team membership summary for the system prompt.
 * Returns an empty string if there are no teams and no active team.
 */
export function render(args: TeamsContextArgs): string {
    const { teams, activeTeam } = args;

    if (teams.length === 0 && !activeTeam) {
        return "";
    }

    const parts: string[] = [];

    parts.push("```xml");
    parts.push("<teams-context>");

    // Team membership line
    const teamNames = teams.map((t) => t.name);
    parts.push(`You belong to teams: ${teamNames.join(", ")}`);

    // Per-team summary
    for (const team of teams) {
        const isActive = team.name === activeTeam;
        const marker = isActive ? " (active)" : "";
        parts.push(
            `${team.name}${marker}: lead=${team.teamLead}, members=${team.members.join(", ")}`
        );
    }

    parts.push("</teams-context>");
    parts.push("```");

    return parts.join("\n");
}
