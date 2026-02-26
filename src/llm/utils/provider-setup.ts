import inquirer from "inquirer";

import { AI_SDK_PROVIDERS } from "@/llm/types";
import type { ProviderCredentials, TenexProviders } from "@/services/config/types";
import { hasApiKey } from "@/llm/providers/key-manager";
import { ProviderConfigUI } from "@/llm/utils/ProviderConfigUI";

/**
 * Interactive flow for configuring provider credentials.
 * Returns an updated TenexProviders object (merges into the existing map).
 */
export async function runProviderSetup(
    existingProviders: TenexProviders
): Promise<TenexProviders> {
    const providers: Record<string, ProviderCredentials> = {
        ...existingProviders.providers,
    };

    const choices = AI_SDK_PROVIDERS.map((provider) => {
        const isConfigured = hasApiKey(providers[provider]?.apiKey);
        const name = ProviderConfigUI.getProviderDisplayName(provider);
        return {
            name: isConfigured ? `${name} (configured)` : name,
            value: provider,
        };
    });

    const { selected } = await inquirer.prompt([
        {
            type: "checkbox",
            name: "selected",
            message: "Select providers to configure:",
            choices,
        },
    ]);

    if (!selected || selected.length === 0) {
        return existingProviders;
    }

    for (const provider of selected) {
        const providerConfig = await ProviderConfigUI.configureProvider(provider, providers);
        providers[provider] = {
            ...providers[provider],
            apiKey: providerConfig.apiKey,
        };
    }

    return { providers };
}
