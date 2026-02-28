import password from "@inquirer/password";
import input from "@inquirer/input";
import { AI_SDK_PROVIDERS } from "@/llm/types";
import type { ProviderCredentials, TenexProviders } from "@/services/config/types";
import { PROVIDER_IDS } from "@/llm/providers/provider-ids";
import providerSelectPrompt, {
    getKeys,
    isOllama,
    type PromptState,
    type ProviderSelectConfig,
} from "@/llm/utils/provider-select-prompt";
import { ProviderConfigUI } from "@/llm/utils/ProviderConfigUI";
import { inquirerTheme } from "@/utils/cli-theme";

/**
 * Interactive flow for configuring provider credentials.
 * Uses a two-level prompt: a provider list (browse/keys) and a separate
 * password prompt for entering API keys.
 */
export async function runProviderSetup(
    existingProviders: TenexProviders,
): Promise<TenexProviders> {
    const providerIds = AI_SDK_PROVIDERS.filter((p) => p !== PROVIDER_IDS.CLAUDE_CODE);

    let resumeState: PromptState | undefined;

    while (true) {
        const baseConfig: ProviderSelectConfig = {
            message: "Configure providers:",
            providerIds: [...providerIds],
            initialProviders: { ...existingProviders.providers },
            resumeState,
            theme: inquirerTheme,
        };

        const result = await providerSelectPrompt(baseConfig);

        if (result.action === "done") {
            return { providers: result.providers };
        }

        // add-key: ask for the key via a separate prompt
        const { providerId, returnTo, state } = result;
        const name = ProviderConfigUI.getProviderDisplayName(providerId);
        const apiKey = await askForKey(providerId, name);

        if (apiKey) {
            const existing = getKeys(state.providers[providerId]?.apiKey);
            if (existing.length > 0) {
                state.providers[providerId] = {
                    ...state.providers[providerId],
                    apiKey: [...existing, apiKey],
                } as ProviderCredentials;
            } else {
                state.providers[providerId] = { apiKey };
            }
        }

        // Restore the prompt in the mode we came from
        resumeState = {
            ...state,
            mode: returnTo,
            keysTarget: returnTo === "keys" ? providerId : null,
            keysActive: 0,
        };
    }
}

async function askForKey(providerId: string, displayName: string): Promise<string | undefined> {
    if (isOllama(providerId)) {
        const url = await input({
            message: `${displayName} URL:`,
            default: "http://localhost:11434",
            theme: inquirerTheme,
        });
        return url.trim() || undefined;
    }

    const key = await password({
        message: `${displayName} API key:`,
        mask: "*",
        theme: inquirerTheme,
    });
    return key.trim() || undefined;
}
