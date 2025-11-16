export interface ProjectInfo {
  projectId: string;
  title: string;
  isRunning: boolean;
  startTime: Date | null;
  eventCount: number;
  agentCount: number;
}

export interface AgentInfo {
  pubkey: string;
  name: string;
  role: string;
  description?: string;
  lessonsCount: number;
}

export type ViewMode = "projects" | "conversations" | "agents" | "agent-detail";

export type ActionType = "kill" | "restart";
