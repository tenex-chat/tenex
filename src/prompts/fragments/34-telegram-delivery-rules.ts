import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import type { PromptFragment } from "../core/types";

export const telegramDeliveryRulesFragment: PromptFragment<{
    triggeringEnvelope?: InboundEnvelope;
}> = {
    id: "telegram-delivery-rules",
    priority: 6,
    template: ({ triggeringEnvelope }) => {
        if (triggeringEnvelope?.transport !== "telegram") {
            return "";
        }

        return [
            "## Telegram Delivery Rules",
            "- To send a Telegram voice reply, output the reserved marker `[[telegram_voice:/absolute/path/to/file.ogg]]` on its own line.",
            "- Use an absolute local path only, and emit the marker only when the file already exists and is ready to send.",
            "- Prefer an `.ogg` voice-note file for this marker.",
            "- If you include prose outside the marker, TENEX will send the voice message first and then send the remaining text as a normal Telegram message.",
            "- Never explain the marker, quote it back to the user, or include more than one `telegram_voice` marker in the same reply.",
        ].join("\n");
    },
};
