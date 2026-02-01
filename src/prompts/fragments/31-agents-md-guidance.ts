/**
 * AGENTS.md Guidance Fragment
 *
 * This fragment is conditionally included when the project has an AGENTS.md file
 * at its root. It provides guidance to agents about:
 * - What AGENTS.md files are and how they work
 * - How to write and update AGENTS.md files
 * - The hierarchical nature of AGENTS.md inheritance
 */

import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";

/**
 * Maximum length for root AGENTS.md content to be included directly in the system prompt.
 * Beyond this threshold, the content is omitted to avoid bloating the prompt.
 * Short AGENTS.md files (< 2000 chars) typically contain essential project guidelines
 * that benefit from being in the system prompt context.
 */
const MAX_ROOT_CONTENT_LENGTH_FOR_SYSTEM_PROMPT = 2000;

interface AgentsMdGuidanceArgs {
    /** Whether the project has an AGENTS.md at the root */
    hasRootAgentsMd: boolean;
    /** Content of the root AGENTS.md (for context) */
    rootAgentsMdContent?: string;
}

export const agentsMdGuidanceFragment: PromptFragment<AgentsMdGuidanceArgs> = {
    id: "agents-md-guidance",
    priority: 31, // After worktree context (30)
    template: ({ hasRootAgentsMd, rootAgentsMdContent }) => {
        // Only include if project has a root AGENTS.md
        if (!hasRootAgentsMd) {
            return "";
        }

        const parts: string[] = [];

        parts.push("## AGENTS.md Guidelines\n");

        parts.push(`This project uses AGENTS.md files to provide contextual guidelines for different directories.

### How AGENTS.md Works
- AGENTS.md files contain instructions relevant to their directory and subdirectories
- When you read files, you may see \`<system-reminder>\` blocks with AGENTS.md content
- Multiple AGENTS.md files can apply (from the file's directory up to project root)
- More specific (deeper) AGENTS.md files take precedence over general ones

### Writing AGENTS.md Files
When working in a directory that would benefit from specific guidelines:
1. Create an AGENTS.md file in that directory
2. Keep content focused on that directory's purpose and conventions
3. Include coding style, naming conventions, and important patterns
4. Reference related AGENTS.md files for inherited guidelines

### AGENTS.md Format
\`\`\`markdown
# Directory Guidelines

Brief description of this directory's purpose.

## Conventions
- Specific coding patterns to follow
- Naming conventions for this area
- Important dependencies or imports

## Related
- Links to relevant documentation
- Cross-references to other important files
\`\`\``);

        // If root AGENTS.md content is available and short, include it
        if (rootAgentsMdContent && rootAgentsMdContent.length < MAX_ROOT_CONTENT_LENGTH_FOR_SYSTEM_PROMPT) {
            parts.push("\n### Root AGENTS.md\n");
            parts.push("This project's root AGENTS.md:\n");
            parts.push("```markdown");
            parts.push(rootAgentsMdContent.trim());
            parts.push("```");
        }

        return parts.join("\n");
    },
};

// Register the fragment
fragmentRegistry.register(agentsMdGuidanceFragment);
