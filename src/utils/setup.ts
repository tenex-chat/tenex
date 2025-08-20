import chalk from "chalk";
import inquirer from "inquirer";
import { LLMConfigEditor } from "@/llm/LLMConfigEditor";
import { configService } from "@/services";
import type { TenexConfig } from "@/services/config/types";
import { logger } from "@/utils/logger";

export async function runInteractiveSetup(): Promise<TenexConfig> {
  logger.info(chalk.cyan("\n🚀 Welcome to TENEX Daemon Setup\n"));
  logger.info("Let's configure your daemon to get started.\n");

  // Load current configuration to check what's missing
  const { config: currentConfig, llms: currentLLMs } = await configService.loadConfig();
  const needsPubkeys =
    !currentConfig.whitelistedPubkeys || currentConfig.whitelistedPubkeys.length === 0;
  const needsLLMs =
    !currentLLMs.configurations || Object.keys(currentLLMs.configurations).length === 0;

  let pubkeys = currentConfig.whitelistedPubkeys || [];

  // Step 1: Get whitelisted pubkeys if needed
  if (needsPubkeys) {
    pubkeys = await promptForPubkeys();
  }

  const config: TenexConfig = {
    whitelistedPubkeys: pubkeys,
  };

  // Step 2: Save basic configuration
  await configService.saveGlobalConfig(config);

  // Step 3: Set up LLM configurations if needed
  if (needsLLMs) {
    logger.info(chalk.yellow("\nStep 2: LLM Configuration"));
    logger.info("You need at least one LLM configuration to run projects.\n");

    const llmEditor = new LLMConfigEditor("", true); // Global config
    await llmEditor.runOnboardingFlow();
  }

  logger.info(chalk.green("\n✅ Setup complete!"));
  logger.info(chalk.green(`Configuration saved to: ${configService.getGlobalPath()}/`));
  logger.info(
    chalk.gray("\nYou can now run 'tenex daemon' to start the daemon with your configuration.")
  );

  return config;
}

async function promptForPubkeys(): Promise<string[]> {
  logger.info(chalk.yellow("Step 1: Whitelist Configuration"));
  logger.info("Enter the Nostr pubkeys (hex format) that are allowed to control this daemon.");
  logger.info("You can add multiple pubkeys, one at a time.\n");

  const pubkeys: string[] = [];
  let addMore = true;

  while (addMore) {
    const { pubkey } = await inquirer.prompt([
      {
        type: "input",
        name: "pubkey",
        message: "Enter a pubkey (hex format):",
        validate: (input) => {
          if (!input.trim()) {
            return "Pubkey cannot be empty";
          }
          if (!/^[a-f0-9]{64}$/i.test(input.trim())) {
            return "Invalid pubkey format. Must be 64 hex characters";
          }
          return true;
        },
      },
    ]);

    pubkeys.push(pubkey.trim().toLowerCase());

    if (pubkeys.length > 0) {
      const { continueAdding } = await inquirer.prompt([
        {
          type: "confirm",
          name: "continueAdding",
          message: "Add another pubkey?",
          default: false,
        },
      ]);
      addMore = continueAdding;
    }
  }

  logger.info(chalk.green(`\n✓ Added ${pubkeys.length} whitelisted pubkey(s)\n`));
  return pubkeys;
}
