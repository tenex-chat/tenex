/** Raw shape of a team definition in teams.json — members is optional on disk */
export interface TeamDefinition {
    description: string;
    teamLead: string; // agent slug
    members?: string[]; // optional in file; normalized to string[] during load
}

/** Shape of teams.json files — team name is the key */
export interface TeamsFileSchema {
    teams: Record<string, TeamDefinition>;
}

/** Resolved team with its name attached — members is always present (normalized) */
export interface Team {
    name: string;
    description: string;
    teamLead: string; // agent slug
    members: string[]; // always non-optional after normalization (includes teamLead)
}
