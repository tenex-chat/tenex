import { watch } from "fs";
import { readdir, stat } from "fs/promises";
import { join, basename } from "path";
import { logger } from "@/utils/logger";
import type { ExecutionContext } from "@/agents/execution/types";
import type { AISdkTool } from "@/tools/registry";
import { debounce } from "lodash";

/**
 * Type for dynamic tool factory functions
 */
export type DynamicToolFactory = (context: ExecutionContext) => AISdkTool<unknown, unknown>;

/**
 * Service for managing dynamically created tools
 */
export class DynamicToolService {
    private static instance: DynamicToolService;
    private readonly dynamicToolsPath = join(process.cwd(), ".tenex/tools");
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
            path: this.dynamicToolsPath
        });

        // Ensure the dynamic tools directory exists
        try {
            await stat(this.dynamicToolsPath);
        } catch {
            // Directory doesn't exist, create it
            const { mkdir } = await import("fs/promises");
            await mkdir(this.dynamicToolsPath, { recursive: true });
            logger.debug("[DynamicToolService] Created dynamic tools directory", {
                path: this.dynamicToolsPath
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
            const tsFiles = files.filter(f => f.endsWith(".ts"));

            logger.debug("[DynamicToolService] Found dynamic tool files", {
                count: tsFiles.length,
                files: tsFiles
            });

            for (const file of tsFiles) {
                const filePath = join(this.dynamicToolsPath, file);
                await this.loadTool(filePath);
            }
        } catch (error) {
            logger.error("[DynamicToolService] Error scanning directory", {
                error: error instanceof Error ? error.message : String(error)
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
        
        this.watcher = watch(this.dynamicToolsPath, (eventType, filename) => {
            if (filename) {
                handleFileChange(filename);
            }
        });

        logger.debug("[DynamicToolService] File watcher initialized");
    }
    
    /**
     * Load or reload a dynamic tool from a file
     */
    private async loadTool(filePath: string): Promise<void> {
        try {
            // Get file hash for cache busting
            const file = Bun.file(filePath);
            const text = await file.text();
            const hash = Bun.hash(text).toString();
            
            // Check if we need to reload
            const previousHash = this.fileHashes.get(filePath);
            if (previousHash === hash) {
                logger.debug("[DynamicToolService] Tool unchanged, skipping reload", {
                    file: basename(filePath)
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
                projectPath: process.cwd(),
                conversationId: "test",
                triggeringEvent: {} as ExecutionContext["triggeringEvent"],
                conversationCoordinator: {} as ExecutionContext["conversationCoordinator"],
                agentPublisher: {} as ExecutionContext["agentPublisher"]
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
                file: basename(filePath)
            });
        } catch (error) {
            logger.error("[DynamicToolService] Failed to load dynamic tool", {
                file: basename(filePath),
                error: error instanceof Error ? error.message : String(error)
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
                file: basename(filePath)
            });
        }
    }
    
    /**
     * Extract tool name from filename
     * Format: agent_{agentId}_{toolName}.ts -> toolName
     */
    private extractToolName(filename: string): string {
        // If it follows the agent_{agentId}_{toolName} pattern
        const match = filename.match(/^agent_[^_]+_(.+)$/);
        if (match) {
            return match[1];
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
    public getDynamicToolsObject(context: ExecutionContext): Record<string, AISdkTool<unknown, unknown>> {
        const tools: Record<string, AISdkTool<unknown, unknown>> = {};
        
        for (const [name, factory] of this.dynamicTools) {
            try {
                const tool = factory(context);
                tools[name] = tool;
            } catch (error) {
                logger.error("[DynamicToolService] Failed to instantiate dynamic tool", {
                    name,
                    error: error instanceof Error ? error.message : String(error)
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