import { getNDK } from "@/nostr/ndkClient";
import { fetchConversation } from "@/utils/conversationFetcher";
import { formatAnyError } from "@/utils/error-formatter";
import { logError, logInfo } from "@/utils/logger";
import { ensureProjectInitialized } from "@/utils/projectInitialization";
import { debugLog, debugError } from "./utils";

export async function runDebugConversation(nevent: string): Promise<void> {
    try {
        const projectPath = process.cwd();

        logInfo(`🔍 Debug: Fetching conversation for ${nevent}`);

        // Initialize project context
        await ensureProjectInitialized(projectPath);

        // Get NDK instance
        const ndk = getNDK();

        // Fetch and format conversation
        const conversationMarkdown = await fetchConversation(nevent, ndk, projectPath);

        // Display the conversation
        debugLog(`\n${conversationMarkdown}`);

        logInfo("Conversation displayed successfully");
    } catch (err) {
        const errorMessage = formatAnyError(err);
        logError(`Failed to fetch conversation: ${errorMessage}`);
        debugError("\nError:", err);
        process.exit(1);
    }
}
