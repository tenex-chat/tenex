import { watch } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExecutionContext } from "@/agents/execution/types";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";

// Simple debounce implementation to avoid lodash type issues
function debounce<TArgs extends unknown[]>(
    fn: (...args: TArgs) => unknown,
    wait: number
): (...args: TArgs) => void {
    let timeout: NodeJS.Timeout | null = null;
    return (...args: TArgs) => {
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(() => fn(...args), wait);
    };
}

/**
 * Type for dynamic tool factory functions
 */
export type DynamicToolFactory = (context: ExecutionContext) => AISdkTool<unknown, unknown>;

/**
 * Service for managing dynamically created tools
 */
export class DynamicToolService {
    private static instance: DynamicToolService;
    // Use global location for dynamic tools since it's a singleton
    private readonly dynamicToolsPath = join(homedir(), ".tenex", "tools");
    private dynamicTools = new Map<string, DynamicToolFactory>();
    private watcher: ReturnType<typeof watch> | null = null;
    private fileHashes = new Map<string, string>();

    private constructor() {
        // Private constructor for singleton
    }

    /**
     * Get singleton instance
     */
    public static getInstance(): DynamicToolService {
        if (!DynamicToolService.instance) {
            DynamicToolService.instance = new DynamicToolService();
        }
        return DynamicToolService.instance;
    }

    /**
     * Initialize the service and start watching for dynamic tools
     */
    public async initialize(): Promise<void> {
        logger.debug("[DynamicToolService] Initializing dynamic tool service", {
            path: this.dynamicToolsPath,
        });

        // Ensure the dynamic tools directory exists
        try {
            await stat(this.dynamicToolsPath);
        } catch {
            // Directory doesn't exist, create it
            const { mkdir } = await import("node:fs/promises");
            await mkdir(this.dynamicToolsPath, { recursive: true });
            logger.debug("[DynamicToolService] Created dynamic tools directory", {
                path: this.dynamicToolsPath,
            });
        }

        // Initial scan for existing tools
        await this.scanDirectory();

        // Set up file watcher with debouncing
        this.setupWatcher();
    }

    /**
     * Scan the directory for dynamic tool files
     */
    private async scanDirectory(): Promise<void> {
        try {
            const files = await readdir(this.dynamicToolsPath);
            const tsFiles = files.filter((f) => f.endsWith(".ts"));

            logger.debug("[DynamicToolService] Found dynamic tool files", {
                count: tsFiles.length,
                files: tsFiles,
            });

            for (const file of tsFiles) {
                const filePath = join(this.dynamicToolsPath, file);
                await this.loadTool(filePath);
            }
        } catch (error) {
            logger.error("[DynamicToolService] Error scanning directory", {
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    /**
     * Set up file watcher for the dynamic tools directory
     */
    private setupWatcher(): void {
        // Debounced handler for file changes
        const handleFileChange = debounce(async (filename: string) => {
            if (!filename?.endsWith(".ts")) return;

            const filePath = join(this.dynamicToolsPath, filename);
            logger.info("[DynamicToolService] File change detected", { file: filename });

            try {
                // Check if file still exists
                await stat(filePath);
                // File exists, reload it
                await this.loadTool(filePath);
            } catch {
                // File was deleted
                await this.unloadTool(filePath);
            }
        }, 300); // 300ms debounce

        this.watcher = watch(this.dynamicToolsPath, (_eventType, filename) => {
            if (filename) {
                handleFileChange(filename);
            }
        });

        logger.debug("[DynamicToolService] File watcher initialized");
    }

    /**
     * Synchronously load a dynamic tool immediately after file creation.
     *
     * This method bypasses the debounced file watcher and loads the tool
     * immediately. Used by create_dynamic_tool to ensure the tool is
     * available before agent tools are validated.
     *
     * @param filePath - Absolute path to the dynamic tool file
     * @returns Promise that resolves when the tool is loaded
     *
     * @example
     * // In create_dynamic_tool after writeFile:
     * await writeFile(filePath, toolCode, "utf-8");
     * await dynamicToolService.loadToolSync(filePath);
     * // Now the tool is immediately available for validation
     */
    public async loadToolSync(filePath: string): Promise<void> {
        await this.loadTool(filePath);
    }

    /**
     * Load or reload a dynamic tool from a file
     */
    private async loadTool(filePath: string): Promise<void> {
        try {
            // Get file hash for cache busting
            const text = await readFile(filePath, "utf-8");
            const hash = createHash("sha256").update(text).digest("hex");

            // Check if we need to reload
            const previousHash = this.fileHashes.get(filePath);
            if (previousHash === hash) {
                logger.debug("[DynamicToolService] Tool unchanged, skipping reload", {
                    file: basename(filePath),
                });
                return;
            }

            // Dynamic import with cache busting
            const importPath = `${filePath}?cachebust=${hash}`;
            const module = await import(importPath);

            // Validate the module
            if (!module.default || typeof module.default !== "function") {
                throw new Error("Module must export a default function");
            }

            // Extract tool name from filename
            const filename = basename(filePath, ".ts");
            const toolName = this.extractToolName(filename);

            // Test that the factory function works
            // We'll need a minimal context to validate it returns a valid tool
            const testContext = {
                agent: { name: "test" },
                projectBasePath: process.cwd(),
                workingDirectory: process.cwd(),
                currentBranch: "main",
                conversationId: "test",
                triggeringEvent: {} as ExecutionContext["triggeringEvent"],
                conversationCoordinator: {} as ExecutionContext["conversationCoordinator"],
                agentPublisher: {} as ExecutionContext["agentPublisher"],
                getConversation: () => undefined,
            } as ExecutionContext;

            const testTool = module.default(testContext);
            if (!testTool || typeof testTool.execute !== "function") {
                throw new Error("Factory must return a valid CoreTool");
            }

            // Store the factory
            this.dynamicTools.set(toolName, module.default);
            this.fileHashes.set(filePath, hash);

            logger.info("[DynamicToolService] Dynamic tool loaded", {
                name: toolName,
                file: basename(filePath),
            });
        } catch (error) {
            logger.error("[DynamicToolService] Failed to load dynamic tool", {
                file: basename(filePath),
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    /**
     * Unload a dynamic tool
     */
    private async unloadTool(filePath: string): Promise<void> {
        const filename = basename(filePath, ".ts");
        const toolName = this.extractToolName(filename);

        if (this.dynamicTools.has(toolName)) {
            this.dynamicTools.delete(toolName);
            this.fileHashes.delete(filePath);

            logger.info("[DynamicToolService] Dynamic tool unloaded", {
                name: toolName,
                file: basename(filePath),
            });
        }
    }

    /**
     * Extract tool name from filename
     * Format: agent_{agentName}__{toolName}.ts -> toolName
     * Note: Uses double underscore (__) as separator to allow agent names with underscores
     */
    private extractToolName(filename: string): string {
        // If it follows the agent_{agentName}__{toolName} pattern (double underscore separator)
        const match = filename.match(/^agent_.+__(.+)$/);
        if (match) {
            return match[1];
        }
        // Legacy format: agent_{agentId}_{toolName} (single underscore, agent ID without underscores)
        const legacyMatch = filename.match(/^agent_[^_]+_(.+)$/);
        if (legacyMatch) {
            return legacyMatch[1];
        }
        // Otherwise use the filename as-is
        return filename;
    }

    /**
     * Get all registered dynamic tools
     */
    public getDynamicTools(): Map<string, DynamicToolFactory> {
        return new Map(this.dynamicTools);
    }

    /**
     * Get dynamic tools as an object for a specific context
     */
    public getDynamicToolsObject(
        context: ExecutionContext
    ): Record<string, AISdkTool<unknown, unknown>> {
        const tools: Record<string, AISdkTool<unknown, unknown>> = {};

        for (const [name, factory] of this.dynamicTools) {
            try {
                const tool = factory(context);
                tools[name] = tool;
            } catch (error) {
                logger.error("[DynamicToolService] Failed to instantiate dynamic tool", {
                    name,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }

        return tools;
    }

    /**
     * Check if a tool is a dynamic tool
     */
    public isDynamicTool(name: string): boolean {
        return this.dynamicTools.has(name);
    }

    /**
     * Cleanup and stop watching
     */
    public shutdown(): void {
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }
        this.dynamicTools.clear();
        this.fileHashes.clear();
        logger.info("[DynamicToolService] Service shut down");
    }
}

// Export singleton instance getter
export const dynamicToolService = DynamicToolService.getInstance();
