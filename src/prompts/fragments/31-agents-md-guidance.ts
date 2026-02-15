/**
 * AGENTS.md Guidance Fragment
 *
 * This fragment is ALWAYS included in the system prompt to inform agents about
 * the AGENTS.md system. It provides guidance to agents about:
 * - What AGENTS.md files are and how they work
 * - How to write and update AGENTS.md files
 * - The hierarchical nature of AGENTS.md inheritance
 *
 * When the project has no root AGENTS.md, it explicitly states so.
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
        const parts: string[] = [];

        parts.push("## AGENTS.md Guidelines\n");

        // When no root AGENTS.md exists, explicitly state so
        if (!hasRootAgentsMd) {
            parts.push(
                "No root AGENTS.md file exists for this project. " +
                    "AGENTS.md files provide contextual guidelines for AI agents working in specific directories. " +
                    "If you need to establish project-specific conventions, commands, or guidelines, " +
                    "consider creating an AGENTS.md file at the project root."
            );
            return parts.join("\n");
        }

        parts.push(`This project uses AGENTS.md files to provide contextual guidelines for different directories.

### How AGENTS.md Works
- AGENTS.md files serve as a "README for Agents," containing context, commands, and conventions.
- Unlike human-focused READMEs, these files focus on actionable instructions (build steps, test commands, code style).
- **Automatic Injection**: When you use tools that interact with files in a directory containing an AGENTS.md, the system automatically injects relevant AGENTS.md content as a \`<system-reminder>\`. You do NOT need to manually search for or read these files—they are provided to you when relevant.
- Multiple AGENTS.md files may apply (Root + Directory specific). The system handles this hierarchy automatically.
- Deeper, more specific AGENTS.md files override general root instructions.

### Writing AGENTS.md Files
When working in a directory that needs specific agent guidance:
1. Create an AGENTS.md file in that directory.
2. Focus on **executable commands** (test/build) and **strict conventions**.
3. Do not duplicate generic info; focus on what is unique to this directory.

### AGENTS.md Format
\`\`\`markdown
# Directory Context
Specific architectural details or business logic for this directory.

## Commands
- Test: \`npm test path/to/dir\`
- Lint: \`npm run lint:specific\`

## Conventions
- Code Style: Functional patterns preferred
- Naming: CamelCase for files, PascalCase for classes

## Related
- [API Docs](./docs/api.md)
\`\`\``);

        // If root AGENTS.md content is available and short, include it
        if (rootAgentsMdContent && rootAgentsMdContent.length < MAX_ROOT_CONTENT_LENGTH_FOR_SYSTEM_PROMPT) {
            parts.push("\n### Root AGENTS.md\n");
            parts.push("This project's root AGENTS.md:\n");
            parts.push("```");
            parts.push(rootAgentsMdContent.trim());
            parts.push("```");
        }

        return parts.join("\n");
    },
};

// Register the fragment
fragmentRegistry.register(agentsMdGuidanceFragment);
