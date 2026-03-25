import type { AgentInstance } from "@/agents/types";
import type { PromptFragment } from "../core/types";
import { createTelegramChannelId } from "@/utils/telegram-identifiers";

export const channelBindingsFragment: PromptFragment<{
    agent: AgentInstance;
}> = {
    id: "channel-bindings",
    priority: 5,
    template: ({ agent }) => {
        const bindings = agent.telegram?.chatBindings;
        if (!bindings || bindings.length === 0) {
            return "";
        }

        const lines = [
            "## Your Channel Bindings",
            "You can proactively send messages to these channels using the send_message tool:",
        ];

        for (const binding of bindings) {
            const channelId = createTelegramChannelId(binding.chatId, binding.topicId);
            const label = binding.title ? ` — "${binding.title}"` : "";
            lines.push(`- ${channelId}${label}`);
        }

        return lines.join("\n");
    },
};
