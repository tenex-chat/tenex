import type NDK from "@nostr-dev-kit/ndk";
import { NDKEvent, type NDKRawEvent } from "@nostr-dev-kit/ndk";

export class NDKAgentLesson extends NDKEvent {
    static kind = 4129;
    static kinds = [4129];

    constructor(ndk?: NDK, event?: NDKEvent | NDKRawEvent) {
        super(ndk, event);
        this.kind ??= 4129;
    }

    static from(event: NDKEvent): NDKAgentLesson {
        return new NDKAgentLesson(event.ndk, event);
    }

    get title(): string | undefined {
        return this.tagValue("title");
    }

    /**
     * Title/description of what this lesson is about.
     */
    set title(value: string | undefined) {
        this.removeTag("title");
        if (value) this.tags.push(["title", value]);
    }

    // Alias for title
    get description(): string | undefined {
        return this.tagValue("title");
    }

    set description(value: string | undefined) {
        this.removeTag("description");
        if (value) this.tags.push(["description", value]);
    }

    /**
     * The lesson content - what the agent learned.
     * This is stored in the event content.
     */
    get lesson(): string {
        return this.content;
    }

    set lesson(value: string) {
        this.content = value;
    }

    /**
     * Set the agent that this lesson belongs to.
     * @param agentEvent The NDKAgentDefinition event to reference
     */
    set agentDefinitionId(agentDefinitionId: string) {
        this.removeTag("e");
        this.tags.push(["e", agentDefinitionId]);
    }

    /**
     * Get the agent event ID this lesson belongs to.
     */
    get agentDefinitionId(): string | undefined {
        return this.tags.find((tag) => tag[0] === "e")?.[1];
    }

    /**
     * Metacognition reasoning - why this lesson is worth learning
     */
    get metacognition(): string | undefined {
        return this.tagValue("metacognition");
    }

    set metacognition(value: string | undefined) {
        this.removeTag("metacognition");
        if (value) this.tags.push(["metacognition", value]);
    }

    /**
     * Detailed version of the lesson with richer explanation
     */
    get detailed(): string | undefined {
        return this.tagValue("detailed");
    }

    set detailed(value: string | undefined) {
        this.removeTag("detailed");
        if (value) this.tags.push(["detailed", value]);
    }

    /**
     * Category for filing this lesson
     */
    get category(): string | undefined {
        return this.tagValue("category");
    }

    set category(value: string | undefined) {
        this.removeTag("category");
        if (value) this.tags.push(["category", value]);
    }

    /**
     * Hashtags for easier sorting and discovery
     */
    get hashtags(): string[] {
        return this.tags.filter((tag) => tag[0] === "t").map((tag) => tag[1]);
    }

    set hashtags(values: string[]) {
        this.tags = this.tags.filter((tag) => tag[0] !== "t");
        for (const hashtag of values) {
            this.tags.push(["t", hashtag]);
        }
    }
}
