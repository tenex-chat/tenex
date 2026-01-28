import { config } from "@/services/ConfigService";
import type { PromptFragment } from "../core/types";

/**
 * Global system prompt fragment.
 *
 * This fragment allows users to configure a system prompt that is added to ALL
 * projects. It is loaded from the global config ($TENEX_BASE_DIR/config.json).
 *
 * Users can configure this via: `tenex setup global-system-prompt`
 *
 * Priority 3 places it after the core identity fragments (priorities 1 and 2),
 * so it is ordered like other fragments instead of being prepended.
 */

// Empty args - the fragment loads content from config
type GlobalSystemPromptArgs = Record<string, never>;

export const globalSystemPromptFragment: PromptFragment<GlobalSystemPromptArgs> = {
    id: "global-system-prompt",
    priority: 3,
    template: () => {
        try {
            const tenexConfig = config.getConfig();
            const globalPrompt = tenexConfig.globalSystemPrompt;

            // Check if enabled and has content
            if (!globalPrompt?.content || globalPrompt.content.trim().length === 0) {
                return "";
            }

            // Check if explicitly disabled
            if (globalPrompt.enabled === false) {
                return "";
            }

            // Return the user-configured global system prompt
            return globalPrompt.content.trim();
        } catch {
            // Config not loaded yet or error - return empty string
            return "";
        }
    },
};
