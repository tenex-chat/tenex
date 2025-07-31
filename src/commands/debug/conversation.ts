import { getNDK } from "@/nostr/ndkClient";
import { fetchConversation } from "@/utils/conversationFetcher";
import { formatError } from "@/utils/errors";
import { logError, logInfo } from "@/utils/logger";
import { ensureProjectInitialized } from "@/utils/projectInitialization";
import chalk from "chalk";

export async function runDebugConversation(nevent: string) {
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
        console.log(`\n${conversationMarkdown}`);

        logInfo("Conversation displayed successfully");
    } catch (err) {
        const errorMessage = formatError(err);
        logError(`Failed to fetch conversation: ${errorMessage}`);
        console.error(chalk.red(`\nError: ${errorMessage}`));
        process.exit(1);
    }
}
