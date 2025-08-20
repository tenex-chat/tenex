import { handleCliError } from "@/utils/cli-error";
import { generateInventory, updateInventory } from "@/utils/inventory";
import { logger } from "@/utils/logger";
import { ensureProjectInitialized } from "@/utils/projectInitialization";
import chalk from "chalk";
import { Command } from "commander";

export const inventoryCommand = new Command("inventory")
  .description("Manage project inventory")
  .action(() => {
    inventoryCommand.help();
  });

inventoryCommand
  .command("generate")
  .description("Generate or update the project inventory using repomix + LLM analysis")
  .option("--path <path>", "Project path (defaults to current directory)")
  .action(async (options) => {
    try {
      const projectPath = options.path || process.cwd();

      // Initialize project context
      await ensureProjectInitialized(projectPath);

      logger.info("Generating project inventory", { projectPath });

      await generateInventory(projectPath);

      logger.info(chalk.green("\n✅ Inventory generation completed successfully!"));
      logger.info(chalk.blue("📋 Main inventory saved to context/INVENTORY.md"));
      logger.info(chalk.blue("📚 Complex module guides (if any) saved to context/ directory"));
    } catch (error) {
      handleCliError(error, "Failed to generate inventory");
    }
  });

inventoryCommand
  .command("update")
  .description("Update inventory for specific files using repomix + LLM analysis")
  .argument("<files...>", "Files to update in the inventory")
  .option("--path <path>", "Project path (defaults to current directory)")
  .action(async (files, options) => {
    try {
      const projectPath = options.path || process.cwd();

      // Initialize project context
      await ensureProjectInitialized(projectPath);

      logger.info("Updating inventory for files", { files });

      await updateInventory(projectPath, files);

      logger.info(chalk.green("\n✅ Inventory update completed successfully!"));
      logger.info(chalk.blue(`📝 Updated inventory for ${files.length} file(s)`));
      logger.info(chalk.blue("📋 Updated inventory saved to context/INVENTORY.md"));
    } catch (error) {
      handleCliError(error, "Failed to update inventory");
    }
  });
