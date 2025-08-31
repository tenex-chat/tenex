import type { TenexLLMs, LLMConfiguration } from "@/services/config/types";
import { configService } from "@/services";
import inquirer from "inquirer";
import searchCheckbox from "@inquirer/search";
import chalk from "chalk";
import { AI_SDK_PROVIDERS } from "./types";
import type { AISdkProvider } from "./types";
import { fetchOpenRouterModels, getPopularModels } from "./providers/openrouter-models";
import type { OpenRouterModel } from "./providers/openrouter-models";

/**
 * LLM Configuration Editor for managing named configurations
 */
export class LLMConfigEditor {
  constructor(
    private configPath: string,
    private isGlobal = true
  ) {}

  async showMainMenu(): Promise<void> {
    const llmsConfig = await this.loadConfig();
    
    console.log(chalk.cyan("\n=== LLM Configuration ===\n"));
    this.displayCurrentConfig(llmsConfig);
    
    const currentDefault = llmsConfig.default && llmsConfig.configurations[llmsConfig.default] 
      ? llmsConfig.default 
      : "none";
    
    const choices = [
      { name: "Configure provider API keys", value: "providers" },
      { name: "Add new configuration", value: "add" },
      { name: "Delete configuration", value: "delete" },
      { name: `Default configuration: ${chalk.cyan(currentDefault)}`, value: "default" },
      { name: "Test configuration", value: "test" },
      { name: "Exit", value: "exit" }
    ];
    
    const { action } = await inquirer.prompt([{
      type: "list",
      name: "action",
      message: "What would you like to do?",
      choices
    }]);
    
    switch (action) {
      case "providers":
        await this.configureProviders(llmsConfig);
        break;
      case "add":
        await this.addConfiguration(llmsConfig);
        break;
      case "delete":
        await this.deleteConfiguration(llmsConfig);
        break;
      case "default":
        await this.setDefaultConfiguration(llmsConfig);
        break;
      case "test":
        await this.testConfiguration(llmsConfig);
        break;
      case "exit":
        process.exit(0);
    }
    
    if (action !== "exit") {
      await this.showMainMenu();
    }
  }

  async runOnboardingFlow(): Promise<void> {
    console.log(chalk.green("\n🚀 Welcome to TENEX LLM Setup!\n"));
    console.log("Let's configure your AI providers and create your first configuration.\n");
    
    const llmsConfig = await this.loadConfig();
    
    // Step 1: Configure at least one provider
    console.log(chalk.cyan("Step 1: Configure Provider API Keys"));
    await this.configureProviders(llmsConfig);
    
    // Step 2: Create first configuration
    console.log(chalk.cyan("\nStep 2: Create Your First Configuration"));
    await this.addConfiguration(llmsConfig, true);
    
    // Step 3: Test configuration
    const { shouldTest } = await inquirer.prompt([{
      type: "confirm",
      name: "shouldTest",
      message: "Would you like to test your configuration?",
      default: true
    }]);
    
    if (shouldTest) {
      await this.testConfiguration(llmsConfig);
    }
    
    console.log(chalk.green("\n✅ LLM configuration complete!"));
  }

  private async configureProviders(llmsConfig: TenexLLMs): Promise<void> {
    const { providers } = await inquirer.prompt([{
      type: "checkbox",
      name: "providers",
      message: "Select providers to configure:",
      choices: AI_SDK_PROVIDERS.map(p => ({
        name: this.getProviderDisplayName(p),
        value: p,
        checked: !!llmsConfig.providers[p]?.apiKey
      }))
    }]);
    
    for (const provider of providers) {
      const currentKey = llmsConfig.providers[provider]?.apiKey;
      const { apiKey } = await inquirer.prompt([{
        type: "password",
        name: "apiKey",
        message: `Enter API key for ${this.getProviderDisplayName(provider)}:`,
        default: currentKey,
        mask: "*",
        validate: (input: string) => {
          if (!input.trim()) return "API key is required";
          return true;
        }
      }]);
      
      if (!llmsConfig.providers[provider]) {
        llmsConfig.providers[provider] = { apiKey: "" };
      }
      llmsConfig.providers[provider]!.apiKey = apiKey;
    }
    
    await this.saveConfig(llmsConfig);
    console.log(chalk.green("✅ Provider API keys configured"));
  }

  private async addConfiguration(llmsConfig: TenexLLMs, isFirstConfig = false): Promise<void> {
    const configuredProviders = Object.keys(llmsConfig.providers).filter(
      p => llmsConfig.providers[p]?.apiKey
    );
    
    if (configuredProviders.length === 0) {
      console.log(chalk.yellow("⚠️  No providers configured. Please configure API keys first."));
      return;
    }
    
    // Get configuration name
    const { name } = await inquirer.prompt([{
      type: "input",
      name: "name",
      message: "Configuration name:",
      default: isFirstConfig ? "default" : undefined,
      validate: (input: string) => {
        if (!input.trim()) return "Name is required";
        if (llmsConfig.configurations[input]) return "Configuration already exists";
        return true;
      }
    }]);
    
    // Select provider
    const { provider } = await inquirer.prompt([{
      type: "list",
      name: "provider",
      message: "Select provider:",
      choices: configuredProviders.map(p => ({
        name: this.getProviderDisplayName(p),
        value: p
      }))
    }]);
    
    // Select model
    let model: string;
    if (provider === 'openrouter') {
      model = await this.selectOpenRouterModel();
    } else {
      const { inputModel } = await inquirer.prompt([{
        type: "input",
        name: "inputModel",
        message: "Enter model name:",
        default: this.getDefaultModelForProvider(provider as AISdkProvider),
        validate: (input: string) => {
          if (!input.trim()) return "Model name is required";
          return true;
        }
      }]);
      model = inputModel;
    }
    
    // Additional settings
    const { temperature, maxTokens } = await inquirer.prompt([
      {
        type: "input",
        name: "temperature",
        message: "Temperature (0-2, press enter to skip):",
        validate: (input: string) => {
          if (!input) return true;
          const num = parseFloat(input);
          if (isNaN(num) || num < 0 || num > 2) return "Temperature must be between 0 and 2";
          return true;
        }
      },
      {
        type: "input",
        name: "maxTokens",
        message: "Max tokens (press enter to skip):",
        validate: (input: string) => {
          if (!input) return true;
          const num = parseInt(input);
          if (isNaN(num) || num <= 0) return "Max tokens must be a positive number";
          return true;
        }
      }
    ]);
    
    // Create configuration
    const config: LLMConfiguration = {
      provider,
      model
    };
    
    if (temperature) config.temperature = parseFloat(temperature);
    if (maxTokens) config.maxTokens = parseInt(maxTokens);
    
    llmsConfig.configurations[name] = config;
    
    // Set as default if it's the first configuration or if user wants
    if (isFirstConfig || !llmsConfig.default) {
      llmsConfig.default = name;
      console.log(chalk.green(`✅ Configuration "${name}" created and set as default`));
    } else {
      const { setAsDefault } = await inquirer.prompt([{
        type: "confirm",
        name: "setAsDefault",
        message: "Set as default configuration?",
        default: false
      }]);
      
      if (setAsDefault) {
        llmsConfig.default = name;
      }
      console.log(chalk.green(`✅ Configuration "${name}" created`));
    }
    
    await this.saveConfig(llmsConfig);
  }

  private async editConfiguration(llmsConfig: TenexLLMs): Promise<void> {
    const configNames = Object.keys(llmsConfig.configurations);
    
    if (configNames.length === 0) {
      console.log(chalk.yellow("⚠️  No configurations to edit"));
      return;
    }
    
    const { name } = await inquirer.prompt([{
      type: "list",
      name: "name",
      message: "Select configuration to edit:",
      choices: configNames.map(n => ({
        name: n === llmsConfig.default ? `${n} (default)` : n,
        value: n
      }))
    }]);
    
    const config = llmsConfig.configurations[name];
    
    // Edit provider
    const configuredProviders = Object.keys(llmsConfig.providers).filter(
      p => llmsConfig.providers[p]?.apiKey
    );
    
    const { provider } = await inquirer.prompt([{
      type: "list",
      name: "provider",
      message: "Provider:",
      default: config.provider,
      choices: configuredProviders.map(p => ({
        name: this.getProviderDisplayName(p),
        value: p
      }))
    }]);
    
    // Edit model
    let model: string;
    if (provider === 'openrouter') {
      model = await this.selectOpenRouterModel(config.model);
    } else {
      const { inputModel } = await inquirer.prompt([{
        type: "input",
        name: "inputModel",
        message: "Model name:",
        default: config.model,
        validate: (input: string) => {
          if (!input.trim()) return "Model name is required";
          return true;
        }
      }]);
      model = inputModel;
    }
    
    // Edit additional settings
    const { temperature, maxTokens } = await inquirer.prompt([
      {
        type: "input",
        name: "temperature",
        message: "Temperature (0-2, press enter to skip):",
        default: config.temperature?.toString(),
        validate: (input: string) => {
          if (!input) return true;
          const num = parseFloat(input);
          if (isNaN(num) || num < 0 || num > 2) return "Temperature must be between 0 and 2";
          return true;
        }
      },
      {
        type: "input",
        name: "maxTokens",
        message: "Max tokens (press enter to skip):",
        default: config.maxTokens?.toString(),
        validate: (input: string) => {
          if (!input) return true;
          const num = parseInt(input);
          if (isNaN(num) || num <= 0) return "Max tokens must be a positive number";
          return true;
        }
      }
    ]);
    
    // Update configuration
    llmsConfig.configurations[name] = {
      provider,
      model,
      ...(temperature && { temperature: parseFloat(temperature) }),
      ...(maxTokens && { maxTokens: parseInt(maxTokens) })
    };
    
    await this.saveConfig(llmsConfig);
    console.log(chalk.green(`✅ Configuration "${name}" updated`));
  }

  private async deleteConfiguration(llmsConfig: TenexLLMs): Promise<void> {
    const configNames = Object.keys(llmsConfig.configurations);
    
    if (configNames.length === 0) {
      console.log(chalk.yellow("⚠️  No configurations to delete"));
      return;
    }
    
    const { name } = await inquirer.prompt([{
      type: "list",
      name: "name",
      message: "Select configuration to delete:",
      choices: configNames.map(n => ({
        name: n === llmsConfig.default ? `${n} (default)` : n,
        value: n
      }))
    }]);
    
    const { confirm } = await inquirer.prompt([{
      type: "confirm",
      name: "confirm",
      message: `Are you sure you want to delete "${name}"?`,
      default: false
    }]);
    
    if (confirm) {
      delete llmsConfig.configurations[name];
      
      // Update default if needed
      if (llmsConfig.default === name) {
        const remaining = Object.keys(llmsConfig.configurations);
        llmsConfig.default = remaining.length > 0 ? remaining[0] : undefined;
        
        if (llmsConfig.default) {
          console.log(chalk.yellow(`Default changed to "${llmsConfig.default}"`));
        }
      }
      
      await this.saveConfig(llmsConfig);
      console.log(chalk.green(`✅ Configuration "${name}" deleted`));
    }
  }

  private async setDefaultConfiguration(llmsConfig: TenexLLMs): Promise<void> {
    const configNames = Object.keys(llmsConfig.configurations);
    
    if (configNames.length === 0) {
      console.log(chalk.yellow("⚠️  No configurations available"));
      return;
    }
    
    const { name } = await inquirer.prompt([{
      type: "list",
      name: "name",
      message: "Select default configuration:",
      choices: configNames.map(n => ({
        name: n === llmsConfig.default ? `${n} (current default)` : n,
        value: n
      }))
    }]);
    
    llmsConfig.default = name;
    await this.saveConfig(llmsConfig);
    console.log(chalk.green(`✅ Default configuration set to "${name}"`));
  }

  private async selectOpenRouterModel(currentModel?: string): Promise<string> {
    console.log(chalk.gray("Fetching available OpenRouter models..."));
    const openRouterModels = await fetchOpenRouterModels();
    
    if (openRouterModels.length > 0) {
      console.log(chalk.green(`✓ Found ${openRouterModels.length} available models`));
    }
    
    const { selectionMethod } = await inquirer.prompt([{
      type: "list",
      name: "selectionMethod",
      message: "How would you like to select the model?",
      choices: [
        { name: "Quick select from popular models", value: "quick" },
        { name: "Search all available models", value: "search" },
        { name: "Type model ID manually", value: "manual" }
      ]
    }]);
    
    if (selectionMethod === 'quick') {
      const popular = getPopularModels();
      const choices = [];
      for (const [category, models] of Object.entries(popular)) {
        choices.push(new inquirer.Separator(`--- ${category} ---`));
        choices.push(...models.map(m => ({
          name: m,
          value: m
        })));
      }
      
      const { selectedModel } = await inquirer.prompt([{
        type: "list",
        name: "selectedModel",
        message: "Select model:",
        default: currentModel,
        choices,
        pageSize: 15
      }]);
      return selectedModel;
    } else if (selectionMethod === 'search' && openRouterModels.length > 0) {
      const { selectedModel } = await inquirer.prompt([{
        type: "search",
        name: "selectedModel",
        message: "Search for model (type to filter):",
        source: async (input = '') => {
          const filtered = openRouterModels.filter(m => 
            m.id.toLowerCase().includes(input.toLowerCase()) ||
            m.name.toLowerCase().includes(input.toLowerCase())
          );
          
          return filtered.slice(0, 20).map(m => ({
            name: `${m.id} ${chalk.gray(`- ${m.name}`)}`,
            value: m.id,
            short: m.id
          }));
        }
      }]);
      return selectedModel;
    } else {
      const { inputModel } = await inquirer.prompt([{
        type: "input",
        name: "inputModel",
        message: "Enter model ID:",
        default: currentModel || "openai/gpt-4",
        validate: (input: string) => {
          if (!input.trim()) return "Model ID is required";
          return true;
        }
      }]);
      return inputModel;
    }
  }

  private async testConfiguration(llmsConfig: TenexLLMs): Promise<void> {
    const configNames = Object.keys(llmsConfig.configurations);
    
    if (configNames.length === 0) {
      console.log(chalk.yellow("⚠️  No configurations to test"));
      return;
    }
    
    const { name } = await inquirer.prompt([{
      type: "list",
      name: "name",
      message: "Select configuration to test:",
      choices: configNames.map(n => ({
        name: n === llmsConfig.default ? `${n} (default)` : n,
        value: n
      }))
    }]);
    
    const config = llmsConfig.configurations[name];
    console.log(chalk.yellow(`\nTesting configuration "${name}"...`));
    console.log(chalk.gray(`Provider: ${config.provider}, Model: ${config.model}`));
    
    try {
      const { getLLMService } = await import("./service");
      const service = getLLMService(
        llmsConfig.providers,
        llmsConfig.configurations,
        llmsConfig.default
      );
      
      // Format model string as provider:model
      const modelString = `${config.provider}:${config.model}`;
      
      console.log(chalk.cyan("📡 Sending test message..."));
      const result = await service.complete(modelString, [
        { role: "user", content: "Say 'Hello, TENEX!' in exactly those words." }
      ], {
        temperature: config.temperature,
        maxTokens: config.maxTokens
      });
      
      console.log(chalk.green("\n✅ Test successful!"));
      console.log(chalk.white("Response: ") + chalk.cyan(result.text));
      
      // Show usage stats if available
      if (result.usage) {
        const promptTokens = result.usage.promptTokens || '?';
        const completionTokens = result.usage.completionTokens || '?';
        const totalTokens = result.usage.totalTokens || '?';
        console.log(chalk.gray(`\nTokens used: ${promptTokens} prompt + ${completionTokens} completion = ${totalTokens} total`));
      }
      
      // Wait a moment so user can see the result
      await new Promise(resolve => setTimeout(resolve, 2000));
      
    } catch (error: any) {
      console.log(chalk.red("\n❌ Test failed!"));
      
      // Better error reporting
      if (error?.message) {
        console.log(chalk.red(`Error: ${error.message}`));
      }
      
      // Check for common issues
      if (error?.message?.includes('401') || error?.message?.includes('Unauthorized')) {
        console.log(chalk.yellow("\n💡 This usually means your API key is invalid or expired."));
        console.log(chalk.yellow("   Please check your API key for this provider."));
      } else if (error?.message?.includes('404')) {
        console.log(chalk.yellow("\n💡 The model '${config.model}' may not be available."));
        console.log(chalk.yellow("   Please verify the model name is correct."));
      } else if (error?.message?.includes('rate limit')) {
        console.log(chalk.yellow("\n💡 You've hit a rate limit. Please wait and try again."));
      } else {
        // Show full error details for debugging
        console.log(chalk.gray("\nFull error details:"));
        console.log(chalk.gray(JSON.stringify(error, null, 2)));
      }
      
      // Wait so user can read the error
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }

  private displayCurrentConfig(llmsConfig: TenexLLMs): void {
    console.log(chalk.bold("Configured Providers:"));
    const providers = Object.keys(llmsConfig.providers).filter(
      p => llmsConfig.providers[p]?.apiKey
    );
    if (providers.length === 0) {
      console.log(chalk.gray("  None configured"));
    } else {
      providers.forEach(p => {
        console.log(chalk.green(`  ✓ ${this.getProviderDisplayName(p)}`));
      });
    }
    
    console.log(chalk.bold("\nConfigurations:"));
    const configNames = Object.keys(llmsConfig.configurations);
    if (configNames.length === 0) {
      console.log(chalk.gray("  None"));
    } else {
      configNames.forEach(name => {
        const config = llmsConfig.configurations[name];
        const isDefault = name === llmsConfig.default;
        const marker = isDefault ? chalk.cyan('• ') : '  ';
        const defaultTag = isDefault ? chalk.gray(' (default)') : '';
        console.log(`  ${marker}${name}${defaultTag}: ${config.provider}:${config.model}`);
      });
    }
  }

  private getProviderDisplayName(provider: string): string {
    const names: Record<string, string> = {
      openrouter: "OpenRouter (300+ models)",
      anthropic: "Anthropic (Claude)",
      openai: "OpenAI (GPT)"
    };
    return names[provider] || provider;
  }

  private getDefaultModelForProvider(provider: AISdkProvider): string {
    const defaults: Record<AISdkProvider, string> = {
      openrouter: "openai/gpt-4",
      anthropic: "claude-3-5-sonnet-latest",
      openai: "gpt-4"
    };
    return defaults[provider] || "";
  }

  private async loadConfig(): Promise<TenexLLMs> {
    try {
      if (this.isGlobal) {
        return await configService.loadTenexLLMs(configService.getGlobalPath());
      }
      const config = await configService.loadConfig(this.configPath);
      return config.llms;
    } catch {
      return {
        providers: {},
        configurations: {},
        default: undefined
      };
    }
  }

  private async saveConfig(config: TenexLLMs): Promise<void> {
    if (this.isGlobal) {
      await configService.saveGlobalLLMs(config);
    } else {
      await configService.saveProjectLLMs(this.configPath, config);
    }
  }
}