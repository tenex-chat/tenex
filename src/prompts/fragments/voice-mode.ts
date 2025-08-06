import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

export interface VoiceModeOptions {
    isVoiceMode: boolean;
}

const voiceModeFragment: PromptFragment<VoiceModeOptions> = {
    id: "voice-mode",
    priority: 20, // High priority to ensure voice instructions are prominent
    template: (options: VoiceModeOptions) => {
        if (!options.isVoiceMode) return "";
        
        return `## Voice Mode Guidelines

You are generating text that will be converted to speech and read aloud. Please follow these guidelines:

### Text Formatting for TTS
- Use natural, conversational language that flows well when spoken
- Avoid complex punctuation that doesn't translate well to speech
- For larger numbers, use a mix (e.g., "15 thousand" instead of "15,000")
- Avoid URLs, file paths, or code snippets unless absolutely necessary
- If you must reference code, describe it in natural language

### Response Structure
- Keep sentences concise and clear
- Use shorter paragraphs with natural pauses
- Avoid bullet points or numbered lists - use flowing prose instead
- Lead with the most important information
- Use transitions like "First," "Next," "Additionally," for clarity

### Tone and Delivery
- Be warm and conversational, as if speaking directly to the user
- Use active voice whenever possible
- Include brief acknowledgments like "I understand" or "Let me help with that"
- Avoid technical jargon unless necessary, and explain terms when used
- Use natural fillers sparingly for a more human feel (e.g., "Well," "Now,")

### Content Adaptation
- Summarize lengthy content rather than reading it verbatim
- Focus on key points and actionable information
- When describing visual elements or code, use descriptive language
- For errors or issues, explain them clearly without reading stack traces
- Provide context before diving into details

Remember: The user is listening, not reading. Make your response engaging and easy to follow by ear.`;
    },
};

// Register the fragment
fragmentRegistry.register(voiceModeFragment);

/**
 * Helper function to check if an event has voice mode enabled
 */
export function isVoiceMode(event: NDKEvent | undefined): boolean {
    if (!event) return false;
    return event.tagValue("mode") === "voice";
}