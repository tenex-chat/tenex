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
import { systemRemindersExplanationFragment } from "./03-system-reminders-explanation";
import { scratchpadPracticeFragment } from "./04-scratchpad-practice";
import { delegationChainFragment } from "./05-delegation-chain";
import { metaProjectContextFragment } from "./07-meta-project-context";
import { todoUsageGuidanceFragment } from "./06-todo-usage-guidance";
import { availableAgentsFragment } from "./15-available-agents";
import { stayInYourLaneFragment } from "./16-stay-in-your-lane";
import { TodoUsageFragment } from "./17-todo-before-delegation";
import { noResponseGuidanceFragment } from "./18-no-response-guidance";
import { delegationAsyncFragment } from "./19-delegation-async";
// 20-voice-mode doesn't export the fragment, it's registered inline
import "./20-voice-mode";
import { nudgesFragment } from "./11-nudges";
import { skillsFragment } from "./12-skills";
import { availableNudgesAndSkillsFragment } from "./13-available-nudges";
import { toolDescriptionGuidanceFragment } from "./14-tool-description-guidance";
import { scheduledTasksFragment } from "./22-scheduled-tasks";
import { mcpResourcesFragment } from "./26-mcp-resources";
import { agentDirectedMonitoringFragment } from "./28-agent-directed-monitoring";
import { ragCollectionsFragment } from "./29-rag-collections";
import { worktreeContextFragment } from "./30-worktree-context";
import { agentsMdGuidanceFragment } from "./31-agents-md-guidance";
import { telegramChatContextFragment } from "./33-telegram-chat-context";
import { telegramDeliveryRulesFragment } from "./34-telegram-delivery-rules";
import { channelBindingsFragment } from "./34-channel-bindings";

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
    fragmentRegistry.register(systemRemindersExplanationFragment);
    fragmentRegistry.register(scratchpadPracticeFragment);
    fragmentRegistry.register(delegationChainFragment);
    fragmentRegistry.register(todoUsageGuidanceFragment);
    fragmentRegistry.register(metaProjectContextFragment);

    // Agent collaboration
    fragmentRegistry.register(availableAgentsFragment);
    fragmentRegistry.register(stayInYourLaneFragment);
    fragmentRegistry.register(TodoUsageFragment);
    fragmentRegistry.register(noResponseGuidanceFragment);
    fragmentRegistry.register(delegationAsyncFragment);

    // Behavioral guidance
    // voice-mode is registered via side effects
    fragmentRegistry.register(nudgesFragment);
    fragmentRegistry.register(skillsFragment);
    fragmentRegistry.register(availableNudgesAndSkillsFragment);
    fragmentRegistry.register(toolDescriptionGuidanceFragment);

    // Scheduled tasks context
    fragmentRegistry.register(scheduledTasksFragment);

    // Context and learning
    fragmentRegistry.register(mcpResourcesFragment);
    fragmentRegistry.register(agentDirectedMonitoringFragment);
    fragmentRegistry.register(ragCollectionsFragment);
    fragmentRegistry.register(worktreeContextFragment);
    fragmentRegistry.register(agentsMdGuidanceFragment);
    fragmentRegistry.register(telegramChatContextFragment);
    fragmentRegistry.register(telegramDeliveryRulesFragment);
    fragmentRegistry.register(channelBindingsFragment);
}

// Auto-register all fragments on import
registerAllFragments();
