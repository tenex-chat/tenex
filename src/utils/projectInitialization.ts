import { ProjectManager } from "@/daemon/ProjectManager";
import { getNDK, initNDK } from "@/nostr/ndkClient";
import { isProjectContextInitialized } from "@/services";
import { logger } from "@/utils/logger";
import { handleCliError } from "@/utils/cli-error";

/**
 * Initialize project context if not already initialized
 * This includes NDK setup and ProjectManager initialization
 *
 * Used by commands that need full project context:
 * - tenex project run
 * - tenex debug chat
 * - tenex debug system-prompt
 * - tenex inventory generate
 */
export async function ensureProjectInitialized(projectPath: string): Promise<void> {
    if (isProjectContextInitialized()) {
        logger.debug("Project context already initialized");
        return;
    }

    try {
        // Step 1: Initialize NDK connection
        await initNDK();
        const ndk = getNDK();

        // Step 2: Initialize ProjectContext using ProjectManager
        const projectManager = new ProjectManager();
        await projectManager.loadAndInitializeProjectContext(projectPath, ndk);
    } catch (error: any) {
        // Check if this is a missing project configuration error
        if (error?.message?.includes("Project configuration missing projectNaddr")) {
            const message = [
                "\n❌ Not in a TENEX project directory\n",
                "This command must be run from within a TENEX project.",
                "\nTo initialize a new project, run:",
                "  tenex init\n",
                "Or navigate to an existing TENEX project directory.\n"
            ].join("\n");
            handleCliError(new Error(message));
        }
        throw error;
    }
}
