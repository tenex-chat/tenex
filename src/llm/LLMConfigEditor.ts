import type { ResolvedLLMConfig, LLMProvider } from "@/llm/types";
import { configService } from "@/services";
import type { TenexLLMs } from "@/services/config/types";
import { LLM_DEFAULTS } from "./constants";
import { ModelSelector } from "./selection/ModelSelector";
import { LLMTester } from "./testing/LLMTester";
import { LLMConfigUI, type LLMConfigWithName } from "./ui/LLMConfigUI";

/**
 * LLM Configuration Editor - Orchestrates configuration management
 * Now focused purely on business logic, delegating to specialized utilities
 */
export class LLMConfigEditor {
    private ui: LLMConfigUI;
    private modelSelector: ModelSelector;
    private tester: LLMTester;

    constructor(private configPath: string, private isGlobal = true) {
        this.ui = new LLMConfigUI(isGlobal);
        this.modelSelector = new ModelSelector();
        this.tester = new LLMTester();
    }

    async showMainMenu(): Promise<void> {
        const llmsConfig = await this.loadConfig();
        const configs = this.getConfigList(llmsConfig);

        this.ui.displayCurrentConfigurations(configs, llmsConfig);
        
        const action = await this.ui.promptMainMenuAction(configs, llmsConfig);
        await this.handleMenuAction(action, llmsConfig);
        
        if (action !== "exit") {
            await this.showMainMenu();
        }
    }

    async runOnboardingFlow(): Promise<void> {
        this.ui.displayMessages.setupStart();
        let hasAddedConfig = false;

        while (true) {
            const llmsConfig = await this.loadConfig();
            const configs = this.getConfigList(llmsConfig);

            this.ui.displayCurrentConfigurations(configs, llmsConfig);
            
            const action = await this.ui.promptOnboardingAction(configs, llmsConfig, hasAddedConfig);
            
            if (action === "add") {
                await this.addConfiguration(llmsConfig);
                hasAddedConfig = true;
            } else if (action === "continue") {
                this.ui.displayMessages.configurationComplete();
                return;
            } else {
                await this.handleMenuAction(action, llmsConfig);
            }
        }
    }

    // Configuration Management - Delegates to ConfigService
    private async loadConfig(): Promise<TenexLLMs> {
        try {
            if (this.isGlobal) {
                return await configService.loadTenexLLMs(configService.getGlobalPath());
            } else {
                const config = await configService.loadConfig(this.configPath);
                return config.llms;
            }
        } catch (error) {
            // Return empty config on error
            return {
                configurations: {},
                defaults: {},
                credentials: {},
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

    private getConfigList(llmsConfig: TenexLLMs): LLMConfigWithName[] {
        const configs: LLMConfigWithName[] = [];

        for (const [key, value] of Object.entries(llmsConfig.configurations)) {
            // Get credentials if they exist
            const credentials = llmsConfig.credentials?.[value.provider];
            const config: LLMConfigWithName = {
                name: key,
                provider: value.provider,
                model: value.model,
                apiKey: credentials?.apiKey,
                baseUrl: credentials?.baseUrl,
                temperature: value.temperature,
                maxTokens: value.maxTokens,
                enableCaching: value.enableCaching,
            };
            configs.push(config);
        }

        return configs;
    }

    private getExistingApiKeys(llmsConfig: TenexLLMs, provider: LLMProvider): string[] {
        const keys = new Set<string>();

        if (llmsConfig.credentials?.[provider]?.apiKey) {
            const apiKey = llmsConfig.credentials[provider]?.apiKey;
            if (apiKey) {
                keys.add(apiKey);
            }
        }

        return Array.from(keys);
    }

    // Menu Action Handler
    private async handleMenuAction(action: string, llmsConfig: TenexLLMs): Promise<void> {
        switch (action) {
            case "add":
                await this.addConfiguration(llmsConfig);
                break;
            case "test":
                await this.testExistingConfiguration(llmsConfig);
                break;
            case "edit":
                await this.editConfiguration(llmsConfig);
                break;
            case "remove":
                await this.removeConfiguration(llmsConfig);
                break;
            case "default-agents":
                await this.setDefaultConfiguration(llmsConfig, LLM_DEFAULTS.AGENTS);
                break;
            case "default-analyze":
                await this.setDefaultConfiguration(llmsConfig, LLM_DEFAULTS.ANALYZE);
                break;
            case "default-orchestrator":
                await this.setDefaultConfiguration(llmsConfig, LLM_DEFAULTS.ORCHESTRATOR);
                break;
            case "exit":
                this.ui.displayMessages.configurationSaved();
                break;
        }
    }

    // Core Configuration Operations
    private async addConfiguration(llmsConfig: TenexLLMs): Promise<void> {
        this.ui.displayMessages.addingConfiguration();

        // 1. Select provider
        const provider = await this.ui.promptProviderSelection();

        // 2. Fetch and select model
        const existingApiKey = provider !== "ollama" 
            ? this.getExistingApiKeys(llmsConfig, provider)[0] 
            : undefined;

        this.ui.displayMessages.fetchingModels(provider);

        let modelSelection;
        try {
            modelSelection = await this.modelSelector.fetchAndSelectModel(provider, existingApiKey);
            if (!modelSelection) {
                this.ui.displayMessages.noModelsAvailable(provider);
                if (provider === "ollama") {
                    this.ui.displayMessages.ollamaNotRunning();
                }
                return;
            }
            
            // Show success message (we can get count from the successful selection)
            this.ui.displayMessages.modelsFound(0, provider); // Count will be shown by fetchAndSelectModel internally
        } catch (error) {
            this.ui.displayMessages.fetchModelsFailed(provider, error);
            return;
        }

        // 3. Get API key
        const existingKeys = this.getExistingApiKeys(llmsConfig, provider);
        const apiKeyResult = await this.ui.promptApiKey(existingKeys, provider);

        // 4. Configure settings
        const defaultConfigName = this.modelSelector.generateDefaultConfigName(provider, modelSelection.model);
        const configPrompts = await this.ui.promptConfigurationSettings(
            defaultConfigName,
            llmsConfig.configurations,
            modelSelection.supportsCaching,
            provider,
            modelSelection.model
        );

        // 5. Build and test configuration
        const newConfig: ResolvedLLMConfig = {
            provider,
            model: modelSelection.model,
            enableCaching: configPrompts.enableCaching ?? modelSelection.supportsCaching,
        };

        if (apiKeyResult.apiKey?.trim()) {
            newConfig.apiKey = apiKeyResult.apiKey;
        }

        if (provider === "openrouter") {
            newConfig.baseUrl = "https://openrouter.ai/api/v1";
        }

        this.ui.displayMessages.testingConfiguration();
        const testSuccessful = await this.tester.testLLMConfig(newConfig);

        if (testSuccessful) {
            this.ui.displayMessages.testSuccessful();
        } else {
            this.ui.displayMessages.testFailed();
            
            const shouldRetry = await this.ui.promptRetryOnTestFailure();
            if (shouldRetry) {
                this.ui.displayMessages.retryPrompt();
                await this.addConfiguration(llmsConfig);
                return;
            }
            
            this.ui.displayMessages.testFailureNotSaved();
            return;
        }

        // 6. Save configuration
        llmsConfig.configurations[configPrompts.configName] = {
            provider,
            model: modelSelection.model,
            enableCaching: configPrompts.enableCaching ?? modelSelection.supportsCaching,
        };

        if (configPrompts.setAsDefault) {
            if (!llmsConfig.defaults) {
                llmsConfig.defaults = {};
            }
            llmsConfig.defaults[LLM_DEFAULTS.AGENTS] = configPrompts.configName;
        }

        if (this.isGlobal && apiKeyResult.apiKey && provider !== "ollama") {
            if (!llmsConfig.credentials) {
                llmsConfig.credentials = {};
            }
            llmsConfig.credentials[provider] = {
                apiKey: apiKeyResult.apiKey,
                baseUrl: provider === "openrouter" ? "https://openrouter.ai/api/v1" : undefined,
            };
        }

        await this.saveConfig(llmsConfig);
        this.ui.displayMessages.configurationAdded(configPrompts.configName);
    }

    private async editConfiguration(llmsConfig: TenexLLMs): Promise<void> {
        const configs = this.getConfigList(llmsConfig);
        const configName = await this.ui.promptConfigurationToEdit(configs);

        const config = llmsConfig.configurations[configName];
        if (!config) {
            this.ui.displayMessages.configurationNotFound(configName);
            return;
        }

        this.ui.displayMessages.editingConfiguration(configName);
        const field = await this.ui.promptFieldToEdit();

        switch (field) {
            case "model":
                await this.editModel(config, llmsConfig);
                break;
            case "apiKey":
                await this.editApiKey(config, llmsConfig);
                break;
            case "enableCaching":
                await this.editCaching(config);
                break;
            case "name":
                await this.editConfigName(config, configName, llmsConfig);
                break;
        }

        await this.saveConfig(llmsConfig);
        this.ui.displayMessages.configurationUpdated();
    }

    private async editModel(config: any, llmsConfig: TenexLLMs): Promise<void> {
        try {
            const apiKey = llmsConfig.credentials?.[config.provider]?.apiKey;
            const modelSelection = await this.modelSelector.fetchAndSelectModel(
                config.provider as LLMProvider,
                apiKey
            );
            
            if (!modelSelection) {
                this.ui.displayMessages.noModelsAvailable(config.provider);
                return;
            }
            
            config.model = modelSelection.model;
        } catch (error) {
            this.ui.displayMessages.fetchModelsFailed2(error);
        }
    }

    private async editApiKey(config: any, llmsConfig: TenexLLMs): Promise<void> {
        if (config.provider === "ollama") {
            this.ui.displayMessages.ollamaNoApiKey();
            return;
        }

        const newKey = await this.ui.promptNewApiKey();
        
        // Always update credentials
        if (!llmsConfig.credentials) {
            llmsConfig.credentials = {};
        }
        if (!llmsConfig.credentials[config.provider]) {
            llmsConfig.credentials[config.provider] = {};
        }
        llmsConfig.credentials[config.provider]!.apiKey = newKey;
    }

    private async editCaching(config: any): Promise<void> {
        const enableCaching = await this.ui.promptEnableCaching(config.enableCaching ?? false);
        config.enableCaching = enableCaching;
    }

    private async editConfigName(config: any, oldName: string, llmsConfig: TenexLLMs): Promise<void> {
        const newName = await this.ui.promptNewConfigName(oldName, llmsConfig.configurations);

        if (newName !== oldName) {
            llmsConfig.configurations[newName] = config;
            delete llmsConfig.configurations[oldName];

            // Update defaults if needed
            if (llmsConfig.defaults) {
                for (const [key, value] of Object.entries(llmsConfig.defaults)) {
                    if (value === oldName) {
                        llmsConfig.defaults[key] = newName;
                    }
                }
            }
        }
    }

    private async removeConfiguration(llmsConfig: TenexLLMs): Promise<void> {
        const configs = this.getConfigList(llmsConfig);
        const configName = await this.ui.promptConfigurationToRemove(configs);
        const confirmed = await this.ui.promptConfirmRemoval(configName);

        if (confirmed) {
            delete llmsConfig.configurations[configName];

            // Update defaults if needed
            if (llmsConfig.defaults) {
                for (const [key, value] of Object.entries(llmsConfig.defaults)) {
                    if (value === configName) {
                        delete llmsConfig.defaults[key];
                    }
                }
            }

            await this.saveConfig(llmsConfig);
            this.ui.displayMessages.configurationRemoved(configName);
        }
    }

    private async setDefaultConfiguration(llmsConfig: TenexLLMs, defaultType: string): Promise<void> {
        const configs = this.getConfigList(llmsConfig);
        const currentDefault = llmsConfig.defaults?.[defaultType] || "none";
        const typeLabel = this.getTypeLabelForDefault(defaultType);

        this.ui.displayMessages.settingDefault(typeLabel);
        this.ui.displayMessages.currentDefault(currentDefault);

        const configName = await this.ui.promptDefaultConfiguration(configs, currentDefault, typeLabel);

        if (!llmsConfig.defaults) {
            llmsConfig.defaults = {};
        }
        llmsConfig.defaults[defaultType] = configName;
        await this.saveConfig(llmsConfig);
        this.ui.displayMessages.defaultSet(configName, typeLabel);
    }

    private getTypeLabelForDefault(defaultType: string): string {
        switch (defaultType) {
            case LLM_DEFAULTS.AGENTS:
                return "agent";
            case LLM_DEFAULTS.ANALYZE:
                return "analyze tool";
            case LLM_DEFAULTS.ORCHESTRATOR:
                return "orchestrator";
            default:
                return "configuration";
        }
    }

    private async testExistingConfiguration(llmsConfig: TenexLLMs): Promise<void> {
        const configs = this.getConfigList(llmsConfig);
        const configName = await this.ui.promptConfigurationToTest(configs);

        const config = llmsConfig.configurations[configName];
        if (!config) {
            this.ui.displayMessages.configurationNotFound(configName);
            return;
        }

        this.ui.displayMessages.testingExistingConfig(configName);
        
        try {
            const success = await this.tester.testExistingConfiguration(
                configName,
                llmsConfig.configurations,
                llmsConfig.credentials
            );

            if (success) {
                this.ui.displayMessages.testSuccessful();
            } else {
                this.ui.displayMessages.testFailed();
            }
        } catch (error) {
            this.ui.displayMessages.testFailed();
        }
    }
}
