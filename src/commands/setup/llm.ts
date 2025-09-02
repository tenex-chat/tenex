import * as os from "node:os";
import * as path from "node:path";
import * as fileSystem from "@/lib/fs";
import { LLMConfigEditor } from "@/llm/LLMConfigEditor";
import { logger } from "@/utils/logger";
import { Command } from "commander";

export const llmCommand = new Command("llm")
  .description("Manage LLM configurations (global by default, --project for current project)")
  .option("--project", "Use project-specific configuration instead of global")
  .action(async (options) => {
    try {
      let configPath: string;
      let isGlobal: boolean;

      if (options.project) {
        // Project-specific configuration
        const projectPath = process.cwd();

        // Check if we're in a TENEX project
        if (!(await fileSystem.directoryExists(path.join(projectPath, ".tenex")))) {
          logger.error("No .tenex directory found. Make sure you're in a TENEX project directory.");
          process.exit(1);
        }

        configPath = projectPath;
        isGlobal = false;
      } else {
        // Global configuration
        const globalConfigDir = path.join(os.homedir(), ".tenex");

        // Ensure global config directory exists
        try {
          await fileSystem.ensureDirectory(globalConfigDir);
        } catch (error) {
          logger.error(`Failed to create global config directory: ${error}`);
          process.exit(1);
        }

        configPath = "";
        isGlobal = true;
      }

      const llmManager = new LLMConfigEditor(configPath, isGlobal);
      await llmManager.showMainMenu();
    } catch (error: unknown) {
      // Handle SIGINT (Ctrl+C) gracefully - just exit without error
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage?.includes('SIGINT') || errorMessage?.includes('force closed')) {
        process.exit(0);
      }
      // Only show error for actual problems
      logger.error(`Failed to start LLM configuration: ${error}`);
      process.exit(1);
    }
  });
