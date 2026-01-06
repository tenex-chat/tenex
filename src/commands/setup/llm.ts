import * as fileSystem from "@/lib/fs";
import { LLMConfigEditor } from "@/llm/LLMConfigEditor";
import { config } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import { Command } from "commander";

export const llmCommand = new Command("llm")
    .description("Manage LLM configurations (global only)")
    .action(async () => {
        try {
            // LLM configuration is global only
            const globalConfigDir = config.getGlobalPath();

            // Ensure global config directory exists
            await fileSystem.ensureDirectory(globalConfigDir);

            const llmManager = new LLMConfigEditor();
            await llmManager.showMainMenu();
        } catch (error: unknown) {
            // Handle SIGINT (Ctrl+C) gracefully - just exit without error
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage?.includes("SIGINT") || errorMessage?.includes("force closed")) {
                return;
            }
            // Only show error for actual problems
            logger.error(`Failed to start LLM configuration: ${error}`);
            process.exitCode = 1;
        }
    });
