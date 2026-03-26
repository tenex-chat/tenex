import type { PromptFragment } from "../core/types";

export const channelBindingsFragment: PromptFragment<{
    bindings: Array<{
        channelId: string;
        description?: string;
    }>;
}> = {
    id: "channel-bindings",
    priority: 5,
    template: ({ bindings }) => {
        if (bindings.length === 0) {
            return "";
        }

        const lines = [
            "## Your Channel Bindings",
            "You can proactively send messages to these channels using the send_message tool:",
        ];

        for (const binding of bindings) {
            lines.push(
                `- ${binding.channelId}${binding.description ? ` — ${binding.description}` : ""}`
            );
        }

        return lines.join("\n");
    },
};
