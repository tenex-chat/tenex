import { EVENT_KINDS } from "@/llm/types";

export const STATUS_KIND = EVENT_KINDS.PROJECT_STATUS;
export const STATUS_INTERVAL_MS = 15000; // 15 seconds

export function getEventKindName(kind: number): string {
    switch (kind) {
        case EVENT_KINDS.METADATA:
            return "Profile";
        case EVENT_KINDS.GENERIC_REPLY:
            return "Reply";
        case EVENT_KINDS.TASK:
            return "Task";
        case EVENT_KINDS.AGENT_REQUEST:
            return "Agent Request";
        case EVENT_KINDS.AGENT_CONFIG:
            return "Agent Configuration";
        case EVENT_KINDS.PROJECT_STATUS:
            return "Project Status";
        case EVENT_KINDS.TYPING_INDICATOR:
            return "Typing Indicator";
        case EVENT_KINDS.TYPING_INDICATOR_STOP:
            return "Typing Stop";
        case EVENT_KINDS.PROJECT:
            return "Project";
        default:
            return `Kind ${kind}`;
    }
}
