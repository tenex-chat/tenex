import { configService } from "@/services/ConfigService";

/**
 * Check if the current directory is a TENEX project
 * @param projectPath - The path to check (defaults to current working directory)
 * @returns True if the directory contains a TENEX project configuration
 */
export async function isProjectDirectory(projectPath: string = process.cwd()): Promise<boolean> {
    return await configService.projectConfigExists(projectPath, "config.json");
}

/**
 * Get the appropriate configuration path based on project detection
 * @param projectPath - The path to check (defaults to current working directory)
 * @returns The configuration path (project path if in a project, global path otherwise)
 */
export async function getConfigPath(projectPath: string = process.cwd()): Promise<string> {
    const isProject = await isProjectDirectory(projectPath);
    return isProject 
        ? configService.getProjectPath(projectPath)
        : configService.getGlobalPath();
}

/**
 * Determine whether to use project or global configuration based on flags and project detection
 * @param options - Command options with optional global and project flags
 * @param projectPath - The path to check (defaults to current working directory)
 * @returns Configuration scope information
 */
export async function determineConfigScope(
    options: { global?: boolean; project?: boolean },
    projectPath: string = process.cwd()
): Promise<{ useProject: boolean; isProject: boolean; configPath: string }> {
    const isProject = await isProjectDirectory(projectPath);
    
    // Validate conflicting flags
    if (options.global && options.project) {
        throw new Error("Cannot use both --global and --project flags");
    }
    
    // Determine scope based on flags or auto-detection
    let useProject = false;
    if (options.global) {
        useProject = false;
    } else if (options.project) {
        if (!isProject) {
            throw new Error("Not in a TENEX project directory. Use --global flag or run from a project.");
        }
        useProject = true;
    } else {
        // Default: use project if in one, otherwise global
        useProject = isProject;
    }
    
    const configPath = useProject 
        ? configService.getProjectPath(projectPath)
        : configService.getGlobalPath();
    
    return { useProject, isProject, configPath };
}