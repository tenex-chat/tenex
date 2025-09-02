import type { TenexLLMs, LLMConfiguration } from "@/services/config/types";
import { configService } from "@/services";
import inquirer from "inquirer";
import chalk from "chalk";
import { AI_SDK_PROVIDERS } from "./types";
import type { AISdkProvider } from "./types";
import { fetchOpenRouterModels, getPopularModels } from "./providers/openrouter-models";
import { fetchOllamaModels, getPopularOllamaModels } from "./providers/ollama-models";

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
    // Show which providers are already configured
    const configuredProviders = AI_SDK_PROVIDERS.filter(p => !!llmsConfig.providers[p]?.apiKey);
    const unconfiguredProviders = AI_SDK_PROVIDERS.filter(p => !llmsConfig.providers[p]?.apiKey);
    
    if (configuredProviders.length > 0) {
      console.log(chalk.gray("\nAlready configured:"));
      configuredProviders.forEach(p => {
        console.log(chalk.green(`  ✓ ${this.getProviderDisplayName(p)}`));
      });
    }
    
    if (unconfiguredProviders.length === 0) {
      console.log(chalk.yellow("\n⚠️  All providers are already configured"));
      const { reconfigure } = await inquirer.prompt([{
        type: "confirm",
        name: "reconfigure",
        message: "Would you like to reconfigure existing providers?",
        default: false
      }]);
      
      if (!reconfigure) {
        return;
      }
      
      // If reconfiguring, let them select which ones
      const { providers } = await inquirer.prompt([{
        type: "checkbox",
        name: "providers",
        message: "Select providers to reconfigure:",
        choices: configuredProviders.map(p => ({
          name: this.getProviderDisplayName(p),
          value: p
        }))
      }]);
      
      for (const provider of providers) {
        await this.configureProvider(provider, llmsConfig);
      }
    } else {
      // Ask which unconfigured providers to set up
      const { providers } = await inquirer.prompt([{
        type: "checkbox",
        name: "providers",
        message: "Select providers to configure:",
        choices: unconfiguredProviders.map(p => ({
          name: this.getProviderDisplayName(p),
          value: p
        })),
        validate: (input: string[]) => {
          if (input.length === 0) return "Please select at least one provider";
          return true;
        }
      }]);
      
      for (const provider of providers) {
        await this.configureProvider(provider, llmsConfig);
      }
    }
    
    await this.saveConfig(llmsConfig);
    console.log(chalk.green("✅ Provider API keys configured"));
  }

  private async configureProvider(provider: string, llmsConfig: TenexLLMs): Promise<void> {
      if (provider === 'ollama') {
        // For Ollama, ask for base URL instead of API key
        const currentUrl = llmsConfig.providers[provider]?.apiKey || 'local';
        const { ollamaConfig } = await inquirer.prompt([{
          type: "list",
          name: "ollamaConfig",
          message: "Ollama configuration:",
          choices: [
            { name: "Use local Ollama (http://localhost:11434)", value: "local" },
            { name: "Use custom Ollama URL", value: "custom" }
          ],
          default: currentUrl === 'local' ? 'local' : 'custom'
        }]);
        
        let baseUrl = 'local';
        if (ollamaConfig === 'custom') {
          const { customUrl } = await inquirer.prompt([{
            type: "input",
            name: "customUrl",
            message: "Enter Ollama base URL:",
            default: currentUrl !== 'local' ? currentUrl : 'http://localhost:11434',
            validate: (input: string) => {
              if (!input.trim()) return "URL is required";
              try {
                new URL(input);
                return true;
              } catch {
                return "Please enter a valid URL";
              }
            }
          }]);
          baseUrl = customUrl;
        }
        
        if (!llmsConfig.providers[provider]) {
          llmsConfig.providers[provider] = { apiKey: "" };
        }
        const providerConfig = llmsConfig.providers[provider];
        if (providerConfig) {
          providerConfig.apiKey = baseUrl;
        }
      } else {
        // For other providers, ask for API key
        const currentKey = llmsConfig.providers[provider]?.apiKey;
        const { apiKey } = await inquirer.prompt([{
          type: "password",
          name: "apiKey",
          message: `Enter API key for ${this.getProviderDisplayName(provider)} (press Enter to keep existing):`,
          default: currentKey,
          mask: "*",
          validate: (input: string) => {
            // Allow empty input if there's an existing key
            if (!input.trim() && !currentKey) return "API key is required";
            return true;
          }
        }]);
        
        // Only update if a new key was provided (not empty)
        if (apiKey && apiKey.trim()) {
          if (!llmsConfig.providers[provider]) {
            llmsConfig.providers[provider] = { apiKey: "" };
          }
          const providerConfig = llmsConfig.providers[provider];
          if (providerConfig) {
            providerConfig.apiKey = apiKey;
          }
        }
      }
  }

  private async addConfiguration(llmsConfig: TenexLLMs, isFirstConfig = false): Promise<void> {
    const configuredProviders = Object.keys(llmsConfig.providers).filter(
      p => llmsConfig.providers[p]?.apiKey
    );
    
    if (configuredProviders.length === 0) {
      console.log(chalk.yellow("⚠️  No providers configured. Please configure API keys first."));
      return;
    }
    
    // Select provider first
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
    } else if (provider === 'ollama') {
      model = await this.selectOllamaModel();
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
    
    // Get configuration name at the end
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
    } else if (provider === 'ollama') {
      model = await this.selectOllamaModel(config.model);
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

  private async selectOllamaModel(currentModel?: string): Promise<string> {
    console.log(chalk.gray("Fetching available Ollama models..."));
    
    const ollamaModels = await fetchOllamaModels();
    
    if (ollamaModels.length > 0) {
      console.log(chalk.green(`✓ Found ${ollamaModels.length} installed models`));
      
      // Add "Type manually..." option at the end of the list
      const choices = [
        ...ollamaModels.map(m => ({
          name: `${m.name} ${chalk.gray(`(${m.size})`)}`,
          value: m.name
        })),
        new inquirer.Separator(),
        { name: chalk.cyan("→ Type model name manually"), value: "__manual__" }
      ];
      
      const { selectedModel } = await inquirer.prompt([{
        type: "list",
        name: "selectedModel",
        message: "Select model:",
        choices,
        default: currentModel,
        pageSize: 15
      }]);
      
      if (selectedModel === "__manual__") {
        const { inputModel } = await inquirer.prompt([{
          type: "input",
          name: "inputModel",
          message: "Enter model name (e.g., llama3.1:8b):",
          default: currentModel || "llama3.1:8b",
          validate: (input: string) => {
            if (!input.trim()) return "Model name is required";
            return true;
          }
        }]);
        return inputModel;
      }
      
      return selectedModel;
    } else {
      console.log(chalk.yellow("⚠️  No Ollama models found. Make sure Ollama is running."));
      console.log(chalk.gray("Showing popular models (you'll need to pull them first)."));
      
      const popular = getPopularOllamaModels();
      const choices = [];
      for (const [category, models] of Object.entries(popular)) {
        choices.push(new inquirer.Separator(`--- ${category} ---`));
        choices.push(...models.map(m => ({
          name: m,
          value: m
        })));
      }
      
      // Add manual entry option at the end
      choices.push(new inquirer.Separator());
      choices.push({ name: chalk.cyan("→ Type model name manually"), value: "__manual__" });
      
      const { selectedModel } = await inquirer.prompt([{
        type: "list",
        name: "selectedModel",
        message: "Select model:",
        default: currentModel,
        choices,
        pageSize: 15
      }]);
      
      if (selectedModel === "__manual__") {
        const { inputModel } = await inquirer.prompt([{
          type: "input",
          name: "inputModel",
          message: "Enter model name (e.g., llama3.1:8b):",
          default: currentModel || "llama3.1:8b",
          validate: (input: string) => {
            if (!input.trim()) return "Model name is required";
            return true;
          }
        }]);
        return inputModel;
      }
      
      return selectedModel;
    }
  }

  private async selectOpenRouterModel(currentModel?: string): Promise<string> {
    console.log(chalk.gray("Fetching available OpenRouter models..."));
    
    const openRouterModels = await fetchOpenRouterModels();
    
    if (openRouterModels.length > 0) {
      console.log(chalk.green(`✓ Found ${openRouterModels.length} available models`));
      
      // Group models by provider for better organization
      const modelsByProvider: Record<string, typeof openRouterModels> = {};
      for (const model of openRouterModels) {
        const provider = model.id.split('/')[0] || 'other';
        if (!modelsByProvider[provider]) {
          modelsByProvider[provider] = [];
        }
        modelsByProvider[provider].push(model);
      }
      
      // Build choices with all models organized by provider
      const choices = [];
      const sortedProviders = Object.keys(modelsByProvider).sort();
      
      for (const provider of sortedProviders) {
        choices.push(new inquirer.Separator(chalk.yellow(`--- ${provider.toUpperCase()} ---`)));
        const providerModels = modelsByProvider[provider];
        
        for (const model of providerModels) {
          const pricing = `$${model.pricing.prompt}/$${model.pricing.completion}/1M`;
          const context = `${Math.round(model.context_length / 1000)}k`;
          const freeTag = model.id.endsWith(':free') ? chalk.green(' [FREE]') : '';
          
          choices.push({
            name: `${model.id}${freeTag} ${chalk.gray(`- ${context} context, ${pricing}`)}`,
            value: model.id,
            short: model.id
          });
        }
      }
      
      // Add manual entry option at the end
      choices.push(new inquirer.Separator());
      choices.push({ name: chalk.cyan("→ Type model ID manually"), value: "__manual__" });
      
      const { selectedModel } = await inquirer.prompt([{
        type: "list",
        name: "selectedModel",
        message: "Select model:",
        choices,
        default: currentModel,
        pageSize: 20,
        loop: false
      }]);
      
      if (selectedModel === "__manual__") {
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
      
      return selectedModel;
    } else {
      console.log(chalk.yellow("⚠️  Failed to fetch models from OpenRouter API"));
      console.log(chalk.gray("You can still enter a model ID manually or select from popular models."));
      
      const { selectionMethod } = await inquirer.prompt([{
        type: "list",
        name: "selectionMethod",
        message: "How would you like to select the model?",
        choices: [
          { name: "Quick select from popular models", value: "quick" },
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
      // Import the factory and create a mock logger
      const { llmServiceFactory } = await import("./LLMServiceFactory");
      
      // Initialize providers if not already done
      llmServiceFactory.initializeProviders(llmsConfig.providers);
      
      // Create a simple mock logger for testing
      const mockLogger = {
        logLLMRequest: async () => {},
        logLLMResponse: async () => {}
      };
      
      // Create the service for the specific configuration
      const service = llmServiceFactory.createService(mockLogger as Parameters<typeof llmServiceFactory.createService>[0], config);
      
      console.log(chalk.cyan("📡 Sending test message..."));
      const result = await service.complete([
        { role: "user", content: "Say 'Hello, TENEX!' in exactly those words." }
      ], {}, {
        temperature: config.temperature,
        maxTokens: config.maxTokens
      });
      
      console.log(chalk.green("\n✅ Test successful!"));
      const resultText = 'text' in result ? result.text : '';
      console.log(chalk.white("Response: ") + chalk.cyan(resultText));
      
      // Show usage stats if available
      if ('usage' in result && result.usage) {
        const usage = result.usage as { promptTokens?: number; completionTokens?: number; totalTokens?: number };
        const promptTokens = usage.promptTokens || '?';
        const completionTokens = usage.completionTokens || '?';
        const totalTokens = usage.totalTokens || '?';
        console.log(chalk.gray(`\nTokens used: ${promptTokens} prompt + ${completionTokens} completion = ${totalTokens} total`));
      }
      
      // Wait a moment so user can see the result
      await new Promise(resolve => setTimeout(resolve, 2000));
      
    } catch (error: unknown) {
      console.log(chalk.red("\n❌ Test failed!"));
      
      // Better error reporting
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage) {
        console.log(chalk.red(`Error: ${errorMessage}`));
      }
      
      // Check for common issues
      if (errorMessage?.includes('401') || errorMessage?.includes('Unauthorized')) {
        console.log(chalk.yellow("\n💡 This usually means your API key is invalid or expired."));
        console.log(chalk.yellow("   Please check your API key for this provider."));
      } else if (errorMessage?.includes('404')) {
        console.log(chalk.yellow(`\n💡 The model '${config.model}' may not be available.`));
        console.log(chalk.yellow("   Please verify the model name is correct."));
      } else if (errorMessage?.includes('rate limit')) {
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
      openai: "OpenAI (GPT)",
      ollama: "Ollama (Local models)"
    };
    return names[provider] || provider;
  }

  private getDefaultModelForProvider(provider: AISdkProvider): string {
    const defaults: Record<AISdkProvider, string> = {
      openrouter: "openai/gpt-4",
      anthropic: "claude-3-5-sonnet-latest",
      openai: "gpt-4",
      ollama: "llama3.1:8b"
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