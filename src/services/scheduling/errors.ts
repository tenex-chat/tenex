/**
 * Scheduling service error types
 */

/**
 * Error thrown when attempting to start a project that is already running.
 * This is a non-fatal condition during auto-boot - the project is already available.
 */
export class ProjectAlreadyRunningError extends Error {
    constructor(public readonly projectId: string) {
        super(`Project already running: ${projectId}`);
        this.name = "ProjectAlreadyRunningError";
    }
}
