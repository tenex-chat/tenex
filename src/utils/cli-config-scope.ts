import { configService } from "@/services/ConfigService";

export interface ConfigScope {
    basePath: string;
    isGlobal: boolean;
    isProject: boolean;
    error?: string;
}

/**
 * Resolves the configuration scope for CLI commands
 * Consolidates the logic for determining whether to use global or project config
 * 
 * @param options Command line options with optional project/global flags
 * @param currentPath The current working directory path
 * @returns ConfigScope object with resolved path and scope information
 */
export async function resolveConfigScope(
    options: { project?: boolean; global?: boolean },
    currentPath: string = process.cwd()
): Promise<ConfigScope> {
    
    // Check for conflicting flags
    if (options.project && options.global) {
        return {
            basePath: "",
            isGlobal: false,
            isProject: false,
            error: "Cannot use both --project and --global flags"
        };
    }
    
    // Determine if we're in a project directory (check for main config file)
    const projectConfigExists = await configService.projectConfigExists(currentPath, "config.json");
    
    // Handle explicit flags
    if (options.global) {
        return {
            basePath: configService.getGlobalPath(),
            isGlobal: true,
            isProject: false
        };
    }
    
    if (options.project) {
        if (!projectConfigExists) {
            return {
                basePath: "",
                isGlobal: false,
                isProject: false,
                error: "Not in a TENEX project directory. Run 'tenex project init' first."
            };
        }
        return {
            basePath: currentPath,
            isGlobal: false,
            isProject: true
        };
    }
    
    // Default behavior: use project config if available, otherwise global
    if (projectConfigExists) {
        return {
            basePath: currentPath,
            isGlobal: false,
            isProject: true
        };
    }
    
    return {
        basePath: configService.getGlobalPath(),
        isGlobal: true,
        isProject: false
    };
}

/**
 * Helper to format config scope for display
 */
export function formatConfigScope(scope: ConfigScope): string {
    if (scope.error) {
        return scope.error;
    }
    
    if (scope.isGlobal) {
        return "global configuration";
    }
    
    if (scope.isProject) {
        return `project configuration at ${scope.basePath}`;
    }
    
    return "configuration";
}

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
 * @deprecated Use resolveConfigScope instead
 */
export async function determineConfigScope(
    options: { global?: boolean; project?: boolean },
    projectPath: string = process.cwd()
): Promise<{ useProject: boolean; isProject: boolean; configPath: string }> {
    const scope = await resolveConfigScope(options, projectPath);
    
    if (scope.error) {
        throw new Error(scope.error);
    }
    
    return {
        useProject: scope.isProject,
        isProject: scope.isProject,
        configPath: scope.basePath
    };
}