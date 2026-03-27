import type { PromptFragment } from "../core/types";

export const toolDescriptionGuidanceFragment: PromptFragment<Record<string, never>> = {
    id: "tool-description-guidance",
    priority: 14,
    template: () => {
        return `## Tool Description Parameter

Many tools include a \`description\` parameter for human-readable context and observability. When filling it in:

- Write 5-10 words in active voice
- Describe *what* the operation does and *why*, not just the tool name
- Good: "Index API docs for onboarding guide", "Remove stale cache collection"
- Bad: "adding documents", "running command", "creating collection"`;
    },
};
