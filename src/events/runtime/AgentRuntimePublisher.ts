import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type {
    AskConfig,
    CompletionIntent,
    ConversationIntent,
    DelegateConfig,
    DelegationMarkerIntent,
    ErrorIntent,
    EventContext,
    LessonIntent,
    StreamTextDeltaIntent,
    ToolUseIntent,
} from "@/nostr/types";

/**
 * Phase-1 transport-neutral publishing contract for the conversation/runtime plane.
 *
 * This contract deliberately preserves the current runtime message intents and event
 * context while removing the executor/tool layers' dependency on the concrete
 * `AgentPublisher` implementation. The wire format is still Nostr-shaped for now.
 */
export interface AgentRuntimePublisher {
    complete(intent: CompletionIntent, context: EventContext): Promise<NDKEvent | undefined>;
    conversation(intent: ConversationIntent, context: EventContext): Promise<NDKEvent>;
    delegate(config: DelegateConfig, context: EventContext): Promise<string>;
    ask(config: AskConfig, context: EventContext): Promise<NDKEvent>;
    delegateFollowup(
        params: {
            recipient: string;
            content: string;
            delegationEventId: string;
            replyToEventId?: string;
        },
        context: EventContext
    ): Promise<string>;
    error(intent: ErrorIntent, context: EventContext): Promise<NDKEvent>;
    lesson(intent: LessonIntent, context: EventContext): Promise<NDKEvent>;
    toolUse(intent: ToolUseIntent, context: EventContext): Promise<NDKEvent>;
    streamTextDelta(intent: StreamTextDeltaIntent, context: EventContext): Promise<void>;
    delegationMarker(intent: DelegationMarkerIntent): Promise<NDKEvent>;
}
