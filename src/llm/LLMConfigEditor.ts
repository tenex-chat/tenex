import type { TenexLLMs } from "@/services/config/types";
import { configService } from "@/services";
import { llmServiceFactory } from "./LLMServiceFactory";
import inquirer from "inquirer";
import chalk from "chalk";
import { AI_SDK_PROVIDERS } from "./types";
import { ProviderConfigUI } from "./utils/ProviderConfigUI";
import { ConfigurationManager } from "./utils/ConfigurationManager";
import { ConfigurationTester } from "./utils/ConfigurationTester";

/**
 * LLM Configuration Editor - Simple menu orchestrator
 */
export class LLMConfigEditor {
  constructor(
    private configPath: string,
    private isGlobal = true
  ) {}

  async showMainMenu(): Promise<void> {
    const llmsConfig = await this.loadConfig();
    
    console.log(chalk.cyan("\n=== LLM Configuration ===\n"));
    ProviderConfigUI.displayCurrentConfig(llmsConfig);
    
    const { action } = await inquirer.prompt([{
      type: "list",
      name: "action",
      message: "What would you like to do?",
      choices: [
        { name: "Configure provider API keys", value: "providers" },
        { name: "Add new configuration", value: "add" },
        { name: "Delete configuration", value: "delete" },
        { name: `Set default (current: ${llmsConfig.default || "none"})`, value: "default" },
        { name: "Test configuration", value: "test" },
        { name: "Exit", value: "exit" }
      ]
    }]);
    
    if (action === "exit") process.exit(0);
    
    if (action === "providers") {
      await this.configureProviders(llmsConfig);
      await this.saveConfig(llmsConfig);
    } else if (action === "test") {
      await ConfigurationTester.test(llmsConfig);
    } else {
      // All other actions use ConfigurationManager
      if (action === "add") await ConfigurationManager.add(llmsConfig);
      if (action === "delete") await ConfigurationManager.delete(llmsConfig);
      if (action === "default") await ConfigurationManager.setDefault(llmsConfig);
      await this.saveConfig(llmsConfig);
    }
    
    await this.showMainMenu();
  }

  async runOnboardingFlow(): Promise<void> {
    console.log(chalk.green("\n🚀 Welcome to TENEX LLM Setup!\n"));
    
    const llmsConfig = await this.loadConfig();
    
    // Step 1: Configure providers
    console.log(chalk.cyan("Step 1: Configure Provider API Keys"));
    await this.configureProviders(llmsConfig);
    await this.saveConfig(llmsConfig);
    
    // Step 2: Create first configuration
    console.log(chalk.cyan("\nStep 2: Create Your First Configuration"));
    await ConfigurationManager.add(llmsConfig, true);
    await this.saveConfig(llmsConfig);
    
    // Step 3: Offer to test
    const { shouldTest } = await inquirer.prompt([{
      type: "confirm",
      name: "shouldTest",
      message: "Would you like to test your configuration?",
      default: true
    }]);
    
    if (shouldTest) {
      await ConfigurationTester.test(llmsConfig);
    }
    
    console.log(chalk.green("\n✅ LLM configuration complete!"));
  }

  private async configureProviders(llmsConfig: TenexLLMs): Promise<void> {
    const choices = AI_SDK_PROVIDERS.map(p => {
      const isConfigured = llmsConfig.providers[p]?.apiKey && llmsConfig.providers[p]?.apiKey !== "none";
      const name = ProviderConfigUI.getProviderDisplayName(p);
      return {
        name: isConfigured ? `${name} (configured)` : name,
        value: p,
      };
    });

    const { selected } = await inquirer.prompt([{
      type: "checkbox",
      name: "selected",
      message: "Select providers to configure:",
      choices: choices
    }]);

    const providers = selected;
    
    for (const provider of providers) {
      const config = await ProviderConfigUI.configureProvider(provider, llmsConfig);
      if (!llmsConfig.providers[provider]) {
        llmsConfig.providers[provider] = { apiKey: "" };
      }
      const providerConfig = llmsConfig.providers[provider];
      if (providerConfig) {
        providerConfig.apiKey = config.apiKey;
      }
    }
  }

  private async loadConfig(): Promise<TenexLLMs> {
    return await configService.loadTenexLLMs(
      this.isGlobal ? configService.getGlobalPath() : this.configPath
    );
  }

  private async saveConfig(config: TenexLLMs): Promise<void> {
    if (this.isGlobal) {
      await configService.saveGlobalLLMs(config);
    } else {
      await configService.saveProjectLLMs(this.configPath, config);
    }
    await llmServiceFactory.initializeProviders(config.providers);
  }
}