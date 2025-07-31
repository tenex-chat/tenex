import path from "node:path";
import { directoryExists, ensureDirectory } from "./filesystem.js";

/**
 * Get paths for common .tenex files
 */
export function getTenexPaths(projectPath: string) {
    const tenexDir = path.join(projectPath, ".tenex");
    return {
        tenexDir,
        agentsJson: path.join(tenexDir, "agents.json"),
        configJson: path.join(tenexDir, "config.json"),
        llmsJson: path.join(tenexDir, "llms.json"),
        agentsDir: path.join(tenexDir, "agents"),
        rulesDir: path.join(tenexDir, "rules"),
        conversationsDir: path.join(tenexDir, "conversations"),
    };
}

// Configuration operations removed - use ConfigService from @/services instead

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
