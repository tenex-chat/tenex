import type { ViewMode } from "./types";

export const VIEW_INSTRUCTIONS: Record<ViewMode, string> = {
  projects: "Use ↑/↓ to navigate | Enter: expand | p: projects | c: conversations | k: kill | r: restart | q: quit",
  conversations: "Use ↑/↓ to navigate | ESC: back to projects",
  agents: "Use ↑/↓ to navigate | Enter: view details | ESC: back",
  "agent-detail": "ESC: back to agents",
};

export function getViewTitle(viewMode: ViewMode, context?: { projectTitle?: string; agentName?: string }): string {
  switch (viewMode) {
    case "projects":
      return "[Projects]";
    case "conversations":
      return "[Conversations]";
    case "agents":
      return `[Agents - ${context?.projectTitle || ""}]`;
    case "agent-detail":
      return `[Agent Details - ${context?.agentName || ""}]`;
    default:
      return "";
  }
}
