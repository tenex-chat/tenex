/**
 * Fragment registration manifest
 * Explicitly registers all prompt fragments in the system
 * This replaces the implicit import side-effects pattern
 */

import { fragmentRegistry } from "../core/FragmentRegistry";

// Import all fragment definitions
import { specialistIdentityFragment } from "./01-specialist-identity";
import { phaseDefinitionsFragment } from "./10-phase-definitions";
// 10-referenced-article uses inline registration, no named export
import "./10-referenced-article";
import { specialistAvailableAgentsFragment } from "./15-specialist-available-agents";
// 20-voice-mode doesn't export the fragment, it's registered inline
import "./20-voice-mode";
import { phaseContextFragment } from "./20-phase-context";
import { phaseConstraintsFragment } from "./20-phase-constraints";
import { retrievedLessonsFragment } from "./24-retrieved-lessons";
import { specialistToolsFragment } from "./25-specialist-tools";
import { projectMdFragment } from "./30-project-md";
import { inventoryContextFragment } from "./30-project-inventory";
import { specialistCompletionGuidanceFragment } from "./35-specialist-completion-guidance";
import { specialistReasoningFragment } from "./85-specialist-reasoning";
import { mainInventoryPromptFragment } from "./90-inventory-generation";
import { delegatedTaskContextFragment } from "./delegated-task-context";

/**
 * Register all fragments explicitly
 * This provides a clear view of all available fragments
 */
export function registerAllFragments(): void {
  // Core identity and context
  fragmentRegistry.register(specialistIdentityFragment);
  fragmentRegistry.register(delegatedTaskContextFragment);
  
  // Phase-related fragments
  fragmentRegistry.register(phaseDefinitionsFragment);
  fragmentRegistry.register(phaseContextFragment);
  fragmentRegistry.register(phaseConstraintsFragment);
  
  // Agent collaboration
  fragmentRegistry.register(specialistAvailableAgentsFragment);
  
  // Tools and capabilities
  fragmentRegistry.register(specialistToolsFragment);
  
  // Behavioral guidance
  // voice-mode and referenced-article are registered via side effects
  fragmentRegistry.register(specialistCompletionGuidanceFragment);
  fragmentRegistry.register(specialistReasoningFragment);
  
  // Context and learning
  fragmentRegistry.register(retrievedLessonsFragment);
  
  // Project-specific
  fragmentRegistry.register(projectMdFragment);
  fragmentRegistry.register(inventoryContextFragment);
  fragmentRegistry.register(mainInventoryPromptFragment);
}

/**
 * Fragment groups for different agent types
 * These can be used to selectively load fragments
 */
export const CORE_FRAGMENTS = [
  "specialist-identity",
  "phase-definitions",
  "retrieved-lessons",
];

export const SPECIALIST_FRAGMENTS = [
  ...CORE_FRAGMENTS,
  "specialist-available-agents",
  "specialist-tools",
  "specialist-completion-guidance",
];

export const PROJECT_MANAGER_FRAGMENTS = [
  ...SPECIALIST_FRAGMENTS,
  "project-md",
];

export const ALL_FRAGMENTS = [
  "specialist-identity",
  "delegated-task-context",
  "phase-definitions",
  "phase-context",
  "phase-constraints",
  "specialist-available-agents",
  "specialist-tools",
  "voice-mode",
  "specialist-completion-guidance",
  "specialist-reasoning",
  "referenced-article",
  "retrieved-lessons",
  "project-md",
  "project-inventory-context",
  "inventory-generation",
];

// Auto-register all fragments on import
registerAllFragments();