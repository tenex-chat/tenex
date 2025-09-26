import type { ModelMessage } from "ai";

interface BrainstormAgent {
    name: string;
    pubkey: string;
    content: string;
}

/**
 * Build the moderation prompt messages for brainstorming sessions
 */
export function buildBrainstormModerationPrompt(
    originalRequest: string,
    responses: BrainstormAgent[]
): ModelMessage[] {
    const messages: ModelMessage[] = [];

    // Frame the moderation task
    messages.push({
        role: "user",
        content: `A brainstorming session was initiated with this request: "${originalRequest}"

The following agents have responded:`
    });

    // Add each response as context
    for (const response of responses) {
        messages.push({
            role: "assistant",
            content: `${response.name} (${response.pubkey}): ${response.content}`
        });
    }

    // Ask for moderation
    messages.push({
        role: "user",
        content: `Please moderate these responses. Select at least one response (or multiple if appropriate).
Return a JSON object with your selection(s):
{"selectedAgents": ["pubkey1", "pubkey2", ...], "reasoning": "your explanation"}

If you believe none of the responses are suitable, you may return an empty array, and all responses will be included by default.`
    });

    return messages;
}