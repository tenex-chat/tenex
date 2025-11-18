import { config } from "@/services/ConfigService";

export interface ConfigScope {
    basePath: string;
    isGlobal: boolean;
    isProject: boolean;
    error?: string;
}

/**
 * Resolves the configuration scope for CLI commands
 * Note: config.json and llms.json are now global only
 * Only mcp.json remains at project level
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
            error: "Cannot use both --project and --global flags",
        };
    }

    // Determine if we're in a project directory (check for mcp.json since config.json is global only)
    const projectMcpExists = await config.projectConfigExists(currentPath, "mcp.json");

    // Handle explicit flags
    if (options.global) {
        return {
            basePath: config.getGlobalPath(),
            isGlobal: true,
            isProject: false,
        };
    }

    if (options.project) {
        if (!projectMcpExists) {
            return {
                basePath: "",
                isGlobal: false,
                isProject: false,
                error: "Not in a TENEX project directory. Run 'tenex project init' first.",
            };
        }
        return {
            basePath: currentPath,
            isGlobal: false,
            isProject: true,
        };
    }

    // Default behavior: use project if available (for MCP), otherwise global
    if (projectMcpExists) {
        return {
            basePath: currentPath,
            isGlobal: false,
            isProject: true,
        };
    }

    return {
        basePath: config.getGlobalPath(),
        isGlobal: true,
        isProject: false,
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
 * @returns True if the directory contains a TENEX project (checks for mcp.json)
 */
export async function isProjectDirectory(projectPath: string = process.cwd()): Promise<boolean> {
    return await config.projectConfigExists(projectPath, "mcp.json");
}

/**
 * Get the appropriate configuration path based on project detection
 * Note: Always returns global path for config.json and llms.json
 * @param projectPath - The path to check (defaults to current working directory)
 * @returns The configuration path (project path if in a project, global path otherwise)
 */
export async function getConfigPath(projectPath: string = process.cwd()): Promise<string> {
    const isProject = await isProjectDirectory(projectPath);
    return isProject ? config.getProjectPath(projectPath) : config.getGlobalPath();
}
