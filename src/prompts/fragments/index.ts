/**
 * Fragment registration manifest
 * Explicitly registers all prompt fragments in the system
 * This replaces the implicit import side-effects pattern
 */

import { fragmentRegistry } from "../core/FragmentRegistry";

// Import all fragment definitions
import { agentIdentityFragment } from "./01-agent-identity";
import { agentHomeDirectoryFragment } from "./02-agent-home-directory";
import { agentTodosFragment } from "./06-agent-todos";
import { todoUsageGuidanceFragment } from "./06-todo-usage-guidance";
// 10-referenced-article uses inline registration, no named export
import "./10-referenced-article";
import { availableAgentsFragment } from "./15-available-agents";
// 20-voice-mode doesn't export the fragment, it's registered inline
import "./20-voice-mode";
import { nudgesFragment } from "./11-nudges";
import { scheduledTasksFragment } from "./22-scheduled-tasks";
import { retrievedLessonsFragment } from "./24-retrieved-lessons";
import { ragInstructionsFragment } from "./25-rag-instructions";
import { mcpResourcesFragment } from "./26-mcp-resources";
import { memorizedReportsFragment } from "./27-memorized-reports";
import { worktreeContextFragment } from "./30-worktree-context";
import { alphaModeFragment } from "./alpha-mode";
import { debugModeFragment } from "./debug-mode";
import { delegationCompletionFragment } from "./delegation-completion";

/**
 * Register all fragments explicitly
 * This provides a clear view of all available fragments
 */
export function registerAllFragments(): void {
    // Core identity and context
    fragmentRegistry.register(agentIdentityFragment);
    fragmentRegistry.register(agentHomeDirectoryFragment);
    fragmentRegistry.register(agentTodosFragment);
    fragmentRegistry.register(todoUsageGuidanceFragment);
    fragmentRegistry.register(alphaModeFragment);
    fragmentRegistry.register(debugModeFragment);
    fragmentRegistry.register(delegationCompletionFragment);

    // Agent collaboration
    fragmentRegistry.register(availableAgentsFragment);

    // Behavioral guidance
    // voice-mode and referenced-article are registered via side effects
    fragmentRegistry.register(nudgesFragment);

    // Scheduled tasks context
    fragmentRegistry.register(scheduledTasksFragment);

    // Context and learning
    fragmentRegistry.register(retrievedLessonsFragment);
    fragmentRegistry.register(ragInstructionsFragment);
    fragmentRegistry.register(mcpResourcesFragment);
    fragmentRegistry.register(memorizedReportsFragment);
    fragmentRegistry.register(worktreeContextFragment);
}

// Auto-register all fragments on import
registerAllFragments();
