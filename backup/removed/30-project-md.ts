import fs from "node:fs";
import path from "node:path";
import { countTotalFiles } from "../utils/projectUtils";
import { fragmentRegistry } from "@/prompts/core/FragmentRegistry";
import type { PromptFragment } from "@/prompts/core/types";

const description = `
## PROJECT SPEC

The PROJECT.md maintains your living understanding of:
- What the project is.
- What assumptions you've made to fill in gaps.
- How the project has evolved based on user feedback.

During REFLECTION phase, update context/PROJECT.md with everything new you learned 
about what the project you manage is:

- Every single detail the user has explicitly described about the project
- Clear delineations between what the user stated vs. your assumptions
- Example: User says "make a calculator" - multiplication support is a 
safe assumption, but still an assumption.
- If the project has screns or pages, you should explain, in a dedicated "User Flows" section, the user flows, features and how it all comes together.

## DOES and DON'Ts for PROJECT.md:
- ✅ DO describe in great level of detail how things technically fit together in high-level.
- ✅ DO think "if five different codebases in different languages were to implement this: what must they all have in common?"

- ❌ DON'T describe known issues in the current implementation
- ❌ DON'T focus on technical details (i.e. language used in the implementation, tech stacks)
- ❌ DON'T discuss code, architectural choices or modules.

CRTICIAL: The correct way to think about PROJECT.md is: "If I had to recreate the entire project from a single product spec, a spec that defines every nuance, every corner of what I know for certain the project is supposed to be: what would that spec be?"

PROJECT.md is NOT the place for code, tech stack, architectural choices or modules, its the place to detail, in as great level of detail and accuracy as possible, what it is we are working on.
`;

interface ProjectMdArgs {
  projectPath?: string;
}

export const projectMdFragment: PromptFragment<ProjectMdArgs> = {
  id: "project-md",
  priority: 30,
  template: () => {
    const projectMdPath = path.join("context", "PROJECT.md");
    let content: string;

    try {
      if (fs.existsSync(projectMdPath)) {
        content = fs.readFileSync(projectMdPath, "utf-8");
      } else {
        // PROJECT.md doesn't exist - check if this is an established project
        const fileCount = countTotalFiles(process.cwd());
        
        if (fileCount > 10) {
          content = `The PROJECT.md file doesn't exist yet. This appears to be an established project with ${fileCount} files.

**CRITICAL**: You MUST create a PROJECT.md immediately. As the PM agent, work with another agent to explore the codebase comprehensively. Use open-ended exploration:

1. Start with: "Explore this codebase thoroughly and tell me what this project does, its main features, and how users interact with it"
2. Follow up with specific questions based on what you learn:
   - "What are the main user-facing features?"
   - "What problems does this solve for users?"
   - "Describe the user journey from start to finish"
   - "Are there different user roles or personas?"
   - "What are the key workflows or processes?"

Remember: The agent helping you may not understand PROJECT.md's purpose. Focus on extracting PROJECT SPECIFICATION details (what the product IS and DOES for users, not HOW it's technically built).`;
        } else {
          content = "The PROJECT.md file doesn't exist yet. This appears to be a new or small project. Work with the user to define what this project should be, validating your understanding through clarifying questions. It's better to underdefine the project spec than to proceed with incorrect assumptions.";
        }
      }
    } catch {
      // Fallback if anything goes wrong
      content = "The PROJECT.md file doesn't exist yet. Work with the user to understand and document what this project is about.";
    }

    return `${description}

<PROJECT.md>
${content}
</PROJECT.md>`;
  },

  validateArgs: (_args): _args is ProjectMdArgs => {
    return true;
  },
  expectedArgs: "{ projectPath?: string, currentAgent?: { id: string, slug?: string } }",
};

// Register the fragment
fragmentRegistry.register(projectMdFragment);
