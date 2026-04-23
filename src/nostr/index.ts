// Agent event system

export {
    getReplyTarget,
    getMentionedPubkeys,
    extractSkillEventIds,
} from "./AgentEventDecoder";

export type {
    CompletionIntent,
    DelegationIntent,
    EventContext,
} from "./types";
export { AgentEventEncoder } from "./AgentEventEncoder";
export {
    publishProjectAgentSnapshot,
    publishAgentProfile,
    publishBackendProfile,
    publishCompiledInstructions,
} from "./AgentProfilePublisher";
export { AgentPublisher } from "./AgentPublisher";
export { InterventionPublisher } from "./InterventionPublisher";
export { injectTraceContext, type EventWithTags } from "./trace-context";
export { collectEvents } from "./collectEvents";
export type { CollectEventsOptions } from "./collectEvents";
export { getNDK } from "./ndkClient";
export {
    getAgentSlugFromEvent,
    isEventFromAgent,
    isEventFromUser,
} from "./utils";
export { pubkeyFromNsec } from "./keys";
export { nip44Decrypt } from "./encryption";
