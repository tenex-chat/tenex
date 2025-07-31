import { ProjectManager } from "@/daemon/ProjectManager";
import { getNDK, initNDK } from "@/nostr/ndkClient";
import { isProjectContextInitialized } from "@/services";
import { logger } from "@/utils/logger";

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

    logger.info("🔄 Initializing project context...");

    // Step 1: Initialize NDK connection
    await initNDK();
    const ndk = getNDK();

    // Step 2: Initialize ProjectContext using ProjectManager
    const projectManager = new ProjectManager();
    await projectManager.loadAndInitializeProjectContext(projectPath, ndk);

    logger.info("✅ Project context initialized");
}
