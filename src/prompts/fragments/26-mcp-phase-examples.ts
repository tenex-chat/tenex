import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";
import type { Phase } from "@/conversations/phases";

/**
 * MCP tool usage examples organized by phase
 * Provides practical, concise examples for each workflow phase
 */
interface McpPhaseExamplesArgs {
    phase: Phase;
    hasMcpTools: boolean;
}

export const mcpPhaseExamplesFragment: PromptFragment<McpPhaseExamplesArgs> = {
    id: "mcp-phase-examples",
    priority: 26,
    template: ({ phase, hasMcpTools }) => {
        if (!hasMcpTools) return "";

        const examples: Record<Phase, string> = {
            CHAT: `## MCP in CHAT Phase
| Goal | Tool Sequence |
|------|---------------|
| Understand codebase | \`filesystem/list\` → \`filesystem/read_file\` |
| Check project state | \`git-server/status\` → \`git-server/diff\` |`,

            BRAINSTORM: `## MCP in BRAINSTORM Phase
| Goal | Tool Sequence |
|------|---------------|
| Explore structure | \`filesystem/search\` → \`filesystem/read_multiple\` |
| Review patterns | \`git-server/log\` → \`git-server/show\` |`,

            PLAN: `## MCP in PLAN Phase
| Goal | Tool Sequence |
|------|---------------|
| Analyze dependencies | \`filesystem/read_file:package.json\` → \`filesystem/search:import\` |
| Review architecture | \`filesystem/tree\` → \`filesystem/read_multiple:*.config.*\` |`,

            EXECUTE: `## MCP in EXECUTE Phase
| Goal | Tool Sequence |
|------|---------------|
| Implement feature | \`filesystem/write_file\` → \`filesystem/create_directory\` |
| Update configs | \`filesystem/read_file\` → \`filesystem/write_file\` |
| Run commands | \`shell/execute:npm install\` → \`shell/execute:npm test\` |`,

            VERIFICATION: `## MCP in VERIFICATION Phase
| Goal | Tool Sequence |
|------|---------------|
| Check changes | \`git-server/diff\` → \`git-server/status\` |
| Test functionality | \`shell/execute:npm test\` → \`filesystem/read_file:test-results\` |`,

            CHORES: `## MCP in CHORES Phase
| Goal | Tool Sequence |
|------|---------------|
| Update docs | \`filesystem/write_file:README.md\` |
| Format code | \`shell/execute:npm run format\` |
| Clean artifacts | \`filesystem/delete\` → \`shell/execute:npm run clean\` |`,

            REFLECTION: `## MCP in REFLECTION Phase
| Goal | Tool Sequence |
|------|---------------|
| Review changes | \`git-server/diff:HEAD~1\` |
| Document decisions | \`filesystem/write_file:docs/decisions.md\` |`
        };

        return examples[phase] || "";
    }
};

// Register the fragment
fragmentRegistry.register(mcpPhaseExamplesFragment);