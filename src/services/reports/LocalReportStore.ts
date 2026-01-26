import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, relative, basename, dirname } from "node:path";
import { isPathWithinDirectory } from "@/lib/agent-home";
import { logger } from "@/utils/logger";

/**
 * Error thrown when a slug fails validation
 */
export class InvalidSlugError extends Error {
    constructor(slug: string, reason: string) {
        super(`Invalid report slug "${slug}": ${reason}`);
        this.name = "InvalidSlugError";
    }
}

/**
 * Metadata stored alongside each local report to track its Nostr origin
 */
export interface LocalReportMetadata {
    /** Addressable reference in NIP-33 format (kind:pubkey:identifier) */
    addressableRef: string;
    /** Unix timestamp when the report was created/published */
    createdAt: number;
    /** The slug (d-tag) of the report */
    slug: string;
}


/**
 * LocalReportStore manages local file storage for reports.
 *
 * Reports are stored at: $TENEX_BASE_DIR/projects/<projectDTag>/reports/<slug>.md
 * Metadata is stored at: $TENEX_BASE_DIR/projects/<projectDTag>/reports/.metadata/<slug>.json
 *
 * This provides:
 * - Fast local reads without Nostr lookups
 * - Single source of truth for multi-agent collaboration
 * - Backwards compatibility via subscription hydration
 * - Project isolation to prevent d-tag conflicts across projects
 */
export class LocalReportStore {
    private _basePath: string | null = null;
    private _projectId: string | null = null;

    /**
     * Initialize the store for a project.
     * Must be called once at startup before using any methods.
     * @param metadataPath The project metadata path (e.g., ~/.tenex/projects/<dTag>)
     */
    initialize(metadataPath: string): void {
        this._basePath = dirname(metadataPath);  // ~/.tenex/projects
        this._projectId = basename(metadataPath); // <dTag>
        logger.info(`[LocalReportStore] Initialized for project ${this._projectId}`, {
            basePath: this._basePath,
            projectId: this._projectId,
        });
    }

    /**
     * Check if the store has been initialized
     */
    isInitialized(): boolean {
        return this._projectId !== null && this._basePath !== null;
    }

    /**
     * Get the project ID (d-tag)
     */
    get projectId(): string | null {
        return this._projectId;
    }

    /**
     * Get the path to the reports directory
     * Requires initialization with a project context
     */
    getReportsDir(): string {
        if (!this._basePath || !this._projectId) {
            throw new Error("LocalReportStore.initialize() must be called before getReportsDir()");
        }
        return join(this._basePath, this._projectId, "reports");
    }

    /**
     * Get the path to the metadata directory
     */
    private getMetadataDir(): string {
        if (!this._basePath || !this._projectId) {
            throw new Error("LocalReportStore.initialize() must be called before getMetadataDir()");
        }
        return join(this._basePath, this._projectId, "reports", ".metadata");
    }

    /**
     * Validate a slug to prevent path traversal attacks.
     * Slugs must:
     * - Not be empty
     * - Not contain path separators (/, \)
     * - Not contain parent directory references (..)
     * - Not start or end with dots
     * - Only contain alphanumeric characters, hyphens, underscores
     *
     * @param slug The slug to validate
     * @throws InvalidSlugError if the slug is invalid
     */
    validateSlug(slug: string): void {
        if (!slug || slug.trim() === "") {
            throw new InvalidSlugError(slug, "slug cannot be empty");
        }

        // Check for path separators
        if (slug.includes("/") || slug.includes("\\")) {
            throw new InvalidSlugError(slug, "slug cannot contain path separators (/ or \\)");
        }

        // Check for parent directory references
        if (slug.includes("..")) {
            throw new InvalidSlugError(slug, "slug cannot contain parent directory references (..)");
        }

        // Check for leading/trailing dots (could be hidden files or special dirs)
        if (slug.startsWith(".") || slug.endsWith(".")) {
            throw new InvalidSlugError(slug, "slug cannot start or end with a dot");
        }

        // Only allow safe characters: alphanumeric, hyphens, underscores
        const safeSlugPattern = /^[a-zA-Z0-9_-]+$/;
        if (!safeSlugPattern.test(slug)) {
            throw new InvalidSlugError(
                slug,
                "slug can only contain alphanumeric characters, hyphens (-), and underscores (_)"
            );
        }
    }

    /**
     * Get a safe, validated path for a report file.
     * Validates the slug and ensures the resulting path is within the reports directory.
     *
     * @param slug The report slug
     * @param extension The file extension (default: "md")
     * @returns The validated file path
     * @throws InvalidSlugError if the slug is invalid or path escapes the reports directory
     */
    private getSafePath(slug: string, extension: "md" | "json" = "md"): string {
        this.validateSlug(slug);

        const baseDir = extension === "md" ? this.getReportsDir() : this.getMetadataDir();
        const filePath = resolve(join(baseDir, `${slug}.${extension}`));

        // Double-check: ensure resolved path is still within the base directory
        const relativePath = relative(baseDir, filePath);
        if (relativePath.startsWith("..") || relativePath.includes("..")) {
            throw new InvalidSlugError(slug, "resolved path escapes the reports directory");
        }

        return filePath;
    }

    /**
     * Ensure the reports and metadata directories exist
     */
    async ensureDirectories(): Promise<void> {
        await mkdir(this.getReportsDir(), { recursive: true });
        await mkdir(this.getMetadataDir(), { recursive: true });
    }

    /**
     * Get the file path for a report's content
     * @throws InvalidSlugError if the slug is invalid
     */
    getReportPath(slug: string): string {
        return this.getSafePath(slug, "md");
    }

    /**
     * Get the file path for a report's metadata
     * @throws InvalidSlugError if the slug is invalid
     */
    private getMetadataPath(slug: string): string {
        return this.getSafePath(slug, "json");
    }

    /**
     * Write a report to local storage with its metadata
     * @param slug The report slug (d-tag)
     * @param content The markdown content
     * @param metadata The Nostr event metadata
     */
    async writeReport(slug: string, content: string, metadata: LocalReportMetadata): Promise<void> {
        await this.ensureDirectories();

        const reportPath = this.getReportPath(slug);
        const metadataPath = this.getMetadataPath(slug);

        // Write content file
        await writeFile(reportPath, content, "utf-8");

        // Write metadata file
        await writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf-8");

        logger.debug("📁 Saved report to local storage", {
            slug,
            path: reportPath,
            contentLength: content.length,
            addressableRef: metadata.addressableRef.substring(0, 20),
        });
    }

    /**
     * Read a report's content from local storage
     * @param slug The report slug (d-tag)
     * @returns The report content or null if not found
     */
    async readReport(slug: string): Promise<string | null> {
        const reportPath = this.getReportPath(slug);

        if (!existsSync(reportPath)) {
            return null;
        }

        try {
            const content = await readFile(reportPath, "utf-8");
            return content;
        } catch (error) {
            logger.warn("📁 Failed to read local report", {
                slug,
                path: reportPath,
                error: error instanceof Error ? error.message : String(error),
            });
            return null;
        }
    }

    /**
     * Read a report's metadata from local storage
     * @param slug The report slug (d-tag)
     * @returns The metadata or null if not found
     */
    async readMetadata(slug: string): Promise<LocalReportMetadata | null> {
        const metadataPath = this.getMetadataPath(slug);

        if (!existsSync(metadataPath)) {
            return null;
        }

        try {
            const content = await readFile(metadataPath, "utf-8");
            return JSON.parse(content) as LocalReportMetadata;
        } catch (error) {
            logger.warn("📁 Failed to read local report metadata", {
                slug,
                path: metadataPath,
                error: error instanceof Error ? error.message : String(error),
            });
            return null;
        }
    }

    /**
     * Check if a report exists locally
     * @param slug The report slug (d-tag)
     */
    exists(slug: string): boolean {
        return existsSync(this.getReportPath(slug));
    }

    /**
     * Check if a Nostr event is newer than the local copy
     * Used for hydration from subscription
     * @param slug The report slug (d-tag)
     * @param eventCreatedAt The Nostr event's created_at timestamp
     * @returns true if the event is newer and should update the local copy
     */
    async isNewerThanLocal(slug: string, eventCreatedAt: number): Promise<boolean> {
        const metadata = await this.readMetadata(slug);

        if (!metadata) {
            // No local copy exists, so the event is "newer"
            return true;
        }

        // Compare timestamps
        return eventCreatedAt > metadata.createdAt;
    }

    /**
     * Hydrate local storage from a Nostr event if it's newer
     * @param slug The report slug (d-tag)
     * @param content The report content
     * @param addressableRef The addressable reference in NIP-33 format (kind:pubkey:identifier)
     * @param createdAt The Nostr event's created_at timestamp
     * @returns true if the local copy was updated
     */
    async hydrateFromNostr(
        slug: string,
        content: string,
        addressableRef: string,
        createdAt: number
    ): Promise<boolean> {
        const isNewer = await this.isNewerThanLocal(slug, createdAt);

        if (!isNewer) {
            logger.debug("📁 Skipping hydration - local copy is current or newer", {
                slug,
                eventCreatedAt: createdAt,
            });
            return false;
        }

        await this.writeReport(slug, content, {
            addressableRef,
            createdAt,
            slug,
        });

        logger.info("📁 Hydrated local report from Nostr", {
            slug,
            addressableRef: addressableRef.substring(0, 20),
            createdAt,
        });

        return true;
    }

    /**
     * Check if a path is within the reports directory
     * Used to block direct writes via fs_write
     * Uses secure path normalization to prevent path traversal attacks.
     * @param path The path to check
     * @throws Error if the store has not been initialized
     */
    isPathInReportsDir(path: string): boolean {
        // CRITICAL: Throw if not initialized to prevent silent bypass of protection
        if (!this.isInitialized()) {
            throw new Error(
                "LocalReportStore.isPathInReportsDir() called before initialization. " +
                "This indicates a bug - the store must be initialized during project startup."
            );
        }

        // Use secure path containment check that handles .., symlinks, case differences
        return isPathWithinDirectory(path, this.getReportsDir());
    }

    /**
     * Reset the store (for testing purposes)
     */
    reset(): void {
        this._basePath = null;
        this._projectId = null;
    }
}

/**
 * Create a new LocalReportStore instance.
 * Each project should have its own instance managed by ProjectContext.
 */
export function createLocalReportStore(): LocalReportStore {
    return new LocalReportStore();
}

/**
 * Get the LocalReportStore for the current project context.
 * This is a convenience function that gets the store from ProjectContext.
 *
 * @throws Error if called outside of a project context
 */
export function getLocalReportStore(): LocalReportStore {
    // Lazy import to avoid circular dependency
    const { getProjectContext } = require("@/services/projects/ProjectContext");
    const context = getProjectContext();
    if (!context.localReportStore) {
        throw new Error(
            "LocalReportStore not available in project context. " +
            "This indicates a bug - the store should be initialized during project startup."
        );
    }
    return context.localReportStore;
}
