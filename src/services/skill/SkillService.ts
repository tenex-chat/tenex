import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { getNDK } from "@/nostr";
import { NDKKind } from "@/nostr/kinds";
import { getTenexBasePath } from "@/constants";
import { ensureDirectory } from "@/lib/fs";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { SpanStatusCode, context as otelContext, trace } from "@opentelemetry/api";
import type { SkillResult, SkillData, SkillFileInfo, SkillFileInstallResult } from "./types";

const tracer = trace.getTracer("tenex.skill-service");

const DOWNLOAD_TIMEOUT_MS = 30_000;
/** Maximum file download size: 10MB */
const MAX_DOWNLOAD_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * Service for fetching and processing Agent Skill events (kind:4202)
 * Single Responsibility: Retrieve skill content, download attached files,
 * and prepare for system prompt injection.
 *
 * Skills are stored in .tenex/skills/<short-id>/ directory structure.
 */
export class SkillService {
    private static instance: SkillService;

    private constructor() {}

    static getInstance(): SkillService {
        if (!SkillService.instance) {
            SkillService.instance = new SkillService();
        }
        return SkillService.instance;
    }

    /**
     * Get the base directory for skill files
     * @returns Path to .tenex/skills/
     */
    private async getSkillsBaseDir(): Promise<string> {
        const basePath = getTenexBasePath();
        const skillsDir = path.join(basePath, "skills");
        await ensureDirectory(skillsDir);
        return skillsDir;
    }

    /**
     * Get the directory for a specific skill
     * @param shortId Short event ID (first 12 chars)
     * @returns Path to .tenex/skills/<short-id>/
     */
    private async getSkillDir(shortId: string): Promise<string> {
        const baseDir = await this.getSkillsBaseDir();
        const skillDir = path.join(baseDir, shortId);
        await ensureDirectory(skillDir);
        return skillDir;
    }

    /**
     * Fetch skill events by IDs and process their content and attached files.
     *
     * @param eventIds Array of skill event IDs to fetch
     * @returns SkillResult with skills data and concatenated content
     */
    async fetchSkills(eventIds: string[]): Promise<SkillResult> {
        const emptyResult: SkillResult = {
            skills: [],
            content: "",
        };

        if (eventIds.length === 0) {
            return emptyResult;
        }

        const span = tracer.startSpan("tenex.skill.fetch_skills", {
            attributes: {
                "skill.requested_count": eventIds.length,
            },
        }, otelContext.active());

        return otelContext.with(trace.setSpan(otelContext.active(), span), async () => {
            try {
                const ndk = getNDK();
                const skillEvents = await ndk.fetchEvents({
                    ids: eventIds,
                });

                const skills = Array.from(skillEvents);

                // Filter to only kind:4202 events
                const validSkills = skills.filter((event) => event.kind === NDKKind.AgentSkill);

                // Process each skill and its attached files
                const skillDataArray: SkillData[] = [];

                for (const skill of validSkills) {
                    const skillData = await this.processSkillEvent(skill);
                    if (skillData) {
                        skillDataArray.push(skillData);
                    }
                }

                // Concatenate content for backward compatibility
                const concatenated = skillDataArray
                    .map((data) => data.content)
                    .filter((content) => content.length > 0)
                    .join("\n\n");

                const skillTitles = skillDataArray
                    .map((s) => s.title || s.name || "untitled")
                    .join(", ");

                span.setAttributes({
                    "skill.fetched_count": validSkills.length,
                    "skill.content_length": concatenated.length,
                    "skill.titles": skillTitles,
                    "skill.total_files": skillDataArray.reduce(
                        (acc, s) => acc + s.installedFiles.length,
                        0
                    ),
                });

                span.setStatus({ code: SpanStatusCode.OK });
                span.end();

                return {
                    skills: skillDataArray,
                    content: concatenated,
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
     * Process a single skill event: extract content, metadata, and download attached files.
     *
     * @param event The skill event (kind:4202)
     * @returns SkillData or null if invalid
     */
    private async processSkillEvent(event: NDKEvent): Promise<SkillData | null> {
        const content = event.content.trim();
        const title = event.tagValue("title") || undefined;
        const name = event.tagValue("name") || undefined;
        const shortId = event.id.substring(0, 12);

        // Extract e-tags that reference kind:1063 (NIP-94 file metadata) events
        const fileETags = this.extractFileETags(event);

        // Download and install attached files
        const installedFiles = await this.installSkillFiles(fileETags, shortId);

        return {
            content,
            title,
            name,
            shortId,
            installedFiles,
        };
    }

    /**
     * Extract e-tags from a skill event that reference kind:1063 file metadata events.
     * Format: ["e", "<event-id>", "<relay-url>?"]
     *
     * NOTE: Relay hints (tag[2]) are parsed but not currently used. NDK's fetchEvent
     * handles relay discovery automatically through our connected relay pool. Adding
     * explicit relay hints would require significant refactoring and the current approach
     * works well for events that are available on commonly-connected relays.
     *
     * @param event The skill event
     * @returns Array of event IDs to fetch
     */
    private extractFileETags(event: NDKEvent): string[] {
        return event.tags
            .filter((tag) => tag[0] === "e" && tag[1])
            .map((tag) => tag[1]);
    }

    /**
     * Fetch and install files referenced by e-tags in a skill event.
     *
     * @param fileEventIds Array of event IDs referencing kind:1063 events
     * @param shortId Short skill ID for directory naming
     * @returns Array of installation results
     */
    private async installSkillFiles(
        fileEventIds: string[],
        shortId: string
    ): Promise<SkillFileInstallResult[]> {
        if (fileEventIds.length === 0) {
            return [];
        }

        const results: SkillFileInstallResult[] = [];
        const ndk = getNDK();
        const skillDir = await this.getSkillDir(shortId);

        for (const eventId of fileEventIds) {
            try {
                // Fetch the kind:1063 file metadata event
                const fileEvent = await ndk.fetchEvent(eventId, { groupable: false });

                if (!fileEvent) {
                    results.push({
                        eventId,
                        relativePath: "unknown",
                        absolutePath: "unknown",
                        success: false,
                        error: `Could not fetch event ${eventId}`,
                    });
                    continue;
                }

                // Verify it's a kind:1063 event
                if (fileEvent.kind !== 1063) {
                    results.push({
                        eventId,
                        relativePath: "unknown",
                        absolutePath: "unknown",
                        success: false,
                        error: `Event ${eventId} is not kind:1063 (got kind:${fileEvent.kind})`,
                    });
                    continue;
                }

                // Extract file info from the event
                const fileInfo = this.extractFileInfo(fileEvent);
                if (!fileInfo) {
                    results.push({
                        eventId,
                        relativePath: "unknown",
                        absolutePath: "unknown",
                        success: false,
                        error: "Missing required tags (url, name) in kind:1063 event",
                    });
                    continue;
                }

                // Download and install the file
                const result = await this.installFile(fileInfo, skillDir);
                results.push(result);
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                results.push({
                    eventId,
                    relativePath: "unknown",
                    absolutePath: "unknown",
                    success: false,
                    error: errorMessage,
                });
            }
        }

        // Log summary
        const successCount = results.filter((r) => r.success).length;
        const failCount = results.filter((r) => !r.success).length;

        if (failCount > 0) {
            logger.warn(`[SkillService] Skill file installation completed with errors`, {
                skillId: shortId,
                success: successCount,
                failed: failCount,
            });
        } else if (successCount > 0) {
            logger.info(`[SkillService] All skill files installed successfully`, {
                skillId: shortId,
                count: successCount,
            });
        }

        return results;
    }

    /**
     * Extract file information from a kind:1063 (NIP-94) event.
     *
     * Expected tags:
     * - ["url", "https://blossom.server/sha256"] - Required: Blossom download URL
     * - ["name", "relative/path/file.ext"] - Required: Relative filepath
     * - ["m", "text/plain"] - Optional: MIME type
     * - ["x", "sha256hash"] - Optional: SHA-256 hash for verification
     *
     * @param event The kind:1063 event
     * @returns SkillFileInfo or null if required tags are missing
     */
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

    /**
     * Download and install a single file to the skill directory.
     *
     * @param fileInfo Information about the file to install
     * @param skillDir Base directory for this skill
     * @returns Installation result
     */
    private async installFile(
        fileInfo: SkillFileInfo,
        skillDir: string
    ): Promise<SkillFileInstallResult> {
        // Resolve to absolute path, normalizing any ../ components
        const resolvedSkillDir = path.resolve(skillDir);
        const absolutePath = path.resolve(skillDir, fileInfo.relativePath);

        try {
            // Security check: ensure the resolved path stays within the skill directory
            // Using path.relative and checking for ".." prefix is more robust than startsWith
            const relativeToBoundary = path.relative(resolvedSkillDir, absolutePath);
            if (relativeToBoundary.startsWith("..") || path.isAbsolute(relativeToBoundary)) {
                throw new Error(
                    `Security violation: path "${fileInfo.relativePath}" would escape skill directory`
                );
            }

            // Create parent directories
            const parentDir = path.dirname(absolutePath);
            await ensureDirectory(parentDir);

            // Download the file with size limit
            logger.debug(`[SkillService] Downloading file from ${fileInfo.url}`);
            const content = await this.downloadFile(fileInfo.url);

            // Verify SHA-256 hash if provided (NIP-94 "x" tag)
            if (fileInfo.sha256) {
                const actualHash = crypto.createHash("sha256").update(content).digest("hex");
                if (actualHash.toLowerCase() !== fileInfo.sha256.toLowerCase()) {
                    throw new Error(
                        `SHA-256 hash mismatch: expected ${fileInfo.sha256}, got ${actualHash}`
                    );
                }
                logger.debug(`[SkillService] SHA-256 verification passed for ${fileInfo.relativePath}`);
            }

            // Write the file
            await fs.writeFile(absolutePath, content);

            logger.info(`[SkillService] Installed skill file: ${fileInfo.relativePath}`, {
                eventId: fileInfo.eventId,
                absolutePath,
                size: content.length,
            });

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

    /**
     * Download a file from a Blossom URL with size limit enforcement.
     *
     * @param url The Blossom URL to download from
     * @returns The downloaded file content as a Buffer
     * @throws Error if download exceeds MAX_DOWNLOAD_SIZE_BYTES
     */
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

            // Check Content-Length header first if available
            const contentLength = response.headers.get("Content-Length");
            if (contentLength) {
                const declaredSize = parseInt(contentLength, 10);
                if (declaredSize > MAX_DOWNLOAD_SIZE_BYTES) {
                    throw new Error(
                        `File too large: ${declaredSize} bytes exceeds ${MAX_DOWNLOAD_SIZE_BYTES} byte limit`
                    );
                }
            }

            // Stream the response and enforce size limit during download
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
                throw new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS}ms`);
            }
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }

    /**
     * Fetch a single skill event by ID.
     *
     * @param eventId The skill event ID
     * @returns The skill event or null if not found
     */
    async fetchSkill(eventId: string): Promise<NDKEvent | null> {
        try {
            const ndk = getNDK();
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
