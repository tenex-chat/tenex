import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import type { PromptFragment } from "../core/types";

export const noResponseGuidanceFragment: PromptFragment<{
    triggeringEnvelope?: InboundEnvelope;
}> = {
    id: "no-response-guidance",
    priority: 18,
    template: ({ triggeringEnvelope }) => {
        if (triggeringEnvelope?.transport !== "telegram") {
            return "";
        }

        return `## Silent Completion

If the latest user message explicitly asks you not to respond, call \`no_response()\` and then end the turn without any assistant text.

Use this only for explicit no-reply intent, such as:
- "don't respond"
- "don't say anything"
- note-to-self messages
- counting aloud / journaling where the user wants silence

Do not send acknowledgements, emojis, filler, or "understood" after calling \`no_response()\`.
`;
    },
};
