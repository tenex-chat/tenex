import * as crypto from "node:crypto";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentHomeDirectory } from "@/lib/agent-home";
import { ensureDirectory } from "@/lib/fs";
import { slugifyIdentifier } from "@/lib/string";
import { getNDK } from "@/nostr";
import { NDKKind } from "@/nostr/kinds";
import { config } from "@/services/ConfigService";
import { NudgeSkillWhitelistService } from "@/services/nudge/NudgeWhitelistService";
import {
    type ParsedSkillDocument,
    parseSkillDocument,
    serializeSkillDocument,
    type StoredSkillMetadata,
} from "./SkillFrontmatterParser";
import type {
    SkillData,
    SkillFileInfo,
    SkillFileInstallResult,
    SkillLookupContext,
    SkillResult,
} from "./types";
import { logger } from "@/utils/logger";
import { SpanStatusCode, context as otelContext, trace } from "@opentelemetry/api";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { shortenEventId } from "@/utils/conversation-id";

const tracer = trace.getTracer("tenex.skill-service");

const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_DOWNLOAD_SIZE_BYTES = 10 * 1024 * 1024;
const SKILL_CONTENT_FILENAME = "SKILL.md";
const AVAILABLE_SKILLS_CACHE_TTL_MS = 5_000;
const FULL_EVENT_ID_REGEX = /^[0-9a-f]{64}$/;

interface LocalSkillRecord {
    id: string;
    dir: string;
    scope: SkillStoreScope;
    metadata?: StoredSkillMetadata;
}

type SkillStoreScope = "agent" | "project-repo" | "project" | "global" | "legacy-agents";

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
 * Service for resolving the effective local skill set across agent, project-repo,
 * project, global directories, plus the shared ~/.agents fallback.
 *
 * Remote kind:4202 skills still hydrate into the global store at
 * $TENEX_BASE_DIR/skills/<id>/SKILL.md.
 *
 * When the same local skill ID exists in multiple scopes, precedence is:
 * agent > project-repo > project > global > ~/.agents.
 */
export class SkillService {
    private static instance: SkillService;
    private static ndkProvider: typeof getNDK = getNDK;
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
     * Reset singleton state and restore default dependencies.
     * Test-only hook to keep suite-level module mocks from leaking into SkillService.
     */
    static resetInstance(): void {
        SkillService.instance = undefined as unknown as SkillService;
        SkillService.ndkProvider = getNDK;
    }

    /**
     * Override the NDK provider for tests.
     */
    static setNDKProviderForTesting(provider: typeof getNDK): void {
        SkillService.ndkProvider = provider;
        SkillService.instance = undefined as unknown as SkillService;
    }

    private getNDK(): ReturnType<typeof getNDK> {
        return SkillService.ndkProvider();
    }

    private buildAvailableSkillsCacheKey(lookupContext: SkillLookupContext = {}): string {
        return JSON.stringify({
            agentPubkey: lookupContext.agentPubkey?.trim() || "",
            projectDTag: lookupContext.projectDTag?.trim() || "",
            projectPath: lookupContext.projectPath
                ? path.resolve(lookupContext.projectPath)
                : "",
        });
    }

    private cloneSkillData(skill: SkillData): SkillData {
        return {
            ...skill,
            installedFiles: skill.installedFiles.map((file) => ({ ...file })),
        };
    }

    private cloneSkillDataArray(skills: SkillData[]): SkillData[] {
        return skills.map((skill) => this.cloneSkillData(skill));
    }

    private invalidateAvailableSkillsCache(): void {
        this.availableSkillsCache.clear();
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

    private async getGlobalSkillsBaseDir(ensureExists = true): Promise<string> {
        const skillsDir = config.getConfigPath("skills");
        if (ensureExists) {
            await ensureDirectory(skillsDir);
        }
        return skillsDir;
    }

    private async getProjectSkillsBaseDir(
        projectDTag: string,
        ensureExists = false
    ): Promise<string> {
        const skillsDir = path.join(config.getConfigPath("projects"), projectDTag, "skills");
        if (ensureExists) {
            await ensureDirectory(skillsDir);
        }
        return skillsDir;
    }

    private async getProjectRepoSkillsBaseDir(
        projectPath: string,
        ensureExists = false
    ): Promise<string> {
        const skillsDir = path.join(projectPath, "skills");
        if (ensureExists) {
            await ensureDirectory(skillsDir);
        }
        return skillsDir;
    }

    private async getAgentSkillsBaseDir(
        agentPubkey: string,
        ensureExists = false
    ): Promise<string> {
        const skillsDir = path.join(getAgentHomeDirectory(agentPubkey), "skills");
        if (ensureExists) {
            await ensureDirectory(skillsDir);
        }
        return skillsDir;
    }

    private async getLegacyAgentsSkillsBaseDir(ensureExists = false): Promise<string> {
        const skillsDir = config.getLegacyAgentsSkillsPath();
        if (ensureExists) {
            await ensureDirectory(skillsDir);
        }
        return skillsDir;
    }

    private async getSkillsBaseDir(): Promise<string> {
        return this.getGlobalSkillsBaseDir(true);
    }

    private async getSkillDir(skillId: string, ensureExists = true): Promise<string> {
        const baseDir = await this.getSkillsBaseDir();
        const skillDir = path.join(baseDir, skillId);
        if (ensureExists) {
            await ensureDirectory(skillDir);
        }
        return skillDir;
    }

    private async getLookupDirectories(
        lookupContext: SkillLookupContext = {}
    ): Promise<SkillStoreDirectory[]> {
        const directories: SkillStoreDirectory[] = [];

        if (lookupContext.agentPubkey) {
            directories.push({
                scope: "agent",
                dir: await this.getAgentSkillsBaseDir(lookupContext.agentPubkey),
            });
        }

        if (lookupContext.projectPath) {
            directories.push({
                scope: "project-repo",
                dir: await this.getProjectRepoSkillsBaseDir(lookupContext.projectPath),
            });
        }

        if (lookupContext.projectDTag) {
            directories.push({
                scope: "project",
                dir: await this.getProjectSkillsBaseDir(lookupContext.projectDTag),
            });
        }

        directories.push({
            scope: "global",
            dir: await this.getGlobalSkillsBaseDir(true),
        });

        directories.push({
            scope: "legacy-agents",
            dir: await this.getLegacyAgentsSkillsBaseDir(false),
        });

        return directories;
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

    private async listAllLocalSkillRecords(
        lookupContext: SkillLookupContext = {}
    ): Promise<LocalSkillRecord[]> {
        const records: LocalSkillRecord[] = [];
        const directories = await this.getLookupDirectories(lookupContext);

        for (const directory of directories) {
            records.push(...await this.listLocalSkillRecordsInDirectory(directory));
        }

        return records;
    }

    private async listVisibleLocalSkillRecords(
        lookupContext: SkillLookupContext = {}
    ): Promise<LocalSkillRecord[]> {
        const visibleById = new Map<string, LocalSkillRecord>();
        const records = await this.listAllLocalSkillRecords(lookupContext);

        for (const record of records) {
            if (!visibleById.has(record.id)) {
                visibleById.set(record.id, record);
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
        sourceEventId?: string,
        currentDir = skillDir
    ): Promise<SkillFileInstallResult[]> {
        const entries = await fs.readdir(currentDir, { withFileTypes: true });
        const files: SkillFileInstallResult[] = [];

        for (const entry of entries) {
            const entryPath = path.join(currentDir, entry.name);
            const relativePath = path.relative(skillDir, entryPath);

            if (await this.isDirectoryEntry(entry, currentDir)) {
                files.push(...await this.listLocalSkillFiles(skillDir, sourceEventId, entryPath));
                continue;
            }

            if (
                relativePath === SKILL_CONTENT_FILENAME
            ) {
                continue;
            }

            files.push({
                eventId: sourceEventId,
                relativePath,
                absolutePath: entryPath,
                success: true,
            });
        }

        return files;
    }

    private mergeInstalledFiles(
        localFiles: SkillFileInstallResult[],
        hydrationFiles: SkillFileInstallResult[]
    ): SkillFileInstallResult[] {
        const merged = new Map<string, SkillFileInstallResult>();

        for (const file of localFiles) {
            merged.set(file.relativePath, file);
        }

        for (const file of hydrationFiles) {
            merged.set(file.relativePath, file);
        }

        return Array.from(merged.values());
    }

    private async loadLocalSkillRecord(record: LocalSkillRecord): Promise<SkillData | null> {
        const skillDir = record.dir;

        try {
            const skillDocument = await this.readSkillDocument(skillDir);
            if (!skillDocument) {
                return null;
            }
            const metadata = record.metadata ?? skillDocument.metadata;
            const whitelistedDescription = metadata?.eventId
                ? this.getWhitelistedSkillDescription(metadata.eventId)
                : undefined;
            const description = whitelistedDescription ?? metadata?.description;
            const installedFiles = await this.listLocalSkillFiles(skillDir, metadata?.eventId);

            return {
                identifier: record.id,
                eventId: metadata?.eventId,
                description,
                content: skillDocument.content,
                name: metadata?.name,
                installedFiles,
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

    private async findLocalSkillBySourceIdentifier(
        identifier: string,
        lookupContext: SkillLookupContext = {}
    ): Promise<SkillData | null> {
        const normalizedIdentifier = identifier.trim().toLowerCase();
        if (!normalizedIdentifier) {
            return null;
        }

        const records = await this.listAllLocalSkillRecords(lookupContext);

        for (const record of records) {
            const eventId = record.metadata?.eventId?.toLowerCase();
            const shortId = record.metadata?.eventId
                ? shortenEventId(record.metadata.eventId).toLowerCase()
                : undefined;

            if (eventId === normalizedIdentifier || shortId === normalizedIdentifier) {
                return this.loadLocalSkillRecord(record);
            }
        }

        return null;
    }

    private resolveRemoteSkillEventId(identifier: string): string | null {
        const normalizedIdentifier = identifier.trim().toLowerCase();
        if (!normalizedIdentifier) {
            return null;
        }

        if (FULL_EVENT_ID_REGEX.test(normalizedIdentifier)) {
            return normalizedIdentifier;
        }

        const availableSkills = NudgeSkillWhitelistService.getInstance().getWhitelistedSkills();
        for (const skill of availableSkills) {
            const aliases = [skill.identifier, skill.shortId, skill.eventId];
            if (aliases.some((alias) => alias?.toLowerCase() === normalizedIdentifier)) {
                return skill.eventId;
            }
        }

        return null;
    }

    private async isHydrationTargetAvailable(skillId: string, eventId: string): Promise<boolean> {
        const skillDir = await this.getSkillDir(skillId, false);

        try {
            const stats = await fs.stat(skillDir);
            if (!stats.isDirectory()) {
                return false;
            }
        } catch {
            return true;
        }

        const metadata = await this.readSkillMetadata(skillDir);
        return metadata?.eventId === eventId;
    }

    private async resolveHydratedSkillId(event: NDKEvent): Promise<string> {
        const existingSkill = await this.findLocalSkillBySourceIdentifier(event.id);
        if (existingSkill?.identifier) {
            return existingSkill.identifier;
        }

        const shortId = shortenEventId(event.id);
        const preferredSlug = slugifyIdentifier(
            event.tagValue("title") ||
            event.tagValue("name") ||
            event.tagValue("d") ||
            ""
        );
        const baseCandidates = [
            preferredSlug,
            shortId,
            preferredSlug ? `${preferredSlug}-${shortId}` : undefined,
            `skill-${shortId}`,
        ].filter((candidate): candidate is string => Boolean(candidate));

        for (const candidate of baseCandidates) {
            if (await this.isHydrationTargetAvailable(candidate, event.id)) {
                return candidate;
            }
        }

        let counter = 1;
        const fallbackBase = preferredSlug || "skill";
        while (true) {
            const candidate = `${fallbackBase}-${shortId}-${counter}`;
            if (await this.isHydrationTargetAvailable(candidate, event.id)) {
                return candidate;
            }
            counter += 1;
        }
    }

    private extractFileETags(event: NDKEvent): string[] {
        return event.tags
            .filter((tag) => tag[0] === "e" && tag[1])
            .map((tag) => tag[1]);
    }

    private getHydratedSkillDescription(event: NDKEvent, content: string): string | undefined {
        const whitelistedDescription = this.getWhitelistedSkillDescription(event.id);

        if (whitelistedDescription) {
            return whitelistedDescription;
        }

        const tagDescription = event.tagValue("description") || event.tagValue("summary") || "";
        const trimmedTagDescription = tagDescription.trim();
        if (trimmedTagDescription) {
            return trimmedTagDescription;
        }

        const fallbackDescription = content
            .split("\n")
            .map((line) => line.trim())
            .find((line) => line.length > 0);

        return fallbackDescription?.slice(0, 1024) || undefined;
    }

    private getWhitelistedSkillDescription(eventId: string): string | undefined {
        const description = NudgeSkillWhitelistService
            .getInstance()
            .getWhitelistedSkills()
            .find((skill) => skill.eventId === eventId)
            ?.description
            ?.trim();

        return description || undefined;
    }

    private extractFileInfo(event: NDKEvent): SkillFileInfo | null {
        const url = event.tagValue("url");
        const relativePath = event.tagValue("name");

        if (!url || !relativePath) {
            logger.warn(`[SkillService] Kind 1063 event ${event.id} missing required tags`, {
                hasUrl: !!url,
                hasName: !!relativePath,
            });
            return null;
        }

        return {
            eventId: event.id,
            url,
            relativePath,
            mimeType: event.tagValue("m") || undefined,
            sha256: event.tagValue("x") || undefined,
        };
    }

    private async installSkillFiles(
        fileEventIds: string[],
        skillId: string
    ): Promise<SkillFileInstallResult[]> {
        if (fileEventIds.length === 0) {
            return [];
        }

        const results: SkillFileInstallResult[] = [];
        const ndk = this.getNDK();
        const skillDir = await this.getSkillDir(skillId);

        for (const eventId of fileEventIds) {
            try {
                const fileEvent = await ndk.fetchEvent(eventId, { groupable: false });

                if (!fileEvent) {
                    throw new Error(`[SkillService] Could not fetch event ${eventId}`);
                }

                if (fileEvent.kind !== 1063) {
                    throw new Error(
                        `[SkillService] Event ${eventId} is not kind:1063 (got kind:${fileEvent.kind})`
                    );
                }

                const fileInfo = this.extractFileInfo(fileEvent);
                if (!fileInfo) {
                    throw new Error(
                        `[SkillService] Missing required tags (url, name) in kind:1063 event ${eventId}`
                    );
                }

                const result = await this.installFile(fileInfo, skillDir);
                results.push(result);
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                results.push({
                    eventId,
                    relativePath: eventId,
                    absolutePath: path.resolve(skillDir, eventId),
                    success: false,
                    error: `[SkillService] Failed to install skill file ${eventId}: ${errorMessage}`,
                });
            }
        }

        const successCount = results.filter((result) => result.success).length;
        const failCount = results.filter((result) => !result.success).length;

        if (failCount > 0) {
            logger.warn("[SkillService] Skill file installation completed with errors", {
                skillId,
                success: successCount,
                failed: failCount,
            });
        } else if (successCount > 0) {
            logger.info("[SkillService] All skill files installed successfully", {
                skillId,
                count: successCount,
            });
        }

        return results;
    }

    private async installFile(
        fileInfo: SkillFileInfo,
        skillDir: string
    ): Promise<SkillFileInstallResult> {
        const resolvedSkillDir = path.resolve(skillDir);
        const absolutePath = path.resolve(skillDir, fileInfo.relativePath);

        try {
            const relativeToBoundary = path.relative(resolvedSkillDir, absolutePath);
            if (relativeToBoundary.startsWith("..") || path.isAbsolute(relativeToBoundary)) {
                throw new Error(
                    `Security violation: path "${fileInfo.relativePath}" would escape skill directory`
                );
            }

            await ensureDirectory(path.dirname(absolutePath));

            logger.debug(`[SkillService] Downloading file from ${fileInfo.url}`);
            const content = await this.downloadFile(fileInfo.url);

            if (fileInfo.sha256) {
                const actualHash = crypto.createHash("sha256").update(content).digest("hex");
                if (actualHash.toLowerCase() !== fileInfo.sha256.toLowerCase()) {
                    throw new Error(
                        `SHA-256 hash mismatch: expected ${fileInfo.sha256}, got ${actualHash}`
                    );
                }
            }

            await fs.writeFile(absolutePath, content);

            return {
                eventId: fileInfo.eventId,
                relativePath: fileInfo.relativePath,
                absolutePath,
                success: true,
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error(`[SkillService] Failed to install skill file: ${fileInfo.relativePath}`, {
                eventId: fileInfo.eventId,
                error: errorMessage,
            });

            return {
                eventId: fileInfo.eventId,
                relativePath: fileInfo.relativePath,
                absolutePath,
                success: false,
                error: errorMessage,
            };
        }
    }

    private async downloadFile(url: string): Promise<Buffer> {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

        try {
            const response = await fetch(url, {
                headers: {
                    "User-Agent": "TENEX/1.0 (Skill Service)",
                },
                signal: controller.signal,
            });

            if (!response.ok) {
                throw new Error(`Failed to download: ${response.status} ${response.statusText}`);
            }

            const contentLength = response.headers.get("Content-Length");
            if (contentLength) {
                const declaredSize = Number.parseInt(contentLength, 10);
                if (declaredSize > MAX_DOWNLOAD_SIZE_BYTES) {
                    throw new Error(
                        `File too large: ${declaredSize} bytes exceeds ${MAX_DOWNLOAD_SIZE_BYTES} byte limit`
                    );
                }
            }

            const reader = response.body?.getReader();
            if (!reader) {
                throw new Error("Response body is not readable");
            }

            const chunks: Uint8Array[] = [];
            let totalSize = 0;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                totalSize += value.length;
                if (totalSize > MAX_DOWNLOAD_SIZE_BYTES) {
                    reader.cancel();
                    throw new Error(
                        `File too large: exceeded ${MAX_DOWNLOAD_SIZE_BYTES} byte limit during download`
                    );
                }
                chunks.push(value);
            }

            return Buffer.concat(chunks);
        } catch (error) {
            if (error instanceof Error && error.name === "AbortError") {
                throw new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS}ms`, {
                    cause: error,
                });
            }
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }

    private async hydrateSkillEvent(event: NDKEvent): Promise<SkillData | null> {
        const skillId = await this.resolveHydratedSkillId(event);
        const skillDir = await this.getSkillDir(skillId);
        const content = event.content.trim();
        const name =
            event.tagValue("name") || event.tagValue("title") || skillId;
        const description = this.getHydratedSkillDescription(event, content);

        await fs.writeFile(
            this.getSkillContentPath(skillDir),
            serializeSkillDocument(content, {
                eventId: event.id,
                name,
                description: description ?? skillId,
            })
        );

        const hydrationResults = await this.installSkillFiles(
            this.extractFileETags(event),
            skillId
        );
        this.invalidateAvailableSkillsCache();

        const localSkill = await this.loadLocalSkillById(skillId);
        if (!localSkill) {
            return null;
        }

        return {
            ...localSkill,
            installedFiles: this.mergeInstalledFiles(localSkill.installedFiles, hydrationResults),
        };
    }

    private async resolveAndLoadSkill(
        skillIdentifier: string,
        lookupContext: SkillLookupContext = {}
    ): Promise<SkillData | null> {
        const trimmedIdentifier = skillIdentifier.trim();
        if (!trimmedIdentifier) {
            return null;
        }

        const localSkill = await this.loadLocalSkillById(trimmedIdentifier, lookupContext);
        if (localSkill) {
            return localSkill;
        }

        const hydratedSkill = await this.findLocalSkillBySourceIdentifier(
            trimmedIdentifier,
            lookupContext
        );
        if (hydratedSkill) {
            return hydratedSkill;
        }

        const remoteEventId = this.resolveRemoteSkillEventId(trimmedIdentifier);
        if (!remoteEventId) {
            return null;
        }

        const existingHydratedSkill = await this.findLocalSkillBySourceIdentifier(
            remoteEventId,
            lookupContext
        );
        if (existingHydratedSkill) {
            return existingHydratedSkill;
        }

        const remoteSkill = await this.fetchSkill(remoteEventId);
        if (!remoteSkill) {
            return null;
        }

        return this.hydrateSkillEvent(remoteSkill);
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
            return this.cloneSkillDataArray(await inFlight.promise);
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

        const span = tracer.startSpan(
            "tenex.skill.fetch_skills",
            {
                attributes: {
                    "skill.requested_count": skillIdentifiers.length,
                },
            },
            otelContext.active()
        );

        return otelContext.with(trace.setSpan(otelContext.active(), span), async () => {
            try {
                const skillDataArray: SkillData[] = [];
                const loadedSkillIds = new Set<string>();

                for (const skillIdentifier of skillIdentifiers) {
                    const skillData = await this.resolveAndLoadSkill(
                        skillIdentifier,
                        lookupContext
                    );
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

                span.setAttributes({
                    "skill.fetched_count": skillDataArray.length,
                    "skill.content_length": concatenated.length,
                    "skill.names": skillDataArray
                        .map((skill) => skill.name || skill.identifier || "untitled")
                        .join(", "),
                    "skill.total_files": skillDataArray.reduce(
                        (count, skill) => count + skill.installedFiles.length,
                        0
                    ),
                });

                span.setStatus({ code: SpanStatusCode.OK });
                span.end();

                return {
                    skills: skillDataArray,
                    content: concatenated,
                    toolPermissions: {},
                };
            } catch (error) {
                span.recordException(error as Error);
                span.setStatus({
                    code: SpanStatusCode.ERROR,
                    message: (error as Error).message,
                });
                span.end();
                logger.error("[SkillService] Failed to fetch skills", { error });
                return emptyResult;
            }
        });
    }

    /**
     * Fetch a single skill event by canonical Nostr event ID.
     */
    async fetchSkill(eventId: string): Promise<NDKEvent | null> {
        try {
            const ndk = this.getNDK();
            const events = await ndk.fetchEvents({
                ids: [eventId],
            });

            const skill = Array.from(events).find((event) => event.kind === NDKKind.AgentSkill);
            return skill || null;
        } catch (error) {
            logger.error("[SkillService] Failed to fetch skill", { error, eventId });
            return null;
        }
    }
}
