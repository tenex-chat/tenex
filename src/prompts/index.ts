// Export core functionality

export { FragmentRegistry, fragmentRegistry } from "./core/FragmentRegistry";
export { PromptBuilder } from "./core/PromptBuilder";
export type { FragmentConfig, PromptFragment } from "./core/types";

// Import all fragments to ensure they're registered when the module is imported
// Priority 01 - Identity
import "./fragments/01-agent-identity";

// Priority 10 - Early context
import "./fragments/10-referenced-article"; // Conditional

// Priority 15 - Available agents
import "./fragments/15-available-agents";

// Priority 20 - Mode context
import "./fragments/20-voice-mode"; // Conditional

// Priority 24 - Lessons
import "./fragments/24-retrieved-lessons"; // Shared
