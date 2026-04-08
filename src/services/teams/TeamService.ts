import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { readJsonFile } from "@/lib/fs/filesystem";
import { config as defaultConfig } from "@/services/ConfigService";
import type { ConfigService } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import type { Team } from "./types";
import type { TeamInfo } from "@/prompts/fragments/types";
import type { AgentInstance } from "@/agents/types";

// =============================================================================
// Schema
// =============================================================================

const TeamDefinitionSchema = z.object({
    description: z.string(),
    teamLead: z.string().min(1, "teamLead is required"),
    members: z.array(z.string()).optional().default([]),
});

const TeamsFileSchema = z.object({
    teams: z.record(z.string(), TeamDefinitionSchema),
});

// =============================================================================
// Types
// =============================================================================

interface FileState {
    mtimeMs: number;
    size: number;
}

interface TeamsCacheEntry {
    expiresAt: number;
    data: Team[];
    globalFileState: FileState | null;
    projectFileState: FileState | null;
}

// =============================================================================
// TeamService
// =============================================================================

export class TeamService {
    private readonly cache = new Map<string, TeamsCacheEntry>();
    private static readonly CACHE_TTL_MS = 30_000; // 30 seconds

    constructor(private readonly config: ConfigService = defaultConfig) {}

    // =========================================================================
    // Public API
    // =========================================================================

    /**
     * Load all teams for a project (or global only if no projectId).
     * Merges global + per-project files; per-project teams override global teams.
     */
    async getTeams(projectId?: string): Promise<Team[]> {
        const cacheKey = projectId ?? "__global__";
        return await this.loadAndCache(cacheKey, projectId);
    }

    /**
     * Look up a team by name (case-insensitive).
     */
    async getTeamByName(name: string, projectId?: string): Promise<Team | undefined> {
        const teams = await this.getTeams(projectId);
        const lower = name.toLowerCase();
        return teams.find((t) => t.name.toLowerCase() === lower);
    }

    /**
     * Return all teams that include the given agent slug.
     */
    async getTeamsForAgent(slug: string, projectId?: string): Promise<Team[]> {
        const teams = await this.getTeams(projectId);
        return teams.filter((t) => t.members.includes(slug));
    }

    /**
     * Resolve a team name to its team lead's slug.
     */
    async resolveTeamToLead(teamName: string, projectId?: string): Promise<string | undefined> {
        const team = await this.getTeamByName(teamName, projectId);
        return team?.teamLead;
    }

    /**
     * Return all team names (for error messages / autocomplete).
     */
    async getTeamNames(projectId?: string): Promise<string[]> {
        const teams = await this.getTeams(projectId);
        return teams.map((t) => t.name);
    }

    /**
     * Compute the prompt-facing TeamContext DTO.
     * Returns undefined if no teams exist or no available agents.
     */
    async computeTeamContext(params: {
        agentSlug: string;
        projectId: string;
        activeTeamName?: string;
        availableAgents: AgentInstance[];
    }): Promise<import("@/prompts/fragments/types").TeamContext | undefined> {
        const { agentSlug, projectId, activeTeamName, availableAgents } = params;

        if (availableAgents.length === 0) {
            return undefined;
        }

        const allTeams = await this.getTeams(projectId);
        if (allTeams.length === 0) {
            return undefined;
        }

        // Filter available agents to those matching real slugs
        const availableSlugs = new Set(availableAgents.map((a) => a.slug));

        // Warn about unknown slugs in team definitions
        for (const team of allTeams) {
            if (!availableSlugs.has(team.teamLead)) {
                logger.warn("Unknown agent slug in team definition", {
                    team: team.name,
                    slug: team.teamLead,
                    warning: "teamLead not found in available agents",
                });
            }
            for (const member of team.members) {
                if (!availableSlugs.has(member)) {
                    logger.warn("Unknown agent slug in team definition", {
                        team: team.name,
                        slug: member,
                        warning: "member not found in available agents",
                    });
                }
            }
        }

        const memberTeams = allTeams.filter((t) => t.members.includes(agentSlug));

        let activeTeam: Team | undefined;
        if (activeTeamName) {
            activeTeam = allTeams.find(
                (t) => t.name.toLowerCase() === activeTeamName.toLowerCase()
            );
        }

        // Determine teammates source
        let teammatesSlugs: string[];
        if (activeTeam) {
            // Scoped to active team
            teammatesSlugs = activeTeam.members.filter((s) => s !== agentSlug);
        } else {
            // Union of all member teams
            const seen = new Set<string>();
            for (const t of memberTeams) {
                for (const s of t.members) {
                    if (s !== agentSlug) seen.add(s);
                }
            }
            teammatesSlugs = [...seen];
        }

        const teammates = availableAgents.filter((a) => teammatesSlugs.includes(a.slug));

        const otherTeams = allTeams.filter(
            (t) => !memberTeams.some((mt) => mt.name === t.name)
        );

        // Unaffiliated: not in any team and not self
        const allTeamMembers = new Set<string>();
        for (const t of allTeams) {
            for (const s of t.members) {
                allTeamMembers.add(s);
            }
        }
        const unaffiliated = availableAgents.filter(
            (a) => a.slug !== agentSlug && !allTeamMembers.has(a.slug)
        );

        // Build TeamInfo arrays (plain primitives for prompt layer)
        const toTeamInfo = (t: Team): TeamInfo => ({
            name: t.name,
            description: t.description,
            teamLead: t.teamLead,
            members: t.members,
        });

        return {
            memberTeams: memberTeams.map(toTeamInfo),
            activeTeam: activeTeam ? toTeamInfo(activeTeam) : undefined,
            otherTeams: otherTeams.map(toTeamInfo),
            teammates,
            unaffiliated,
        };
    }

    // =========================================================================
    // Private: Cache
    // =========================================================================

    private async loadAndCache(key: string, projectId?: string): Promise<Team[]> {
        const globalFilePath = path.join(this.config.getConfigPath(), "teams.json");
        const projectFilePath = projectId
            ? path.join(this.config.getProjectMetadataPath(projectId), "teams.json")
            : null;

        // Stat both files to get current state
        const [globalFileState, projectFileState] = await Promise.all([
            this.statFile(globalFilePath),
            projectFilePath ? this.statFile(projectFilePath) : Promise.resolve(null),
        ]);

        // Check existing cache entry for state-change detection
        const existing = this.cache.get(key);
        if (existing) {
            const globalChanged =
                globalFileState === null
                    ? existing.globalFileState !== null
                    : existing.globalFileState === null ||
                      globalFileState.mtimeMs !== existing.globalFileState.mtimeMs ||
                      globalFileState.size !== existing.globalFileState.size;

            const projectChanged =
                projectFileState === null
                    ? existing.projectFileState !== null
                    : existing.projectFileState === null ||
                      projectFileState.mtimeMs !== existing.projectFileState.mtimeMs ||
                      projectFileState.size !== existing.projectFileState.size;

            if (!globalChanged && !projectChanged && Date.now() < existing.expiresAt) {
                return existing.data;
            }
        }

        // Load and merge — use file states from the actual read to avoid TOCTOU skew
        const {
            data,
            globalFileState: readGlobalState,
            projectFileState: readProjectState,
        } = await this.loadAndMergeTeams(globalFilePath, projectFilePath);

        this.cache.set(key, {
            expiresAt: Date.now() + TeamService.CACHE_TTL_MS,
            data,
            globalFileState: readGlobalState,
            projectFileState: readProjectState,
        });

        return data;
    }

    private async statFile(
        filePath: string
    ): Promise<{ mtimeMs: number; size: number } | null> {
        try {
            const stats = await fsPromises.stat(filePath);
            return { mtimeMs: stats.mtimeMs, size: stats.size };
        } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                return null;
            }
            throw err;
        }
    }

    // =========================================================================
    // Private: Loading
    // =========================================================================

    private async loadAndMergeTeams(
        globalPath: string,
        projectPath: string | null
    ): Promise<{ data: Team[]; globalFileState: FileState | null; projectFileState: FileState | null }> {
        const [globalResult, projectResult] = await Promise.all([
            this.loadTeamsFile(globalPath),
            projectPath
                ? this.loadTeamsFile(projectPath)
                : Promise.resolve({ data: [] as Team[], fileState: null as FileState | null }),
        ]);

        // Merge: per-project overrides global
        const merged = new Map<string, Team>();
        for (const team of globalResult.data) {
            merged.set(team.name.toLowerCase(), team);
        }
        for (const team of projectResult.data) {
            merged.set(team.name.toLowerCase(), team);
        }

        return {
            data: [...merged.values()],
            globalFileState: globalResult.fileState,
            projectFileState: projectResult.fileState,
        };
    }

    private async loadTeamsFile(
        filePath: string
    ): Promise<{ data: Team[]; fileState: FileState | null }> {
        // TOCTOU-fix: stat first, then read
        let fileState: FileState | null;
        try {
            const stats = await fsPromises.stat(filePath);
            fileState = { mtimeMs: stats.mtimeMs, size: stats.size };
        } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                return { data: [], fileState: null };
            }
            throw err;
        }

        // readJsonFile returns null for ENOENT and throws for JSON parse errors.
        // Both cases degrade to empty so a malformed file never crashes the service.
        let raw: unknown;
        try {
            raw = await readJsonFile<unknown>(filePath);
        } catch {
            logger.warn("Could not read teams file, returning empty teams", {
                filePath,
                warning: "file read or parse failure",
            });
            return { data: [], fileState };
        }
        if (raw === null) {
            // File disappeared between stat and read (TOCTOU)
            return { data: [], fileState };
        }

        // Validate with Zod
        const parseResult = TeamsFileSchema.safeParse(raw);
        if (!parseResult.success) {
            logger.warn("Teams file validation failed, returning empty teams", {
                filePath,
                error: parseResult.error.message,
                warning: "schema validation failure",
            });
            return { data: [], fileState };
        }

        const teams: Team[] = [];
        const parsed = parseResult.data;

        for (const [name, definition] of Object.entries(parsed.teams)) {
            // Validate individual slugs are non-empty
            if (!definition.teamLead || definition.teamLead.trim() === "") {
                logger.warn("Empty teamLead slug, skipping team", {
                    filePath,
                    team: name,
                    slug: definition.teamLead,
                    warning: "empty slug in teamLead",
                });
                continue;
            }

            // Normalize: members defaults to [], then ensure teamLead is included
            const members = [...(definition.members ?? [])];
            if (!members.includes(definition.teamLead)) {
                members.push(definition.teamLead);
            }

            // Warn about empty/whitespace member slugs, but keep the team
            for (const member of members) {
                if (!member || member.trim() === "") {
                    logger.warn("Empty member slug in team", {
                        filePath,
                        team: name,
                        slug: member,
                        warning: "empty slug in members",
                    });
                }
            }

            // Filter out empty/whitespace slugs from members
            const validMembers = members.filter((s) => s && s.trim() !== "");

            teams.push({
                name,
                description: definition.description,
                teamLead: definition.teamLead.trim(),
                members: validMembers,
            });
        }

        return { data: teams, fileState };
    }
}

// Singleton instance
export const teamService = new TeamService();
