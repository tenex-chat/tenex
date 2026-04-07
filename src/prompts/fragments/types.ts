import type { AgentInstance } from "@/agents/types";

/**
 * Prompt-facing representation of a team — uses plain primitives,
 * no service-layer types. Defined here to avoid cross-layer imports.
 */
export interface TeamInfo {
    name: string;
    description: string;
    teamLead: string;
    members: string[];
}

/**
 * Precomputed team context for prompt rendering — avoids service calls in fragments.
 *
 * Semantic distinction between MEMBERSHIP and ACTIVE SCOPE:
 * - "membership" = teams the agent actually belongs to (via members array)
 * - "active scope" = the team context the agent is currently operating in
 *
 * When an active team tag is present on the incoming event:
 *   - `activeTeam` = that team (even if agent is not a member)
 *   - `memberTeams` = agent's actual membership (may be empty, may include activeTeam)
 *   - Teammates are drawn from the active team
 *
 * When no active team tag:
 *   - `activeTeam` = undefined
 *   - `memberTeams` = all teams the agent belongs to
 *   - Teammates are the union of all memberTeams
 */
export interface TeamContext {
    /** Teams the current agent actually belongs to (via members array) */
    memberTeams: TeamInfo[];
    /** The team context from the active [team] tag on the incoming job event (may be set even if agent is not a member) */
    activeTeam: TeamInfo | undefined;
    /** Teams the current agent does NOT belong to */
    otherTeams: TeamInfo[];
    /** Agents in the active team (if activeTeam is set) or memberTeams (if not). Excludes self. */
    teammates: AgentInstance[];
    /** Agents not in any team (exclude self) */
    unaffiliated: AgentInstance[];
}
