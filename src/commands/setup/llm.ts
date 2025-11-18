import * as os from "node:os";
import * as path from "node:path";
import * as fileSystem from "@/lib/fs";
import { LLMConfigEditor } from "@/llm/LLMConfigEditor";
import { logger } from "@/utils/logger";
import { Command } from "commander";

export const llmCommand = new Command("llm")
    .description("Manage LLM configurations (global only)")
    .action(async () => {
        try {
            // LLM configuration is global only
            const globalConfigDir = path.join(os.homedir(), ".tenex");

            // Ensure global config directory exists
            try {
                await fileSystem.ensureDirectory(globalConfigDir);
            } catch (error) {
                logger.error(`Failed to create global config directory: ${error}`);
                process.exit(1);
            }

            const llmManager = new LLMConfigEditor();
            await llmManager.showMainMenu();
        } catch (error: unknown) {
            // Handle SIGINT (Ctrl+C) gracefully - just exit without error
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage?.includes("SIGINT") || errorMessage?.includes("force closed")) {
                process.exit(0);
            }
            // Only show error for actual problems
            logger.error(`Failed to start LLM configuration: ${error}`);
            process.exit(1);
        }
    });
