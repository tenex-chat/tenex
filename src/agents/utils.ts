import type { Agent } from "./types";

export const isClaudeBackend = (agent: Agent): boolean => agent.backend === "claude";

export const isRoutingBackend = (agent: Agent): boolean => agent.backend === "routing";

export const isToollessBackend = (agent: Agent): boolean => 
    agent.backend === "claude" || agent.backend === "routing";
