import type { PromptFragment } from "../core/types";

export const toolDescriptionGuidanceFragment: PromptFragment<Record<string, never>> = {
    id: "tool-description-guidance",
    priority: 14,
    template: () => {
        return "When tools have a `description` parameter, write 5-10 words in active voice describing *what* and *why* (e.g. \"Index API docs for onboarding guide\").";
    },
};
