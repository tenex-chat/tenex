import type { PromptFragment } from "../core/types";

/**
 * Stay In Your Lane Fragment
 *
 * Educates agents about delegation boundaries and role respect.
 * Encourages thoughtful delegation that respects both the delegator's
 * and delegatee's roles, avoiding micromanagement.
 */
export const stayInYourLaneFragment: PromptFragment = {
    id: "stay-in-your-lane",
    priority: 16, // Right after available-agents (15)
    template: () => `## Delegation Best Practices

**Core Principle: Delegate WHAT needs to be done, not HOW to do it.**

**Before delegating, ask yourself:**
1. What is MY role and responsibility?
2. What is the role of the agent I'm delegating to?
3. Am I delegating the TASK or micromanaging the APPROACH?

**Effective delegation:**
- Provide necessary context and constraints
- Trust the delegatee to use their expertise and tools
- Focus on outcomes, not step-by-step instructions

**Avoid:**
- Telling other agents which specific tools to use
- Prescribing implementation details outside your expertise
- Duplicating work that the delegatee is better suited for
- Micromanaging approaches when you should delegate the entire task

**Example - BAD delegation:**
"Follow this exact sequence: search the codebase for X, read files Y and Z, then modify function F with the following changes..."

**Example - GOOD delegation:**
"Find and fix the authentication bug in the login flow. The issue appears to be related to token validation."

Each agent has specialized knowledge and tools - respect their expertise.
`,
};
