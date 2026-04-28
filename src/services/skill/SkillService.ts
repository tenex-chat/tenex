import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentHomeDirectory, getShortPubkey } from "@/lib/agent-home";
import { homedir } from "node:os";
import {
    type ParsedSkillDocument,
    parseSkillDocument,
    type StoredSkillMetadata,
} from "./SkillFrontmatterParser";
import type {
    SkillData,
    SkillFileInstallResult,
    SkillLookupContext,
    SkillResult,
    SkillStoreScope,
} from "./types";
import { logger } from "@/utils/logger";
import { getTenexBasePath } from "@/constants";

const SKILL_CONTENT_FILENAME = "SKILL.md";
const AVAILABLE_SKILLS_CACHE_TTL_MS = 5_000;

interface LocalSkillRecord {
    id: string;
    dir: string;
    scope: SkillStoreScope;
    metadata?: StoredSkillMetadata;
}

interface SkillStoreDirectory {
    dir: string;
    scope: SkillStoreScope;
}

interface AvailableSkillsCacheEntry {
    signature: string;
    skills: SkillData[];
    expiresAt: number;
}

interface InFlightAvailableSkillsEntry {
    promise: Promise<SkillData[]>;
    signature: string;
}

/**
 * Service for resolving the effective local skill set across scoped directories.
 *
 * When the same local skill ID exists in multiple scopes, precedence is:
 * agent > agent-project > project > shared > built-in.
 */
export class SkillService {
    private static instance: SkillService;
    private availableSkillsCache = new Map<string, AvailableSkillsCacheEntry>();
    private inFlightAvailableSkills = new Map<string, InFlightAvailableSkillsEntry>();

    private constructor() {}

    static getInstance(): SkillService {
        if (!SkillService.instance) {
            SkillService.instance = new SkillService();
        }
        return SkillService.instance;
    }

    /**
     * Reset singleton state. Test-only hook.
     */
    static resetInstance(): void {
        SkillService.instance = undefined as unknown as SkillService;
    }

    private buildAvailableSkillsCacheKey(lookupContext: SkillLookupContext = {}): string {
        return JSON.stringify({
            agentPubkey: lookupContext.agentPubkey?.trim() || "",
            projectPath: lookupContext.projectPath
                ? path.resolve(lookupContext.projectPath)
                : "",
        });
    }

    private cloneSkillData(skill: SkillData): SkillData {
        return {
            ...skill,
            installedFiles: skill.installedFiles.map((file) => ({ ...file })),
            toolNames: skill.toolNames ? [...skill.toolNames] : undefined,
            // loadedTools are intentionally NOT cloned — they are runtime-only
            // and populated by SkillToolLoader at RAL setup time
            loadedTools: undefined,
        };
    }

    private cloneSkillDataArray(skills: SkillData[]): SkillData[] {
        return skills.map((skill) => this.cloneSkillData(skill));
    }

    private async buildAvailableSkillsSignature(
        lookupContext: SkillLookupContext = {}
    ): Promise<string> {
        const directories = await this.getLookupDirectories(lookupContext);
        const visibleSignatures = new Map<string, string>();

        for (const directory of directories) {
            let entries: Dirent[];
            try {
                entries = await fs.readdir(directory.dir, { withFileTypes: true });
            } catch (error) {
                if (this.isMissingDirectoryError(error)) {
                    continue;
                }
                throw error;
            }

            entries.sort((a, b) => a.name.localeCompare(b.name));

            for (const entry of entries) {
                if (visibleSignatures.has(entry.name)) {
                    continue;
                }

                if (!(await this.isDirectoryEntry(entry, directory.dir))) {
                    continue;
                }

                const skillDir = path.join(directory.dir, entry.name);
                try {
                    const stats = await fs.stat(this.getSkillContentPath(skillDir));
                    visibleSignatures.set(
                        entry.name,
                        [
                            directory.scope,
                            entry.name,
                            stats.size,
                            stats.mtimeMs,
                        ].join(":")
                    );
                } catch {
                    continue;
                }
            }
        }

        return Array.from(visibleSignatures.values()).join("|");
    }

    private getAgentSkillsBaseDir(agentPubkey: string): string {
        return path.join(getAgentHomeDirectory(agentPubkey), "skills");
    }

    private getAgentProjectSkillsBaseDir(projectPath: string, agentPubkey: string): string {
        return path.join(projectPath, ".agents", getShortPubkey(agentPubkey), "skills");
    }

    private getProjectSharedSkillsBaseDir(projectPath: string): string {
        return path.join(projectPath, ".agents", "skills");
    }

    private getSharedSkillsBaseDir(): string {
        return path.join(homedir(), ".agents", "skills");
    }

    private async getLookupDirectories(
        lookupContext: SkillLookupContext = {}
    ): Promise<SkillStoreDirectory[]> {
        const directories: SkillStoreDirectory[] = [];

        directories.push({
            scope: "built-in",
            dir: await this.getBuiltInSkillsBaseDir(),
        });

        if (lookupContext.agentPubkey) {
            directories.push({
                scope: "agent",
                dir: this.getAgentSkillsBaseDir(lookupContext.agentPubkey),
            });
        }

        if (lookupContext.projectPath && lookupContext.agentPubkey) {
            directories.push({
                scope: "agent-project",
                dir: this.getAgentProjectSkillsBaseDir(lookupContext.projectPath, lookupContext.agentPubkey),
            });
        }

        if (lookupContext.projectPath) {
            directories.push({
                scope: "project",
                dir: this.getProjectSharedSkillsBaseDir(lookupContext.projectPath),
            });
        }

        directories.push({
            scope: "shared",
            dir: this.getSharedSkillsBaseDir(),
        });

        return directories;
    }

    private async getBuiltInSkillsBaseDir(): Promise<string> {
        const bundledDir = path.join(getTenexBasePath(), "skills", "built-in");
        if (await this.directoryExists(bundledDir)) {
            return bundledDir;
        }

        const candidates = [
            path.resolve(import.meta.dirname, "../../skills/built-in"),
            path.resolve(import.meta.dirname, "../src/skills/built-in"),
        ];

        for (const candidate of candidates) {
            if (await this.directoryExists(candidate)) {
                return candidate;
            }
        }

        return bundledDir;
    }

    private async directoryExists(dirPath: string): Promise<boolean> {
        try {
            const stats = await fs.stat(dirPath);
            return stats.isDirectory();
        } catch (error) {
            if (this.isMissingDirectoryError(error)) {
                return false;
            }
            throw error;
        }
    }

    private isMissingDirectoryError(error: unknown): boolean {
        if (typeof error === "object" && error !== null) {
            const code = (error as { code?: unknown }).code;
            if (code === "ENOENT") {
                return true;
            }
        }

        return error instanceof Error && error.message.includes("ENOENT");
    }

    private getSkillContentPath(skillDir: string): string {
        return path.join(skillDir, SKILL_CONTENT_FILENAME);
    }

    private async readSkillDocument(skillDir: string): Promise<ParsedSkillDocument | null> {
        try {
            const raw = await fs.readFile(this.getSkillContentPath(skillDir), "utf-8");
            return parseSkillDocument(raw);
        } catch {
            return null;
        }
    }

    private async readSkillMetadata(skillDir: string): Promise<StoredSkillMetadata | undefined> {
        const document = await this.readSkillDocument(skillDir);
        return document?.metadata;
    }

    private async isDirectoryEntry(entry: Dirent, parentDir: string): Promise<boolean> {
        if (entry.isDirectory()) {
            return true;
        }
        if (entry.isSymbolicLink?.()) {
            try {
                const resolved = await fs.stat(path.join(parentDir, entry.name));
                return resolved.isDirectory();
            } catch {
                return false;
            }
        }
        return false;
    }

    private async listLocalSkillRecordsInDirectory(
        directory: SkillStoreDirectory
    ): Promise<LocalSkillRecord[]> {
        let entries: Dirent[];
        try {
            entries = await fs.readdir(directory.dir, { withFileTypes: true });
        } catch (error) {
            if (this.isMissingDirectoryError(error)) {
                return [];
            }
            throw error;
        }

        const records: LocalSkillRecord[] = [];

        for (const entry of entries) {
            if (!(await this.isDirectoryEntry(entry, directory.dir))) {
                continue;
            }

            const skillDir = path.join(directory.dir, entry.name);
            try {
                await fs.access(this.getSkillContentPath(skillDir));
            } catch {
                continue;
            }

            records.push({
                id: entry.name,
                dir: skillDir,
                scope: directory.scope,
                metadata: await this.readSkillMetadata(skillDir),
            });
        }

        return records.sort((a, b) => a.id.localeCompare(b.id));
    }

    private async listVisibleLocalSkillRecords(
        lookupContext: SkillLookupContext = {}
    ): Promise<LocalSkillRecord[]> {
        const visibleById = new Map<string, LocalSkillRecord>();
        const directories = await this.getLookupDirectories(lookupContext);

        for (const directory of directories) {
            const records = await this.listLocalSkillRecordsInDirectory(directory);
            for (const record of records) {
                if (!visibleById.has(record.id)) {
                    visibleById.set(record.id, record);
                }
            }
        }

        return Array.from(visibleById.values()).sort((a, b) => a.id.localeCompare(b.id));
    }

    private async findLocalSkillRecordById(
        skillId: string,
        lookupContext: SkillLookupContext = {}
    ): Promise<LocalSkillRecord | null> {
        const trimmedSkillId = skillId.trim();
        if (!trimmedSkillId) {
            return null;
        }

        const directories = await this.getLookupDirectories(lookupContext);

        for (const directory of directories) {
            const skillDir = path.join(directory.dir, trimmedSkillId);
            try {
                await fs.access(this.getSkillContentPath(skillDir));
                return {
                    id: trimmedSkillId,
                    dir: skillDir,
                    scope: directory.scope,
                    metadata: await this.readSkillMetadata(skillDir),
                };
            } catch {
                continue;
            }
        }

        return null;
    }

    private async listLocalSkillFiles(
        skillDir: string,
        currentDir = skillDir
    ): Promise<SkillFileInstallResult[]> {
        const entries = await fs.readdir(currentDir, { withFileTypes: true });
        const files: SkillFileInstallResult[] = [];

        for (const entry of entries) {
            const entryPath = path.join(currentDir, entry.name);
            const relativePath = path.relative(skillDir, entryPath);

            if (await this.isDirectoryEntry(entry, currentDir)) {
                files.push(...await this.listLocalSkillFiles(skillDir, entryPath));
                continue;
            }

            if (relativePath === SKILL_CONTENT_FILENAME) {
                continue;
            }

            files.push({
                relativePath,
                absolutePath: entryPath,
                success: true,
            });
        }

        return files;
    }

    private async loadLocalSkillRecord(record: LocalSkillRecord): Promise<SkillData | null> {
        const skillDir = record.dir;

        try {
            const skillDocument = await this.readSkillDocument(skillDir);
            if (!skillDocument) {
                return null;
            }
            const metadata = record.metadata ?? skillDocument.metadata;
            const installedFiles = await this.listLocalSkillFiles(skillDir);

            return {
                identifier: record.id,
                description: metadata?.description,
                content: skillDocument.content,
                name: metadata?.name,
                installedFiles,
                scope: record.scope,
                localDir: skillDir,
                toolNames: metadata?.tools,
            };
        } catch {
            return null;
        }
    }

    private async loadLocalSkillById(
        skillId: string,
        lookupContext: SkillLookupContext = {}
    ): Promise<SkillData | null> {
        const record = await this.findLocalSkillRecordById(skillId, lookupContext);
        if (!record) {
            return null;
        }

        return this.loadLocalSkillRecord(record);
    }

    async listAvailableSkills(lookupContext: SkillLookupContext = {}): Promise<SkillData[]> {
        const cacheKey = this.buildAvailableSkillsCacheKey(lookupContext);
        const cached = this.availableSkillsCache.get(cacheKey);
        const now = Date.now();

        if (cached && cached.expiresAt > now) {
            return this.cloneSkillDataArray(cached.skills);
        }

        const signature = await this.buildAvailableSkillsSignature(lookupContext);

        if (cached && cached.signature === signature) {
            cached.expiresAt = Date.now() + AVAILABLE_SKILLS_CACHE_TTL_MS;
            return this.cloneSkillDataArray(cached.skills);
        }

        const inFlight = this.inFlightAvailableSkills.get(cacheKey);
        if (inFlight && inFlight.signature === signature) {
            const skills = await inFlight.promise;
            return this.cloneSkillDataArray(skills);
        }

        const loadPromise = (async () => {
            const records = await this.listVisibleLocalSkillRecords(lookupContext);
            const skills = await Promise.all(records.map((record) => this.loadLocalSkillRecord(record)));
            return skills.filter((skill): skill is SkillData => skill !== null);
        })();

        this.inFlightAvailableSkills.set(cacheKey, {
            promise: loadPromise,
            signature,
        });

        try {
            const skills = await loadPromise;
            this.availableSkillsCache.set(cacheKey, {
                signature,
                skills,
                expiresAt: Date.now() + AVAILABLE_SKILLS_CACHE_TTL_MS,
            });

            return this.cloneSkillDataArray(skills);
        } finally {
            const currentInFlight = this.inFlightAvailableSkills.get(cacheKey);
            if (currentInFlight?.promise === loadPromise) {
                this.inFlightAvailableSkills.delete(cacheKey);
            }
        }
    }

    async fetchSkills(
        skillIdentifiers: string[],
        lookupContext: SkillLookupContext = {}
    ): Promise<SkillResult> {
        const emptyResult: SkillResult = {
            skills: [],
            content: "",
            toolPermissions: {},
        };

        if (skillIdentifiers.length === 0) {
            return emptyResult;
        }

        try {
            const skillDataArray: SkillData[] = [];
            const loadedSkillIds = new Set<string>();

            for (const skillIdentifier of skillIdentifiers) {
                const trimmed = skillIdentifier.trim();
                if (!trimmed) {
                    continue;
                }

                const skillData = await this.loadLocalSkillById(trimmed, lookupContext);
                if (!skillData) {
                    continue;
                }

                if (loadedSkillIds.has(skillData.identifier)) {
                    continue;
                }

                loadedSkillIds.add(skillData.identifier);
                skillDataArray.push(skillData);
            }

            const concatenated = skillDataArray
                .map((data) => data.content)
                .filter((content) => content.length > 0)
                .join("\n\n");

            return {
                skills: skillDataArray,
                content: concatenated,
                toolPermissions: {},
            };
        } catch (error) {
            logger.error("[SkillService] Failed to fetch skills", { error });
            return emptyResult;
        }
    }
}
