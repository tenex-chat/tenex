/**
 * Fragment registration manifest
 * Explicitly registers all prompt fragments in the system
 * This replaces the implicit import side-effects pattern
 */

import { fragmentRegistry } from "../core/FragmentRegistry";

// Import all fragment definitions
import { globalSystemPromptFragment } from "./00-global-system-prompt";
import { agentIdentityFragment } from "./01-agent-identity";
import { agentHomeDirectoryFragment } from "./02-agent-home-directory";
import { relayConfigurationFragment } from "./04-relay-configuration";
import { delegationChainFragment } from "./05-delegation-chain";
import { agentTodosFragment } from "./06-agent-todos";
import { recentConversationsFragment } from "./09-recent-conversations";
import { todoUsageGuidanceFragment } from "./06-todo-usage-guidance";
// 10-referenced-article uses inline registration, no named export
import "./10-referenced-article";
import { availableAgentsFragment } from "./15-available-agents";
import { stayInYourLaneFragment } from "./16-stay-in-your-lane";
import { todoBeforeDelegationFragment } from "./17-todo-before-delegation";
// 20-voice-mode doesn't export the fragment, it's registered inline
import "./20-voice-mode";
import { nudgesFragment } from "./11-nudges";
import { scheduledTasksFragment } from "./22-scheduled-tasks";
import { retrievedLessonsFragment } from "./24-retrieved-lessons";
import { ragInstructionsFragment } from "./25-rag-instructions";
import { mcpResourcesFragment } from "./26-mcp-resources";
import { memorizedReportsFragment } from "./27-memorized-reports";
import { agentDirectedMonitoringFragment } from "./28-agent-directed-monitoring";
import { worktreeContextFragment } from "./30-worktree-context";
import { agentsMdGuidanceFragment } from "./31-agents-md-guidance";
import { alphaModeFragment } from "./alpha-mode";
import { debugModeFragment } from "./debug-mode";
import { delegationCompletionFragment } from "./delegation-completion";

/**
 * Register all fragments explicitly
 * This provides a clear view of all available fragments
 */
export function registerAllFragments(): void {
    // Global user-configured prompt (ordered with other fragments by priority)
    fragmentRegistry.register(globalSystemPromptFragment);

    // Core identity and context
    fragmentRegistry.register(agentIdentityFragment);
    fragmentRegistry.register(agentHomeDirectoryFragment);
    fragmentRegistry.register(relayConfigurationFragment);
    fragmentRegistry.register(delegationChainFragment);
    fragmentRegistry.register(agentTodosFragment);
    fragmentRegistry.register(todoUsageGuidanceFragment);
    fragmentRegistry.register(recentConversationsFragment);
    fragmentRegistry.register(alphaModeFragment);
    fragmentRegistry.register(debugModeFragment);
    fragmentRegistry.register(delegationCompletionFragment);

    // Agent collaboration
    fragmentRegistry.register(availableAgentsFragment);
    fragmentRegistry.register(stayInYourLaneFragment);
    fragmentRegistry.register(todoBeforeDelegationFragment);

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
    fragmentRegistry.register(agentDirectedMonitoringFragment);
    fragmentRegistry.register(worktreeContextFragment);
    fragmentRegistry.register(agentsMdGuidanceFragment);
}

// Auto-register all fragments on import
registerAllFragments();
