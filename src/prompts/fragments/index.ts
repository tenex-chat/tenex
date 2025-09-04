/**
 * Fragment registration manifest
 * Explicitly registers all prompt fragments in the system
 * This replaces the implicit import side-effects pattern
 */

import { fragmentRegistry } from "../core/FragmentRegistry";

// Import all fragment definitions
import { specialistIdentityFragment } from "./01-specialist-identity";
// 10-referenced-article uses inline registration, no named export
import "./10-referenced-article";
import { specialistAvailableAgentsFragment } from "./15-specialist-available-agents";
// 20-voice-mode doesn't export the fragment, it's registered inline
import "./20-voice-mode";
import { phaseContextFragment } from "./20-phase-context";
import { retrievedLessonsFragment } from "./24-retrieved-lessons";
import { projectMdFragment } from "./30-project-md";
import { inventoryContextFragment } from "./30-project-inventory";
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
  fragmentRegistry.register(phaseContextFragment);
  
  // Agent collaboration
  fragmentRegistry.register(specialistAvailableAgentsFragment);
  
  // Behavioral guidance
  // voice-mode and referenced-article are registered via side effects
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
  "retrieved-lessons",
];

export const SPECIALIST_FRAGMENTS = [
  ...CORE_FRAGMENTS,
  "specialist-available-agents",
];

export const PROJECT_MANAGER_FRAGMENTS = [
  ...SPECIALIST_FRAGMENTS,
  "project-md",
];

export const ALL_FRAGMENTS = [
  "specialist-identity",
  "delegated-task-context",
  "phase-context",
  "specialist-available-agents",
  "voice-mode",
  "specialist-reasoning",
  "referenced-article",
  "retrieved-lessons",
  "project-md",
  "project-inventory-context",
  "inventory-generation",
];

// Auto-register all fragments on import
registerAllFragments();