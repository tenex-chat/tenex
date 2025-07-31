// Export core functionality
export { PromptBuilder } from "./core/PromptBuilder";
export { FragmentRegistry, fragmentRegistry } from "./core/FragmentRegistry";
export type { PromptFragment, FragmentConfig } from "./core/types";

// Import all fragments to ensure they're registered when the module is imported
import "./fragments/agent-reasoning";
import "./fragments/agent-tools";
import "./fragments/agentFragments";
import "./fragments/available-agents";
import "./fragments/domain-expert-guidelines";
import "./fragments/execute-task-prompt";
import "./fragments/expertise-boundaries";
import "./fragments/inventory";
import "./fragments/mcp-tools";
import "./fragments/orchestrator-routing";
import "./fragments/phase";
import "./fragments/phase-definitions";
import "./fragments/project";
import "./fragments/project-md";
import "./fragments/retrieved-lessons";
import "./fragments/tool-use";
