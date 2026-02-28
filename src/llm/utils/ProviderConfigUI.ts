import { PROVIDER_IDS } from "@/llm/providers/provider-ids";
import { hasApiKey } from "@/llm/providers/key-manager";
import type { TenexLLMs } from "@/services/config/types";
import chalk from "chalk";
import * as display from "@/commands/setup/display";

/**
 * Extended type for editor use - includes providers
 */
type TenexLLMsWithProviders = TenexLLMs & {
    providers: Record<string, { apiKey: string | string[] }>;
};

/**
 * UI utilities for provider configuration
 */
export class ProviderConfigUI {
    static getProviderDisplayName(provider: string): string {
        const names: Record<string, string> = {
            [PROVIDER_IDS.OPENROUTER]: "OpenRouter (300+ models)",
            [PROVIDER_IDS.ANTHROPIC]: "Anthropic (Claude)",
            [PROVIDER_IDS.OPENAI]: "OpenAI (GPT)",
            [PROVIDER_IDS.OLLAMA]: "Ollama (Local models)",
            [PROVIDER_IDS.CODEX_APP_SERVER]: "Codex App Server (GPT-5.1/5.2)",
        };
        return names[provider] || provider;
    }

    static displayProviders(llmsConfig: TenexLLMsWithProviders): void {
        display.context("Configured Providers");
        const providers = Object.keys(llmsConfig.providers).filter(
            (p) => {
                const key = llmsConfig.providers[p]?.apiKey;
                return hasApiKey(key) || key === "none";
            },
        );
        if (providers.length === 0) {
            console.log(chalk.gray("  None configured"));
        } else {
            for (const p of providers) {
                display.success(ProviderConfigUI.getProviderDisplayName(p));
            }
        }
        display.blank();
    }
}
