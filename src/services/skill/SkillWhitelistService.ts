import * as fs from "node:fs";
import * as path from "node:path";
import { getTenexBasePath } from "@/constants";
import { NDKKind } from "@/nostr/kinds";
import { logger } from "@/utils/logger";
import type { SkillData } from "./types";

const SKILL_WHITELIST_SCHEMA_VERSION = 1;
const SKILL_WHITELIST_FILE_NAME = "skill-whitelist.json";

/**
 * Whitelisted skill item (kind:4202)
 */
export interface WhitelistItem {
    /** The event ID of the whitelisted skill */
    eventId: string;
    /** Prompt-facing identifier derived from d-tag/name/title, falling back to shortId */
    identifier?: string;
    /** Short event ID kept locally for fallback mapping/debugging */
    shortId?: string;
    /** The kind of the referenced event */
    kind: typeof NDKKind.AgentSkill;
    /** The name of the skill (from title tag) */
    name?: string;
    /** Description of the skill (full content - truncation is done in presentation layer) */
    description?: string;
    /** Pubkeys that have whitelisted this item (multiple whitelist events can reference same item) */
    whitelistedBy: string[];
}

/**
 * Cached whitelist data with fetch timestamp
 */
interface WhitelistCache {
    /** All whitelisted skills */
    skills: WhitelistItem[];
    /** The Rust snapshot updatedAt timestamp */
    lastUpdated: number;
}

interface SkillWhitelistSnapshot {
    schemaVersion: number;
    updatedAt: number;
    skills: WhitelistItem[];
}

/**
 * Service for reading skill whitelist state and installed skill aliases.
 *
 * Rust owns relay subscriptions and writes `$TENEX_BASE_DIR/daemon/skill-whitelist.json`.
 * This service only reads that filesystem snapshot and caches installed local skills
 * populated by `SkillService`.
 */
export class SkillWhitelistService {
    private static instance: SkillWhitelistService;
    private cache: WhitelistCache | null = null;
    private installedSkills: SkillData[] = [];
    private cacheFileMtimeMs: number | null = null;
    private lastReadWarningKey: string | null = null;

    private constructor() {}

    static getInstance(): SkillWhitelistService {
        if (!SkillWhitelistService.instance) {
            SkillWhitelistService.instance = new SkillWhitelistService();
        }
        return SkillWhitelistService.instance;
    }

    /**
     * Get all whitelisted skills from the Rust-authored filesystem snapshot.
     */
    getWhitelistedSkills(): WhitelistItem[] {
        this.refreshWhitelistCache();
        return this.cache?.skills || [];
    }

    /**
     * Get all whitelisted items.
     */
    getAllWhitelistedItems(): WhitelistItem[] {
        return this.getWhitelistedSkills();
    }

    /**
     * Get the currently cached installed skills used for alias expansion.
     */
    getInstalledSkills(): SkillData[] {
        return this.installedSkills;
    }

    /**
     * Update the cached installed skills used for alias expansion.
     */
    setInstalledSkills(skills: SkillData[]): void {
        this.installedSkills = skills.map((skill) => ({
            ...skill,
            installedFiles: skill.installedFiles.map((file) => ({ ...file })),
            toolNames: skill.toolNames ? [...skill.toolNames] : undefined,
        }));
    }

    /**
     * Check if a skill event ID is whitelisted.
     */
    isSkillWhitelisted(eventId: string): boolean {
        return this.getWhitelistedSkills().some((skill) => skill.eventId === eventId);
    }

    /**
     * Get the last Rust snapshot update time.
     */
    getLastUpdated(): number | null {
        this.refreshWhitelistCache();
        return this.cache?.lastUpdated || null;
    }

    /**
     * Clear cached filesystem and installed-skill state.
     * Used for cleanup during tests.
     */
    shutdown(): void {
        this.cache = null;
        this.installedSkills = [];
        this.cacheFileMtimeMs = null;
        this.lastReadWarningKey = null;
    }

    private getWhitelistPath(): string {
        return path.join(
            getTenexBasePath(),
            "daemon",
            SKILL_WHITELIST_FILE_NAME
        );
    }

    private refreshWhitelistCache(): void {
        const whitelistPath = this.getWhitelistPath();

        let stats: fs.Stats;
        try {
            stats = fs.statSync(whitelistPath);
        } catch (error) {
            if (this.isMissingFileError(error)) {
                this.cache = { skills: [], lastUpdated: 0 };
                this.cacheFileMtimeMs = null;
                return;
            }
            this.warnReadFailure(whitelistPath, error);
            this.cache = { skills: [], lastUpdated: 0 };
            this.cacheFileMtimeMs = null;
            return;
        }

        if (this.cache && this.cacheFileMtimeMs === stats.mtimeMs) {
            return;
        }

        try {
            const snapshot = JSON.parse(
                fs.readFileSync(whitelistPath, "utf-8")
            ) as unknown;
            this.cache = this.parseSnapshot(snapshot);
            this.cacheFileMtimeMs = stats.mtimeMs;
            this.lastReadWarningKey = null;
        } catch (error) {
            this.warnReadFailure(whitelistPath, error);
            this.cache = { skills: [], lastUpdated: 0 };
            this.cacheFileMtimeMs = stats.mtimeMs;
        }
    }

    private parseSnapshot(snapshot: unknown): WhitelistCache {
        if (typeof snapshot !== "object" || snapshot === null) {
            throw new Error("snapshot must be an object");
        }
        const candidate = snapshot as Partial<SkillWhitelistSnapshot>;
        if (candidate.schemaVersion !== SKILL_WHITELIST_SCHEMA_VERSION) {
            throw new Error(
                `unsupported schemaVersion ${String(candidate.schemaVersion)}`
            );
        }
        if (!Array.isArray(candidate.skills)) {
            throw new Error("snapshot skills must be an array");
        }

        return {
            skills: candidate.skills
                .filter((skill) => this.isValidWhitelistItem(skill))
                .map((skill) => ({
                    eventId: skill.eventId,
                    identifier: skill.identifier,
                    shortId: skill.shortId,
                    kind: skill.kind,
                    name: skill.name,
                    description: skill.description,
                    whitelistedBy: [...skill.whitelistedBy],
                })),
            lastUpdated: Number.isFinite(candidate.updatedAt) ? candidate.updatedAt! : 0,
        };
    }

    private isValidWhitelistItem(skill: unknown): skill is WhitelistItem {
        if (typeof skill !== "object" || skill === null) {
            return false;
        }
        const candidate = skill as Partial<WhitelistItem>;
        return (
            typeof candidate.eventId === "string" &&
            candidate.kind === NDKKind.AgentSkill &&
            Array.isArray(candidate.whitelistedBy) &&
            candidate.whitelistedBy.every((pubkey) => typeof pubkey === "string")
        );
    }

    private isMissingFileError(error: unknown): boolean {
        return (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            (error as { code?: unknown }).code === "ENOENT"
        );
    }

    private warnReadFailure(whitelistPath: string, error: unknown): void {
        const message = error instanceof Error ? error.message : String(error);
        const warningKey = `${whitelistPath}:${message}`;
        if (this.lastReadWarningKey === warningKey) {
            return;
        }
        this.lastReadWarningKey = warningKey;
        logger.warn("[SkillWhitelistService] Failed to read skill whitelist cache", {
            path: whitelistPath,
            error: message,
        });
    }
}
