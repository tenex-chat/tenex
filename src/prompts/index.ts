// Export core functionality
export { PromptBuilder } from "./core/PromptBuilder";
export { FragmentRegistry, fragmentRegistry } from "./core/FragmentRegistry";
export type { PromptFragment, FragmentConfig } from "./core/types";

// Import all fragments to ensure they're registered when the module is imported
// Priority 01 - Identity
import "./fragments/01-specialist-identity";

// Priority 02 - Delegated task context (conditional)
import "./fragments/delegated-task-context";

// Priority 10 - Early context
import "./fragments/10-phase-definitions"; // Shared
import "./fragments/10-referenced-article"; // Conditional

// Priority 15 - Available agents
import "./fragments/15-specialist-available-agents";

// Priority 20 - Phase and mode context
import "./fragments/20-phase-constraints"; // Shared
import "./fragments/20-phase-context"; // Shared
import "./fragments/20-voice-mode"; // Conditional

// Priority 24 - Lessons
import "./fragments/24-retrieved-lessons"; // Shared

// Priority 25 - Tools
import "./fragments/25-specialist-tools"; // All agents use tools

// Priority 30 - Project context
import "./fragments/30-project-inventory"; // Shared
import "./fragments/30-project-md"; // Conditional (project-manager)

// Priority 35 - Completion guidance
import "./fragments/35-specialist-completion-guidance"; // Specialist only

// Priority 85 - Reasoning (specialist only - orchestrator outputs JSON only)
import "./fragments/85-specialist-reasoning";

// Priority 90+ - Special purpose
import "./fragments/90-inventory-generation"; // Internal LLM prompts
