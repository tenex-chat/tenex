/**
 * Fragment registration manifest
 * Explicitly registers all prompt fragments in the system
 * This replaces the implicit import side-effects pattern
 */

import { fragmentRegistry } from "../core/FragmentRegistry";

// Import all fragment definitions
import { agentIdentityFragment } from "./01-agent-identity";
import { agentPhasesFragment } from "./05-agent-phases";
// 10-referenced-article uses inline registration, no named export
import "./10-referenced-article";
import { availableAgentsFragment } from "./15-available-agents";
// 20-voice-mode doesn't export the fragment, it's registered inline
import "./20-voice-mode";
import { phaseContextFragment } from "./20-phase-context";
import { retrievedLessonsFragment } from "./24-retrieved-lessons";
import { projectMdFragment } from "./30-project-md";
import { inventoryContextFragment } from "./30-project-inventory";
import { mainInventoryPromptFragment } from "./90-inventory-generation";
import { delegatedTaskContextFragment } from "./delegated-task-context";
import { debugModeFragment } from "./debug-mode";
import { delegationCompletionFragment } from "./delegation-completion";
import { phaseTransitionFragment } from "./phase-transition";

/**
 * Register all fragments explicitly
 * This provides a clear view of all available fragments
 */
export function registerAllFragments(): void {
  // Core identity and context
  fragmentRegistry.register(agentIdentityFragment);
  fragmentRegistry.register(agentPhasesFragment);
  fragmentRegistry.register(delegatedTaskContextFragment);
  fragmentRegistry.register(debugModeFragment);
  fragmentRegistry.register(delegationCompletionFragment);
  fragmentRegistry.register(phaseTransitionFragment);

  // Phase-related fragments
  fragmentRegistry.register(phaseContextFragment);
  
  // Agent collaboration
  fragmentRegistry.register(availableAgentsFragment);
  
  // Behavioral guidance
  // voice-mode and referenced-article are registered via side effects
  
  // Context and learning
  fragmentRegistry.register(retrievedLessonsFragment);
  
  // Project-specific
  fragmentRegistry.register(projectMdFragment);
  fragmentRegistry.register(inventoryContextFragment);
  fragmentRegistry.register(mainInventoryPromptFragment);
}

// Auto-register all fragments on import
registerAllFragments();