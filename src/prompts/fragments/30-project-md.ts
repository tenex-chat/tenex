import { fragmentRegistry } from "@/prompts/core/FragmentRegistry";
import type { PromptFragment } from "@/prompts/core/types";
import fs from "node:fs";
import path from "node:path";

const description = `
## PROJECT SPEC

The PROJECT.md maintains your living understanding of:
- What the project is.
- What assumptions you've made to fill in gaps.
- How the project has evolved based on user feedback.
- Features the user has confirmed vs features you've inferred

During REFLECTION phase, update context/PROJECT.md with everything new you learned 
about what the project you manage is:

- Every single detail the user has explicitly described about the project
- Clear delineations between what the user stated vs. your assumptions
- Example: User says "make a calculator" - multiplication support is a 
safe assumption, but still an assumption.

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
        let content =
            "The PROJECT.md file doesn't exist yet. If this is not a new project you should suggest to the user if they want to kickstart the creation of the PROJECT.md -- for this, you can use the `analyze` tool. Since this is such a critical moment, you should validate your understanding and iterate with the user, ask clarifying questions and try to nail down the specifics, it's better to underdefine the project spec than to proceed with incorrect assumptions.";

        try {
            if (fs.existsSync(projectMdPath)) {
                content = fs.readFileSync(projectMdPath, "utf-8");
            }
        } catch {
            // Ignore errors
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
