import path from "node:path";
import { directoryExists, ensureDirectory } from "./filesystem.js";

/**
 * Get paths for common project-level .tenex directories
 * Note: config.json and llms.json are now global only (in ~/.tenex)
 * Only mcp.json remains at the project level
 */
export function getTenexPaths(projectPath: string): {
    tenexDir: string;
    agentsDir: string;
    rulesDir: string;
    conversationsDir: string;
    mcpJson: string;
} {
    const tenexDir = path.join(projectPath, ".tenex");
    return {
        tenexDir,
        agentsDir: path.join(tenexDir, "agents"),
        rulesDir: path.join(tenexDir, "rules"),
        conversationsDir: path.join(tenexDir, "conversations"),
        mcpJson: path.join(tenexDir, "mcp.json"),
    };
}

// Use ConfigService from @/services for config.json and llms.json (global only)

/**
 * Check if a project has been initialized (has .tenex directory)
 */
export async function isProjectInitialized(projectPath: string): Promise<boolean> {
    const paths = getTenexPaths(projectPath);
    return directoryExists(paths.tenexDir);
}

/**
 * Initialize .tenex directory structure
 */
export async function initializeTenexDirectory(projectPath: string): Promise<void> {
    const paths = getTenexPaths(projectPath);

    // Create main .tenex directory
    await ensureDirectory(paths.tenexDir);

    // Create subdirectories
    await ensureDirectory(paths.agentsDir);
    await ensureDirectory(paths.rulesDir);
    await ensureDirectory(paths.conversationsDir);
}
