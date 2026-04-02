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
import { todoUsageGuidanceFragment } from "./06-todo-usage-guidance";
import { projectContextFragment } from "./08-project-context";
import { stayInYourLaneFragment } from "./16-stay-in-your-lane";
import { TodoUsageFragment } from "./17-todo-before-delegation";
import { noResponseGuidanceFragment } from "./18-no-response-guidance";
import { delegationAsyncFragment } from "./19-delegation-async";
// 20-voice-mode doesn't export the fragment, it's registered inline
import "./20-voice-mode";
import { skillsFragment } from "./12-skills";
import { availableSkillsFragment } from "./13-available-skills";
import { toolDescriptionGuidanceFragment } from "./14-tool-description-guidance";
import { scheduledTasksFragment } from "./22-scheduled-tasks";
import { mcpResourcesFragment } from "./26-mcp-resources";
import { agentDirectedMonitoringFragment } from "./28-agent-directed-monitoring";
import { ragCollectionsFragment } from "./29-rag-collections";
import { telegramChatContextFragment } from "./33-telegram-chat-context";
import { telegramDeliveryRulesFragment } from "./34-telegram-delivery-rules";

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
    fragmentRegistry.register(projectContextFragment);

    // Agent collaboration
    fragmentRegistry.register(stayInYourLaneFragment);
    fragmentRegistry.register(TodoUsageFragment);
    fragmentRegistry.register(noResponseGuidanceFragment);
    fragmentRegistry.register(delegationAsyncFragment);

    // Behavioral guidance
    // voice-mode is registered via side effects
    fragmentRegistry.register(skillsFragment);
    fragmentRegistry.register(availableSkillsFragment);
    fragmentRegistry.register(toolDescriptionGuidanceFragment);

    // Scheduled tasks context
    fragmentRegistry.register(scheduledTasksFragment);

    // Context and learning
    fragmentRegistry.register(mcpResourcesFragment);
    fragmentRegistry.register(agentDirectedMonitoringFragment);
    fragmentRegistry.register(ragCollectionsFragment);
    fragmentRegistry.register(telegramChatContextFragment);
    fragmentRegistry.register(telegramDeliveryRulesFragment);
}

// Auto-register all fragments on import
registerAllFragments();
