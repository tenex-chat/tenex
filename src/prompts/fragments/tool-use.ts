import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";

export const toolUseFragment: PromptFragment = {
    id: "tool-use",
    priority: 300, // Place after basic instructions but before specific tool instructions
    template: () => `## Tool Usage Guidelines
  
1. In <thinking> tags, assess what information you already have and what information you need to proceed with the task. You MUST *ALWAYS* produce this <thinking> tag that shows your meta-cognition. You can never skip it.
2. If multiple actions are needed, use one tool at a time per message to accomplish the task iteratively, with each tool use being informed by the result of the previous tool use. Do not assume the outcome of any tool use. Each step must be informed by the previous step's result.
3. Tools are used through function calls, not by writing their syntax in your message. Your message text and tool calls are separate.`,
};

// Register the fragment
fragmentRegistry.register(toolUseFragment);
