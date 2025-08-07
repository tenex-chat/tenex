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