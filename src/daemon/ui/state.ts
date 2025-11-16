import type { AgentInstance } from "@/agents/types";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import type { ProjectInfo, AgentInfo, ViewMode } from "./types";

export interface ViewState {
  viewMode: ViewMode;
  selectedIndex: number;
  selectedProjectId: string | null;
  selectedAgent: AgentInstance | null;
  agents: AgentInfo[];
  agentLessons: NDKAgentLesson[];
  statusMessage: string;
}

export type ViewAction =
  | { type: "SET_STATUS"; message: string }
  | { type: "CLEAR_STATUS" }
  | { type: "NAVIGATE"; direction: "up" | "down"; maxIndex: number }
  | { type: "VIEW_AGENTS"; projectId: string; agents: AgentInfo[] }
  | { type: "VIEW_AGENT_DETAIL"; agent: AgentInstance; lessons: NDKAgentLesson[] }
  | { type: "VIEW_CONVERSATIONS" }
  | { type: "NAVIGATE_BACK" };

export const initialViewState: ViewState = {
  viewMode: "projects",
  selectedIndex: 0,
  selectedProjectId: null,
  selectedAgent: null,
  agents: [],
  agentLessons: [],
  statusMessage: "",
};

export function viewReducer(state: ViewState, action: ViewAction): ViewState {
  switch (action.type) {
    case "SET_STATUS":
      return { ...state, statusMessage: action.message };

    case "CLEAR_STATUS":
      return { ...state, statusMessage: "" };

    case "NAVIGATE":
      if (action.direction === "up") {
        return { ...state, selectedIndex: Math.max(0, state.selectedIndex - 1) };
      }
      return { ...state, selectedIndex: Math.min(action.maxIndex, state.selectedIndex + 1) };

    case "VIEW_AGENTS":
      return {
        ...state,
        viewMode: "agents",
        selectedProjectId: action.projectId,
        agents: action.agents,
        selectedIndex: 0,
      };

    case "VIEW_AGENT_DETAIL":
      return {
        ...state,
        viewMode: "agent-detail",
        selectedAgent: action.agent,
        agentLessons: action.lessons,
        selectedIndex: 0,
      };

    case "VIEW_CONVERSATIONS":
      return {
        ...state,
        viewMode: "conversations",
        selectedIndex: 0,
      };

    case "NAVIGATE_BACK":
      if (state.viewMode === "agent-detail") {
        return {
          ...state,
          viewMode: "agents",
          selectedAgent: null,
          agentLessons: [],
          selectedIndex: 0,
        };
      }
      if (state.viewMode === "agents") {
        return {
          ...state,
          viewMode: "projects",
          selectedProjectId: null,
          agents: [],
          selectedIndex: 0,
        };
      }
      if (state.viewMode === "conversations") {
        return {
          ...state,
          viewMode: "projects",
          selectedIndex: 0,
        };
      }
      return state;

    default:
      return state;
  }
}
