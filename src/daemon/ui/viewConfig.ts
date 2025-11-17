import type { ViewMode } from "./types";

export const VIEW_INSTRUCTIONS: Record<ViewMode, string> = {
    projects:
        "Use ↑/↓ to navigate | Enter: expand/start | c: conversations | k: kill | r: restart | q: quit",
    conversations: "Use ↑/↓ to navigate | ESC: back to projects",
    agents: "Use ↑/↓ to navigate | Enter: view details | ESC: back",
    "agent-detail": "Use ↑/↓ to navigate | Enter: view details | ESC: back",
    "lesson-detail": "ESC: back to agent",
    "system-prompt": "ESC: back to agent",
};

export function getViewTitle(
    viewMode: ViewMode,
    context?: { projectTitle?: string; agentName?: string; lessonTitle?: string }
): string {
    switch (viewMode) {
        case "projects":
            return "[Projects]";
        case "conversations":
            return "[Conversations]";
        case "agents":
            return `[Agents - ${context?.projectTitle || ""}]`;
        case "agent-detail":
            return `[Agent Details - ${context?.agentName || ""}]`;
        case "lesson-detail":
            return `[Lesson - ${context?.lessonTitle || ""}]`;
        case "system-prompt":
            return `[System Instructions - ${context?.agentName || ""}]`;
        default:
            return "";
    }
}
