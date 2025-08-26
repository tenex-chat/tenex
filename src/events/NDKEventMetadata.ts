import { NDKEvent } from "@nostr-dev-kit/ndk";

/**
 * NDKEventMetadata - Kind 513
 * 
 * Allows setting metadata about conversations:
 * - ["e", "<event-id>"] - References the conversation
 * - ["title", "title-of-the-conversation"] - Sets the conversation title
 */
export class NDKEventMetadata extends NDKEvent {
    static kind = 513;

    get conversationId(): string | undefined {
        return this.tagValue("e");
    }

    get title(): string | undefined {
        return this.tagValue("title");
    }

    set title(value: string) {
        this.removeTag("title");
        this.tags.push(["title", value]);
    }

    setConversationId(eventId: string): void {
        this.removeTag("e");
        this.tags.push(["e", eventId]);
    }
}