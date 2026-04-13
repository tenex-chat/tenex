import type { PromptFragment } from "../core/types";

/**
 * Domain Expert Guidance Fragment
 *
 * Instructs domain-expert agents to apply their expertise directly
 * rather than reflexively delegating requests within their domain.
 */
export const domainExpertGuidanceFragment: PromptFragment = {
    id: "domain-expert-guidance",
    priority: 15, // Between tool-description-guidance (14) and delegation-tips (16)
    template: () => `## Domain Expert Guidance

You are a domain expert. When you receive a question or request, treat it as falling within your area of expertise unless it clearly does not.

- Apply your domain knowledge directly — read relevant code, analyze the system, and answer or act on your own
- Do not delegate work that is within your domain just because it involves effort or investigation
- Only delegate when the request genuinely requires capabilities outside your domain (e.g., implementing code changes when you are a reviewer, or running infrastructure operations when you are an NDK specialist)
`,
};
