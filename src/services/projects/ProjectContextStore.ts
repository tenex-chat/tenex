import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "@/utils/logger";
import type { ProjectContext } from "./ProjectContext";

/**
 * ProjectContextStore uses AsyncLocalStorage to maintain project context
 * throughout async execution chains. This allows multiple projects to run
 * in the same process without context interference.
 *
 * AsyncLocalStorage is Node.js's built-in solution for context propagation
 * through async operations, similar to thread-local storage in other languages.
 *
 * @example
 * ```typescript
 * // In ProjectRuntime
 * await projectContextStore.run(this.context, async () => {
 *   // All async operations in this chain have access to the context
 *   await eventHandler.handleEvent(event);
 * });
 *
 * // Anywhere in the codebase
 * const context = projectContextStore.getContext();
 * ```
 */
class ProjectContextStore {
    private storage = new AsyncLocalStorage<ProjectContext>();

    /**
     * Run a function with the given project context.
     * All async operations within this function will have access to the context.
     */
    async run<T>(context: ProjectContext, fn: () => Promise<T>): Promise<T> {
        return this.storage.run(context, fn);
    }

    /**
     * Run a synchronous function with the given project context.
     */
    runSync<T>(context: ProjectContext, fn: () => T): T {
        return this.storage.run(context, fn);
    }

    /**
     * Get the current project context from AsyncLocalStorage.
     * Returns undefined if no context is set (e.g., outside of a run() call).
     */
    getContext(): ProjectContext | undefined {
        return this.storage.getStore();
    }

    /**
     * Get the current project context, throwing if not available.
     * Use this when context is required.
     */
    getContextOrThrow(): ProjectContext {
        const context = this.storage.getStore();
        if (!context) {
            throw new Error(
                "ProjectContext not available in current async context. " +
                    "Ensure this code is running within projectContextStore.run()."
            );
        }
        return context;
    }

    /**
     * Check if a context is currently set
     */
    hasContext(): boolean {
        return this.storage.getStore() !== undefined;
    }

    /**
     * Exit the current context (useful for cleanup or isolation)
     */
    exit<T>(fn: () => T): T {
        return this.storage.exit(fn);
    }

    /**
     * Debug utility to log current context info
     */
    debugContext(): void {
        const context = this.storage.getStore();
        if (context) {
            logger.debug("Current ProjectContext:", {
                projectId: context.project.id,
                projectTitle: context.project.tagValue("title"),
                agentCount: context.agents.size,
                hasSigner: !!context.projectManager?.signer,
            });
        } else {
            logger.debug("No ProjectContext in current async context");
        }
    }
}

// Export singleton instance
export const projectContextStore = new ProjectContextStore();

// Also export the class for testing
export { ProjectContextStore };
