import { configService } from "@/services/ConfigService";
import { logger } from "@/utils/logger";

export interface ConfigLocationOptions {
    project?: boolean;
    global?: boolean;
}

/**
 * Determines whether to use project or global configuration based on options and current context.
 * @returns true if project config should be used, false for global config
 * @throws Error if invalid options combination or project not available when required
 */
export async function determineConfigLocation(
    options: ConfigLocationOptions,
    projectPath: string = process.cwd()
): Promise<boolean> {
    // Check for conflicting flags
    if (options.global && options.project) {
        logger.error("Cannot use both --global and --project flags");
        throw new Error("Conflicting configuration flags");
    }

    const isProject = await configService.projectConfigExists(projectPath, "config.json");

    // Explicit global flag
    if (options.global) {
        return false;
    }

    // Explicit project flag
    if (options.project) {
        if (!isProject) {
            logger.error("Not in a TENEX project directory. Use --global to add to global configuration.");
            throw new Error("Project configuration not available");
        }
        return true;
    }

    // Default: use project if available, otherwise global
    return isProject;
}

/**
 * Gets a descriptive location string for logging purposes
 */
export function getConfigLocationDescription(useProject: boolean): string {
    return useProject ? "project" : "global";
}