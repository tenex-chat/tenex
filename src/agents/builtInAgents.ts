import { DEFAULT_AGENT_LLM_CONFIG } from "@/llm/constants";
import { EXECUTOR_AGENT } from "./built-in/executor";
import { PLANNER_AGENT } from "./built-in/planner";
import { PROJECT_MANAGER_AGENT_DEFINITION } from "./built-in/project-manager";

export interface BuiltInAgentDefinition {
    name: string;
    slug: string;
    role: string;
    instructions: string;
    llmConfig?: string;
    useCriteria?: string;
    tools?: string[];
}

export const PROJECT_MANAGER_BUILT_IN: BuiltInAgentDefinition = {
    name: PROJECT_MANAGER_AGENT_DEFINITION.name,
    slug: "project-manager",
    role: PROJECT_MANAGER_AGENT_DEFINITION.role,
    instructions: PROJECT_MANAGER_AGENT_DEFINITION.instructions || "",
    llmConfig: PROJECT_MANAGER_AGENT_DEFINITION.llmConfig || DEFAULT_AGENT_LLM_CONFIG,
    useCriteria: PROJECT_MANAGER_AGENT_DEFINITION.useCriteria,
};

export function getBuiltInAgents(): BuiltInAgentDefinition[] {
    return [EXECUTOR_AGENT, PLANNER_AGENT, PROJECT_MANAGER_BUILT_IN];
}
